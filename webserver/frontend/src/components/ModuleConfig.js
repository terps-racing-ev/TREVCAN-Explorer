import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, Send, RefreshCw, Check, X, AlertTriangle } from 'lucide-react';
import './ModuleConfig.css';

// CAN ID calculation for BMS configuration
// Base ID: 0x08F0XF00 where X = module ID (bits 15:12)
const CONFIG_CMD_BASE = 0x08F00F00;
const CONFIG_ACK_BASE = 0x08F00F01;

// Command bytes
const CMD_SET_MODULE_ID = 0x01;
const CMD_SET_MAX_TEMP = 0x02;
const CMD_SET_MIN_TEMP = 0x03;
const CMD_SET_MIN_VOLTAGE = 0x04;
const CMD_SET_MAX_VOLTAGE = 0x05;
const CMD_GET_VALUE = 0x06;
const CMD_SET_BQ_MODE = 0x07;

// Parameter selectors for GET command
const PARAM_MODULE_ID = 0x01;
const PARAM_MAX_TEMP = 0x02;
const PARAM_MIN_TEMP = 0x03;
const PARAM_MIN_VOLTAGE = 0x04;
const PARAM_MAX_VOLTAGE = 0x05;
const PARAM_BQ_MODE = 0x06;
const PARAM_BQ_NORMAL_READ_INTERVAL = 0x07;
const PARAM_BQ_NORMAL_CAN_INTERVAL = 0x08;
const PARAM_BQ_SLEEP_READ_INTERVAL = 0x09;
const PARAM_BQ_SLEEP_CAN_INTERVAL = 0x0A;
const PARAM_I2C_TIMEOUT = 0x0B;
const PARAM_BALANCE_CMD_TIMEOUT = 0x0C;
const PARAM_BALANCE_REEVALUATE = 0x0D;
const PARAM_BALANCE_REFRESH = 0x0E;
const PARAM_BALANCE_OCV_SETTLE = 0x0F;
const PARAM_BALANCE_STATUS_INTERVAL = 0x10;
const PARAM_CAN_HEARTBEAT_INTERVAL = 0x11;
const PARAM_TEMP_SUMMARY_INTERVAL = 0x12;
const PARAM_CAN_TX_TIMEOUT = 0x13;

const READBACK_PARAM_DEFINITIONS = [
  { selector: PARAM_BQ_NORMAL_READ_INTERVAL, dbcName: 'BQ_NORMAL_READ_INT', key: 'bqNormalReadInterval', label: 'BQ Normal Read', unit: 'ms', is16Bit: true },
  { selector: PARAM_BQ_NORMAL_CAN_INTERVAL, dbcName: 'BQ_NORMAL_CAN_INT', key: 'bqNormalCanInterval', label: 'BQ Normal CAN', unit: 'ms', is16Bit: true },
  { selector: PARAM_BQ_SLEEP_READ_INTERVAL, dbcName: 'BQ_SLEEP_READ_INT', key: 'bqSleepReadInterval', label: 'BQ Sleep Read', unit: 'ms', is16Bit: true },
  { selector: PARAM_BQ_SLEEP_CAN_INTERVAL, dbcName: 'BQ_SLEEP_CAN_INT', key: 'bqSleepCanInterval', label: 'BQ Sleep CAN', unit: 'ms', is16Bit: true },
  { selector: PARAM_I2C_TIMEOUT, dbcName: 'I2C_TIMEOUT', key: 'i2cTimeout', label: 'I2C Timeout', unit: 'ms', is16Bit: false },
  { selector: PARAM_BALANCE_CMD_TIMEOUT, dbcName: 'BAL_CMD_TIMEOUT', key: 'balanceCmdTimeout', label: 'Balance Cmd Timeout', unit: 'ms', is16Bit: true },
  { selector: PARAM_BALANCE_REEVALUATE, dbcName: 'BAL_REEVALUATE', key: 'balanceReevaluate', label: 'Balance Reevaluate', unit: 'ms', is16Bit: true },
  { selector: PARAM_BALANCE_REFRESH, dbcName: 'BAL_REFRESH', key: 'balanceRefresh', label: 'Balance Refresh', unit: 'ms', is16Bit: true },
  { selector: PARAM_BALANCE_OCV_SETTLE, dbcName: 'BAL_OCV_SETTLE', key: 'balanceOcvSettle', label: 'Balance OCV Settle', unit: 'ms', is16Bit: true },
  { selector: PARAM_BALANCE_STATUS_INTERVAL, dbcName: 'BAL_STATUS_INT', key: 'balanceStatusInterval', label: 'Balance Status CAN', unit: 'ms', is16Bit: true },
  { selector: PARAM_CAN_HEARTBEAT_INTERVAL, dbcName: 'CAN_HEARTBEAT_INT', key: 'canHeartbeatInterval', label: 'CAN Heartbeat', unit: 'ms', is16Bit: true },
  { selector: PARAM_TEMP_SUMMARY_INTERVAL, dbcName: 'TEMP_SUMMARY_INT', key: 'tempSummaryInterval', label: 'Temp Summary CAN', unit: 'ms', is16Bit: true },
  { selector: PARAM_CAN_TX_TIMEOUT, dbcName: 'CAN_TX_TIMEOUT', key: 'canTxTimeout', label: 'CAN TX Timeout', unit: 'ms', is16Bit: false }
];

