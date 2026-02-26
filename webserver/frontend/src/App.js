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

  // Performance: Batch incoming messages and aggregate by CAN ID
  const messageBufferRef = useRef([]);
  const flushIntervalRef = useRef(null);
  const messageCountsRef = useRef(new Map()); // Track total counts per CAN ID
  
  // Raw message callbacks for components that need to see ALL messages (not aggregated)
  const rawMessageCallbacksRef = useRef([]);
  
  // Register/unregister callbacks for raw messages
  const registerRawMessageCallback = useCallback((callback) => {
    rawMessageCallbacksRef.current.push(callback);
    return () => {
      rawMessageCallbacksRef.current = rawMessageCallbacksRef.current.filter(cb => cb !== callback);
    };
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
      
      if (status.connected && !websocketService.isConnected()) {
        connectWebSocket();
      }
    } catch (error) {
      console.error('Failed to check status:', error);
    }
  };

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
    });
  }, []);

  const handleConnect = async (deviceType, channel, baudrate) => {
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
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [connected]);

  return (
    <div className="App">
      <div className="tab-content">
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
        >
          {activeTab === 'bms-status' && (
            <BMSStatus 
              messages={messages} 
              onSendMessage={handleSendMessage}
              dbcFile={dbcFile}
            />
          )}
          {activeTab === 'bms-overview' && (
            <BMSOverview messages={messages} />
          )}
          {activeTab === 'module-config' && (
            <ModuleConfig 
              messages={messages} 
              onSendMessage={handleSendMessage}
              connected={connected}
              onRegisterRawCallback={registerRawMessageCallback}
            />
          )}
        </CANExplorer>
      </div>
    </div>
  );
}

export default App;
