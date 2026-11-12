import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import CANExplorer from './components/CANExplorer';
import ModuleConfig from './components/ModuleConfig';
import BMSOverview from './components/BMSOverview';
import BalanceManager from './components/BalanceManager';
import BMSStatus from './components/BMSStatus';
import HVCDashboard from './components/HVCDashboard';
import MoboDashboard from './components/MoboDashboard';
import InverterDashboard from './components/InverterDashboard';
import InverterTesting from './components/InverterTesting';
import VCUDashboard from './components/VCUDashboard';
import VCULaunchControlDashboard from './components/VCULaunchControlDashboard';
import DAQDashboard from './components/DAQDashboard';
import DrivingDashboard from './components/DrivingDashboard';
import { apiService } from './services/api';
import { websocketService } from './services/websocket';
import { syncFreshnessClock } from './hooks/useStaleness';

const isPageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const BUS_IDS = ['bus1', 'bus2'];
const AUTO_CONNECT_SOCKETCAN_CHANNELS = {
  bus1: 'can0',
  bus2: 'can1',
};

const formatStatusLabel = (status) => {
  if (!status || typeof status !== 'string') {
    return 'Disconnected';
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
};

const createEmptyBusState = (busId) => ({
  bus_id: busId,
  connected: false,
  device_type: null,
  channel: null,
  baudrate: null,
  status: 'Disconnected',
  interface: null,
  reason: null,
  message_count: 0,
  uptime_seconds: 0,
  message_rate: 0,
});

const mergeBusStates = (buses = []) => {
  if (!Array.isArray(buses) || buses.length === 0) {
    return BUS_IDS.map(createEmptyBusState);
  }

  const busMap = new Map(
    buses
      .filter((bus) => bus && bus.bus_id)
      .map((bus) => [
        bus.bus_id,
        {
          ...createEmptyBusState(bus.bus_id),
          ...bus,
          status: formatStatusLabel(bus.status),
        },
      ])
  );

  if (busMap.has('simulation')) {
    return Array.from(busMap.values());
  }

  return BUS_IDS.map((busId) => ({
    ...createEmptyBusState(busId),
    ...(busMap.get(busId) || {}),
  }));
};

const createEmptyConnectionStatus = () => ({
  connected: false,
  connected_bus_count: 0,
  primary_bus_id: null,
  device_type: null,
  channel: null,
  baudrate: null,
  status: 'Disconnected',
  interface: null,
  buses: BUS_IDS.map(createEmptyBusState),
});

const createEmptyStats = () => ({
  connected: false,
  connected_bus_count: 0,
  primary_bus_id: null,
  message_count: 0,
  uptime_seconds: 0,
  message_rate: 0,
  buses: BUS_IDS.map(createEmptyBusState),
});

const createSimulationConnectionStatus = () => ({
  connected: true,
  connected_bus_count: BUS_IDS.length,
  primary_bus_id: 'bus1',
  device_type: 'simulation',
  channel: 'bms-fake-data',
  baudrate: 'SIM',
  status: 'Connected',
  interface: 'simulation',
  buses: BUS_IDS.map((busId) => ({
    ...createEmptyBusState(busId),
    connected: true,
    device_type: 'simulation',
    channel: busId === 'bus1' ? 'bms-fake-data' : 'master-fake-data',
    baudrate: 'SIM',
    status: 'Connected',
    interface: 'simulation',
    reason: 'simulation',
  })),
});

const normalizeConnectionStatus = (status = {}) => ({
  ...createEmptyConnectionStatus(),
  ...status,
  connected: Boolean(status.connected),
  status: formatStatusLabel(status.status || (status.connected ? 'connected' : 'disconnected')),
  buses: mergeBusStates(status.buses),
});

const normalizeStats = (stats = {}) => ({
  ...createEmptyStats(),
  ...stats,
  connected: Boolean(stats.connected),
  buses: mergeBusStates(stats.buses),
});

const getExplorerAggregateKey = (msg) => `${msg.bus_id || 'bus1'}:${msg.is_extended ? 'ext' : 'std'}:${msg.id}`;
const getDashboardAggregateKey = (msg) => `${msg.is_extended ? 'ext' : 'std'}:${msg.id}`;

const compareExplorerMessages = (left, right) => {
  if (left.id !== right.id) {
    return left.id - right.id;
  }

  if ((left.bus_id || 'bus1') !== (right.bus_id || 'bus1')) {
    return (left.bus_id || 'bus1').localeCompare(right.bus_id || 'bus1');
  }

  return Number(left.is_extended) - Number(right.is_extended);
};

const compareDashboardMessages = (left, right) => {
  if (left.id !== right.id) {
    return left.id - right.id;
  }
  return Number(left.is_extended) - Number(right.is_extended);
};

const aggregateMessages = (previousMessages, incomingMessages, getAggregateKey, messageCounts, compareMessages) => {
  const messageMap = new Map();
  previousMessages.forEach((message) => {
    messageMap.set(getAggregateKey(message), message);
  });

  incomingMessages.forEach((message) => {
    const aggregateKey = getAggregateKey(message);
    const existingMessage = messageMap.get(aggregateKey);
    const currentCount = messageCounts.get(aggregateKey) || 0;
    messageCounts.set(aggregateKey, currentCount + 1);

    let mergedDecoded = message.decoded;
    if (existingMessage?.decoded) {
      if (message.decoded?.signals) {
        mergedDecoded = {
          ...existingMessage.decoded,
          ...message.decoded,
          signals: {
            ...(existingMessage.decoded.signals || {}),
            ...message.decoded.signals,
          },
        };
      } else {
        mergedDecoded = existingMessage.decoded;
      }
    }

    const nextMessage = {
      ...message,
      decoded: mergedDecoded,
    };

    if (existingMessage) {
      const timeDiff = message.timestamp - existingMessage.timestamp;
      messageMap.set(aggregateKey, {
        ...nextMessage,
        count: messageCounts.get(aggregateKey),
        cycleTime: timeDiff > 0 ? timeDiff : existingMessage.cycleTime,
        lastTimestamp: existingMessage.timestamp,
      });
      return;
    }

    messageMap.set(aggregateKey, {
      ...nextMessage,
      count: messageCounts.get(aggregateKey),
      cycleTime: null,
      lastTimestamp: null,
    });
  });

  return Array.from(messageMap.values()).sort(compareMessages);
};

function App() {
  const [activeTab, setActiveTab] = useState('explorer');
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(createEmptyConnectionStatus);
  const [devices, setDevices] = useState([]);
  const [messages, setMessages] = useState([]);
  const [explorerMessages, setExplorerMessages] = useState([]);
  const [stats, setStats] = useState(createEmptyStats);
  const [dbcConfig, setDbcConfig] = useState({
    loaded: false,
    filename: null,
    message_count: 0,
    active_signature: null,
    active_count: 0,
    files: []
  });
  const [toast, setToast] = useState(null);
  const [simulationActive, setSimulationActive] = useState(false);

  // Stale message timeout (ms) — controls when sub-pages gray out data whose
  // source CAN message hasn't been seen recently. Persisted to localStorage.
  const [staleMessagesEnabled, setStaleMessagesEnabledState] = useState(() => {
    const stored = localStorage.getItem('staleMessagesEnabled');
    if (stored === null) {
      return true;
    }
    return stored === 'true';
  });
  const [staleTimeoutMs, setStaleTimeoutMsState] = useState(() => {
    const stored = parseInt(localStorage.getItem('staleTimeoutMs'), 10);
    return Number.isFinite(stored) && stored > 0 ? stored : 30000;
  });
  const setStaleMessagesEnabled = useCallback((enabled) => {
    const nextValue = Boolean(enabled);
    setStaleMessagesEnabledState(nextValue);
    localStorage.setItem('staleMessagesEnabled', String(nextValue));
  }, []);
  const setStaleTimeoutMs = useCallback((ms) => {
    const clamped = Math.max(1000, Math.min(600000, Math.round(ms)));
    setStaleTimeoutMsState(clamped);
    localStorage.setItem('staleTimeoutMs', String(clamped));
  }, []);
  const effectiveStaleTimeoutMs = staleMessagesEnabled ? staleTimeoutMs : 0;

  // Performance: Batch incoming messages and aggregate by CAN ID
  const messageBufferRef = useRef([]);
  const flushIntervalRef = useRef(null);
  const dashboardMessageCountsRef = useRef(new Map());
  const explorerMessageCountsRef = useRef(new Map());
  const wakeCheckTimerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const lastHeartbeatRef = useRef(Date.now());
  const canStateRef = useRef('unknown'); // tracks backend CAN state for toast gating
  const connectWebSocketRef = useRef(null);
  const autoConnectAttemptedBusIdsRef = useRef(new Set());
  const latestMessageSequenceRef = useRef(0);
  const seenMessageSequencesRef = useRef(new Set());
  
  // Raw message callbacks for components that need to see ALL messages (not aggregated)
  const rawMessageCallbacksRef = useRef([]);
  
  // Register/unregister callbacks for raw messages
  const registerRawMessageCallback = useCallback((callback) => {
    rawMessageCallbacksRef.current.push(callback);
    return () => {
      rawMessageCallbacksRef.current = rawMessageCallbacksRef.current.filter(cb => cb !== callback);
    };
  }, []);

  const dbcLoaded = dbcConfig.loaded;
  const dbcFile = dbcConfig.filename;
  const dbcFiles = dbcConfig.files || [];
  const dbcContext = dbcConfig.active_signature;

  const flushBufferedMessages = useCallback(() => {
    if (messageBufferRef.current.length === 0) {
      return;
    }

    const bufferedMessages = [...messageBufferRef.current];
    messageBufferRef.current = [];

    setExplorerMessages((previousMessages) => aggregateMessages(
      previousMessages,
      bufferedMessages,
      getExplorerAggregateKey,
      explorerMessageCountsRef.current,
      compareExplorerMessages
    ));

    setMessages((previousMessages) => aggregateMessages(
      previousMessages,
      bufferedMessages,
      getDashboardAggregateKey,
      dashboardMessageCountsRef.current,
      compareDashboardMessages
    ));
  }, []);

  const enqueueIncomingCanMessage = useCallback((message) => {
    if (!message || message.type === 'heartbeat' || message.type === 'connection_status') {
      return false;
    }

    const sequence = Number(message.sequence);
    if (Number.isFinite(sequence) && sequence > 0) {
      if (seenMessageSequencesRef.current.has(sequence)) {
        return false;
      }

      seenMessageSequencesRef.current.add(sequence);
      latestMessageSequenceRef.current = Math.max(latestMessageSequenceRef.current, sequence);

      if (seenMessageSequencesRef.current.size > 5000) {
        const recentSequences = Array.from(seenMessageSequencesRef.current).slice(-2500);
        seenMessageSequencesRef.current = new Set(recentSequences);
      }
    }

    const observedAtMs = Date.now();
    syncFreshnessClock(message.received_at, observedAtMs);
    lastHeartbeatRef.current = observedAtMs;

    // Notify raw message callbacks (for components like ModuleConfig that need ALL messages)
    rawMessageCallbacksRef.current.forEach(callback => {
      try {
        callback(message);
      } catch (e) {
        console.error('[App] Raw message callback error:', e);
      }
    });

    // Buffer incoming messages - they'll be flushed by the interval
    messageBufferRef.current.push(message);
    return true;
  }, []);

  useEffect(() => {
    if (connected) {
      flushIntervalRef.current = setInterval(flushBufferedMessages, 100);
    } else if (flushIntervalRef.current) {
      clearInterval(flushIntervalRef.current);
      flushIntervalRef.current = null;
    }

    return () => {
      if (flushIntervalRef.current) {
        clearInterval(flushIntervalRef.current);
        flushIntervalRef.current = null;
      }
    };
  }, [connected, flushBufferedMessages]);

  const fetchDevices = useCallback(async () => {
    try {
      const data = await apiService.getDevices();
      console.log('[App] Fetched devices:', data.devices);
      setDevices(data.devices || []);
    } catch (error) {
      console.error('Failed to fetch devices:', error);
    }
  }, []);

  const checkConnectionStatus = useCallback(async () => {
    try {
      const status = normalizeConnectionStatus(await apiService.getStatus());
      setConnected(status.connected);
      setConnectionStatus(status);
      setSimulationActive(status.device_type === 'simulation');
      
      if (status.connected && !websocketService.isConnected()) {
        connectWebSocketRef.current?.();
      }
    } catch (error) {
      console.error('Failed to check status:', error);
    }
  }, []);

  const checkSimulationStatus = useCallback(async () => {
    try {
      const status = await apiService.getSimulationStatus();
      setSimulationActive(status.active);

      if (status.active) {
        setConnected(true);
        setConnectionStatus(normalizeConnectionStatus(createSimulationConnectionStatus()));

        if (!websocketService.isConnected()) {
          connectWebSocketRef.current?.();
        }
      }
    } catch (error) {
      console.error('Failed to check simulation status:', error);
    }
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback((message, level = 'info', duration = 10000) => {
    // Success toasts should always auto-dismiss after 10s.
    const effectiveDuration = level === 'success' ? 10000 : duration;

    setToast({ message, level });
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    if (effectiveDuration > 0) {
      toastTimerRef.current = setTimeout(() => {
        toastTimerRef.current = null;
        setToast(null);
      }, effectiveDuration);
    }
  }, []);

  const handleWakeRecovery = useCallback(async () => {
    try {
      const health = await apiService.getHealth();
      if (health.connection_state === 'reconnecting' || health.recovery_in_progress) {
        if (canStateRef.current !== 'reconnecting') {
          showToast('Reconnecting to CAN hardware...', 'warning', 0);
        }
        canStateRef.current = 'reconnecting';
        setConnectionStatus(prev => ({ ...prev, status: 'Reconnecting' }));
        return;
      }

      if (health.connection_state === 'connected') {
        const wasDown = canStateRef.current === 'reconnecting' || canStateRef.current === 'disconnected';
        canStateRef.current = 'connected';
        setConnected(true);
        setConnectionStatus(prev => ({ ...prev, status: 'Connected' }));
        if (wasDown && !health.simulation_active) {
          showToast('CAN connection restored', 'success', 3000);
        }
      } else if (health.connection_state === 'disconnected' && connected) {
        canStateRef.current = 'disconnected';
        setConnected(false);
        setConnectionStatus(prev => ({ ...prev, status: 'Disconnected' }));
        showToast('CAN connection lost — hardware may need to be re-plugged', 'error', 0);
      }
    } catch (error) {
      console.error('Wake recovery health check failed:', error);
    }
  }, [connected, showToast]);

  const checkDBCStatus = useCallback(async () => {
    try {
      const dbcStatus = await apiService.getDBCConfig();
      setDbcConfig(dbcStatus);
    } catch (error) {
      console.error('Failed to check DBC status:', error);
    }
  }, []);

  // Clear all messages and counts
  const handleClearMessages = useCallback(() => {
    setMessages([]);
    setExplorerMessages([]);
    dashboardMessageCountsRef.current.clear();
    explorerMessageCountsRef.current.clear();
    messageBufferRef.current = [];
  }, []);

  const connectWebSocket = useCallback(() => {
    websocketService.connect((message) => {
      if (message.type === 'connection_status') {
        const aggregateStatus = message.status || 'disconnected';
        const nextConnectionStatus = normalizeConnectionStatus({
          connected: message.connected,
          connected_bus_count: message.connected_bus_count,
          primary_bus_id: message.primary_bus_id,
          status: aggregateStatus,
          buses: message.buses,
        });

        setConnectionStatus(nextConnectionStatus);
        setConnected(Boolean(nextConnectionStatus.connected));

        if (aggregateStatus === 'reconnecting') {
          canStateRef.current = 'reconnecting';
          showToast('Reconnecting to CAN hardware...', 'warning', 0);
        } else if (aggregateStatus === 'connected') {
          const simulationConnected = message.reason === 'simulation_started' || simulationActive;
          if (simulationConnected) {
            setSimulationActive(true);
          }
          const wasDown = canStateRef.current === 'reconnecting' || canStateRef.current === 'disconnected';
          canStateRef.current = 'connected';
          if (wasDown && !simulationConnected) {
            showToast('CAN connection restored', 'success', 3000);
          }
        } else if (aggregateStatus === 'disconnected') {
          if (message.reason === 'simulation_stopped') {
            setSimulationActive(false);
          }
          canStateRef.current = 'disconnected';
          if (message.reason === 'hardware_lost') {
            showToast('CAN connection lost — hardware may need to be re-plugged', 'error', 0);
          }
        }
        return;
      }

      enqueueIncomingCanMessage(message);
    }, () => {
      checkConnectionStatus();
    });
  }, [checkConnectionStatus, enqueueIncomingCanMessage, showToast, simulationActive]);

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  // Fetch available devices and backend status on mount.
  useEffect(() => {
    fetchDevices();
    checkConnectionStatus();
    checkSimulationStatus();
    checkDBCStatus();
  }, [fetchDevices, checkConnectionStatus, checkSimulationStatus, checkDBCStatus]);

  const handleConnect = useCallback(async (busId, deviceType, channel, baudrate) => {
    if (simulationActive) {
      alert('Stop Test Mode before connecting to real hardware.');
      return false;
    }

    console.log('handleConnect called with:', { busId, deviceType, channel, baudrate });
    try {
      console.log('Calling API connect...');
      const response = await apiService.connect(deviceType, channel, baudrate, busId);
      console.log('API response:', response);
      
      if (response.success) {
        await checkConnectionStatus();
        canStateRef.current = 'connected';
        if (!websocketService.isConnected()) {
          connectWebSocket();
        }
        console.log('Connected successfully!');
        return true;
      }
      console.warn('Connection failed:', response);
      return false;
    } catch (error) {
      console.error('Connection failed:', error);
      alert('Failed to connect: ' + (error.response?.data?.detail || error.message));
      return false;
    }
  }, [checkConnectionStatus, connectWebSocket, simulationActive]);

  useEffect(() => {
    if (simulationActive || devices.length === 0) {
      return;
    }

    const connectedBusIds = new Set(
      (connectionStatus.buses || [])
        .filter((bus) => bus?.connected)
        .map((bus) => bus.bus_id)
    );

    const pendingTargets = Object.entries(AUTO_CONNECT_SOCKETCAN_CHANNELS)
      .filter(([busId]) => !connectedBusIds.has(busId) && !autoConnectAttemptedBusIdsRef.current.has(busId))
      .map(([busId, interfaceName]) => {
        const matchingDevice = devices.find((device) => (
          device?.device_type === 'canable'
          && device?.interface === 'socketcan'
          && device?.channel === interfaceName
        ));
        return matchingDevice ? { busId, deviceIndex: String(matchingDevice.index) } : null;
      })
      .filter(Boolean);

    if (pendingTargets.length === 0) {
      return;
    }

    let cancelled = false;

    const attemptAutoConnect = async () => {
      for (const target of pendingTargets) {
        if (cancelled) {
          return;
        }

        autoConnectAttemptedBusIdsRef.current.add(target.busId);
        const success = await handleConnect(target.busId, 'canable', target.deviceIndex, 'BAUD_500K');
        if (!success && !cancelled) {
          autoConnectAttemptedBusIdsRef.current.delete(target.busId);
        }
      }
    };

    attemptAutoConnect();

    return () => {
      cancelled = true;
    };
  }, [connectionStatus.buses, devices, handleConnect, simulationActive]);

  const handleStartSimulation = async () => {
    try {
      const response = await apiService.startSimulation();
      if (response.success) {
        setSimulationActive(true);
        setConnected(true);
        setConnectionStatus(normalizeConnectionStatus(createSimulationConnectionStatus()));

        if (!websocketService.isConnected()) {
          connectWebSocket();
        }

        checkDBCStatus();
        showToast('Test mode started', 'success', 2500);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to start simulation:', error);

      const statusCode = error?.response?.status;
      if (statusCode === 404) {
        alert('Failed to start test mode: backend is missing simulation endpoints. Restart services (run start.py) to load the latest backend.');
      } else {
        alert('Failed to start test mode: ' + (error.response?.data?.detail || error.message));
      }
      return false;
    }
  };

  const handleStopSimulation = async () => {
    try {
      const response = await apiService.stopSimulation();
      if (response.success) {
        websocketService.disconnect();
        setSimulationActive(false);
        setConnected(false);
        setConnectionStatus(createEmptyConnectionStatus());
        setToast(null);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to stop simulation:', error);
      return false;
    }
  };

  const handleDisconnect = async (busId = null) => {
    try {
      // Clear message buffer
      messageBufferRef.current = [];
      
      await apiService.disconnect(busId);
      const status = normalizeConnectionStatus(await apiService.getStatus());
      setConnected(status.connected);
      setConnectionStatus(status);
      canStateRef.current = status.connected ? 'connected' : 'disconnected';
      if (!status.connected) {
        websocketService.disconnect();
      }
      setToast(null);
      // Don't clear messages on disconnect - they persist until manually cleared
      return true;
    } catch (error) {
      console.error('Disconnect failed:', error);
      return false;
    }
  };

  const handleSendMessage = async (canId, data, isExtended, isRemote, busId = null) => {
    try {
      await apiService.sendMessage(canId, data, isExtended, isRemote, busId);
      return true;
    } catch (error) {
      console.error('Send failed:', error);
      return false;
    }
  };

  const handleLoadDBC = async (file) => {
    try {
      const response = await apiService.uploadDBC(file);
      if (response.success) {
        await checkDBCStatus();
        alert(`DBC file uploaded successfully!\n${response.message}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('DBC upload failed:', error);
      alert('Failed to upload DBC file: ' + (error.response?.data?.detail || error.message));
      return false;
    }
  };

  const handleUpdateDBCConfig = async (files) => {
    try {
      const response = await apiService.updateDBCConfig(files);
      setDbcConfig(response);
      return true;
    } catch (error) {
      console.error('Failed to update DBC config:', error);
      alert('Failed to update DBC configuration: ' + (error.response?.data?.detail || error.message));
      return false;
    }
  };

  const handleDeleteDBC = async (filename) => {
    try {
      const response = await apiService.deleteDBC(filename);
      if (response.success && response.dbc) {
        setDbcConfig(response.dbc);
      } else {
        await checkDBCStatus();
      }
      return true;
    } catch (error) {
      console.error('Failed to delete DBC file:', error);
      alert('Failed to delete DBC file: ' + (error.response?.data?.detail || error.message));
      return false;
    }
  };

  // Update stats periodically
  useEffect(() => {
    if (!connected) return;

    const interval = setInterval(async () => {
      try {
        const statsData = normalizeStats(await apiService.getStats());
        setStats(statsData);

        const recentData = await apiService.getRecentMessages(latestMessageSequenceRef.current, 500);
        (recentData.messages || []).forEach(enqueueIncomingCanMessage);

        const now = Date.now();
        if (isPageVisible() && now - lastHeartbeatRef.current > 15000) {
          handleWakeRecovery();
        }
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [connected, enqueueIncomingCanMessage, handleWakeRecovery]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!connected || document.visibilityState !== 'visible') {
        return;
      }

      if (!websocketService.isConnected() || Date.now() - lastHeartbeatRef.current > 15000) {
        handleWakeRecovery();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    wakeCheckTimerRef.current = setInterval(() => {
      if (document.visibilityState === 'visible' && connected) {
        const now = Date.now();
        if (now - lastHeartbeatRef.current > 15000) {
          handleWakeRecovery();
        }
      }
    }, 5000);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (wakeCheckTimerRef.current) {
        clearInterval(wakeCheckTimerRef.current);
        wakeCheckTimerRef.current = null;
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [connected, handleWakeRecovery, simulationActive]);

  return (
    <div className="App">
      {toast && (
        <div className={`connection-toast ${toast.level}`}>
          {toast.message}
          <button className="toast-close" onClick={dismissToast} aria-label="Dismiss notification">×</button>
        </div>
      )}
      <div className="tab-content">
        {activeTab === 'explorer' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          />
        )}
        {activeTab === 'bms-status' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <BMSStatus 
              messages={messages} 
              onSendMessage={handleSendMessage}
              dbcFile={dbcFile}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'bms-overview' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <BMSOverview messages={messages} staleTimeoutMs={effectiveStaleTimeoutMs} />
          </CANExplorer>
        )}
        {activeTab === 'balance-manager' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <BalanceManager
              messages={messages}
              onSendMessage={handleSendMessage}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'module-config' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <ModuleConfig 
              messages={messages} 
              onSendMessage={handleSendMessage}
              connected={connected}
              onRegisterRawCallback={registerRawMessageCallback}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'hvc-dashboard' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <HVCDashboard
              messages={messages}
              onSendMessage={handleSendMessage}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'vcu-dashboard' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <VCUDashboard
              messages={messages}
              dbcFiles={dbcFiles}
              onSendMessage={handleSendMessage}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'vcu-launch-control' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <VCULaunchControlDashboard
              messages={messages}
              dbcFiles={dbcFiles}
              onSendMessage={handleSendMessage}
              onRegisterRawCallback={registerRawMessageCallback}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'mobo' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <MoboDashboard
              messages={messages}
              dbcFiles={dbcFiles}
              onSendMessage={handleSendMessage}
              onRegisterRawCallback={registerRawMessageCallback}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {(activeTab === 'inverter-dashboard' || activeTab === 'inverter-testing') && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            {activeTab === 'inverter-testing' ? <InverterTesting
              messages={explorerMessages}
              connectionStatus={connectionStatus}
              simulationActive={simulationActive}
              onSendMessage={handleSendMessage}
              onRegisterRawCallback={registerRawMessageCallback}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            /> : <InverterDashboard
              messages={messages}
              dbcFiles={dbcFiles}
              onSendMessage={handleSendMessage}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />}
          </CANExplorer>
        )}
        {activeTab === 'driving-dashboard' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <DrivingDashboard
              messages={messages}
              dbcFiles={dbcFiles}
              staleTimeoutMs={effectiveStaleTimeoutMs}
            />
          </CANExplorer>
        )}
        {activeTab === 'daq-dashboard' && (
          <CANExplorer
            connected={connected}
            messages={explorerMessages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            onUpdateDBCConfig={handleUpdateDBCConfig}
            onDeleteDBC={handleDeleteDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
            dbcFiles={dbcFiles}
            dbcContext={dbcContext}
            devices={devices}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefreshDevices={fetchDevices}
            connectionStatus={connectionStatus}
            stats={stats}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onRegisterRawCallback={registerRawMessageCallback}
            simulationActive={simulationActive}
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            staleTimeoutMs={staleTimeoutMs}
            staleMessagesEnabled={staleMessagesEnabled}
            onStaleMessagesEnabledChange={setStaleMessagesEnabled}
            onStaleTimeoutChange={setStaleTimeoutMs}
          >
            <DAQDashboard
              messages={messages}
              connected={connected}
              connectionStatus={connectionStatus}
              stats={stats}
              dbcFiles={dbcFiles}
              onSendMessage={handleSendMessage}
              onUpdateDBCConfig={handleUpdateDBCConfig}
            />
          </CANExplorer>
        )}
      </div>
    </div>
  );
}

export default App;
