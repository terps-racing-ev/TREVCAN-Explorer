import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Send, Trash2, FileText, Filter, Upload, ChevronDown, ChevronRight, ChevronLeft, Activity, Wifi, WifiOff, RefreshCw, List, PanelLeftClose, PanelLeft, Download, X, Eye, EyeOff, Flag } from 'lucide-react';
import TransmitList from './TransmitList';
import './CANExplorer.css';

function CANExplorer({ 
  connected, 
  messages, 
  onClearMessages, 
  onSendMessage, 
  onLoadDBC, 
  dbcLoaded, 
  dbcFile,
  devices,
  onConnect,
  onDisconnect,
  onRefreshDevices,
  connectionStatus,
  stats,
  activeTab,
  onTabChange,
  onRegisterRawCallback,
  children
}) {
  const [filterText, setFilterText] = useState('');
  const [sortOption, setSortOption] = useState('id-asc'); // 'id-asc', 'id-desc', 'name-asc', 'name-desc'
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [expandedReceivedMessages, setExpandedReceivedMessages] = useState(true);
  const [expandedTransmitList, setExpandedTransmitList] = useState(false);
  const [connectionExpanded, setConnectionExpanded] = useState(true);
  const [dbcExpanded, setDbcExpanded] = useState(true);
  const [filterExpanded, setFilterExpanded] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const fileInputRef = useRef(null);
  
  // Message Isolation feature state
  const [isolatedIds, setIsolatedIds] = useState(new Set());
  const [isolatedMessages, setIsolatedMessages] = useState([]);
  const [isolationPanelOpen, setIsolationPanelOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0, message: null });
  const [autoScroll, setAutoScroll] = useState(true);
  const [hideDuplicates, setHideDuplicates] = useState(false);
  const isolatedMessagesRef = useRef([]);
  const isolationContentRef = useRef(null);
  const MAX_ISOLATED_MESSAGES = 1000; // Limit to prevent memory issues
  const DUPLICATE_TIME_THRESHOLD_MS = 1; // Messages within 1ms with same data are duplicates
  
  // Connection form state
  const [deviceType, setDeviceType] = useState('canable');
  const [channel, setChannel] = useState('Device 0');
  const [baudrate, setBaudrate] = useState('BAUD_500K');
  
  // Network device specific state - load from localStorage for persistence
  const [networkHost, setNetworkHost] = useState(() => {
    return localStorage.getItem('networkDeviceHost') || '192.168.1.100';
  });
  const [networkPort, setNetworkPort] = useState(() => {
    return localStorage.getItem('networkDevicePort') || '8080';
  });

  // Bluetooth device specific state - load from localStorage for persistence
  const [bluetoothAddress, setBluetoothAddress] = useState(() => {
    return localStorage.getItem('bluetoothAddress') || '';
  });
  const [bluetoothChannel, setBluetoothChannel] = useState(() => {
    return localStorage.getItem('bluetoothChannel') || '1';
  });

  // Save network settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('networkDeviceHost', networkHost);
  }, [networkHost]);

  useEffect(() => {
    localStorage.setItem('networkDevicePort', networkPort);
  }, [networkPort]);

  // Save bluetooth settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('bluetoothAddress', bluetoothAddress);
  }, [bluetoothAddress]);

  useEffect(() => {
    localStorage.setItem('bluetoothChannel', bluetoothChannel);
  }, [bluetoothChannel]);

  // Register raw message callback for isolation feature
  useEffect(() => {
    if (!onRegisterRawCallback) return;
    
    const handleRawMessage = (message) => {
      // Only capture messages for isolated IDs
      if (isolatedIds.has(message.id)) {
        const newMessage = {
          ...message,
          sequenceNum: isolatedMessagesRef.current.length + 1,
          capturedAt: Date.now()
        };
        
        isolatedMessagesRef.current = [
          ...isolatedMessagesRef.current.slice(-MAX_ISOLATED_MESSAGES + 1),
          newMessage
        ];
        
        // Update state periodically (every 100ms is handled by the interval below)
      }
    };
    
    const unregister = onRegisterRawCallback(handleRawMessage);
    return () => unregister();
  }, [onRegisterRawCallback, isolatedIds]);
  
  // Update isolated messages state periodically for UI rendering
  useEffect(() => {
    if (isolatedIds.size === 0) return;
    
    const interval = setInterval(() => {
      if (isolatedMessagesRef.current.length !== isolatedMessages.length) {
        setIsolatedMessages([...isolatedMessagesRef.current]);
      }
    }, 100);
    
    return () => clearInterval(interval);
  }, [isolatedIds, isolatedMessages.length]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && isolationContentRef.current && isolatedMessages.length > 0) {
      isolationContentRef.current.scrollTop = isolationContentRef.current.scrollHeight;
    }
  }, [autoScroll, isolatedMessages.length]);

  // Filter devices by type
  const pcanDevices = devices.filter(d => d.device_type === 'pcan');
  const canableDevices = devices.filter(d => d.device_type === 'canable');
  const networkDevices = devices.filter(d => d.device_type === 'network');

  // Update channel when devices are loaded or device type changes
  useEffect(() => {
    console.log('[CANExplorer] Device type or devices changed:', { deviceType, devicesCount: devices.length });
    
    if (deviceType === 'canable') {
      const canable = devices.filter(d => d.device_type === 'canable');
      if (canable.length > 0) {
        const firstDevice = canable[0];
        const newChannel = `Device ${firstDevice.index}: ${firstDevice.description}`;
        console.log('[CANExplorer] Setting CANable channel to:', newChannel);
        setChannel(newChannel);
      }
    } else if (deviceType === 'pcan') {
      const pcan = devices.filter(d => d.device_type === 'pcan');
      if (pcan.length > 0) {
        console.log('[CANExplorer] Setting PCAN channel to:', pcan[0].name);
        setChannel(pcan[0].name);
      }
    }
    // Network device uses host:port fields, no channel selection needed
  }, [devices, deviceType]);

  // Messages are already aggregated by App.js with count and cycleTime
  // Filter and sort them
  const filteredMessages = useMemo(() => {
    let result = messages;
    
    // Apply filter
    if (filterText) {
      const filter = filterText.toLowerCase();
      result = result.filter(msg => {
        const idHex = msg.id.toString(16).toLowerCase();
        const dataHex = msg.data.map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
        const messageName = msg.decoded?.message_name?.toLowerCase() || '';
        
        return idHex.includes(filter) || dataHex.includes(filter) || messageName.includes(filter);
      });
    }
    
    // Apply sorting
    const sorted = [...result].sort((a, b) => {
      switch (sortOption) {
        case 'id-asc':
          return a.id - b.id;
        case 'id-desc':
          return b.id - a.id;
        case 'name-asc': {
          const nameA = a.decoded?.message_name || '';
          const nameB = b.decoded?.message_name || '';
          return nameA.localeCompare(nameB);
        }
        case 'name-desc': {
          const nameA = a.decoded?.message_name || '';
          const nameB = b.decoded?.message_name || '';
          return nameB.localeCompare(nameA);
        }
        default:
          return a.id - b.id;
      }
    });
    
    return sorted;
  }, [messages, filterText, sortOption]);

  // Download filtered messages as CSV
  const handleDownloadCSV = () => {
    if (filteredMessages.length === 0) {
      alert('No messages to download');
      return;
    }

    // Build CSV content
    const headers = ['ID (Hex)', 'ID (Dec)', 'Name', 'Data (Hex)', 'DLC', 'Count', 'Cycle Time (ms)', 'Timestamp', 'Extended'];
    
    // Add signal columns if any message has decoded signals
    const hasSignals = filteredMessages.some(msg => msg.decoded && Object.keys(msg.decoded.signals || {}).length > 0);
    if (hasSignals) {
      headers.push('Signals');
    }

    const rows = filteredMessages.map(msg => {
      const idHex = msg.is_extended 
        ? `0x${msg.id.toString(16).padStart(8, '0').toUpperCase()}`
        : `0x${msg.id.toString(16).padStart(3, '0').toUpperCase()}`;
      const dataHex = msg.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      const name = msg.decoded?.message_name || '';
      const cycleTime = msg.cycleTime ? (msg.cycleTime * 1000).toFixed(1) : '';
      const timestamp = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : '';
      
      const row = [
        idHex,
        msg.id,
        name,
        dataHex,
        msg.dlc || msg.data.length,
        msg.count || 0,
        cycleTime,
        timestamp,
        msg.is_extended ? 'Yes' : 'No'
      ];

      if (hasSignals) {
        // Format signals as "name=value unit; name2=value2 unit2"
        // Handles both network driver format (direct value) and local decoding format (object with value/unit)
        const signalsStr = msg.decoded?.signals 
          ? Object.entries(msg.decoded.signals)
              .map(([name, info]) => {
                const isObject = typeof info === 'object' && info !== null && !Array.isArray(info);
                const value = isObject ? info.value : info;
                const unit = isObject && info.unit ? ` ${info.unit}` : '';
                return `${name}=${value}${unit}`;
              })
              .join('; ')
          : '';
        row.push(signalsStr);
      }

      return row;
    });

    // Create CSV string
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => {
        // Escape cells that contain commas, quotes, or newlines
        const str = String(cell);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','))
    ].join('\n');

    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `can_messages_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleLoadDBC = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.dbc')) {
      alert('Please select a .dbc file');
      return;
    }

    try {
      await onLoadDBC(file);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      alert('Failed to upload DBC file: ' + error.message);
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const toggleRowExpansion = (msgId) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(msgId)) {
        newSet.delete(msgId);
      } else {
        newSet.add(msgId);
      }
      return newSet;
    });
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('en-US', { hour12: false });
  };

  const formatCycleTime = (cycleTime) => {
    if (!cycleTime) return '—';
    if (cycleTime < 1) {
      return `${(cycleTime * 1000).toFixed(0)} ms`;
    }
    return `${cycleTime.toFixed(3)} s`;
  };

  const formatData = (data) => {
    return data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  };

  // Message Isolation feature handlers
  const handleContextMenu = (event, message) => {
    event.preventDefault();
    setContextMenu({
      show: true,
      x: event.clientX,
      y: event.clientY,
      message: message
    });
  };

  const closeContextMenu = () => {
    setContextMenu({ show: false, x: 0, y: 0, message: null });
  };

  // Close context menu on click elsewhere
  useEffect(() => {
    const handleClick = () => closeContextMenu();
    if (contextMenu.show) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu.show]);

  const addIsolatedId = (id) => {
    setIsolatedIds(prev => {
      const newSet = new Set(prev);
      newSet.add(id);
      return newSet;
    });
    setIsolationPanelOpen(true);
    closeContextMenu();
  };

  const removeIsolatedId = (id) => {
    setIsolatedIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
    // Also remove messages for this ID
    isolatedMessagesRef.current = isolatedMessagesRef.current.filter(m => m.id !== id);
    setIsolatedMessages(prev => prev.filter(m => m.id !== id));
  };

  const clearIsolatedMessages = () => {
    isolatedMessagesRef.current = [];
    setIsolatedMessages([]);
  };

  const addCheckpoint = () => {
    // Use the timestamp from the last message, not computer time
    // This is important for network driver which delivers messages in batches
    const lastMessage = isolatedMessagesRef.current.filter(m => !m.isCheckpoint).slice(-1)[0];
    const timestamp = lastMessage ? lastMessage.timestamp : Date.now() / 1000;
    
    const checkpoint = {
      isCheckpoint: true,
      timestamp: timestamp,
      label: `Checkpoint ${isolatedMessagesRef.current.filter(m => m.isCheckpoint).length + 1}`
    };
    isolatedMessagesRef.current.push(checkpoint);
    setIsolatedMessages([...isolatedMessagesRef.current]);
  };

  const clearAllIsolations = () => {
    setIsolatedIds(new Set());
    isolatedMessagesRef.current = [];
    setIsolatedMessages([]);
    setIsolationPanelOpen(false);
  };

  const exportIsolatedMessagesCSV = () => {
    // Filter out checkpoints - only export actual messages
    let messagesToExport = isolatedMessages.filter(msg => !msg.isCheckpoint);
    
    // Apply duplicate filtering if hideDuplicates is enabled (same logic as display)
    if (hideDuplicates) {
      messagesToExport = messagesToExport.filter((msg, index, arr) => {
        // Find previous message with the SAME CAN ID
        let prevMsgSameId = null;
        for (let i = index - 1; i >= 0; i--) {
          if (arr[i].id === msg.id) {
            prevMsgSameId = arr[i];
            break;
          }
        }
        
        if (!prevMsgSameId) return true; // No previous message with same ID, keep it
        
        const changedBytes = getChangedBytes(msg.data, prevMsgSameId.data);
        const changedSignals = getChangedSignals(
          msg.decoded?.signals, 
          prevMsgSameId.decoded?.signals
        );
        const hasChanges = changedBytes.size > 0 || changedSignals.size > 0;
        const deltaTimeSameId = (msg.timestamp - prevMsgSameId.timestamp) * 1000;
        
        // Keep if it has changes OR time delta is >= threshold
        return hasChanges || deltaTimeSameId >= DUPLICATE_TIME_THRESHOLD_MS;
      });
    }
    
    if (messagesToExport.length === 0) {
      alert('No messages to export');
      return;
    }
    
    // Build CSV header
    const headers = ['Sequence', 'Timestamp', 'Delta (ms)', 'CAN ID', 'Extended', 'DLC', 'Raw Data (Hex)', 'Message Name'];
    
    // Collect all unique signal names across all messages for columns
    const allSignalNames = new Set();
    messagesToExport.forEach(msg => {
      if (msg.decoded?.signals) {
        Object.keys(msg.decoded.signals).forEach(name => allSignalNames.add(name));
      }
    });
    const signalNames = Array.from(allSignalNames).sort();
    signalNames.forEach(name => headers.push(name));
    
    // Build CSV rows
    const rows = messagesToExport.map((msg, index) => {
      // Calculate delta time from previous message (same logic as display)
      const prevMsg = index > 0 ? messagesToExport[index - 1] : null;
      const deltaTime = prevMsg ? (msg.timestamp - prevMsg.timestamp) * 1000 : 0; // in ms
      
      const row = [
        index + 1, // Use sequential index, not original sequenceNum
        formatIsolationTimestamp(msg.timestamp),
        deltaTime.toFixed(3),
        msg.is_extended 
          ? `0x${msg.id.toString(16).padStart(8, '0').toUpperCase()}`
          : `0x${msg.id.toString(16).padStart(3, '0').toUpperCase()}`,
        msg.is_extended ? 'Yes' : 'No',
        msg.data.length,
        msg.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
        msg.decoded?.message_name || ''
      ];
      
      // Add signal values
      signalNames.forEach(name => {
        if (msg.decoded?.signals && msg.decoded.signals[name] !== undefined) {
          const sig = msg.decoded.signals[name];
          // Handle both object format {value, unit} and simple value format
          const value = typeof sig === 'object' ? sig.value : sig;
          const unit = typeof sig === 'object' ? (sig.unit || '') : '';
          row.push(unit ? `${value} ${unit}` : value);
        } else {
          row.push('');
        }
      });
      
      return row;
    });
    
    // Escape CSV values
    const escapeCSV = (val) => {
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    
    // Build CSV content
    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');
    
    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ids = Array.from(isolatedIds).map(id => id.toString(16).toUpperCase()).join('_');
    link.download = `can_isolated_${ids}_${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const formatIsolationTimestamp = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + date.getMilliseconds().toString().padStart(3, '0');
  };

  // Helper to compare two messages and find changed bytes/signals
  const getChangedBytes = (currentData, prevData) => {
    if (!prevData) return new Set();
    const changed = new Set();
    for (let i = 0; i < currentData.length; i++) {
      if (currentData[i] !== prevData[i]) {
        changed.add(i);
      }
    }
    return changed;
  };

  const getChangedSignals = (currentSignals, prevSignals) => {
    if (!prevSignals || !currentSignals) return new Set();
    const changed = new Set();
    for (const [key, value] of Object.entries(currentSignals)) {
      const currentVal = typeof value === 'object' ? value.value : value;
      const prevVal = prevSignals[key];
      const prevValNum = typeof prevVal === 'object' ? prevVal?.value : prevVal;
      if (currentVal !== prevValNum) {
        changed.add(key);
      }
    }
    return changed;
  };

  // Group isolated messages by ID for the full-screen view
  const groupedIsolatedMessages = useMemo(() => {
    const groups = new Map();
    isolatedMessages.forEach(msg => {
      if (!groups.has(msg.id)) {
        groups.set(msg.id, []);
      }
      groups.get(msg.id).push(msg);
    });
    return groups;
  }, [isolatedMessages]);

  const handleConnectClick = async () => {
    console.log('[CANExplorer] Connect button clicked:', { connected, deviceType, channel, baudrate });
    
    try {
      if (connected) {
        console.log('[CANExplorer] Attempting to disconnect...');
        await onDisconnect();
      } else {
        console.log('[CANExplorer] Attempting to connect...');
        
        // Handle channel based on device type
        let channelToSend = channel;
        
        if (deviceType === 'network') {
          // Network device - combine host and port
          channelToSend = `${networkHost}:${networkPort}`;
          console.log('[CANExplorer] Network channel:', channelToSend);
        } else if (deviceType === 'bluetooth') {
          // Bluetooth device - combine address and RFCOMM channel
          channelToSend = `${bluetoothAddress}:${bluetoothChannel}`;
          console.log('[CANExplorer] Bluetooth channel:', channelToSend);
        } else if (deviceType === 'canable') {
          // For CANable, extract device index from "Device X: Description" format
          if (typeof channel === 'string' && channel.startsWith('Device ')) {
            try {
              const parts = channel.split(':')[0].split(' ');
              channelToSend = parts[1]; // Extract just the number
              console.log('[CANExplorer] Parsed CANable channel:', channelToSend);
            } catch (e) {
              console.error('[CANExplorer] Failed to parse CANable channel:', e);
              alert('Invalid channel format. Please select a device.');
              return;
            }
          } else {
            // Extract digits only
            channelToSend = channel.replace(/\D/g, '');
            if (!channelToSend) {
              alert('Invalid channel. Please select a CANable device.');
              return;
            }
          }
        }
        
        console.log('[CANExplorer] Connecting with:', { deviceType, channelToSend, baudrate });
        const result = await onConnect(deviceType, channelToSend, baudrate);
        console.log('[CANExplorer] Connection result:', result);
      }
    } catch (error) {
      console.error('[CANExplorer] Connection error:', error);
      alert('Connection failed: ' + error.message);
    }
  };

  const formatUptime = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="can-explorer-layout">
      {/* Sidebar Toggle Button */}
      <button 
        className="sidebar-toggle"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      >
        {sidebarCollapsed ? <PanelLeft size={20} /> : <PanelLeftClose size={20} />}
      </button>

      {/* Sidebar for ALL controls */}
      <div className={`can-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        {/* App Header */}
        <div className="sidebar-section app-header">
          <div className="app-title">
            <img src="/logo.png" alt="TREV Logo" className="app-logo" />
            <div>
              <h1>TREV Explorer</h1>
              <span className="app-subtitle">TREV4 CAN Viewer</span>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="sidebar-section">
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${activeTab === 'explorer' ? 'active' : ''}`}
              onClick={() => onTabChange('explorer')}
            >
              CAN Explorer
            </button>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">BMS</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'bms-overview' ? 'active' : ''}`}
                onClick={() => onTabChange('bms-overview')}
              >
                Overview
              </button>
              <button
                className={`sidebar-tab submenu ${activeTab === 'bms-status' ? 'active' : ''}`}
                onClick={() => onTabChange('bms-status')}
              >
                Status Dashboard
              </button>
              <button
                className={`sidebar-tab submenu ${activeTab === 'module-config' ? 'active' : ''}`}
                onClick={() => onTabChange('module-config')}
              >
                Module Config
              </button>
            </div>
          </div>
        </div>

        {/* Connection Panel */}
        <div className="sidebar-section">
          <div className="sidebar-header collapsible" onClick={() => setConnectionExpanded(!connectionExpanded)}>
            {connectionExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
            <span>Connection</span>
          </div>
          
          {connectionExpanded && <div className="connection-form">
            <div className="form-group">
              <label>Device Type</label>
              <select 
                value={deviceType} 
                onChange={(e) => {
                  const newDeviceType = e.target.value;
                  setDeviceType(newDeviceType);
                  
                  // Update channel when device type changes
                  if (newDeviceType === 'pcan') {
                    const pcan = devices.filter(d => d.device_type === 'pcan');
                    if (pcan.length > 0) {
                      setChannel(pcan[0].name);
                    } else {
                      setChannel('USB1');
                    }
                  } else if (newDeviceType === 'canable') {
                    const canable = devices.filter(d => d.device_type === 'canable');
                    if (canable.length > 0) {
                      const firstDevice = canable[0];
                      setChannel(`Device ${firstDevice.index}: ${firstDevice.description}`);
                    } else {
                      setChannel('Device 0');
                    }
                  } else if (newDeviceType === 'bluetooth') {
                    // Check for paired Bluetooth devices - use first one if available
                    const btDevices = devices.filter(d => d.device_type === 'bluetooth' && d.name !== 'Bluetooth CAN Server');
                    if (btDevices.length > 0 && btDevices[0].name.includes(':')) {
                      setBluetoothAddress(btDevices[0].name);
                    }
                  }
                  // Network/Bluetooth devices use their own input fields, no channel needed
                }}
                disabled={connected}
              >
                <option value="pcan">PCAN-USB</option>
                <option value="canable">CANable</option>
                <option value="network">Network</option>
                <option value="bluetooth">Bluetooth</option>
              </select>
            </div>

            {deviceType === 'network' ? (
              <div className="form-group">
                <label>Server Address</label>
                <div className="network-address-input">
                  <input
                    type="text"
                    className="network-host"
                    value={networkHost}
                    onChange={(e) => setNetworkHost(e.target.value)}
                    placeholder="IP Address"
                    disabled={connected}
                  />
                  <span className="network-separator">:</span>
                  <input
                    type="text"
                    className="network-port"
                    value={networkPort}
                    onChange={(e) => setNetworkPort(e.target.value)}
                    placeholder="Port"
                    disabled={connected}
                  />
                </div>
              </div>
            ) : deviceType === 'bluetooth' ? (
              <div className="form-group">
                <label>Bluetooth Device</label>
                {(() => {
                  const btDevices = devices.filter(d => d.device_type === 'bluetooth' && d.name !== 'Bluetooth CAN Server');
                  return btDevices.length > 0 ? (
                    <select
                      className="bluetooth-device-select"
                      value={bluetoothAddress}
                      onChange={(e) => setBluetoothAddress(e.target.value)}
                      disabled={connected}
                    >
                      <option value="">-- Select device --</option>
                      {btDevices.map(device => (
                        <option key={device.name} value={device.name}>
                          {device.description}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="bluetooth-address"
                      value={bluetoothAddress}
                      onChange={(e) => setBluetoothAddress(e.target.value.toUpperCase())}
                      placeholder="XX:XX:XX:XX:XX:XX"
                      disabled={connected}
                    />
                  );
                })()}
                <div className="bluetooth-channel-row">
                  <label>RFCOMM Channel</label>
                  <input
                    type="number"
                    className="bluetooth-channel"
                    value={bluetoothChannel}
                    onChange={(e) => setBluetoothChannel(e.target.value)}
                    min="1"
                    max="30"
                    placeholder="1"
                    disabled={connected}
                  />
                </div>
              </div>
            ) : (
              <div className="form-group">
                <label>Channel</label>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  disabled={connected}
                >
                  {deviceType === 'pcan' ? (
                    pcanDevices.length > 0 ? (
                      pcanDevices.map(device => (
                        <option key={device.name} value={device.name}>
                          {device.name} {device.occupied && '(Occupied)'}
                        </option>
                      ))
                    ) : (
                      <option value="USB1">USB1</option>
                    )
                  ) : (
                    canableDevices.length > 0 ? (
                      canableDevices.map(device => {
                        const fullName = `Device ${device.index}: ${device.description}`;
                        return (
                          <option key={device.index} value={fullName}>
                            {fullName}
                          </option>
                        );
                      })
                    ) : (
                      <option value="Device 0">Device 0</option>
                    )
                  )}
                </select>
              </div>
            )}

            <div className="form-group">
              <label>Baudrate</label>
              <select
                value={baudrate}
                onChange={(e) => setBaudrate(e.target.value)}
                disabled={connected}
              >
                <option value="BAUD_1M">1 Mbit/s</option>
                <option value="BAUD_500K">500 kbit/s</option>
                <option value="BAUD_250K">250 kbit/s</option>
                <option value="BAUD_125K">125 kbit/s</option>
              </select>
            </div>

            <button
              className={`btn btn-block ${connected ? 'btn-danger' : 'btn-primary'}`}
              onClick={handleConnectClick}
            >
              {connected ? 'Disconnect' : 'Connect'}
            </button>

            <button
              className="btn btn-secondary btn-block"
              onClick={onRefreshDevices}
              disabled={connected}
            >
              <RefreshCw size={16} />
              Refresh Devices
            </button>

            {connected && (
              <div className="connection-info">
                <div className="info-row">
                  <span className="info-label">Device:</span>
                  <span className="info-value">{connectionStatus.device_type?.toUpperCase()}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Channel:</span>
                  <span className="info-value">{connectionStatus.channel}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Messages:</span>
                  <span className="info-value">{stats.message_count}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Rate:</span>
                  <span className="info-value">{stats.message_rate} msg/s</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Uptime:</span>
                  <span className="info-value">{formatUptime(stats.uptime_seconds)}</span>
                </div>
              </div>
            )}
          </div>}
        </div>

        {/* DBC Upload */}
        <div className="sidebar-section">
          <div className="sidebar-header collapsible" onClick={() => setDbcExpanded(!dbcExpanded)}>
            {dbcExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <FileText size={18} />
            <span>DBC File</span>
          </div>
          {dbcExpanded && <><button className="btn btn-secondary btn-block" onClick={handleUploadClick}>
            <Upload size={16} />
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dbc"
            onChange={handleLoadDBC}
            style={{ display: 'none' }}
          />
          {dbcLoaded ? (
            <div className="sidebar-status success">
              ✓ {dbcFile || 'Loaded'}
            </div>
          ) : (
            <div className="sidebar-status">
              No file loaded
            </div>
          )}</>}
        </div>

        {/* Filter */}
        <div className="sidebar-section">
          <div className="sidebar-header collapsible" onClick={() => setFilterExpanded(!filterExpanded)}>
            {filterExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <Filter size={18} />
            <span>Filter</span>
          </div>
          {filterExpanded && <input
            type="text"
            placeholder="ID or data..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="filter-input-sidebar"
          />}
        </div>
      </div>

      {/* Main content area - Message table or custom content */}
      <div className="can-main-content">
        {children ? (
          // Render custom content (like ThermistorMonitor or CellVoltageMonitor)
          children
        ) : (
          // Default: Render collapsible sections for Received Messages and Transmit List
          <>
            {/* Received Messages Section */}
            <div className="collapsible-section">
              <div 
                className="collapsible-header"
                onClick={() => setExpandedReceivedMessages(!expandedReceivedMessages)}
              >
                <div className="collapsible-title">
                  {expandedReceivedMessages ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span>Received Messages ({filteredMessages.length})</span>
                </div>
                {expandedReceivedMessages && (
                  <div className="header-buttons">
                    <div className="sort-dropdown" onClick={(e) => e.stopPropagation()}>
                      <label>Sort:</label>
                      <select 
                        value={sortOption} 
                        onChange={(e) => setSortOption(e.target.value)}
                        className="sort-select"
                      >
                        <option value="id-asc">ID (Ascending)</option>
                        <option value="id-desc">ID (Descending)</option>
                        <option value="name-asc">Name (A-Z)</option>
                        <option value="name-desc">Name (Z-A)</option>
                      </select>
                    </div>
                    <button 
                      className="btn btn-secondary btn-sm" 
                      onClick={(e) => { e.stopPropagation(); handleDownloadCSV(); }}
                      title="Download as CSV"
                    >
                      <Download size={16} />
                      Save CSV
                    </button>
                    <button 
                      className="btn btn-danger btn-sm" 
                      onClick={(e) => { e.stopPropagation(); onClearMessages(); }}
                    >
                      <Trash2 size={16} />
                      Clear All
                    </button>
                  </div>
                )}
              </div>

              {expandedReceivedMessages && (
                <div className="collapsible-content">
                  <div className="table-container-full">
              <table className="messages-table">
                <thead>
                  <tr>
                    <th style={{ width: '20px' }}></th>
                    <th style={{ width: '75px' }}>ID</th>
                    <th>Name</th>
                    <th style={{ width: '140px' }}>Data</th>
                    <th style={{ width: '50px' }}>Cnt</th>
                    <th style={{ width: '70px' }}>Cycle</th>
                    <th style={{ width: '70px' }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMessages.length === 0 ? (
                    <tr>
                      <td colSpan="7" style={{ textAlign: 'center', padding: '40px', color: '#a0aec0' }}>
                        {messages.length === 0 ? 'No messages received yet' : 'No messages match filter'}
                      </td>
                    </tr>
                  ) : (
                    filteredMessages.map((msg, index) => {
                      const rowKey = `${msg.id}-${index}`;
                      const isExpanded = expandedRows.has(rowKey);
                      const hasSignals = msg.decoded && Object.keys(msg.decoded.signals).length > 0;
                      
                      return (
                        <React.Fragment key={rowKey}>
                          <tr 
                            className={`message-row ${hasSignals ? 'clickable' : ''} ${isolatedIds.has(msg.id) ? 'isolated' : ''}`}
                            onClick={() => hasSignals && toggleRowExpansion(rowKey)}
                            onContextMenu={(e) => handleContextMenu(e, msg)}
                          >
                            <td>
                              {hasSignals && (
                                <span className="expand-icon">
                                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </span>
                              )}
                            </td>
                            <td>
                              <span className="hex-data">
                                {msg.is_extended ? `0x${msg.id.toString(16).padStart(8, '0').toUpperCase()}` : `0x${msg.id.toString(16).padStart(3, '0').toUpperCase()}`}
                              </span>
                            </td>
                            <td>
                              {msg.decoded ? (
                                <span className="message-name">{msg.decoded.message_name}</span>
                              ) : (
                                <span style={{ color: '#a0aec0' }}>No DBC</span>
                              )}
                            </td>
                            <td><span className="hex-data-small">{formatData(msg.data)}</span></td>
                            <td>
                              <span className="badge badge-info">{msg.count}</span>
                            </td>
                            <td>{formatCycleTime(msg.cycleTime)}</td>
                            <td>{formatTimestamp(msg.timestamp)}</td>
                          </tr>
                          
                          {/* Expanded row showing all signals */}
                          {isExpanded && hasSignals && (
                            <tr className="expanded-row">
                              <td></td>
                              <td colSpan="6">
                                <div className="signals-container">
                                  <table className="signals-table">
                                    <thead>
                                      <tr>
                                        <th>Signal Name</th>
                                        <th>Value</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {Object.entries(msg.decoded.signals).map(([key, signalData]) => {
                                        // Handle both old format (plain value) and new format (object with metadata)
                                        const isObject = typeof signalData === 'object' && signalData !== null && !Array.isArray(signalData);
                                        const value = isObject ? signalData.value : signalData;
                                        const unit = isObject ? signalData.unit : null;
                                        const raw = isObject ? signalData.raw : null;
                                        
                                        // Format the display value
                                        let displayValue;
                                        if (typeof value === 'number') {
                                          displayValue = value.toFixed(3);
                                        } else {
                                          displayValue = value;
                                        }
                                        
                                        // Add unit if available
                                        if (unit) {
                                          displayValue = `${displayValue} ${unit}`;
                                        }
                                        
                                        // For enums, show both name and raw value
                                        if (typeof value === 'string' && raw !== null && raw !== undefined) {
                                          displayValue = `${value} (${raw})`;
                                        }
                                        
                                        return (
                                          <tr key={key}>
                                            <td className="signal-name">{key}</td>
                                            <td className="signal-value">{displayValue}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
                  </div>
                </div>
              )}
            </div>

            {/* Transmit List Section */}
            <div className="collapsible-section">
              <div 
                className="collapsible-header"
                onClick={() => setExpandedTransmitList(!expandedTransmitList)}
              >
                <div className="collapsible-title">
                  {expandedTransmitList ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <span>Transmit List</span>
                </div>
              </div>

              {expandedTransmitList && (
                <div className="collapsible-content transmit-list-container">
                  <TransmitList 
                    dbcFile={dbcFile}
                    onSendMessage={onSendMessage}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Context Menu for Message Isolation */}
      {contextMenu.show && (
        <div 
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {!isolatedIds.has(contextMenu.message?.id) ? (
            <button 
              className="context-menu-item"
              onClick={() => addIsolatedId(contextMenu.message?.id)}
            >
              <Eye size={14} />
              <span>Isolate ID: 0x{contextMenu.message?.id.toString(16).toUpperCase()}</span>
            </button>
          ) : (
            <button 
              className="context-menu-item"
              onClick={() => removeIsolatedId(contextMenu.message?.id)}
            >
              <EyeOff size={14} />
              <span>Stop Isolating 0x{contextMenu.message?.id.toString(16).toUpperCase()}</span>
            </button>
          )}
          {isolatedIds.size > 0 && (
            <button 
              className="context-menu-item"
              onClick={() => setIsolationPanelOpen(true)}
            >
              <List size={14} />
              <span>Open Isolation View</span>
            </button>
          )}
        </div>
      )}

      {/* Full-Screen Message Isolation View */}
      {isolationPanelOpen && (
        <div className="isolation-fullscreen">
          <div className="isolation-fullscreen-header">
            <div className="isolation-header-left">
              <Eye size={22} />
              <h2>Message Isolation View</h2>
              <span className="isolation-count">{isolatedMessages.length} messages captured</span>
            </div>
            <div className="isolation-header-right">
              {/* Isolated IDs Tags */}
              <div className="isolation-tags-inline">
                {Array.from(isolatedIds).map(id => {
                  const msg = messages.find(m => m.id === id);
                  const name = msg?.decoded?.message_name;
                  return (
                    <div key={id} className="isolation-tag">
                      <span className="isolation-tag-id">0x{id.toString(16).toUpperCase()}</span>
                      {name && <span className="isolation-tag-name">{name}</span>}
                      <button 
                        className="isolation-tag-remove"
                        onClick={() => removeIsolatedId(id)}
                        title="Stop isolating this ID"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="isolation-header-actions">
                <label className="isolation-autoscroll-toggle" title="Auto-scroll to latest message">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                  />
                  <span>Auto-scroll</span>
                </label>
                <label className="isolation-autoscroll-toggle" title="Hide duplicate messages (same data within 1ms)">
                  <input
                    type="checkbox"
                    checked={hideDuplicates}
                    onChange={(e) => setHideDuplicates(e.target.checked)}
                  />
                  <span>Hide duplicates</span>
                </label>
                <button 
                  className="btn btn-checkpoint btn-sm"
                  onClick={addCheckpoint}
                  title="Add a visual checkpoint marker"
                >
                  <Flag size={14} />
                  Checkpoint
                </button>
                <button 
                  className="btn btn-export btn-sm"
                  onClick={exportIsolatedMessagesCSV}
                  title="Export messages to CSV file"
                  disabled={isolatedMessages.filter(m => !m.isCheckpoint).length === 0}
                >
                  <Download size={14} />
                  Export CSV
                </button>
                <button 
                  className="btn btn-secondary btn-sm"
                  onClick={clearIsolatedMessages}
                  title="Clear captured messages"
                >
                  <Trash2 size={14} />
                  Clear Messages
                </button>
                <button 
                  className="btn btn-danger btn-sm"
                  onClick={clearAllIsolations}
                  title="Stop all isolations and close"
                >
                  <X size={14} />
                  Clear All
                </button>
                <button 
                  className="btn btn-primary btn-sm"
                  onClick={() => setIsolationPanelOpen(false)}
                  title="Return to CAN Explorer"
                >
                  <ChevronLeft size={14} />
                  Back
                </button>
              </div>
            </div>
          </div>
          
          <div className="isolation-fullscreen-content" ref={isolationContentRef}>
            {isolatedMessages.length === 0 ? (
              <div className="isolation-empty-state">
                <Eye size={48} />
                <h3>{isolatedIds.size === 0 ? 'No IDs Selected' : 'Waiting for Messages...'}</h3>
                <p>
                  {isolatedIds.size === 0 
                    ? 'Right-click on a message in the CAN Explorer to isolate its ID'
                    : 'Messages for the selected IDs will appear here in sequential order'}
                </p>
              </div>
            ) : (
              <div className="isolation-messages-list">
                {(() => {
                  let displayIndex = 0;
                  return isolatedMessages.map((msg, index) => {
                  // Handle checkpoint markers
                  if (msg.isCheckpoint) {
                    return (
                      <div key={`checkpoint-${index}`} className="isolation-checkpoint">
                        <div className="isolation-checkpoint-line"></div>
                        <div className="isolation-checkpoint-label">
                          <Flag size={12} />
                          <span>{msg.label}</span>
                          <span className="isolation-checkpoint-time">
                            {formatIsolationTimestamp(msg.timestamp)}
                          </span>
                        </div>
                        <div className="isolation-checkpoint-line"></div>
                      </div>
                    );
                  }
                  
                  // Find previous non-checkpoint message (any ID) for delta time calculation
                  let prevMsg = null;
                  for (let i = index - 1; i >= 0; i--) {
                    if (!isolatedMessages[i].isCheckpoint) {
                      prevMsg = isolatedMessages[i];
                      break;
                    }
                  }
                  
                  // Find previous non-checkpoint message with the SAME CAN ID for change/duplicate detection
                  let prevMsgSameId = null;
                  for (let i = index - 1; i >= 0; i--) {
                    if (!isolatedMessages[i].isCheckpoint && isolatedMessages[i].id === msg.id) {
                      prevMsgSameId = isolatedMessages[i];
                      break;
                    }
                  }
                  
                  const changedBytes = getChangedBytes(msg.data, prevMsgSameId?.data);
                  const changedSignals = getChangedSignals(
                    msg.decoded?.signals, 
                    prevMsgSameId?.decoded?.signals
                  );
                  const hasChanges = changedBytes.size > 0 || changedSignals.size > 0;
                  
                  // Calculate delta time from previous message with SAME ID for duplicate detection
                  const deltaTimeSameId = prevMsgSameId ? (msg.timestamp - prevMsgSameId.timestamp) * 1000 : null;
                  
                  // Calculate delta time from previous message (any ID) for display
                  const deltaTime = prevMsg ? (msg.timestamp - prevMsg.timestamp) * 1000 : null; // in ms
                  const deltaTimeStr = deltaTime !== null 
                    ? deltaTime < 1 
                      ? `+${(deltaTime * 1000).toFixed(0)}µs`
                      : deltaTime < 1000 
                        ? `+${deltaTime.toFixed(2)}ms`
                        : `+${(deltaTime / 1000).toFixed(3)}s`
                    : '';
                  
                  // Check if this is a duplicate (same ID, same data, tiny time delta between same-ID messages)
                  const isDuplicate = prevMsgSameId && 
                    !hasChanges && 
                    deltaTimeSameId !== null && 
                    deltaTimeSameId < DUPLICATE_TIME_THRESHOLD_MS;
                  
                  // Skip rendering if hideDuplicates is enabled and this is a duplicate
                  if (hideDuplicates && isDuplicate) {
                    return null;
                  }
                  
                  // Increment display index for non-duplicate messages
                  displayIndex++;
                  
                  return (
                    <div 
                      key={`${msg.id}-${msg.sequenceNum}-${index}`} 
                      className={`isolation-message-card ${hasChanges ? 'has-changes' : ''}`}
                    >
                      <div className="isolation-card-header">
                        <div className="isolation-card-meta">
                          <span className="isolation-seq">#{displayIndex}</span>
                          <span className="isolation-id">
                            {msg.is_extended 
                              ? `0x${msg.id.toString(16).padStart(8, '0').toUpperCase()}` 
                              : `0x${msg.id.toString(16).padStart(3, '0').toUpperCase()}`}
                          </span>
                          {msg.decoded?.message_name && (
                            <span className="isolation-name">{msg.decoded.message_name}</span>
                          )}
                        </div>
                        <div className="isolation-time-group">
                          {deltaTimeStr && <span className="isolation-delta">{deltaTimeStr}</span>}
                          <span className="isolation-time">{formatIsolationTimestamp(msg.timestamp)}</span>
                        </div>
                      </div>
                      
                      <div className="isolation-card-body">
                        {/* Raw Data Section */}
                        <div className="isolation-section">
                          <div className="isolation-section-header">
                            <span>Raw Data</span>
                            <span className="isolation-dlc">DLC: {msg.dlc || msg.data.length}</span>
                          </div>
                          <div className="isolation-raw-data">
                            {msg.data.map((byte, byteIndex) => (
                              <span 
                                key={byteIndex} 
                                className={`isolation-byte ${changedBytes.has(byteIndex) ? 'changed' : ''}`}
                                title={`Byte ${byteIndex}: ${byte} (0x${byte.toString(16).padStart(2, '0').toUpperCase()})`}
                              >
                                {byte.toString(16).padStart(2, '0').toUpperCase()}
                              </span>
                            ))}
                          </div>
                          {/* Binary representation */}
                          <div className="isolation-binary-row">
                            {msg.data.map((byte, byteIndex) => (
                              <span 
                                key={byteIndex} 
                                className={`isolation-binary ${changedBytes.has(byteIndex) ? 'changed' : ''}`}
                              >
                                {byte.toString(2).padStart(8, '0')}
                              </span>
                            ))}
                          </div>
                        </div>
                        
                        {/* Decoded Signals Section */}
                        {msg.decoded?.signals && Object.keys(msg.decoded.signals).length > 0 && (
                          <div className="isolation-section">
                            <div className="isolation-section-header">
                              <span>Decoded Signals</span>
                              <span className="isolation-signal-count">
                                {Object.keys(msg.decoded.signals).length} signals
                              </span>
                            </div>
                            <div className="isolation-signals-grid">
                              {Object.entries(msg.decoded.signals).map(([signalName, signalData]) => {
                                const isObject = typeof signalData === 'object' && signalData !== null;
                                const value = isObject ? signalData.value : signalData;
                                const unit = isObject ? signalData.unit : null;
                                const raw = isObject ? signalData.raw : null;
                                const isChanged = changedSignals.has(signalName);
                                
                                let displayValue;
                                if (typeof value === 'number') {
                                  displayValue = Number.isInteger(value) ? value : value.toFixed(3);
                                } else {
                                  displayValue = value;
                                }
                                
                                return (
                                  <div 
                                    key={signalName} 
                                    className={`isolation-signal ${isChanged ? 'changed' : ''}`}
                                  >
                                    <span className="isolation-signal-name">{signalName}</span>
                                    <span className="isolation-signal-value">
                                      {displayValue}
                                      {unit && <span className="isolation-signal-unit">{unit}</span>}
                                      {typeof value === 'string' && raw !== null && raw !== undefined && (
                                        <span className="isolation-signal-raw">({raw})</span>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                });
                })()}
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Floating button to open isolation view when closed */}
      {!isolationPanelOpen && isolatedIds.size > 0 && (
        <button 
          className="isolation-floating-btn"
          onClick={() => setIsolationPanelOpen(true)}
          title={`${isolatedIds.size} isolated ID(s) - Click to open view`}
        >
          <Eye size={18} />
          <span className="isolation-badge">{isolatedIds.size}</span>
        </button>
      )}
    </div>
  );
}

export default CANExplorer;
