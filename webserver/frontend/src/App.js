import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import Header from './components/Header';
import ConnectionPanel from './components/ConnectionPanel';
import CANExplorer from './components/CANExplorer';
import ModuleConfig from './components/ModuleConfig';
import BMSOverview from './components/BMSOverview';
import BalanceManager from './components/BalanceManager';
import BMSStatus from './components/BMSStatus';
import HVCDashboard from './components/HVCDashboard';
import MoboDashboard from './components/MoboDashboard';
import StatusBar from './components/StatusBar';
import { apiService } from './services/api';
import { websocketService } from './services/websocket';

const isPageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

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

  // Performance: Batch incoming messages and aggregate by CAN ID
  const messageBufferRef = useRef([]);
  const flushIntervalRef = useRef(null);
  const messageCountsRef = useRef(new Map()); // Track total counts per CAN ID
  const wakeCheckTimerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const lastHeartbeatRef = useRef(Date.now());
  const canStateRef = useRef('unknown'); // tracks backend CAN state for toast gating
  
  // Raw message callbacks for components that need to see ALL messages (not aggregated)
  const rawMessageCallbacksRef = useRef([]);;
  
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

  const checkDBCStatus = async () => {
    try {
      const dbcStatus = await apiService.getDBCConfig();
      setDbcConfig(dbcStatus);
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
          canStateRef.current = 'reconnecting';
          setConnectionStatus(prev => ({ ...prev, status: 'Reconnecting' }));
          showToast('Reconnecting to CAN hardware...', 'warning', 0);
        } else if (message.status === 'connected') {
          const simulationConnected = message.reason === 'simulation_started' || simulationActive;
          if (simulationConnected) {
            setSimulationActive(true);
          }
          const wasDown = canStateRef.current === 'reconnecting' || canStateRef.current === 'disconnected';
          canStateRef.current = 'connected';
          setConnected(true);
          setConnectionStatus(prev => ({ ...prev, status: 'Connected' }));
          if (wasDown && !simulationConnected) {
            showToast('CAN connection restored', 'success', 3000);
          }
        } else if (message.status === 'disconnected') {
          if (message.reason === 'simulation_stopped') {
            setSimulationActive(false);
          }
          canStateRef.current = 'disconnected';
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
      
      // Add a client-side receive timestamp so UI freshness can be computed
      // even if driver-provided CAN timestamps use a different time base.
      messageBufferRef.current.push({
        ...message,
        clientTimestamp: Date.now() / 1000
      });
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
        canStateRef.current = 'connected';
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
      canStateRef.current = 'disconnected';
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
            messages={messages}
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
          />
        )}
        {activeTab === 'bms-status' && (
          <CANExplorer
            connected={connected}
            messages={messages}
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
          >
            <BMSOverview messages={messages} />
          </CANExplorer>
        )}
        {activeTab === 'balance-manager' && (
          <CANExplorer
            connected={connected}
            messages={messages}
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
          >
            <BalanceManager
              messages={messages}
              onSendMessage={handleSendMessage}
            />
          </CANExplorer>
        )}
        {activeTab === 'module-config' && (
          <CANExplorer
            connected={connected}
            messages={messages}
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
          >
            <ModuleConfig 
              messages={messages} 
              onSendMessage={handleSendMessage}
              connected={connected}
              onRegisterRawCallback={registerRawMessageCallback}
            />
          </CANExplorer>
        )}
        {activeTab === 'hvc-dashboard' && (
          <CANExplorer
            connected={connected}
            messages={messages}
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
          >
            <HVCDashboard
              messages={messages}
              onSendMessage={handleSendMessage}
            />
          </CANExplorer>
        )}
        {activeTab === 'mobo' && (
          <CANExplorer
            connected={connected}
            messages={messages}
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
          >
            <MoboDashboard
              messages={messages}
              dbcFiles={dbcFiles}
              onRegisterRawCallback={registerRawMessageCallback}
              onSendMessage={handleSendMessage}
            />
          </CANExplorer>
        )}
      </div>
    </div>
  );
}

export default App;
