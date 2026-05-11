import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Activity, AlertTriangle, Thermometer, Zap, TrendingUp, TrendingDown, Info, Send, CheckCircle, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import { useIsMobile } from '../hooks/useIsMobile';
import ErrorBoundary from './ErrorBoundary';
import './BMSStatus.css';

const MODULE_IDS = [0, 1, 2, 3, 4, 5];
const DEBUG_BROADCAST_CAN_ID = 0x08F00F10;
const DEBUG_BOOT_FLAGS = [
  { key: 'Boot_Active_App_Valid', label: 'App', okValue: 1 },
  { key: 'Boot_Metadata_Valid', label: 'Meta', okValue: 1 },
  { key: 'Boot_Bank_A_Marked_Valid', label: 'A Valid', okValue: 1 },
  { key: 'Boot_Bank_B_Marked_Valid', label: 'B Valid', okValue: 1 },
  { key: 'Boot_Bank_A_CRC_OK', label: 'A CRC', okValue: 1 },
  { key: 'Boot_Bank_B_CRC_OK', label: 'B CRC', okValue: 1 },
  { key: 'Boot_Update_In_Progress', label: 'Update', okValue: 0 }
];

// Helper function to extract numeric signal value - handles both local DBC decoding (object with .value/.raw)
// and server-side decoding (raw value directly). Prefers raw numeric value for calculations.
const getSignalValue = (signal, defaultValue = 0) => {
  if (signal === undefined || signal === null) return defaultValue;
  if (typeof signal === 'number') return signal;
  if (typeof signal === 'object') {
    return signal.raw ?? signal.value ?? defaultValue;
  }
  return defaultValue;
};

// Helper function to extract string signal value (e.g., enum names like 'NORMAL', 'FAULT')
// Prefers the display value over raw numeric value.
const getSignalDisplayValue = (signal, defaultValue = '') => {
  if (signal === undefined || signal === null) return defaultValue;
  if (typeof signal === 'string') return signal;
  if (typeof signal === 'number') return String(signal);
  if (typeof signal === 'object') {
    if (typeof signal.value === 'string') return signal.value;
    if (signal.value !== undefined) return String(signal.value);
    if (signal.raw !== undefined) return String(signal.raw);
    return defaultValue;
  }
  return String(signal);
};

const getSignalUnit = (signal, defaultUnit = '') => {
  if (typeof signal === 'object' && signal !== null) {
    return signal.unit ?? defaultUnit;
  }
  return defaultUnit;
};

const isValidThermistorTemp = (value) => value !== null && value !== undefined && value >= -30;
const isValidVoltage = (value) => value !== null && value !== undefined && Number.isFinite(value);

const normalizeStackVoltage = (value) => {
  if (value === null || value === undefined) return null;
  // Handle both legacy mV payloads and current DBC V units.
  return value > 1000 ? value / 1000 : value;
};

const parseCellId = (name) => {
  const match = name.match(/Cell_(\d+)_Voltage/);
  return match ? parseInt(match[1], 10) : null;
};

const parseTempId = (name) => {
  const match = name.match(/Temp_(\d+)/);
  return match ? parseInt(match[1], 10) : null;
};

const getExtrema = (items, validator = isValidVoltage) => {
  const valid = items.filter(item => item && validator(item.value));
  if (valid.length === 0) {
    return { min: null, max: null, avg: null, count: 0 };
  }

  const min = valid.reduce((lowest, item) => item.value < lowest.value ? item : lowest, valid[0]);
  const max = valid.reduce((highest, item) => item.value > highest.value ? item : highest, valid[0]);
  const avg = valid.reduce((sum, item) => sum + item.value, 0) / valid.length;
  return { min, max, avg, count: valid.length };
};

