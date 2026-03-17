import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import Header from './components/Header';
import ConnectionPanel from './components/ConnectionPanel';
import CANExplorer from './components/CANExplorer';
import ModuleConfig from './components/ModuleConfig';
import BMSOverview from './components/BMSOverview';
import BMSStatus from './components/BMSStatus';
import StatusBar from './components/StatusBar';
import { apiService } from './services/api';
import { websocketService } from './services/websocket';

const TAB_REGISTRY_KEY = 'trevcan-open-tabs';
const TAB_STALE_MS = 15000;

const isPageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

const readTabRegistry = () => {
  try {
    const raw = window.localStorage.getItem(TAB_REGISTRY_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn('[Tabs] Failed to read tab registry:', error);
    return {};
  }
};

const pruneTabRegistry = (registry, now = Date.now()) => {
  return Object.fromEntries(
    Object.entries(registry).filter(([, timestamp]) => (
      typeof timestamp === 'number' && now - timestamp < TAB_STALE_MS
    ))
  );
};

const writeTabRegistry = (registry) => {
  try {
    window.localStorage.setItem(TAB_REGISTRY_KEY, JSON.stringify(registry));
  } catch (error) {
    console.warn('[Tabs] Failed to write tab registry:', error);
  }
};

function App() {
  const [activeTab, setActiveTab] = useState('explorer');
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState({
    device_type: null,
    channel: null,
    baudrate: null,
    status: 'Disconnected'
  });
  const [devices, setDevices] = useState([]);
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState({
    message_count: 0,
    uptime_seconds: 0,
    message_rate: 0
  });
  const [dbcLoaded, setDbcLoaded] = useState(false);
  const [dbcFile, setDbcFile] = useState(null);
  const [toast, setToast] = useState(null);
  const [simulationActive, setSimulationActive] = useState(false);

  // Performance: Batch incoming messages and aggregate by CAN ID
  const messageBufferRef = useRef([]);
  const flushIntervalRef = useRef(null);
  const messageCountsRef = useRef(new Map()); // Track total counts per CAN ID
  const wakeCheckTimerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const lastHeartbeatRef = useRef(Date.now());
  const tabHeartbeatRef = useRef(null);
  const tabIdRef = useRef(`tab-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  
  // Raw message callbacks for components that need to see ALL messages (not aggregated)
  const rawMessageCallbacksRef = useRef([]);
  
  // Register/unregister callbacks for raw messages
  const registerRawMessageCallback = useCallback((callback) => {
    rawMessageCallbacksRef.current.push(callback);
    return () => {
      rawMessageCallbacksRef.current = rawMessageCallbacksRef.current.filter(cb => cb !== callback);
    };
  }, []);

  const updateTabPresence = useCallback(() => {
    const now = Date.now();
    const registry = pruneTabRegistry(readTabRegistry(), now);
    registry[tabIdRef.current] = now;
    writeTabRegistry(registry);
    return Object.keys(registry).length;
  }, []);

  const unregisterTab = useCallback(() => {
    const registry = pruneTabRegistry(readTabRegistry());
    delete registry[tabIdRef.current];
    writeTabRegistry(registry);
    return Object.keys(registry).length;
  }, []);

  // Start periodic flushing when connected
  useEffect(() => {
    if (connected) {
      // Flush messages every 100ms
      flushIntervalRef.current = setInterval(() => {
        if (messageBufferRef.current.length > 0) {
          const bufferedMessages = [...messageBufferRef.current];
          messageBufferRef.current = [];
          
          setMessages(prev => {
            // Create a map from existing messages
            const messageMap = new Map();
            prev.forEach(msg => {
              messageMap.set(msg.id, msg);
            });
            
            // Update with new messages (aggregating by CAN ID)
            bufferedMessages.forEach(msg => {
              const existing = messageMap.get(msg.id);
              
              // Update count
              const currentCount = messageCountsRef.current.get(msg.id) || 0;
              messageCountsRef.current.set(msg.id, currentCount + 1);
              
              if (existing) {
                // Update existing entry with new data
                const timeDiff = msg.timestamp - existing.timestamp;
                messageMap.set(msg.id, {
                  ...msg,
                  count: messageCountsRef.current.get(msg.id),
                  cycleTime: timeDiff > 0 ? timeDiff : existing.cycleTime,
                  lastTimestamp: existing.timestamp
                });
              } else {
                // New CAN ID
                messageMap.set(msg.id, {
                  ...msg,
                  count: messageCountsRef.current.get(msg.id),
                  cycleTime: null,
                  lastTimestamp: null
                });
              }
            });
            
            // Convert back to array, sorted by CAN ID
            return Array.from(messageMap.values()).sort((a, b) => a.id - b.id);
          });
        }
      }, 100);
    } else {
      // Clear interval when disconnected
      if (flushIntervalRef.current) {
        clearInterval(flushIntervalRef.current);
        flushIntervalRef.current = null;
      }
    }
    
    return () => {
      if (flushIntervalRef.current) {
        clearInterval(flushIntervalRef.current);
        flushIntervalRef.current = null;
      }
    };
  }, [connected]);

  // Fetch available devices on mount
  useEffect(() => {
    fetchDevices();
    checkConnectionStatus();
    checkSimulationStatus();
    checkDBCStatus();
  }, []);

  useEffect(() => {
    updateTabPresence();
    tabHeartbeatRef.current = setInterval(updateTabPresence, 5000);

    return () => {
      if (tabHeartbeatRef.current) {
        clearInterval(tabHeartbeatRef.current);
        tabHeartbeatRef.current = null;
      }
      unregisterTab();
    };
  }, [unregisterTab, updateTabPresence]);

  const fetchDevices = async () => {
    try {
      const data = await apiService.getDevices();
      console.log('[App] Fetched devices:', data.devices);
      setDevices(data.devices || []);
    } catch (error) {
      console.error('Failed to fetch devices:', error);
    }
  };

  const checkConnectionStatus = async () => {
    try {
      const status = await apiService.getStatus();
      setConnected(status.connected);
      setConnectionStatus(status);
      setSimulationActive(status.device_type === 'simulation');
      
      if (status.connected && !websocketService.isConnected()) {
        connectWebSocket();
      }
    } catch (error) {
      console.error('Failed to check status:', error);
    }
  };

  const checkSimulationStatus = async () => {
    try {
      const status = await apiService.getSimulationStatus();
      setSimulationActive(status.active);

      if (status.active) {
        setConnected(true);
        setConnectionStatus({
          device_type: 'simulation',
          channel: 'bms-fake-data',
          baudrate: 'SIM',
          status: 'Connected (Test Mode)'
        });

        if (!websocketService.isConnected()) {
          connectWebSocket();
        }
      }
    } catch (error) {
      console.error('Failed to check simulation status:', error);
    }
  };

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
        showToast('Reconnecting to CAN hardware...', 'warning', 0);
        setConnectionStatus(prev => ({ ...prev, status: 'Reconnecting' }));
        return;
      }

      if (health.connection_state === 'connected') {
        setConnected(true);
        setConnectionStatus(prev => ({ ...prev, status: 'Connected' }));
        if (!health.simulation_active) {
          showToast('CAN connection restored', 'success', 3000);
        }
      } else if (health.connection_state === 'disconnected' && connected) {
        setConnected(false);
        setConnectionStatus(prev => ({ ...prev, status: 'Disconnected' }));
        showToast('CAN connection lost — hardware may need to be re-plugged', 'error', 0);
      }
    } catch (error) {
      console.error('Wake recovery health check failed:', error);
    }
  }, [connected, showToast]);

  const checkDBCStatus = async () => {
    try {
      const dbcStatus = await apiService.getCurrentDBC();
      if (dbcStatus.loaded) {
        setDbcLoaded(true);
        setDbcFile(dbcStatus.filename);
      }
    } catch (error) {
      console.error('Failed to check DBC status:', error);
    }
  };

  // Clear all messages and counts
  const handleClearMessages = useCallback(() => {
    setMessages([]);
    messageCountsRef.current.clear();
    messageBufferRef.current = [];
  }, []);

  const connectWebSocket = useCallback(() => {
    websocketService.connect((message) => {
      if (message.type === 'connection_status') {
        if (message.status === 'reconnecting') {
          setConnectionStatus(prev => ({ ...prev, status: 'Reconnecting' }));
          showToast('Reconnecting to CAN hardware...', 'warning', 0);
        } else if (message.status === 'connected') {
          const simulationConnected = message.reason === 'simulation_started' || simulationActive;
          if (simulationConnected) {
            setSimulationActive(true);
          }
          setConnected(true);
          setConnectionStatus(prev => ({ ...prev, status: 'Connected' }));
          if (!simulationConnected) {
            showToast('CAN connection restored', 'success', 3000);
          }
        } else if (message.status === 'disconnected') {
          if (message.reason === 'simulation_stopped') {
            setSimulationActive(false);
          }
          setConnected(false);
          setConnectionStatus(prev => ({ ...prev, status: 'Disconnected' }));
          if (message.reason === 'hardware_lost') {
            showToast('CAN connection lost — hardware may need to be re-plugged', 'error', 0);
          }
        }
        return;
      }

      lastHeartbeatRef.current = Date.now();

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
    }, () => {
      checkConnectionStatus();
    });
  }, [checkConnectionStatus, showToast, simulationActive]);

  const handleConnect = async (deviceType, channel, baudrate) => {
    if (simulationActive) {
      alert('Stop Test Mode before connecting to real hardware.');
      return false;
    }

    console.log('handleConnect called with:', { deviceType, channel, baudrate });
    try {
      console.log('Calling API connect...');
      const response = await apiService.connect(deviceType, channel, baudrate);
      console.log('API response:', response);
      
      if (response.success) {
        setConnected(true);
        setConnectionStatus({
          device_type: deviceType,
          channel: channel,
          baudrate: baudrate,
          status: 'Connected'
        });
        connectWebSocket();
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
  };

  const handleStartSimulation = async () => {
    try {
      const response = await apiService.startSimulation();
      if (response.success) {
        setSimulationActive(true);
        setConnected(true);
        setConnectionStatus({
          device_type: 'simulation',
          channel: 'bms-fake-data',
          baudrate: 'SIM',
          status: 'Connected (Test Mode)'
        });

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
        setConnectionStatus({
          device_type: null,
          channel: null,
          baudrate: null,
          status: 'Disconnected'
        });
        setToast(null);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to stop simulation:', error);
      return false;
    }
  };

  const handleDisconnect = async () => {
    try {
      // Clear message buffer
      messageBufferRef.current = [];
      
      await apiService.disconnect();
      websocketService.disconnect();
      setConnected(false);
      setConnectionStatus({
        device_type: null,
        channel: null,
        baudrate: null,
        status: 'Disconnected'
      });
      setToast(null);
      // Don't clear messages on disconnect - they persist until manually cleared
      return true;
    } catch (error) {
      console.error('Disconnect failed:', error);
      return false;
    }
  };

  const handleSendMessage = async (canId, data, isExtended, isRemote) => {
    try {
      await apiService.sendMessage(canId, data, isExtended, isRemote);
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
        setDbcLoaded(true);
        setDbcFile(file.name);
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

  // Update stats periodically
  useEffect(() => {
    if (!connected) return;

    const interval = setInterval(async () => {
      try {
        const statsData = await apiService.getStats();
        setStats(statsData);

        const now = Date.now();
        if (isPageVisible() && now - lastHeartbeatRef.current > 15000) {
          handleWakeRecovery();
        }
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [connected, handleWakeRecovery]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!connected || document.visibilityState !== 'visible') {
        return;
      }

      if (!websocketService.isConnected() || Date.now() - lastHeartbeatRef.current > 15000) {
        handleWakeRecovery();
      }
    };

    const onBeforeUnload = () => {
      const remainingTabs = unregisterTab();
      if (!connected || simulationActive || remainingTabs > 0) {
        return;
      }

      try {
        const baseUrl = apiService.getBaseUrl();
        const endpoint = `${baseUrl}/disconnect`;
        navigator.sendBeacon(endpoint, new Blob([JSON.stringify({})], { type: 'application/json' }));
      } catch (error) {
        console.error('Failed to send disconnect beacon:', error);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);

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
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (wakeCheckTimerRef.current) {
        clearInterval(wakeCheckTimerRef.current);
        wakeCheckTimerRef.current = null;
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [connected, handleWakeRecovery, simulationActive, unregisterTab]);

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
            messages={messages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
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
          />
        )}
        {activeTab === 'bms-status' && (
          <CANExplorer
            connected={connected}
            messages={messages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
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
          >
            <BMSStatus 
              messages={messages} 
              onSendMessage={handleSendMessage}
              dbcFile={dbcFile}
            />
          </CANExplorer>
        )}
        {activeTab === 'bms-overview' && (
          <CANExplorer
            connected={connected}
            messages={messages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
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
          >
            <BMSOverview messages={messages} />
          </CANExplorer>
        )}
        {activeTab === 'module-config' && (
          <CANExplorer
            connected={connected}
            messages={messages}
            onClearMessages={handleClearMessages}
            onSendMessage={handleSendMessage}
            onLoadDBC={handleLoadDBC}
            dbcLoaded={dbcLoaded}
            dbcFile={dbcFile}
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
          >
            <ModuleConfig 
              messages={messages} 
              onSendMessage={handleSendMessage}
              connected={connected}
              onRegisterRawCallback={registerRawMessageCallback}
            />
          </CANExplorer>
        )}
      </div>
    </div>
  );
}

export default App;
