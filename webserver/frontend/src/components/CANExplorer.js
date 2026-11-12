import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Trash2, FileText, Filter, Upload, ChevronDown, ChevronRight, ChevronLeft, Activity, Wifi, WifiOff, RefreshCw, List, PanelLeftClose, PanelLeft, Download, X, Eye, EyeOff, Flag, ArrowUp, ArrowDown, GripVertical, Settings as SettingsIcon } from 'lucide-react';
import TransmitList from './TransmitList';
import './CANExplorer.css';

const BUS_IDS = ['bus1', 'bus2'];
const VCU_LOG_EVENT_FLAG_CAN_ID = 2366639360;
const VCU_LOG_EVENT_FLAG_INTERVAL_MS = 10;
const VCU_LOG_EVENT_FLAG_DURATION_MS = 1000;

const getPreferredSocketCanInterface = (busId) => (busId === 'bus2' ? 'can1' : 'can0');

const formatCanableChannelOption = (device) => `Device ${device.index}: ${device.description}`;

const readStoredValue = (key, fallback) => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  return window.localStorage.getItem(key) || fallback;
};

const parseEventFlagValue = (rawValue) => {
  const text = String(rawValue || '').trim();
  if (!text) return null;

  const parsed = /^0x/i.test(text)
    ? parseInt(text.slice(2), 16)
    : Number(text);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xFFFFFFFF) {
    return null;
  }

  return parsed >>> 0;
};

const encodeEventFlagData = (value) => [
  value & 0xFF,
  (value >>> 8) & 0xFF,
  (value >>> 16) & 0xFF,
  (value >>> 24) & 0xFF,
  0,
  0,
  0,
  0,
];

const formatEventFlagValue = (value) => `${value} / 0x${value.toString(16).padStart(8, '0').toUpperCase()}`;

const createInitialConnectionDraft = (busId) => ({
  deviceType: 'canable',
  channel: busId === 'bus2' ? 'Device 1' : 'Device 0',
  baudrate: 'BAUD_500K',
  networkHost: readStoredValue(`${busId}:networkDeviceHost`, '192.168.1.100'),
  networkPort: readStoredValue(`${busId}:networkDevicePort`, '8080'),
  bluetoothAddress: readStoredValue(`${busId}:bluetoothAddress`, ''),
  bluetoothChannel: readStoredValue(`${busId}:bluetoothChannel`, '1'),
});

const getBusLabel = (busId) => {
  if (busId === 'bus2') {
    return 'Bus 2';
  }
  if (busId === 'bus1') {
    return 'Bus 1';
  }
  return busId ? String(busId).toUpperCase() : 'Bus 1';
};

const getBusToneClass = (busId) => (busId === 'bus2' ? 'bus-bus2' : 'bus-bus1');

const formatCanId = (message) => (
  message.is_extended
    ? `0x${message.id.toString(16).padStart(8, '0').toUpperCase()}`
    : `0x${message.id.toString(16).padStart(3, '0').toUpperCase()}`
);

const getMessageIdentityKey = (message) => `${message.bus_id || 'bus1'}:${message.is_extended ? 'ext' : 'std'}:${message.id}`;

const parseMessageIdentityKey = (identityKey) => {
  const [busId, frameType, idText] = String(identityKey).split(':');
  return {
    busId: busId || 'bus1',
    isExtended: frameType === 'ext',
    id: Number(idText),
  };
};