const formatStackVoltage = (value) => value !== null && value !== undefined ? `${value.toFixed(2)} V` : '--';
const formatCellVoltage = (value) => value !== null && value !== undefined ? `${(value / 1000).toFixed(3)} V` : '--';
const formatTemperature = (value) => value !== null && value !== undefined ? `${value.toFixed(1)}°C` : '--';
const formatPlainTemperature = (value) => value !== null && value !== undefined ? `${value.toFixed(1)}°` : '--';
const formatCellRef = (entry) => entry?.cellId ? `Cell ${entry.cellId}` : '--';
const formatTempRef = (entry) => entry?.sensorId !== null && entry?.sensorId !== undefined ? `Temp ${entry.sensorId}` : '--';
const formatDuration = (seconds) => {
  if (seconds === null || seconds === undefined) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

const getBootFlagClass = (signal, okValue) => {
  const value = getSignalValue(signal, null);
  if (value === null || value === undefined) return 'unknown';
  return value === okValue ? 'ok' : 'danger';
};

const formatBootFlagValue = (signal) => {
  const value = getSignalDisplayValue(signal, '--');
  if (value === 'Yes') return 'Y';
  if (value === 'No') return 'N';
  return value;
};

function BMSStatus({ messages, onSendMessage, staleTimeoutMs = 30000 }) {
  const [moduleData, setModuleData] = useState({});
  const [commandStatus, setCommandStatus] = useState({});
  const [faultHistory, setFaultHistory] = useState({});
  const [expandedModules, setExpandedModules] = useState({});
  const nowMs = useNowTick(1000);
  const isMobile = useIsMobile(768);

  // One-time global error logger so cross-origin "Script error." messages
  // still print useful info to the console for debugging.
  useEffect(() => {
    const onErr = (e) => {
      // eslint-disable-next-line no-console
      console.error('[GlobalError]', e?.message, e?.filename, e?.lineno, e?.colno, e?.error);
    };
    const onRej = (e) => {
      // eslint-disable-next-line no-console
      console.error('[UnhandledRejection]', e?.reason);
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);

  const toggleExpanded = (moduleId) => {
    setExpandedModules(prev => {
      const next = { ...prev };
      if (next[moduleId]) delete next[moduleId];
      else next[moduleId] = true;
      return next;
    });
  };

  const isExpanded = (moduleId) => Boolean(expandedModules[moduleId]);

  // Per-module freshest CAN timestamp (in seconds). Used to gray out modules
  // whose telemetry has gone silent for longer than the user-configured timeout.
  const moduleFreshestTimestamp = useMemo(() => {
    const timestamps = Array(6).fill(null);
    if (!messages || messages.length === 0) return timestamps;

    messages.forEach(msg => {
      const t = typeof msg?.timestamp === 'number' ? msg.timestamp : null;
      if (t === null) return;
      const msgName = msg?.decoded?.message_name || '';
      const ids = new Set();

      const tempMatch = msgName.match(/Cell_Temp_(\d+)_/);
      if (tempMatch) ids.add(Math.floor(parseInt(tempMatch[1], 10) / 56));
      const voltMatch = msgName.match(/Cell_Voltage_(\d+)_/);
      if (voltMatch) ids.add(Math.floor((parseInt(voltMatch[1], 10) - 1) / 18));
      const suffixMatch = msgName.match(/_(\d)$/);
      if (suffixMatch) ids.add(parseInt(suffixMatch[1], 10));

      ids.forEach(id => {
        if (id >= 0 && id < 6 && (timestamps[id] === null || t > timestamps[id])) {
          timestamps[id] = t;
        }
      });
    });
    return timestamps;
  }, [messages]);

  const moduleStale = useMemo(() => (
    moduleFreshestTimestamp.map(ts => isTimestampStale(ts, nowMs, staleTimeoutMs))
  ), [moduleFreshestTimestamp, nowMs, staleTimeoutMs]);

  useEffect(() => {
    if (!messages || messages.length === 0) return;

    const newModuleData = {};
    const now = Date.now();

    messages.forEach(msg => {
      if (!msg.decoded) return;

      const msgName = msg.decoded.message_name;
      let moduleId = null;

      const tempMatch = msgName.match(/Cell_Temp_(\d+)_/);
      if (tempMatch) {
        const thermNum = parseInt(tempMatch[1], 10);
        moduleId = Math.floor(thermNum / 56);
      } else {
        const voltMatch = msgName.match(/Cell_Voltage_(\d+)_/);
        if (voltMatch) {
          const cellNum = parseInt(voltMatch[1], 10);
          moduleId = Math.floor((cellNum - 1) / 18);
        } else {
          const moduleSuffixMatch = msgName.match(/_(\d)$/);
          if (moduleSuffixMatch) {
            moduleId = parseInt(moduleSuffixMatch[1], 10);
          }
        }
      }

      if (moduleId === null || moduleId < 0 || moduleId > 5) return;

      if (!newModuleData[moduleId]) {
        newModuleData[moduleId] = {
          heartbeat: null,
          canStats: null,
          bms1Status: null,
          bms2Status: null,
          tempSummary: null,
          temperatures: {},
          voltages: {},
          i2cDiag: null,
          debugInfo: null
        };
      }

      if (msgName.startsWith('BMS_Heartbeat_')) {
        newModuleData[moduleId].heartbeat = msg.decoded.signals;

        const byte0 = getSignalValue(msg.decoded.signals.Error_Flags_Byte0);
        const byte1 = getSignalValue(msg.decoded.signals.Error_Flags_Byte1);
        const byte2 = getSignalValue(msg.decoded.signals.Error_Flags_Byte2);
        const byte3 = getSignalValue(msg.decoded.signals.Error_Flags_Byte3);
        const activeFaults = [];

        if (byte0 & 1) activeFaults.push({ type: 'temp', msg: 'Over Temperature', id: 'temp_over' });
        if (byte0 & 2) activeFaults.push({ type: 'temp', msg: 'Under Temperature', id: 'temp_under' });
        if (byte0 & 4) activeFaults.push({ type: 'temp', msg: 'Temp Sensor Fault', id: 'temp_sensor' });
        if (byte0 & 8) activeFaults.push({ type: 'temp', msg: 'Temperature Gradient', id: 'temp_gradient' });

        if (byte1 & 1) activeFaults.push({ type: 'voltage', msg: 'Over Voltage', id: 'volt_over' });
        if (byte1 & 2) activeFaults.push({ type: 'voltage', msg: 'Under Voltage', id: 'volt_under' });
        if (byte1 & 4) activeFaults.push({ type: 'voltage', msg: 'Voltage Imbalance', id: 'volt_imbalance' });
        if (byte1 & 8) activeFaults.push({ type: 'voltage', msg: 'Voltage Sensor Fault', id: 'volt_sensor' });

        if (byte2 & 1) activeFaults.push({ type: 'current', msg: 'Over Current Charge', id: 'curr_over_charge' });
        if (byte2 & 2) activeFaults.push({ type: 'current', msg: 'Over Current Discharge', id: 'curr_over_discharge' });
        if (byte2 & 4) activeFaults.push({ type: 'current', msg: 'Current Sensor Fault', id: 'curr_sensor' });
        if (byte2 & 8) activeFaults.push({ type: 'current', msg: 'Short Circuit', id: 'curr_short' });

        if (byte3 & 1) activeFaults.push({ type: 'comm', msg: 'CAN Bus Off', id: 'can_bus_off' });
        if (byte3 & 2) activeFaults.push({ type: 'comm', msg: 'CAN TX Timeout', id: 'can_tx_timeout' });
        if (byte3 & 4) activeFaults.push({ type: 'comm', msg: 'CAN RX Overflow', id: 'can_rx_overflow' });
        if (byte3 & 8) activeFaults.push({ type: 'comm', msg: 'I2C1 BMS1 Error', id: 'i2c1_bms1' });
        if (byte3 & 16) activeFaults.push({ type: 'comm', msg: 'I2C3 BMS2 Error', id: 'i2c3_bms2' });
        if (byte3 & 32) activeFaults.push({ type: 'comm', msg: 'I2C Timeout', id: 'i2c_timeout' });
        if (byte3 & 64) activeFaults.push({ type: 'comm', msg: 'I2C Fault', id: 'i2c_fault' });
        if (byte3 & 128) activeFaults.push({ type: 'comm', msg: 'Watchdog Reset', id: 'watchdog' });

        setFaultHistory(prev => {
          const next = { ...prev };
          const moduleKey = `module_${moduleId}`;
          if (!next[moduleKey]) next[moduleKey] = {};
          activeFaults.forEach(fault => {
            next[moduleKey][fault.id] = { ...fault, lastSeen: now };
          });
          return next;
        });
      } else if (msgName.startsWith('BMS_CAN_Stats_')) {
        newModuleData[moduleId].canStats = msg.decoded.signals;
      } else if (msgName.startsWith('BMS_Chip_Status_')) {
        newModuleData[moduleId].bms1Status = msg.decoded.signals;
        newModuleData[moduleId].bms2Status = msg.decoded.signals;
      } else if (msgName.startsWith('BMS1_Chip_Status_')) {
        newModuleData[moduleId].bms1Status = msg.decoded.signals;
      } else if (msgName.startsWith('BMS2_Chip_Status_')) {
        newModuleData[moduleId].bms2Status = msg.decoded.signals;
      } else if (msgName.startsWith('Cell_Temp_Summary_')) {
        newModuleData[moduleId].tempSummary = msg.decoded.signals;
      } else if (/^Cell_Temp_\d+_/.test(msgName)) {
        Object.entries(msg.decoded.signals).forEach(([name, signal]) => {
          if (name.startsWith('Temp_')) {
            newModuleData[moduleId].temperatures[name] = {
              name,
              value: getSignalValue(signal),
              unit: getSignalUnit(signal, '°C'),
              moduleId,
              sensorId: parseTempId(name)
            };
          }
        });
      } else if (msgName.startsWith('Cell_Voltage_')) {
        Object.entries(msg.decoded.signals).forEach(([name, signal]) => {
          if (name.includes('Voltage')) {
            newModuleData[moduleId].voltages[name] = {
              name,
              value: getSignalValue(signal),
              unit: getSignalUnit(signal, 'mV'),
              moduleId,
              cellId: parseCellId(name)
            };
          }
        });
      } else if (msgName.startsWith('BMS_I2C_Diagnostics_')) {
        newModuleData[moduleId].i2cDiag = msg.decoded.signals;
      } else if (msgName.startsWith('BMS_Debug_Response_')) {
        newModuleData[moduleId].debugInfo = msg.decoded.signals;
      }
    });

    setModuleData(newModuleData);
  }, [messages]);

  // Monitor for command ACK/response messages.
  useEffect(() => {
    if (!messages || messages.length === 0) return;

    const recentMessages = messages.slice(-50);

    recentMessages.forEach(msg => {
      if (!msg.decoded) return;

      const msgName = msg.decoded.message_name;

      if (msgName.startsWith('BMS_Chip_Reset_ACK_')) {
        const moduleMatch = msgName.match(/_(\d)$/);
        if (moduleMatch) {
          const modId = parseInt(moduleMatch[1], 10);
          const status = getSignalDisplayValue(msg.decoded.signals.Status, 'Unknown');
          setCommandStatus(prev => ({
            ...prev,
            [`chip_reset_${modId}`]: {
              status: status === 'Success' ? 'success' : 'error',
              message: `Status: ${status}`,
              timestamp: Date.now()
            },
            [`bq_reset_${modId}`]: {
              status: status === 'Success' || status === 'Queued' ? 'success' : 'error',
              message: `Status: ${status}`,
              timestamp: Date.now()
            }
          }));
        }
      }

      if (msgName.startsWith('BMS_Debug_Response_')) {
        const moduleMatch = msgName.match(/_(\d)$/);
        const responseModule = getSignalValue(msg.decoded.signals.Module_ID, null);
        const modId = responseModule !== null ? responseModule : (moduleMatch ? parseInt(moduleMatch[1], 10) : null);
        if (modId !== null && modId >= 0 && modId < 6) {
          setCommandStatus(prev => ({
            ...prev,
            [`debug_${modId}`]: {
              status: 'success',
              message: 'Debug response received',
              timestamp: Date.now(),
              data: msg.decoded.signals
            }
          }));
        }
      }
    });

    recentMessages.forEach(msg => {
      const baseAckId = 0x08F00F04;
      for (let modId = 0; modId < 6; modId++) {
        const expectedAckId = baseAckId | (modId << 12);
        if (msg.id === expectedAckId) {
          const statusByte = msg.data[0];
          const status = statusByte === 0 ? 'Queued' : 'Fail';
          setCommandStatus(prev => ({
            ...prev,
            [`bq_reset_${modId}`]: {
              status: statusByte === 0 ? 'success' : 'error',
              message: `BQ Reset ${status}`,
              timestamp: Date.now()
            }
          }));
          break;
        }
      }
    });
  }, [messages]);

  // Clear old command statuses after 5 seconds.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCommandStatus(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(key => {
          if (now - updated[key].timestamp > 5000) {
            delete updated[key];
          }
        });
        return updated;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Clear old faults from history after 5 seconds of not being seen.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setFaultHistory(prev => {
        const updated = { ...prev };
        let hasChanges = false;

        Object.keys(updated).forEach(moduleKey => {
          Object.keys(updated[moduleKey]).forEach(faultId => {
            if (now - updated[moduleKey][faultId].lastSeen > 5000) {
              delete updated[moduleKey][faultId];
              hasChanges = true;
            }
          });

          if (Object.keys(updated[moduleKey]).length === 0) {
            delete updated[moduleKey];
            hasChanges = true;
          }
        });

        return hasChanges ? updated : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleSTMResetDirect = async (moduleId) => {
    const canId = 0x08F00F02 | (moduleId << 12);
    try {
      const success = await onSendMessage(canId, [0, 0, 0, 0, 0, 0, 0, 0], true, false);
      if (success) {
        setCommandStatus(prev => ({
          ...prev,
          [`stm_reset_${moduleId}`]: {
            status: 'success',
            message: 'STM32 reset sent',
            timestamp: Date.now()
          }
        }));
      }
    } catch (error) {
      setCommandStatus(prev => ({
        ...prev,
        [`stm_reset_${moduleId}`]: {
          status: 'error',
          message: `Failed: ${error.message}`,
          timestamp: Date.now()
        }
      }));
    }
  };

  const handleBQResetDirect = async (moduleId) => {
    const canId = 0x08F00F03 | (moduleId << 12);
    try {
      const success = await onSendMessage(canId, [0, 0, 0, 0, 0, 0, 0, 0], true, false);
      if (success) {
        setCommandStatus(prev => ({
          ...prev,
          [`bq_reset_${moduleId}`]: {
            status: 'pending',
            message: 'Waiting for ACK...',
            timestamp: Date.now()
          }
        }));
      }
    } catch (error) {
      setCommandStatus(prev => ({
        ...prev,
        [`bq_reset_${moduleId}`]: {
          status: 'error',
          message: `Failed: ${error.message}`,
          timestamp: Date.now()
        }
      }));
    }
  };

  const handleDebugRequest = async () => {
    const pendingStatuses = MODULE_IDS.reduce((acc, moduleId) => {
      acc[`debug_${moduleId}`] = {
        status: 'pending',
        message: 'Waiting for response...',
        timestamp: Date.now()
      };
      return acc;
    }, {});

    setCommandStatus(prev => ({
      ...prev,
      ...pendingStatuses,
      debug_broadcast: {
        status: 'pending',
        message: 'Broadcast sent, waiting for modules...',
        timestamp: Date.now()
      }
    }));

    try {
      const success = await onSendMessage(DEBUG_BROADCAST_CAN_ID, [0, 0, 0, 0, 0, 0, 0, 0], true, false);
      if (!success) {
        throw new Error('Send failed');
      }
    } catch (error) {
      setCommandStatus(prev => ({
        ...prev,
        debug_broadcast: {
          status: 'error',
          message: `Debug broadcast failed: ${error.message}`,
          timestamp: Date.now()
        }
      }));
    }
  };

  const getErrorFlags = useCallback((moduleId) => {
    if (moduleId === null || moduleId === undefined) return [];
    const moduleKey = `module_${moduleId}`;
    const moduleFaults = faultHistory[moduleKey] || {};
    return Object.values(moduleFaults);
  }, [faultHistory]);

  const combinedData = useMemo(() => {
    const combined = {
      temperatures: [],
      voltages: [],
      totalErrors: 0,
      activeModules: 0,
      totalStackVoltage: 0,
      hasStackVoltage: false,
      debugResponses: 0
    };

    MODULE_IDS.forEach(moduleId => {
      const module = moduleData[moduleId];
      if (!module) return;

      const temps = Object.values(module.temperatures || {});
      const volts = Object.values(module.voltages || {});
      combined.temperatures.push(...temps);
      combined.voltages.push(...volts);

      if (module.heartbeat) {
        combined.activeModules++;
        combined.totalErrors += getSignalValue(module.heartbeat.Fault_Count);
      }

      const bms1Voltage = normalizeStackVoltage(getSignalValue(module.bms1Status?.BMS1_Stack_Voltage, null));
      const bms2Voltage = normalizeStackVoltage(getSignalValue(module.bms2Status?.BMS2_Stack_Voltage, null));
      if (bms1Voltage !== null) {
        combined.totalStackVoltage += bms1Voltage;
        combined.hasStackVoltage = true;
      }
      if (bms2Voltage !== null) {
        combined.totalStackVoltage += bms2Voltage;
        combined.hasStackVoltage = true;
      }

      if (module.debugInfo) combined.debugResponses++;
    });

    return combined;
  }, [moduleData]);

  const moduleStats = useMemo(() => MODULE_IDS.map(moduleId => {
    const modData = moduleData[moduleId];
    const temps = Object.values(modData?.temperatures || {});
    const volts = Object.values(modData?.voltages || {});
    const tempStats = getExtrema(temps, isValidThermistorTemp);
    const voltStats = getExtrema(volts, isValidVoltage);

    const bms1StackVoltage = normalizeStackVoltage(getSignalValue(modData?.bms1Status?.BMS1_Stack_Voltage, null));
    const bms2StackVoltage = normalizeStackVoltage(getSignalValue(modData?.bms2Status?.BMS2_Stack_Voltage, null));
    const stackPieces = [bms1StackVoltage, bms2StackVoltage].filter(value => value !== null);
    const stackVoltage = stackPieces.length > 0 ? stackPieces.reduce((sum, value) => sum + value, 0) : null;

    const state = getSignalDisplayValue(modData?.heartbeat?.BMS_State, modData ? 'UNKNOWN' : 'OFFLINE');
    const faultCount = getSignalValue(modData?.heartbeat?.Fault_Count, 0);
    const errorFlags = getErrorFlags(moduleId);

    return {
      moduleId,
      data: modData,
      state,
      faultCount,
      hasFault: faultCount > 0 || state === 'FAULT',
      errorFlags,
      tempStats,
      voltStats,
      bms1StackVoltage,
      bms2StackVoltage,
      stackVoltage,
      bms1Temp: getSignalValue(modData?.bms1Status?.BMS1_IC_Temperature, null),
      bms2Temp: getSignalValue(modData?.bms2Status?.BMS2_IC_Temperature, null),
      canRx: getSignalValue(modData?.canStats?.RX_Message_Count, null),
      canTxOk: getSignalValue(modData?.canStats?.TX_Success_Count, null),
      canTxErr: getSignalValue(modData?.canStats?.TX_Error_Count, null),
      debugInfo: modData?.debugInfo || null,
      stale: moduleStale[moduleId]
    };
  }), [moduleData, moduleStale, getErrorFlags]);

  const packTempStats = getExtrema(combinedData.temperatures, isValidThermistorTemp);
  const packVoltageStats = getExtrema(combinedData.voltages, isValidVoltage);
  const voltageDelta = packVoltageStats.min && packVoltageStats.max ? packVoltageStats.max.value - packVoltageStats.min.value : null;
  const moduleDataCount = MODULE_IDS.filter(id => moduleData[id]).length;
  const debugSuccessCount = MODULE_IDS.filter(id => commandStatus[`debug_${id}`]?.status === 'success').length;
  const debugPendingCount = MODULE_IDS.filter(id => commandStatus[`debug_${id}`]?.status === 'pending').length;
  const debugBroadcastStatus = commandStatus.debug_broadcast;

  return (
    <div className="bms-status bms-status-redesign">
      <div className="bms-header bms-header-redesign">
        <div>
          <h2><Activity size={24} /> BMS Status Dashboard</h2>
          <p className="bms-subtitle">Pack-level health at a glance with per-module diagnostics below.</p>
        </div>
        <div className="dashboard-actions">
          <button className="btn-command btn-debug-broadcast" onClick={handleDebugRequest}>
            <Send size={16} />
            Debug Broadcast
          </button>
          <span className="can-id-pill">0x{DEBUG_BROADCAST_CAN_ID.toString(16).toUpperCase()}</span>
          {debugBroadcastStatus && (
            <div className={`command-status compact ${debugBroadcastStatus.status}`}>
              {debugBroadcastStatus.status === 'success' ? <CheckCircle size={14} /> : debugBroadcastStatus.status === 'pending' ? <Activity size={14} className="spinning" /> : <XCircle size={14} />}
              {debugBroadcastStatus.message}
            </div>
          )}
        </div>
      </div>

      {moduleDataCount === 0 && (
        <div className="no-data no-data-redesign">
          <Info size={48} />
          <p>No BMS telemetry received yet</p>
          <p className="hint">Connect to CAN bus and ensure modules are transmitting heartbeat, voltage, and temperature frames.</p>
        </div>
      )}

      <div className="bms-dashboard dashboard-overview">
        <section className="pack-hero-grid">
          <div className="hero-card hero-card-stack">
            <div className="hero-label"><Zap size={18} /> Pack Stack Voltage</div>
            <div className="hero-value">{combinedData.hasStackVoltage ? formatStackVoltage(combinedData.totalStackVoltage) : '--'}</div>
            <div className="hero-meta">{combinedData.activeModules} active modules / {moduleDataCount} reporting</div>
          </div>

          <div className="hero-card">
            <div className="hero-label"><TrendingDown size={18} /> Min Cell Voltage</div>
            <div className="hero-value">{packVoltageStats.min ? formatCellVoltage(packVoltageStats.min.value) : '--'}</div>
            <div className="hero-meta">{packVoltageStats.min ? `Module ${packVoltageStats.min.moduleId} - ${formatCellRef(packVoltageStats.min)}` : 'Waiting for cell voltage data'}</div>
          </div>

          <div className="hero-card">
            <div className="hero-label"><TrendingUp size={18} /> Max Cell Voltage</div>
            <div className="hero-value">{packVoltageStats.max ? formatCellVoltage(packVoltageStats.max.value) : '--'}</div>
            <div className="hero-meta">{packVoltageStats.max ? `Module ${packVoltageStats.max.moduleId} - ${formatCellRef(packVoltageStats.max)}` : 'Waiting for cell voltage data'}</div>
          </div>

          <div className="hero-card split-card">
            <div className="hero-label"><Thermometer size={18} /> Temperature Window</div>
            <div className="split-metrics">
              <div>
                <span className="split-label">Min</span>
                <strong>{packTempStats.min ? formatTemperature(packTempStats.min.value) : '--'}</strong>
                <small>{packTempStats.min ? `Module ${packTempStats.min.moduleId} - ${formatTempRef(packTempStats.min)}` : '--'}</small>
              </div>
              <div>
                <span className="split-label">Max</span>
                <strong>{packTempStats.max ? formatTemperature(packTempStats.max.value) : '--'}</strong>
                <small>{packTempStats.max ? `Module ${packTempStats.max.moduleId} - ${formatTempRef(packTempStats.max)}` : '--'}</small>
              </div>
            </div>
          </div>

          <div className="hero-card split-card">
            <div className="hero-label"><Activity size={18} /> Pack Health</div>
            <div className="split-metrics health-metrics">
              <div>
                <span className="split-label">Faults</span>
                <strong className={combinedData.totalErrors > 0 ? 'danger-text' : 'ok-text'}>{combinedData.totalErrors}</strong>
                <small>{combinedData.totalErrors > 0 ? 'active faults' : 'no active faults'}</small>
              </div>
              <div>
                <span className="split-label">Debug</span>
                <strong>{combinedData.debugResponses}/6</strong>
                <small>{debugPendingCount > 0 ? `${debugPendingCount} pending` : `${debugSuccessCount} recent replies`}</small>
              </div>
              <div>
                <span className="split-label">Delta V</span>
                <strong>{voltageDelta !== null ? formatCellVoltage(voltageDelta) : '--'}</strong>
                <small>{combinedData.voltages.length} cells</small>
              </div>
            </div>
          </div>
        </section>

        <ErrorBoundary>
          <section className="modules-grid-section modules-grid-section-redesign">
            <div className="section-heading-row">
              <div>
                <h3>Module Cards</h3>
                <p>Each card summarizes stack, voltage extremes, temperature extremes, faults, CAN stats, and debug responses.</p>
              </div>
              <div className="section-chip">{moduleDataCount}/6 reporting</div>
            </div>

            <div className="modules-grid modules-grid-redesign">
              {moduleStats.map(stats => {
                const { moduleId, data: modData, state, faultCount, hasFault, errorFlags, tempStats, voltStats, stackVoltage, bms1StackVoltage, bms2StackVoltage, bms1Temp, bms2Temp, canRx, canTxOk, canTxErr, debugInfo, stale } = stats;
                const debugStatus = commandStatus[`debug_${moduleId}`];
                const freeHeap = getSignalValue(debugInfo?.Free_Heap_KB, null);
                const minFreeHeap = getSignalValue(debugInfo?.Min_Free_Heap_KB, null);
                const uptime = getSignalValue(debugInfo?.Uptime_Seconds, null);
                const activeBank = getSignalDisplayValue(debugInfo?.Boot_Active_Bank, '--').replace('_', ' ');
                const legacyBootValid = getSignalValue(debugInfo?.Boot_Valid, null);

                return (
                  <article key={moduleId} className={`module-column module-card-v2 ${!modData ? 'offline' : hasFault ? 'has-fault' : 'active'} ${stale ? 'stale' : ''} ${isMobile && isExpanded(moduleId) ? 'expanded' : ''} ${isMobile && !isExpanded(moduleId) ? 'collapsed' : ''}`} title={stale ? `Stale - no data received in the last ${Math.round(staleTimeoutMs / 1000)}s` : undefined}>
                    <div
                      className="module-header module-header-v2"
                      onClick={isMobile ? () => toggleExpanded(moduleId) : undefined}
                      role={isMobile ? 'button' : undefined}
                      tabIndex={isMobile ? 0 : undefined}
                      onKeyDown={isMobile ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(moduleId); } } : undefined}
                    >
                      <span className="module-title">
                        {isMobile && (
                          isExpanded(moduleId)
                            ? <ChevronDown size={14} className="accordion-icon" />
                            : <ChevronRight size={14} className="accordion-icon" />
                        )}
                        Module {moduleId}
                      </span>
                      <span className="module-header-meta">
                        <span className={`status-badge ${state.toLowerCase()}`}>{stale ? `${state} (stale)` : state}</span>
                      </span>
                    </div>

                    <div className="module-content module-content-v2">
                      {!modData ? (
                        <div className="module-offline">
                          <Info size={20} />
                          <span>No data</span>
                        </div>
                      ) : (
                        <>
                          <div className="module-stack-strip">
                            <span>Stack</span>
                            <strong>{formatStackVoltage(stackVoltage)}</strong>
                            <small>BMS1 {formatStackVoltage(bms1StackVoltage)} / BMS2 {formatStackVoltage(bms2StackVoltage)}</small>
                          </div>

                          <div className="module-critical-grid">
                            <div className="critical-tile voltage-low">
                              <span>Min Cell V</span>
                              <strong>{voltStats.min ? formatCellVoltage(voltStats.min.value) : '--'}</strong>
                              <small>{formatCellRef(voltStats.min)}</small>
                            </div>
                            <div className="critical-tile voltage-high">
                              <span>Max Cell V</span>
                              <strong>{voltStats.max ? formatCellVoltage(voltStats.max.value) : '--'}</strong>
                              <small>{formatCellRef(voltStats.max)}</small>
                            </div>
                            <div className="critical-tile temp-low">
                              <span>Min Temp</span>
                              <strong>{tempStats.min ? formatPlainTemperature(tempStats.min.value) : '--'}</strong>
                              <small>{formatTempRef(tempStats.min)}</small>
                            </div>
                            <div className="critical-tile temp-high">
                              <span>Max Temp</span>
                              <strong>{tempStats.max ? formatPlainTemperature(tempStats.max.value) : '--'}</strong>
                              <small>{formatTempRef(tempStats.max)}</small>
                            </div>
                          </div>

                          <div className="module-section module-section-v2">
                            <div className="section-label">
                              <Thermometer size={12} />
                              <span>Averages</span>
                            </div>
                            <div className="inline-metrics">
                              <span>Cell Avg <strong>{voltStats.avg !== null ? formatCellVoltage(voltStats.avg) : '--'}</strong></span>
                              <span>Temp Avg <strong>{tempStats.avg !== null ? formatTemperature(tempStats.avg) : '--'}</strong></span>
                              <span>Delta <strong>{voltStats.min && voltStats.max ? formatCellVoltage(voltStats.max.value - voltStats.min.value) : '--'}</strong></span>
                            </div>
                          </div>

                          {hasFault && (
                            <div className="module-section module-section-v2 fault-section">
                              <div className="section-label fault">
                                <AlertTriangle size={12} />
                                <span>Faults ({faultCount})</span>
                              </div>
                              <div className="fault-tags">
                                {errorFlags.length > 0 ? errorFlags.map((flag, idx) => (
                                  <span key={idx} className={`fault-tag fault-${flag.type}`}>{flag.msg}</span>
                                )) : <span className="fault-tag fault-voltage">Fault count reported</span>}
                              </div>
                            </div>
                          )}

                          {(debugInfo || debugStatus?.status === 'pending' || debugStatus?.status === 'success' || debugStatus?.status === 'error') && (
                            <div className="module-section module-section-v2 debug-section-card">
                              <div className="section-label">
                                <Info size={12} />
                                <span>Debug</span>
                              </div>
                              {debugInfo ? (
                                <>
                                  <div className="debug-grid debug-core-grid">
                                    <span>Heap <strong>{freeHeap !== null ? `${freeHeap.toFixed(2)} KB` : '--'}</strong></span>
                                    <span>Min Heap <strong>{minFreeHeap !== null ? `${minFreeHeap.toFixed(2)} KB` : '--'}</strong></span>
                                    <span>Bank <strong>{activeBank}</strong></span>
                                    <span>Uptime <strong>{formatDuration(uptime)}</strong></span>
                                  </div>
                                  <div className="debug-boot-grid">
                                    {legacyBootValid !== null && !debugInfo.Boot_Active_App_Valid && (
                                      <span className={`boot-bit ${legacyBootValid === 1 ? 'ok' : 'danger'}`}>
                                        <small>Boot</small>
                                        <strong>{legacyBootValid === 1 ? 'Valid' : 'Invalid'}</strong>
                                      </span>
                                    )}
                                    {DEBUG_BOOT_FLAGS.map(field => (
                                      <span key={field.key} className={`boot-bit ${getBootFlagClass(debugInfo[field.key], field.okValue)}`}>
                                        <small>{field.label}</small>
                                        <strong>{formatBootFlagValue(debugInfo[field.key])}</strong>
                                      </span>
                                    ))}
                                  </div>
                                </>
                              ) : debugStatus?.status === 'pending' ? (
                              <div className="pending-inline"><Activity size={12} className="spinning" /> Waiting for debug reply...</div>
                              ) : (
                                <div className={`muted-inline ${debugStatus?.status || ''}`}>{debugStatus?.message || 'No debug response captured'}</div>
                              )}
                            </div>
                          )}

                          <div className="module-section module-section-v2 chip-temps-card">
                            <div className="section-label">
                              <Activity size={12} />
                              <span>Chip / CAN</span>
                            </div>
                            <div className="inline-metrics">
                              <span>BMS1 IC <strong>{formatTemperature(bms1Temp)}</strong></span>
                              <span>BMS2 IC <strong>{formatTemperature(bms2Temp)}</strong></span>
                              <span>RX <strong>{canRx ?? '--'}</strong></span>
                              <span>TX <strong>{canTxOk ?? '--'}</strong></span>
                              {canTxErr > 0 && <span className="danger-text">ERR <strong>{canTxErr}</strong></span>}
                            </div>
                          </div>

                          <div className="module-section module-section-v2 reset-section">
                            <div className="reset-buttons">
                              <button className="btn-reset btn-stm-reset" onClick={() => handleSTMResetDirect(moduleId)} title="Reset STM32 microcontroller">
                                STM Reset
                              </button>
                              <button className="btn-reset btn-bq-reset" onClick={() => handleBQResetDirect(moduleId)} title="Reset BQ76952 battery management chips">
                                BQ Reset
                              </button>
                            </div>
                            {commandStatus[`stm_reset_${moduleId}`] && (
                              <div className={`reset-status ${commandStatus[`stm_reset_${moduleId}`].status}`}>
                                {commandStatus[`stm_reset_${moduleId}`].message}
                              </div>
                            )}
                            {commandStatus[`bq_reset_${moduleId}`] && (
                              <div className={`reset-status ${commandStatus[`bq_reset_${moduleId}`].status}`}>
                                {commandStatus[`bq_reset_${moduleId}`].message}
                              </div>
                            )}
                            {debugStatus && debugStatus.status !== 'pending' && (
                              <div className={`reset-status ${debugStatus.status}`}>{debugStatus.message}</div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default BMSStatus;