function ModuleConfig({ messages, onSendMessage, connected, onRegisterRawCallback }) {
  // Module configurations (keyed by module ID 0-15)
  const [moduleConfigs, setModuleConfigs] = useState({});
  // Input field values (separate from confirmed values)
  const [inputValues, setInputValues] = useState({});
  // Last ACK status per module
  const [ackStatus, setAckStatus] = useState({});
  // All 6 modules are always shown
  const activeModules = [0, 1, 2, 3, 4, 5];
  // Track which modules have responded (have any config data)
  const [respondingModules, setRespondingModules] = useState(new Set());
  // Loading state per module
  const [loadingModules, setLoadingModules] = useState({});
  // Global refresh in progress
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  
  // Track processed message timestamps to avoid re-processing
  const processedTimestampsRef = useRef(new Set());
  // Store active modules in ref for callback access
  const activeModulesRef = useRef(activeModules);
  
  // Calculate CAN ID for a module
  const getConfigCmdId = useCallback((moduleId) => CONFIG_CMD_BASE | (moduleId << 12), []);
  const getConfigAckId = useCallback((moduleId) => CONFIG_ACK_BASE | (moduleId << 12), []);

  // Helper function to extract signal value from different formats
  // Network driver returns: { signal_name: value }
  // PCAN/CANable local decoding returns: { signal_name: { value: ..., raw: ... } }
  const getSignalValue = useCallback((signals, signalName) => {
    const signal = signals[signalName];
    if (signal === undefined || signal === null) return undefined;
    
    // If it's an object with a 'value' property (local DBC decoding format)
    if (typeof signal === 'object' && signal !== null && 'value' in signal) {
      return signal.value;
    }
    
    // Otherwise it's a direct value (network driver format)
    return signal;
  }, []);

  const isGetValueCommand = (cmdEcho) => cmdEcho === 'GET_VALUE' || cmdEcho === CMD_GET_VALUE || cmdEcho === 6;
  const isSetBqModeCommand = (cmdEcho) => cmdEcho === 'SET_BQ_MODE' || cmdEcho === CMD_SET_BQ_MODE || cmdEcho === 7;
  const isSuccessStatus = (status) => status === 'SUCCESS' || status === 0 || status === 'Success';
  const isResetRequiredStatus = (status) =>
    status === 'NEEDS_RESET' ||
    status === 'SUCCESS_RESET_REQUIRED' ||
    status === 'Reset_Required' ||
    status === 2;
  const normalizeParam = (param) => (typeof param === 'string' ? param.toUpperCase() : param);
  const findReadbackParamDefinition = (param) => {
    const normalizedParam = normalizeParam(param);
    return READBACK_PARAM_DEFINITIONS.find(
      (def) => def.selector === normalizedParam || def.dbcName === normalizedParam
    );
  };

  // Process a single raw message (called for EVERY message, not aggregated)
  const processRawMessage = useCallback((msg) => {
    // Create unique key for this message
    const msgKey = `${msg.id}-${msg.timestamp}`;
    
    // Skip if already processed
    if (processedTimestampsRef.current.has(msgKey)) return;
    
    // Check each active module's ACK ID
    for (const moduleId of activeModulesRef.current) {
      const expectedAckId = CONFIG_ACK_BASE | (moduleId << 12);
      
      // Check if this message matches
      if (msg.id !== expectedAckId) continue;
      
      // Mark as processed
      processedTimestampsRef.current.add(msgKey);
      
      // Limit the set size to prevent memory growth
      if (processedTimestampsRef.current.size > 1000) {
        const arr = Array.from(processedTimestampsRef.current);
        processedTimestampsRef.current = new Set(arr.slice(-500));
      }
      
      // Extract data from decoded signals
      // Supports both network driver (server-side) and PCAN/CANable (local) DBC decoding
      const signals = msg.decoded?.signals;
      if (!signals) {
        console.log(`[ModuleConfig] Message matched but no decoded signals`);
        continue;
      }
      
      // Use helper to extract values from either signal format
      const cmdEcho = getSignalValue(signals, 'Command_Echo');
      const status = getSignalValue(signals, 'Status');
      const param = getSignalValue(signals, 'Byte2_OldVal_or_Param');
      const normalizedParam = normalizeParam(param);
      const valueLow = getSignalValue(signals, 'Byte3_NewVal_or_ValLo');
      const valueHigh = getSignalValue(signals, 'Byte4_ValHi') || 0;
      const combined16Bit = ((valueHigh & 0xFF) << 8) | (valueLow & 0xFF);
      const rawData = Array.isArray(msg.data) ? msg.data : [];
      const byte5Value = rawData.length > 5 ? rawData[5] : undefined;
      
      console.log(`[ModuleConfig] ✓ MATCHED ACK for module ${moduleId}: cmd=${cmdEcho}, status=${status}, param=${param}, value=${valueLow}`);
      
      // Mark this module as responding
      setRespondingModules(prev => new Set([...prev, moduleId]));
      
      if (isGetValueCommand(cmdEcho)) {
        // GET response - update module config based on parameter
        setModuleConfigs(prev => {
          const updated = { ...prev };
          if (!updated[moduleId]) {
            updated[moduleId] = {};
          }
          
          // Map parameter names to config fields
          if (normalizedParam === 'MODULE_ID' || normalizedParam === PARAM_MODULE_ID) {
            updated[moduleId].moduleId = valueLow;
            console.log(`[ModuleConfig] Module ${moduleId}: moduleId = ${valueLow}`);
          } else if (normalizedParam === 'MAX_TEMP' || normalizedParam === PARAM_MAX_TEMP) {
            updated[moduleId].maxTemp = valueLow;
            console.log(`[ModuleConfig] Module ${moduleId}: maxTemp = ${valueLow}°C`);
          } else if (normalizedParam === 'MIN_TEMP' || normalizedParam === PARAM_MIN_TEMP) {
            // Handle signed byte
            const signedVal = valueLow > 127 ? valueLow - 256 : valueLow;
            updated[moduleId].minTemp = signedVal;
            console.log(`[ModuleConfig] Module ${moduleId}: minTemp = ${signedVal}°C`);
          } else if (normalizedParam === 'MIN_VOLTAGE' || normalizedParam === PARAM_MIN_VOLTAGE) {
            updated[moduleId].minVoltage = valueLow * 100; // Convert to mV
            console.log(`[ModuleConfig] Module ${moduleId}: minVoltage = ${valueLow * 100}mV`);
          } else if (normalizedParam === 'MAX_VOLTAGE' || normalizedParam === PARAM_MAX_VOLTAGE) {
            updated[moduleId].maxVoltage = valueLow * 100; // Convert to mV
            console.log(`[ModuleConfig] Module ${moduleId}: maxVoltage = ${valueLow * 100}mV`);
          } else if (normalizedParam === 'BQ_MODE' || normalizedParam === PARAM_BQ_MODE) {
            // GET BQ Mode response: Byte3=BMS1 actual, Byte4=BMS2 actual, Byte5=cached mode
            updated[moduleId].bms1Mode = valueLow;
            updated[moduleId].bms2Mode = valueHigh;
            updated[moduleId].bqMode = valueLow; // Use BMS1 as primary display
            if (byte5Value !== undefined) {
              updated[moduleId].bqModeCached = byte5Value;
            }
            console.log(`[ModuleConfig] Module ${moduleId}: BQ Mode — BMS1=${valueLow === 0 ? 'NORMAL' : 'SLEEP'}, BMS2=${valueHigh === 0 ? 'NORMAL' : 'SLEEP'}`);
          } else {
            const readbackParam = findReadbackParamDefinition(normalizedParam);
            if (readbackParam) {
              updated[moduleId][readbackParam.key] = readbackParam.is16Bit ? combined16Bit : (valueLow & 0xFF);
              console.log(`[ModuleConfig] Module ${moduleId}: ${readbackParam.label} = ${updated[moduleId][readbackParam.key]}${readbackParam.unit}`);
            }
          }
          
          return updated;
        });
        
        // Update ACK status
        setAckStatus(prev => ({
          ...prev,
          [moduleId]: { type: 'get', success: isSuccessStatus(status), param: param, timestamp: Date.now() }
        }));
        
      } else {
        // SET response
        setAckStatus(prev => ({
          ...prev,
          [moduleId]: { 
            type: 'set', 
            cmd: cmdEcho, 
            success: isSuccessStatus(status) || isResetRequiredStatus(status),
            needsReset: isResetRequiredStatus(status),
            oldValue: param, 
            newValue: valueLow, 
            timestamp: Date.now() 
          }
        }));
        
        // If successful, refresh to get updated value
        if (isSuccessStatus(status) || isResetRequiredStatus(status)) {
          // The SET was successful, update the display
          setModuleConfigs(prev => {
            const updated = { ...prev };
            if (!updated[moduleId]) {
              updated[moduleId] = {};
            }
            
            // Map command echo to config field and update with new value
            if (cmdEcho === 'SET_MODULE_ID') {
              updated[moduleId].moduleId = valueLow;
            } else if (cmdEcho === 'SET_MAX_TEMP') {
              updated[moduleId].maxTemp = valueLow;
            } else if (cmdEcho === 'SET_MIN_TEMP') {
              updated[moduleId].minTemp = valueLow > 127 ? valueLow - 256 : valueLow;
            } else if (cmdEcho === 'SET_MIN_VOLTAGE') {
              updated[moduleId].minVoltage = valueLow * 100;
            } else if (cmdEcho === 'SET_MAX_VOLTAGE') {
              updated[moduleId].maxVoltage = valueLow * 100;
            } else if (isSetBqModeCommand(cmdEcho)) {
              // SET BQ Mode ACK: Byte2=BMS1 actual, Byte3=BMS2 actual, Byte4=requested
              updated[moduleId].bms1Mode = param; // Byte2 = BMS1 actual mode
              updated[moduleId].bms2Mode = valueLow; // Byte3 = BMS2 actual mode
              updated[moduleId].bqMode = param; // Use BMS1 as primary display
              updated[moduleId].bqModeRequested = valueHigh;
            }
            
            return updated;
          });
        }
      }
      
      break; // Found matching module, stop checking others
    }
  }, [getSignalValue]);

  // Register for raw messages when component mounts
  useEffect(() => {
    if (onRegisterRawCallback) {
      console.log('[ModuleConfig] Registering for raw message callbacks');
      const unregister = onRegisterRawCallback(processRawMessage);
      return () => {
        console.log('[ModuleConfig] Unregistering raw message callbacks');
        unregister();
      };
    }
  }, [onRegisterRawCallback, processRawMessage]);

  // Send GET request for all parameters of a module with delays between each request
  const refreshModule = useCallback(async (moduleId) => {
    if (!connected || !onSendMessage) return;
    
    setLoadingModules(prev => ({ ...prev, [moduleId]: true }));
    
    const canId = getConfigCmdId(moduleId);
    const baseParams = [PARAM_MODULE_ID, PARAM_MAX_TEMP, PARAM_MIN_TEMP, PARAM_MIN_VOLTAGE, PARAM_MAX_VOLTAGE, PARAM_BQ_MODE];
    const params = [...baseParams, ...READBACK_PARAM_DEFINITIONS.map((def) => def.selector)];
    const paramNames = ['Module ID', 'Max Temp', 'Min Temp', 'Min Voltage', 'Max Voltage', 'BQ Mode', ...READBACK_PARAM_DEFINITIONS.map((def) => def.label)];
    
    console.log(`[ModuleConfig] Refreshing module ${moduleId}, CAN ID: 0x${canId.toString(16).toUpperCase()}`);
    
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      console.log(`[ModuleConfig] Sending GET for ${paramNames[i]} (param ${param})`);
      await onSendMessage(canId, [CMD_GET_VALUE, param, 0, 0, 0, 0, 0, 0], true, false);
      // 500ms delay between parameter requests to ensure we receive and process each response
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    setLoadingModules(prev => ({ ...prev, [moduleId]: false }));
  }, [connected, onSendMessage, getConfigCmdId]);

  // Refresh all modules in parallel (each module's parameters are still sequential with delays)
  const refreshAllModules = useCallback(async () => {
    if (!connected || !onSendMessage || isRefreshingAll) return;
    
    setIsRefreshingAll(true);
    console.log(`[ModuleConfig] Refreshing all ${activeModules.length} modules in parallel`);
    
    // Start all module refreshes in parallel
    await Promise.all(activeModules.map(moduleId => refreshModule(moduleId)));
    
    setIsRefreshingAll(false);
  }, [connected, onSendMessage, activeModules, refreshModule, isRefreshingAll]);

  // Refresh all active modules on mount and when connection changes
  useEffect(() => {
    if (connected) {
      // Small delay to let connection stabilize
      const timer = setTimeout(() => {
        refreshAllModules();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Send SET command
  const sendSetCommand = useCallback(async (moduleId, cmd, value) => {
    if (!connected || !onSendMessage) return;
    
    const canId = getConfigCmdId(moduleId);
    let byteValue = value;
    
    // Handle signed values for temperature
    if (cmd === CMD_SET_MIN_TEMP && value < 0) {
      byteValue = 256 + value; // Convert to unsigned byte representation
    }
    
    // Convert voltage to scaled value
    if (cmd === CMD_SET_MIN_VOLTAGE || cmd === CMD_SET_MAX_VOLTAGE) {
      byteValue = Math.round(value / 100); // Convert mV to scaled value
    }
    
    console.log(`[ModuleConfig] Sending SET cmd=0x${cmd.toString(16)}, value=${byteValue} to 0x${canId.toString(16).toUpperCase()}`);
    await onSendMessage(canId, [cmd, byteValue & 0xFF, 0, 0, 0, 0, 0, 0], true, false);
  }, [connected, onSendMessage, getConfigCmdId]);

  // Handle input change
  const handleInputChange = (moduleId, field, value) => {
    setInputValues(prev => ({
      ...prev,
      [moduleId]: {
        ...prev[moduleId],
        [field]: value
      }
    }));
  };

  // Get display value (input if modified, otherwise current config)
  const getDisplayValue = (moduleId, field, defaultValue = '') => {
    if (inputValues[moduleId]?.[field] !== undefined) {
      return inputValues[moduleId][field];
    }
    if (moduleConfigs[moduleId]?.[field] !== undefined) {
      return moduleConfigs[moduleId][field];
    }
    return defaultValue;
  };

  // Check if value has been modified
  const isModified = (moduleId, field) => {
    const inputVal = inputValues[moduleId]?.[field];
    const configVal = moduleConfigs[moduleId]?.[field];
    return inputVal !== undefined && inputVal !== '' && String(inputVal) !== String(configVal);
  };

  // Clear ACK status after 5 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setAckStatus(prev => {
        const updated = { ...prev };
        let changed = false;
        Object.keys(updated).forEach(key => {
          if (now - updated[key].timestamp > 5000) {
            delete updated[key];
            changed = true;
          }
        });
        return changed ? updated : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="module-config">
      <div className="module-config-header">
        <Settings size={18} />
        <h2>BMS Module Configuration</h2>
        <button 
          onClick={refreshAllModules} 
          disabled={!connected || isRefreshingAll}
          className={`refresh-all-btn ${isRefreshingAll ? 'loading' : ''}`}
          title="Refresh all modules sequentially"
        >
          <RefreshCw size={14} className={isRefreshingAll ? 'spinning' : ''} />
          {isRefreshingAll ? 'Refreshing...' : 'Refresh All'}
        </button>
      </div>

      {!connected && (
        <div className="config-warning">
          <AlertTriangle size={14} />
          <span>Connect to CAN bus to configure modules</span>
        </div>
      )}

      <div className="modules-container">
        {activeModules.map(moduleId => {
          const config = moduleConfigs[moduleId] || {};
          const ack = ackStatus[moduleId];
          const isLoading = loadingModules[moduleId];
          const canIdHex = `0x${getConfigCmdId(moduleId).toString(16).toUpperCase()}`;
          const isResponding = respondingModules.has(moduleId);
          
          return (
            <div key={moduleId} className={`module-card ${isResponding ? 'responding' : 'not-responding'}`}>
              <div className="module-card-header">
                <h3>Module {moduleId}</h3>
                <span className="can-id-badge">{canIdHex}</span>
                {!isResponding && <span className="offline-badge">Offline</span>}
                <div className="module-actions">
                  <button 
                    onClick={() => refreshModule(moduleId)} 
                    disabled={!connected || isLoading}
                    className={`refresh-btn ${isLoading ? 'loading' : ''}`}
                    title="Refresh all values (1s between each)"
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
              </div>

              {ack && (
                <div className={`ack-status ${ack.success ? 'success' : 'error'}`}>
                  {ack.success ? <Check size={12} /> : <X size={12} />}
                  {ack.type === 'set' ? (
                    <>
                      {ack.success ? 'Set OK' : 'Set failed'}
                      {ack.needsReset && ' (Reset required)'}
                      {ack.success && ` (${ack.oldValue} → ${ack.newValue})`}
                    </>
                  ) : (
                    ack.success ? 'Value received' : 'Read failed'
                  )}
                </div>
              )}

              <div className="config-grid">
                {/* Module ID */}
                <div className="config-row">
                  <label>Module ID</label>
                  <div className="config-value">
                    <span className={`current-value ${config.moduleId === undefined ? 'placeholder' : ''}`}>
                      {config.moduleId !== undefined ? config.moduleId : '—'}
                    </span>
                  </div>
                  <div className="config-input">
                    <input
                      type="number"
                      min="0"
                      max="15"
                      value={getDisplayValue(moduleId, 'newModuleId', '')}
                      onChange={(e) => handleInputChange(moduleId, 'newModuleId', e.target.value)}
                      placeholder="0-15"
                      disabled={!connected}
                    />
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_MODULE_ID, parseInt(inputValues[moduleId]?.newModuleId))}
                      disabled={!connected || !isModified(moduleId, 'newModuleId')}
                      className="set-btn"
                      title="Set (requires reset)"
                    >
                      <Send size={10} />
                    </button>
                  </div>
                </div>

                {/* Max Temperature */}
                <div className="config-row">
                  <label>Max Temp</label>
                  <div className="config-value">
                    <span className={`current-value ${config.maxTemp === undefined ? 'placeholder' : ''}`}>
                      {config.maxTemp !== undefined ? `${config.maxTemp}°C` : '—'}
                    </span>
                  </div>
                  <div className="config-input">
                    <input
                      type="number"
                      min="0"
                      max="127"
                      value={getDisplayValue(moduleId, 'maxTemp', '')}
                      onChange={(e) => handleInputChange(moduleId, 'maxTemp', e.target.value)}
                      placeholder="°C"
                      disabled={!connected}
                    />
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_MAX_TEMP, parseInt(inputValues[moduleId]?.maxTemp))}
                      disabled={!connected || !isModified(moduleId, 'maxTemp')}
                      className="set-btn"
                    >
                      <Send size={10} />
                    </button>
                  </div>
                </div>

                {/* Min Temperature */}
                <div className="config-row">
                  <label>Min Temp</label>
                  <div className="config-value">
                    <span className={`current-value ${config.minTemp === undefined ? 'placeholder' : ''}`}>
                      {config.minTemp !== undefined ? `${config.minTemp}°C` : '—'}
                    </span>
                  </div>
                  <div className="config-input">
                    <input
                      type="number"
                      min="-128"
                      max="127"
                      value={getDisplayValue(moduleId, 'minTemp', '')}
                      onChange={(e) => handleInputChange(moduleId, 'minTemp', e.target.value)}
                      placeholder="°C"
                      disabled={!connected}
                    />
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_MIN_TEMP, parseInt(inputValues[moduleId]?.minTemp))}
                      disabled={!connected || !isModified(moduleId, 'minTemp')}
                      className="set-btn"
                    >
                      <Send size={10} />
                    </button>
                  </div>
                </div>

                {/* Min Voltage */}
                <div className="config-row">
                  <label>Min Voltage</label>
                  <div className="config-value">
                    <span className={`current-value ${config.minVoltage === undefined ? 'placeholder' : ''}`}>
                      {config.minVoltage !== undefined ? `${config.minVoltage}mV` : '—'}
                    </span>
                  </div>
                  <div className="config-input">
                    <input
                      type="number"
                      min="0"
                      max="25500"
                      step="100"
                      value={getDisplayValue(moduleId, 'minVoltage', '')}
                      onChange={(e) => handleInputChange(moduleId, 'minVoltage', e.target.value)}
                      placeholder="mV"
                      disabled={!connected}
                    />
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_MIN_VOLTAGE, parseInt(inputValues[moduleId]?.minVoltage))}
                      disabled={!connected || !isModified(moduleId, 'minVoltage')}
                      className="set-btn"
                    >
                      <Send size={10} />
                    </button>
                  </div>
                </div>

                {/* Max Voltage */}
                <div className="config-row">
                  <label>Max Voltage</label>
                  <div className="config-value">
                    <span className={`current-value ${config.maxVoltage === undefined ? 'placeholder' : ''}`}>
                      {config.maxVoltage !== undefined ? `${config.maxVoltage}mV` : '—'}
                    </span>
                  </div>
                  <div className="config-input">
                    <input
                      type="number"
                      min="0"
                      max="25500"
                      step="100"
                      value={getDisplayValue(moduleId, 'maxVoltage', '')}
                      onChange={(e) => handleInputChange(moduleId, 'maxVoltage', e.target.value)}
                      placeholder="mV"
                      disabled={!connected}
                    />
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_MAX_VOLTAGE, parseInt(inputValues[moduleId]?.maxVoltage))}
                      disabled={!connected || !isModified(moduleId, 'maxVoltage')}
                      className="set-btn"
                    >
                      <Send size={10} />
                    </button>
                  </div>
                </div>

                {/* BQ Power Mode */}
                <div className="config-row bq-mode-row">
                  <label>BQ Power Mode</label>
                  <div className="config-value bq-mode-value">
                    {config.bqMode !== undefined ? (
                      <span className="bq-mode-status">
                        <span className={`chip-mode ${config.bms1Mode === 0 ? 'normal' : 'sleep'}`}>
                          BMS1: {config.bms1Mode === 0 ? 'NORMAL' : 'SLEEP'}
                        </span>
                        <span className={`chip-mode ${config.bms2Mode === 0 ? 'normal' : 'sleep'}`}>
                          BMS2: {config.bms2Mode === 0 ? 'NORMAL' : 'SLEEP'}
                        </span>
                        {config.bqModeCached !== undefined && (
                          <span className={`chip-mode ${config.bqModeCached === 0 ? 'normal' : 'sleep'}`}>
                            Cached: {config.bqModeCached === 0 ? 'NORMAL' : 'SLEEP'}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="current-value placeholder">—</span>
                    )}
                  </div>
                  <div className="config-input bq-mode-toggle">
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_BQ_MODE, 0)}
                      disabled={!connected}
                      className={`toggle-btn ${config.bqMode === 0 ? 'active normal' : ''}`}
                      title="Set BQ chips to NORMAL mode (500ms read cycle)"
                    >
                      Normal
                    </button>
                    <button
                      onClick={() => sendSetCommand(moduleId, CMD_SET_BQ_MODE, 1)}
                      disabled={!connected}
                      className={`toggle-btn ${config.bqMode === 1 ? 'active sleep' : ''}`}
                      title="Set BQ chips to SLEEP mode (5000ms read cycle)"
                    >
                      Sleep
                    </button>
                  </div>
                </div>

                <div className="readback-section">
                  <div className="readback-title">Firmware Readback (Read Only)</div>
                  {READBACK_PARAM_DEFINITIONS.map((field) => (
                    <div className="config-row readback-row" key={field.key}>
                      <label>{field.label}</label>
                      <div className="config-value">
                        <span className={`current-value ${config[field.key] === undefined ? 'placeholder' : ''}`}>
                          {config[field.key] !== undefined ? `${config[field.key]}${field.unit}` : '—'}
                        </span>
                      </div>
                      <div className="config-input read-only-input">
                        <span className="read-only-pill">Read only</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="config-note">
                <small>Temp/voltage/BQ mode settings reset to defaults on power cycle. Balancing forces NORMAL mode.</small>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ModuleConfig;