function CANExplorer({ 
  connected, 
  messages, 
  onClearMessages, 
  onSendMessage, 
  onLoadDBC, 
  onUpdateDBCConfig,
  onDeleteDBC,
  dbcLoaded, 
  dbcFile,
  dbcFiles,
  dbcContext,
  devices,
  onConnect,
  onDisconnect,
  onRefreshDevices,
  connectionStatus,
  stats,
  activeTab,
  onTabChange,
  onRegisterRawCallback,
  simulationActive,
  onStartSimulation,
  onStopSimulation,
  staleTimeoutMs,
  staleMessagesEnabled = true,
  onStaleMessagesEnabledChange,
  onStaleTimeoutChange,
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
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [staleTimeoutInput, setStaleTimeoutInput] = useState(() =>
    String(Math.round((staleTimeoutMs ?? 30000) / 1000))
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [draggedDbcFile, setDraggedDbcFile] = useState(null);
  const fileInputRef = useRef(null);
  
  // Message Isolation feature state
  const [isolatedIds, setIsolatedIds] = useState(new Set());
  const [isolatedMessages, setIsolatedMessages] = useState([]);
  const [isolationPanelOpen, setIsolationPanelOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0, message: null });
  const [autoScroll, setAutoScroll] = useState(true);
  const [hideDuplicates, setHideDuplicates] = useState(false);
  const [isRecordingTrace, setIsRecordingTrace] = useState(false);
  const [traceMessageCount, setTraceMessageCount] = useState(0);
  const isolatedMessagesRef = useRef([]);
  const isolationContentRef = useRef(null);
  const traceMessagesRef = useRef([]);
  const MAX_ISOLATED_MESSAGES = 1000; // Limit to prevent memory issues
  const DUPLICATE_TIME_THRESHOLD_MS = 1; // Messages within 1ms with same data are duplicates
  
  const [connectionDrafts, setConnectionDrafts] = useState(() => ({
    bus1: createInitialConnectionDraft('bus1'),
    bus2: createInitialConnectionDraft('bus2'),
  }));
  const [selectedTransmitBusId, setSelectedTransmitBusId] = useState(() => readStoredValue('selectedTransmitBusId', 'bus1'));
  const [eventFlagStatus, setEventFlagStatus] = useState(null);
  const [eventFlagBurstActive, setEventFlagBurstActive] = useState(false);
  const [eventFlagValueInput, setEventFlagValueInput] = useState(() => readStoredValue('eventFlagValueInput', '1'));
  const eventFlagIntervalRef = useRef(null);
  const eventFlagTimeoutRef = useRef(null);

  // Keep the local stale-timeout input in sync if the underlying value changes elsewhere.
  useEffect(() => {
    setStaleTimeoutInput(String(Math.round((staleTimeoutMs ?? 30000) / 1000)));
  }, [staleTimeoutMs]);

  const commitStaleTimeout = useCallback((rawValue) => {
    if (!onStaleTimeoutChange) return;
    const seconds = parseFloat(rawValue);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      // Restore previous valid value in the input
      setStaleTimeoutInput(String(Math.round((staleTimeoutMs ?? 30000) / 1000)));
      return;
    }
    const clampedSeconds = Math.max(1, Math.min(600, seconds));
    onStaleTimeoutChange(Math.round(clampedSeconds * 1000));
    setStaleTimeoutInput(String(Math.round(clampedSeconds)));
  }, [onStaleTimeoutChange, staleTimeoutMs]);

  useEffect(() => {
    BUS_IDS.forEach((busId) => {
      const draft = connectionDrafts[busId];
      localStorage.setItem(`${busId}:networkDeviceHost`, draft.networkHost);
      localStorage.setItem(`${busId}:networkDevicePort`, draft.networkPort);
      localStorage.setItem(`${busId}:bluetoothAddress`, draft.bluetoothAddress);
      localStorage.setItem(`${busId}:bluetoothChannel`, draft.bluetoothChannel);
    });
  }, [connectionDrafts]);

  // Register raw message callback for isolation feature
  useEffect(() => {
    if (!onRegisterRawCallback) return;
    
    const handleRawMessage = (message) => {
      // Only capture messages for isolated IDs
      if (isolatedIds.has(getMessageIdentityKey(message))) {
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

      // Trace recording captures all incoming raw messages.
      if (isRecordingTrace) {
        const sequence = traceMessagesRef.current.length + 1;
        traceMessagesRef.current.push({
          sequence,
          timestamp: message.timestamp,
          id: message.id,
          bus_id: message.bus_id,
          is_extended: message.is_extended,
          dlc: message.dlc || message.data?.length || 0,
          data: Array.isArray(message.data) ? [...message.data] : [],
          decoded: message.decoded || null
        });
      }
    };
    
    const unregister = onRegisterRawCallback(handleRawMessage);
    return () => unregister();
  }, [onRegisterRawCallback, isolatedIds, isRecordingTrace]);
  
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

  // Keep trace counter in sync while recording without re-rendering on every frame.
  useEffect(() => {
    if (!isRecordingTrace) {
      return;
    }

    const interval = setInterval(() => {
      const currentCount = traceMessagesRef.current.length;
      if (currentCount !== traceMessageCount) {
        setTraceMessageCount(currentCount);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isRecordingTrace, traceMessageCount]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && isolationContentRef.current && isolatedMessages.length > 0) {
      isolationContentRef.current.scrollTop = isolationContentRef.current.scrollHeight;
    }
  }, [autoScroll, isolatedMessages.length]);

  // Filter devices by type
  const pcanDevices = devices.filter(d => d.device_type === 'pcan');
  const canableDevices = devices.filter(d => d.device_type === 'canable');
  const bluetoothDevices = devices.filter(d => d.device_type === 'bluetooth' && d.name !== 'Bluetooth CAN Server');

  const busStatusMap = useMemo(() => {
    const statuses = Array.isArray(connectionStatus?.buses) ? connectionStatus.buses : [];
    return BUS_IDS.reduce((accumulator, busId) => {
      accumulator[busId] = statuses.find((status) => status.bus_id === busId) || {
        bus_id: busId,
        connected: false,
        status: 'Disconnected',
      };
      return accumulator;
    }, {});
  }, [connectionStatus]);

  const connectedBusIds = useMemo(
    () => BUS_IDS.filter((busId) => Boolean(busStatusMap[busId]?.connected)),
    [busStatusMap]
  );

  const stopEventFlagBurst = useCallback((status = null) => {
    if (eventFlagIntervalRef.current) {
      clearInterval(eventFlagIntervalRef.current);
      eventFlagIntervalRef.current = null;
    }
    if (eventFlagTimeoutRef.current) {
      clearTimeout(eventFlagTimeoutRef.current);
      eventFlagTimeoutRef.current = null;
    }
    setEventFlagBurstActive(false);
    setEventFlagStatus(status);
  }, []);

  const handleTriggerEventFlag = useCallback(async () => {
    if (!onSendMessage || eventFlagBurstActive) {
      return;
    }

    const eventFlagValue = parseEventFlagValue(eventFlagValueInput);
    if (eventFlagValue === null) {
      setEventFlagStatus({
        type: 'error',
        text: 'Enter a valid 32-bit marker value from 0 to 4294967295 (decimal or 0x hex).',
      });
      return;
    }

    const eventFlagData = encodeEventFlagData(eventFlagValue);

    const targetBusId = connectedBusIds.includes(selectedTransmitBusId)
      ? selectedTransmitBusId
      : connectedBusIds[0] || null;

    if (!targetBusId) {
      setEventFlagStatus({
        type: 'error',
        text: 'Connect a bus before sending the event flag.',
      });
      return;
    }

    setEventFlagStatus({
      type: 'success',
      text: `Sending marker ${formatEventFlagValue(eventFlagValue)} on ${getBusLabel(targetBusId)} for 1s.`,
    });
    setEventFlagBurstActive(true);

    const sendEventFlag = async () => {
      const ok = await onSendMessage(
        VCU_LOG_EVENT_FLAG_CAN_ID,
        eventFlagData,
        true,
        false,
        targetBusId
      );

      if (!ok) {
        stopEventFlagBurst({
          type: 'error',
          text: 'Failed to send the VCU event flag burst.',
        });
      }
    };

    const firstSendOk = await onSendMessage(
      VCU_LOG_EVENT_FLAG_CAN_ID,
      eventFlagData,
      true,
      false,
      targetBusId
    );

    if (!firstSendOk) {
      stopEventFlagBurst({
        type: 'error',
        text: 'Failed to send the VCU event flag burst.',
      });
      return;
    }

    eventFlagIntervalRef.current = setInterval(() => {
      sendEventFlag();
    }, VCU_LOG_EVENT_FLAG_INTERVAL_MS);

    eventFlagTimeoutRef.current = setTimeout(() => {
      stopEventFlagBurst({
        type: 'success',
        text: `Marker ${formatEventFlagValue(eventFlagValue)} finished on ${getBusLabel(targetBusId)}.`,
      });
    }, VCU_LOG_EVENT_FLAG_DURATION_MS);
  }, [connectedBusIds, eventFlagBurstActive, eventFlagValueInput, onSendMessage, selectedTransmitBusId, stopEventFlagBurst]);

  const busStatsMap = useMemo(() => {
    const statEntries = Array.isArray(stats?.buses) ? stats.buses : [];
    return BUS_IDS.reduce((accumulator, busId) => {
      accumulator[busId] = statEntries.find((entry) => entry.bus_id === busId) || {
        bus_id: busId,
        message_count: 0,
        message_rate: 0,
        uptime_seconds: 0,
      };
      return accumulator;
    }, {});
  }, [stats]);

  useEffect(() => {
    if (connectedBusIds.length === 0) {
      return;
    }

    setSelectedTransmitBusId((currentBusId) => (
      connectedBusIds.includes(currentBusId) ? currentBusId : connectedBusIds[0]
    ));
  }, [connectedBusIds]);

  useEffect(() => {
    localStorage.setItem('selectedTransmitBusId', selectedTransmitBusId);
  }, [selectedTransmitBusId]);

  useEffect(() => {
    localStorage.setItem('eventFlagValueInput', eventFlagValueInput);
  }, [eventFlagValueInput]);

  useEffect(() => () => {
    stopEventFlagBurst();
  }, [stopEventFlagBurst]);

  const parsedEventFlagValue = parseEventFlagValue(eventFlagValueInput);

  const updateConnectionDraft = useCallback((busId, patch) => {
    setConnectionDrafts((previousDrafts) => ({
      ...previousDrafts,
      [busId]: {
        ...previousDrafts[busId],
        ...patch,
      },
    }));
  }, []);

  const getDefaultDraftValues = useCallback((nextDeviceType, busId) => {
    if (nextDeviceType === 'pcan') {
      return { channel: pcanDevices[0]?.name || 'USB1' };
    }

    if (nextDeviceType === 'canable') {
      const preferredInterface = getPreferredSocketCanInterface(busId);
      const firstCanable = canableDevices.find((device) => (
        device.interface === 'socketcan' && device.channel === preferredInterface
      )) || canableDevices[0];
      return {
        channel: firstCanable
          ? formatCanableChannelOption(firstCanable)
          : (busId === 'bus2' ? 'Device 1' : 'Device 0'),
      };
    }

    if (nextDeviceType === 'bluetooth') {
      return {
        bluetoothAddress: bluetoothDevices[0]?.name || '',
      };
    }

    return {};
  }, [bluetoothDevices, canableDevices, pcanDevices]);

  useEffect(() => {
    if (canableDevices.length === 0) {
      return;
    }

    const availableChannels = new Set(canableDevices.map((device) => formatCanableChannelOption(device)));

    setConnectionDrafts((previousDrafts) => {
      let changed = false;
      const nextDrafts = { ...previousDrafts };

      BUS_IDS.forEach((busId) => {
        const draft = previousDrafts[busId];
        if (draft.deviceType !== 'canable') {
          return;
        }

        const preferredChannel = getDefaultDraftValues('canable', busId).channel;
        const usesPlaceholder = /^Device \d+$/.test(String(draft.channel));
        const missingFromDeviceList = !availableChannels.has(draft.channel);

        if ((usesPlaceholder || missingFromDeviceList) && draft.channel !== preferredChannel) {
          nextDrafts[busId] = {
            ...draft,
            channel: preferredChannel,
          };
          changed = true;
        }
      });

      return changed ? nextDrafts : previousDrafts;
    });
  }, [canableDevices, getDefaultDraftValues]);

  const handleBusDeviceTypeChange = useCallback((busId, nextDeviceType) => {
    updateConnectionDraft(busId, {
      deviceType: nextDeviceType,
      ...getDefaultDraftValues(nextDeviceType, busId),
    });
  }, [getDefaultDraftValues, updateConnectionDraft]);

  const resolveChannelForDraft = useCallback((draft) => {
    let channelToSend = draft.channel;

    if (draft.deviceType === 'network') {
      return `${draft.networkHost}:${draft.networkPort}`;
    }

    if (draft.deviceType === 'bluetooth') {
      return `${draft.bluetoothAddress}:${draft.bluetoothChannel}`;
    }

    if (draft.deviceType === 'canable') {
      if (typeof draft.channel === 'string' && draft.channel.startsWith('Device ')) {
        const parts = draft.channel.split(':')[0].split(' ');
        channelToSend = parts[1];
      } else {
        channelToSend = String(draft.channel).replace(/\D/g, '');
      }

      if (!channelToSend) {
        throw new Error('Invalid CANable channel. Please select a device.');
      }
    }

    return channelToSend;
  }, []);

  const handleTransmitSendMessage = useCallback((canId, data, isExtended, isRemote = false) => {
    if (!simulationActive && !busStatusMap[selectedTransmitBusId]?.connected) {
      alert(`Select a connected target bus before sending. Current target: ${getBusLabel(selectedTransmitBusId)}.`);
      return false;
    }

    return onSendMessage(canId, data, isExtended, isRemote, selectedTransmitBusId);
  }, [busStatusMap, onSendMessage, selectedTransmitBusId, simulationActive]);

  const scopedChildren = useMemo(() => React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) {
      return child;
    }

    return React.cloneElement(child, {
      onSendMessage: handleTransmitSendMessage,
      transmitBusId: selectedTransmitBusId,
    });
  }), [children, handleTransmitSendMessage, selectedTransmitBusId]);

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
        const busLabel = getBusLabel(msg.bus_id).toLowerCase();
        
        return idHex.includes(filter) || dataHex.includes(filter) || messageName.includes(filter) || busLabel.includes(filter);
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
        const signalsStr = msg.decoded?.signals
          ? Object.entries(msg.decoded.signals)
              .map(([name, signal]) => {
                const isObject = typeof signal === 'object' && signal !== null;
                const value = isObject ? signal.value : signal;
                const unit = isObject && signal.unit ? ` ${signal.unit}` : '';
                return `${name}=${value}${unit}`;
              })
              .join('; ')
          : '';
        row.push(signalsStr);
      }

      return row;
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => {
        const str = String(cell ?? '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `can_messages_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportTraceCSV = (traceMessages) => {
    if (!traceMessages || traceMessages.length === 0) {
      alert('No recorded CAN trace to save');
      return;
    }

    const headers = [
      'Sequence',
      'Timestamp',
      'Delta (ms)',
      'CAN ID',
      'Extended',
      'DLC',
      'Raw Data (Hex)',
      'Message Name',
      'Signals'
    ];

    const rows = traceMessages.map((msg, index) => {
      const prev = index > 0 ? traceMessages[index - 1] : null;
      const deltaMs = prev && typeof msg.timestamp === 'number' && typeof prev.timestamp === 'number'
        ? ((msg.timestamp - prev.timestamp) * 1000)
        : 0;

      const idHex = msg.is_extended
        ? `0x${msg.id.toString(16).padStart(8, '0').toUpperCase()}`
        : `0x${msg.id.toString(16).padStart(3, '0').toUpperCase()}`;

      const dataHex = Array.isArray(msg.data)
        ? msg.data.map(b => Number(b).toString(16).padStart(2, '0').toUpperCase()).join(' ')
        : '';

      const messageName = msg.decoded?.message_name || '';

      const signals = msg.decoded?.signals
        ? Object.entries(msg.decoded.signals)
            .map(([name, signal]) => {
              const isObject = typeof signal === 'object' && signal !== null;
              const value = isObject ? signal.value : signal;
              const unit = isObject && signal.unit ? ` ${signal.unit}` : '';
              return `${name}=${value}${unit}`;
            })
            .join('; ')
        : '';

      return [
        msg.sequence,
        msg.timestamp ?? '',
        deltaMs.toFixed(3),
        idHex,
        msg.is_extended ? 'Yes' : 'No',
        msg.dlc,
        dataHex,
        messageName,
        signals
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => {
        const str = String(cell ?? '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `can_trace_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleRecordToggle = () => {
    if (!isRecordingTrace) {
      traceMessagesRef.current = [];
      setTraceMessageCount(0);
      setIsRecordingTrace(true);
      return;
    }

    setIsRecordingTrace(false);
    const snapshot = [...traceMessagesRef.current];
    setTraceMessageCount(snapshot.length);
    exportTraceCSV(snapshot);
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

  const persistDbcFiles = useCallback(async (nextFiles) => {
    if (!onUpdateDBCConfig) {
      return false;
    }

    return onUpdateDBCConfig(
      nextFiles.map(file => ({
        filename: file.filename,
        enabled: file.enabled,
      }))
    );
  }, [onUpdateDBCConfig]);

  const handleToggleDbcEnabled = async (filename) => {
    const nextFiles = dbcFiles.map(file => (
      file.filename === filename
        ? { ...file, enabled: !file.enabled }
        : { ...file }
    ));
    await persistDbcFiles(nextFiles);
  };

  const handleMoveDbc = async (filename, direction) => {
    const currentIndex = dbcFiles.findIndex(file => file.filename === filename);
    if (currentIndex === -1) {
      return;
    }

    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= dbcFiles.length) {
      return;
    }

    const nextFiles = dbcFiles.map(file => ({ ...file }));
    const [movedFile] = nextFiles.splice(currentIndex, 1);
    nextFiles.splice(targetIndex, 0, movedFile);
    await persistDbcFiles(nextFiles);
  };

  const handleDropDbc = async (targetFilename) => {
    if (!draggedDbcFile || draggedDbcFile === targetFilename) {
      setDraggedDbcFile(null);
      return;
    }

    const sourceIndex = dbcFiles.findIndex(file => file.filename === draggedDbcFile);
    const targetIndex = dbcFiles.findIndex(file => file.filename === targetFilename);
    if (sourceIndex === -1 || targetIndex === -1) {
      setDraggedDbcFile(null);
      return;
    }

    const nextFiles = dbcFiles.map(file => ({ ...file }));
    const [movedFile] = nextFiles.splice(sourceIndex, 1);
    nextFiles.splice(targetIndex, 0, movedFile);
    setDraggedDbcFile(null);
    await persistDbcFiles(nextFiles);
  };

  const handleDeleteDbc = async (filename) => {
    if (!onDeleteDBC) {
      return;
    }

    const confirmed = window.confirm(`Delete DBC file "${filename}"?`);
    if (!confirmed) {
      return;
    }

    await onDeleteDBC(filename);
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
    const isolationKey = typeof id === 'string' ? id : getMessageIdentityKey(id);
    setIsolatedIds(prev => {
      const newSet = new Set(prev);
      newSet.add(isolationKey);
      return newSet;
    });
    setIsolationPanelOpen(true);
    closeContextMenu();
  };

  const removeIsolatedId = (id) => {
    const isolationKey = typeof id === 'string' ? id : getMessageIdentityKey(id);
    setIsolatedIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(isolationKey);
      return newSet;
    });
    isolatedMessagesRef.current = isolatedMessagesRef.current.filter(
      (message) => message.isCheckpoint || getMessageIdentityKey(message) !== isolationKey
    );
    setIsolatedMessages((previousMessages) => previousMessages.filter(
      (message) => message.isCheckpoint || getMessageIdentityKey(message) !== isolationKey
    ));
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
        const identityKey = getMessageIdentityKey(msg);
        // Find previous message with the SAME CAN ID
        let prevMsgSameId = null;
        for (let i = index - 1; i >= 0; i--) {
          if (getMessageIdentityKey(arr[i]) === identityKey) {
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

  const handleConnectClick = async (busId) => {
    const draft = connectionDrafts[busId];
    const busStatus = busStatusMap[busId] || {};
    const slotConnected = Boolean(busStatus.connected);

    console.log('[CANExplorer] Connect button clicked:', { busId, slotConnected, draft });

    if (simulationActive) {
      alert('Stop Test Mode before connecting or disconnecting hardware.');
      return;
    }
    
    try {
      if (slotConnected) {
        console.log('[CANExplorer] Attempting to disconnect...', busId);
        await onDisconnect(busId);
      } else {
        console.log('[CANExplorer] Attempting to connect...', busId);
        const channelToSend = resolveChannelForDraft(draft);
        console.log('[CANExplorer] Connecting with:', { busId, channelToSend, baudrate: draft.baudrate });
        const result = await onConnect(busId, draft.deviceType, channelToSend, draft.baudrate);
        console.log('[CANExplorer] Connection result:', result);
      }
    } catch (error) {
      console.error('[CANExplorer] Connection error:', error);
      alert('Connection failed: ' + error.message);
    }
  };

  const handleSimulationToggle = async () => {
    try {
      if (simulationActive) {
        await onStopSimulation();
      } else {
        await onStartSimulation();
      }
    } catch (error) {
      console.error('[CANExplorer] Simulation toggle error:', error);
      alert('Failed to toggle Test Mode: ' + error.message);
    }
  };

  const formatUptime = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const renderConnectionSlot = (busId) => {
    const draft = connectionDrafts[busId];
    const busStatus = busStatusMap[busId] || {};
    const busStatistics = busStatsMap[busId] || {};
    const slotConnected = Boolean(busStatus.connected);
    const slotBusy = slotConnected || busStatus.status === 'Reconnecting';
    const toneClass = getBusToneClass(busId);

    return (
      <div key={busId} className={`bus-connection-card ${toneClass} ${slotBusy ? 'connected' : ''}`}>
        <div className="bus-connection-header">
          <span className={`bus-pill ${toneClass}`}>{getBusLabel(busId)}</span>
          <span className={`bus-connection-state ${(busStatus.status || 'Disconnected').toLowerCase()}`}>
            {busStatus.status || 'Disconnected'}
          </span>
        </div>

        <div className="connection-form">
          <div className="form-group">
            <label>Device Type</label>
            <select
              value={draft.deviceType}
              onChange={(event) => handleBusDeviceTypeChange(busId, event.target.value)}
              disabled={slotBusy || simulationActive}
            >
              <option value="pcan">PCAN</option>
              <option value="canable">CANable / SocketCAN</option>
              <option value="network">Network</option>
              <option value="bluetooth">Bluetooth</option>
            </select>
          </div>

          {draft.deviceType === 'network' ? (
            <div className="form-group">
              <label>Server Address</label>
              <div className="network-address-input">
                <input
                  type="text"
                  className="network-host"
                  value={draft.networkHost}
                  onChange={(event) => updateConnectionDraft(busId, { networkHost: event.target.value })}
                  placeholder="IP Address"
                  disabled={slotBusy || simulationActive}
                />
                <span className="network-separator">:</span>
                <input
                  type="text"
                  className="network-port"
                  value={draft.networkPort}
                  onChange={(event) => updateConnectionDraft(busId, { networkPort: event.target.value })}
                  placeholder="Port"
                  disabled={slotBusy || simulationActive}
                />
              </div>
            </div>
          ) : draft.deviceType === 'bluetooth' ? (
            <div className="form-group">
              <label>Bluetooth Address</label>
              <div className="network-address-input bluetooth-address-input">
                {bluetoothDevices.length > 0 ? (
                  <select
                    value={draft.bluetoothAddress}
                    onChange={(event) => updateConnectionDraft(busId, { bluetoothAddress: event.target.value })}
                    disabled={slotBusy || simulationActive}
                  >
                    <option value="">-- Select paired device --</option>
                    {bluetoothDevices.map((device) => (
                      <option key={`${busId}-${device.name}`} value={device.name}>
                        {device.description}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={draft.bluetoothAddress}
                    onChange={(event) => updateConnectionDraft(busId, { bluetoothAddress: event.target.value.toUpperCase() })}
                    placeholder="XX:XX:XX:XX:XX:XX"
                    disabled={slotBusy || simulationActive}
                  />
                )}
                <span className="network-separator">Ch:</span>
                <input
                  type="number"
                  value={draft.bluetoothChannel}
                  onChange={(event) => updateConnectionDraft(busId, { bluetoothChannel: event.target.value })}
                  min="1"
                  max="30"
                  placeholder="1"
                  disabled={slotBusy || simulationActive}
                />
              </div>
            </div>
          ) : (
            <div className="form-group">
              <label>Channel</label>
              <select
                value={draft.channel}
                onChange={(event) => updateConnectionDraft(busId, { channel: event.target.value })}
                disabled={slotBusy || simulationActive}
              >
                {draft.deviceType === 'pcan' ? (
                  pcanDevices.length > 0 ? (
                    pcanDevices.map((device) => (
                      <option key={`${busId}-${device.name}`} value={device.name}>
                        {device.name} {device.occupied && '(Occupied)'}
                      </option>
                    ))
                  ) : (
                    <option value="USB1">USB1</option>
                  )
                ) : (
                  canableDevices.length > 0 ? (
                    canableDevices.map((device) => {
                      const fullName = formatCanableChannelOption(device);
                      return (
                        <option key={`${busId}-${device.index}`} value={fullName}>
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
              value={draft.baudrate}
              onChange={(event) => updateConnectionDraft(busId, { baudrate: event.target.value })}
              disabled={slotBusy || simulationActive}
            >
              <option value="BAUD_1M">1 Mbit/s</option>
              <option value="BAUD_500K">500 kbit/s</option>
              <option value="BAUD_250K">250 kbit/s</option>
              <option value="BAUD_125K">125 kbit/s</option>
            </select>
          </div>

          <button
            className={`btn btn-block ${slotBusy ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => handleConnectClick(busId)}
            disabled={simulationActive}
          >
            {slotBusy ? `Disconnect ${getBusLabel(busId)}` : `Connect ${getBusLabel(busId)}`}
          </button>

          {slotBusy && (
            <div className="connection-info bus-connection-info">
              <div className="info-row">
                <span className="info-label">Device:</span>
                <span className="info-value">{busStatus.device_type?.toUpperCase() || 'UNKNOWN'}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Channel:</span>
                <span className="info-value">{busStatus.channel || 'N/A'}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Messages:</span>
                <span className="info-value">{busStatistics.message_count || 0}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Rate:</span>
                <span className="info-value">{busStatistics.message_rate || 0} msg/s</span>
              </div>
              <div className="info-row">
                <span className="info-label">Uptime:</span>
                <span className="info-value">{formatUptime(busStatistics.uptime_seconds || 0)}</span>
              </div>
              {busStatus.reason && busStatus.status !== 'Connected' && (
                <div className="info-row bus-connection-reason">
                  <span className="info-label">Reason:</span>
                  <span className="info-value">{busStatus.reason}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`can-explorer-layout ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      {/* Sidebar overlay backdrop for narrow screens */}
      {!sidebarCollapsed && (
        <div className="sidebar-overlay" onClick={() => setSidebarCollapsed(true)} />
      )}

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

        <div className="sidebar-section sidebar-event-flag-section">
          <div className="sidebar-header">
            <Flag size={18} />
            <span>Event Flag</span>
          </div>
          <div className="form-group">
            <label htmlFor="event-flag-value-input">Marker Value</label>
            <input
              id="event-flag-value-input"
              type="text"
              value={eventFlagValueInput}
              onChange={(event) => setEventFlagValueInput(event.target.value)}
              placeholder="1 or 0x00000001"
              disabled={eventFlagBurstActive}
            />
          </div>
          {parsedEventFlagValue !== null && (
            <div className="event-flag-preview">
              Payload value: <strong>{formatEventFlagValue(parsedEventFlagValue)}</strong>
            </div>
          )}
          <button
            className={`btn btn-block ${eventFlagBurstActive ? 'btn-warning' : 'btn-primary'}`}
            onClick={handleTriggerEventFlag}
            disabled={!onSendMessage || connectedBusIds.length === 0 || eventFlagBurstActive}
            title="Send the VCU event flag frame every 10ms for 1 second using the configured 32-bit marker"
          >
            <Flag size={16} />
            {eventFlagBurstActive ? 'Sending Event Flag...' : 'Flag Event In Logs'}
          </button>
          <div className="event-flag-hint">
            Sends VCU_LOG_Event_Flag on the selected transmit bus at 10 ms for 1 second. The first 4 data bytes carry the marker as a little-endian 32-bit value.
          </div>
          {eventFlagStatus && (
            <div className={`sidebar-status ${eventFlagStatus.type === 'success' ? 'success' : ''}`}>
              {eventFlagStatus.text}
            </div>
          )}
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
                className={`sidebar-tab submenu ${activeTab === 'balance-manager' ? 'active' : ''}`}
                onClick={() => onTabChange('balance-manager')}
              >
                Balance Manager
              </button>
              <button
                className={`sidebar-tab submenu ${activeTab === 'module-config' ? 'active' : ''}`}
                onClick={() => onTabChange('module-config')}
              >
                Module Config
              </button>
            </div>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">HVC</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'hvc-dashboard' ? 'active' : ''}`}
                onClick={() => onTabChange('hvc-dashboard')}
              >
                HVC Dashboard
              </button>
            </div>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">VCU</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'vcu-dashboard' ? 'active' : ''}`}
                onClick={() => onTabChange('vcu-dashboard')}
              >
                VCU Dashboard
              </button>
              <button
                className={`sidebar-tab submenu ${activeTab === 'vcu-launch-control' ? 'active' : ''}`}
                onClick={() => onTabChange('vcu-launch-control')}
              >
                Launch Control
              </button>
            </div>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">Inverter</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'inverter-dashboard' ? 'active' : ''}`}
                onClick={() => onTabChange('inverter-dashboard')}
              >
                CM200DZ Dashboard
              </button>
              <button
                className={`sidebar-tab submenu ${activeTab === 'inverter-testing' ? 'active' : ''}`}
                onClick={() => onTabChange('inverter-testing')}
              >
                Inverter Testing
              </button>
            </div>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">MOBO</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'mobo' ? 'active' : ''}`}
                onClick={() => onTabChange('mobo')}
              >
                MOBO Dashboard
              </button>
            </div>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">DAQ</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'daq-dashboard' ? 'active' : ''}`}
                onClick={() => onTabChange('daq-dashboard')}
              >
                DAQ Dashboard
              </button>
            </div>
            <div className="sidebar-menu-group">
              <div className="sidebar-menu-header">Driving</div>
              <button
                className={`sidebar-tab submenu ${activeTab === 'driving-dashboard' ? 'active' : ''}`}
                onClick={() => onTabChange('driving-dashboard')}
              >
                Driving Dashboard
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

          {connectionExpanded && <div className="connection-section-content">
            <div className="bus-connection-grid">
              {BUS_IDS.map((busId) => renderConnectionSlot(busId))}
            </div>

            <button
              className={`btn btn-block ${simulationActive ? 'btn-warning' : 'btn-secondary'}`}
              onClick={handleSimulationToggle}
              disabled={connected && !simulationActive}
            >
              {simulationActive ? 'Stop Test Mode' : 'Start Test Mode'}
            </button>

            <button
              className="btn btn-secondary btn-block"
              onClick={onRefreshDevices}
              disabled={connected || simulationActive}
            >
              <RefreshCw size={16} />
              Refresh Devices
            </button>

            {(connected || simulationActive) && (
              <div className="connection-info">
                {simulationActive && (
                  <div className="test-mode-pill">TEST MODE ACTIVE</div>
                )}
                <div className="info-row">
                  <span className="info-label">Connected Buses:</span>
                  <span className="info-value">{connectedBusIds.length || (simulationActive ? 1 : 0)}</span>
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

        <div className="sidebar-section">
          <div className="sidebar-header">
            <Activity size={18} />
            <span>Transmit Target</span>
          </div>
          <div className="connection-form">
            <div className="form-group transmit-target-sidebar">
              <label htmlFor="sidebar-transmit-target-select">Target Bus</label>
              <select
                id="sidebar-transmit-target-select"
                value={selectedTransmitBusId}
                onChange={(event) => setSelectedTransmitBusId(event.target.value)}
                disabled={connectedBusIds.length === 0 || simulationActive}
              >
                {BUS_IDS.map((busId) => (
                  <option key={busId} value={busId} disabled={!busStatusMap[busId]?.connected}>
                    {getBusLabel(busId)} {busStatusMap[busId]?.connected ? '' : '(Disconnected)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="transmit-target-hint">
              Dashboard commands and the transmit list both send on this selected bus.
            </div>
          </div>
        </div>

        {/* DBC Upload */}
        <div className="sidebar-section">
          <div className="sidebar-header collapsible" onClick={() => setDbcExpanded(!dbcExpanded)}>
            {dbcExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <FileText size={18} />
            <span>DBC File</span>
          </div>
          {dbcExpanded && <>
            <button className="btn btn-secondary btn-block" onClick={handleUploadClick}>
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
                Active: {dbcFile}
              </div>
            ) : (
              <div className="sidebar-status">
                No enabled DBC files
              </div>
            )}
            {dbcFiles.length > 0 ? (
              <div className="dbc-list">
                {dbcFiles.map((file, index) => (
                  <div
                    key={file.filename}
                    className={`dbc-list-item ${file.effective ? 'effective' : ''} ${draggedDbcFile === file.filename ? 'dragging' : ''}`}
                    draggable
                    onDragStart={() => setDraggedDbcFile(file.filename)}
                    onDragEnd={() => setDraggedDbcFile(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => handleDropDbc(file.filename)}
                  >
                    <div className="dbc-item-main">
                      <label className="dbc-checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(file.enabled)}
                          onChange={() => handleToggleDbcEnabled(file.filename)}
                        />
                      </label>
                      <button
                        type="button"
                        className="dbc-drag-handle"
                        title="Drag to reorder"
                        aria-label={`Drag ${file.filename} to reorder`}
                      >
                        <GripVertical size={14} />
                      </button>
                      <div className="dbc-item-info">
                        <div className="dbc-item-title-row">
                          <span className="dbc-item-title">{file.filename}</span>
                        </div>
                      </div>
                    </div>
                    <div className="dbc-item-footer">
                      <div className="dbc-item-meta">
                        <span className={`dbc-state-pill ${file.enabled ? 'enabled' : 'disabled'}`}>
                          {file.enabled ? `Priority ${index + 1}` : 'Disabled'}
                        </span>
                        {file.effective && <span className="dbc-effective-pill">Active</span>}
                        <span>{file.message_count || 0} msgs</span>
                      </div>
                      <div className="dbc-item-actions">
                        <button
                          type="button"
                          className="dbc-action-btn"
                          onClick={() => handleMoveDbc(file.filename, -1)}
                          disabled={index === 0}
                          title="Move up"
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="dbc-action-btn"
                          onClick={() => handleMoveDbc(file.filename, 1)}
                          disabled={index === dbcFiles.length - 1}
                          title="Move down"
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          type="button"
                          className="dbc-action-btn dbc-delete-btn"
                          onClick={() => handleDeleteDbc(file.filename)}
                          title="Delete DBC file"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sidebar-status">
                No uploaded DBC files
              </div>
            )}
          </>}
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

        {/* Settings */}
        <div className="sidebar-section">
          <div className="sidebar-header collapsible" onClick={() => setSettingsExpanded(!settingsExpanded)}>
            {settingsExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <SettingsIcon size={18} />
            <span>Settings</span>
          </div>
          {settingsExpanded && (
            <div className="settings-form">
              <div className="form-group">
                <label className="settings-checkbox" htmlFor="stale-messages-enabled">
                  <input
                    id="stale-messages-enabled"
                    type="checkbox"
                    checked={staleMessagesEnabled}
                    onChange={(e) => onStaleMessagesEnabledChange?.(e.target.checked)}
                  />
                  <span>Enable stale message detection</span>
                </label>
                <div className="settings-hint">
                  Turn this off to stop graying out cards and freshness badges everywhere.
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="stale-timeout-input">Stale Message Timeout (s)</label>
                <input
                  id="stale-timeout-input"
                  type="number"
                  min="1"
                  max="600"
                  step="1"
                  value={staleTimeoutInput}
                  onChange={(e) => setStaleTimeoutInput(e.target.value)}
                  onBlur={(e) => commitStaleTimeout(e.target.value)}
                  disabled={!staleMessagesEnabled}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.target.blur();
                    }
                  }}
                  className="settings-input"
                />
                <div className="settings-hint">
                  {staleMessagesEnabled
                    ? 'Data older than this is shown grayed-out on sub-pages. Default 30s.'
                    : 'Stale detection is off. Re-enable it to use this timeout again.'}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar Toggle Button */}
      <button
        className="sidebar-toggle"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      >
        {sidebarCollapsed ? <PanelLeft size={20} /> : <PanelLeftClose size={20} />}
      </button>

      {/* Main content area - Message table or custom content */}
      <div className="can-main-content">
        {children ? (
          // Render custom content (like ThermistorMonitor or CellVoltageMonitor)
          scopedChildren
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
                      className={`btn btn-sm ${isRecordingTrace ? 'btn-danger' : 'btn-secondary'}`}
                      onClick={(e) => { e.stopPropagation(); handleRecordToggle(); }}
                      title={isRecordingTrace ? 'Stop recording and save CSV trace' : 'Start recording all incoming CAN messages'}
                    >
                      <Activity size={16} />
                      {isRecordingTrace ? `Stop (${traceMessageCount})` : 'Record'}
                    </button>
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
                      const rowKey = getMessageIdentityKey(msg);
                      const isExpanded = expandedRows.has(rowKey);
                      const hasSignals = msg.decoded && Object.keys(msg.decoded.signals).length > 0;
                      
                      return (
                        <React.Fragment key={rowKey}>
                          <tr 
                            className={`message-row ${getBusToneClass(msg.bus_id)} ${hasSignals ? 'clickable' : ''} ${isolatedIds.has(getMessageIdentityKey(msg)) ? 'isolated' : ''}`}
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
                              <div className="message-id-cell">
                                <span className="hex-data">{formatCanId(msg)}</span>
                                <span className={`message-bus-badge ${getBusToneClass(msg.bus_id)}`}>
                                  {getBusLabel(msg.bus_id)}
                                </span>
                              </div>
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
                    dbcContext={dbcContext}
                    onSendMessage={handleTransmitSendMessage}
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
          {!isolatedIds.has(getMessageIdentityKey(contextMenu.message || { id: 0, is_extended: false, bus_id: 'bus1' })) ? (
            <button 
              className="context-menu-item"
              onClick={() => addIsolatedId(contextMenu.message)}
            >
              <Eye size={14} />
              <span>Isolate {getBusLabel(contextMenu.message?.bus_id)} {formatCanId(contextMenu.message || { id: 0, is_extended: false })}</span>
            </button>
          ) : (
            <button 
              className="context-menu-item"
              onClick={() => removeIsolatedId(contextMenu.message)}
            >
              <EyeOff size={14} />
              <span>Stop Isolating {getBusLabel(contextMenu.message?.bus_id)} {formatCanId(contextMenu.message || { id: 0, is_extended: false })}</span>
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
                {Array.from(isolatedIds).map(identityKey => {
                  const parsedKey = parseMessageIdentityKey(identityKey);
                  const msg = messages.find(m => getMessageIdentityKey(m) === identityKey);
                  const name = msg?.decoded?.message_name;
                  return (
                    <div key={identityKey} className={`isolation-tag ${getBusToneClass(parsedKey.busId)}`}>
                      <span className={`message-bus-badge ${getBusToneClass(parsedKey.busId)}`}>
                        {getBusLabel(parsedKey.busId)}
                      </span>
                      <span className="isolation-tag-id">
                        {parsedKey.isExtended
                          ? `0x${parsedKey.id.toString(16).padStart(8, '0').toUpperCase()}`
                          : `0x${parsedKey.id.toString(16).padStart(3, '0').toUpperCase()}`}
                      </span>
                      {name && <span className="isolation-tag-name">{name}</span>}
                      <button 
                        className="isolation-tag-remove"
                        onClick={() => removeIsolatedId(identityKey)}
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
                    if (!isolatedMessages[i].isCheckpoint && getMessageIdentityKey(isolatedMessages[i]) === getMessageIdentityKey(msg)) {
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
                      className={`isolation-message-card ${getBusToneClass(msg.bus_id)} ${hasChanges ? 'has-changes' : ''}`}
                    >
                      <div className="isolation-card-header">
                        <div className="isolation-card-meta">
                          <span className="isolation-seq">#{displayIndex}</span>
                          <span className={`message-bus-badge ${getBusToneClass(msg.bus_id)}`}>
                            {getBusLabel(msg.bus_id)}
                          </span>
                          <span className="isolation-id">
                            {formatCanId(msg)}
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
