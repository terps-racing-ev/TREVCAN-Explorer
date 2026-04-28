import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Battery, Activity, Gauge, Thermometer, AlertTriangle, Zap, RotateCcw } from 'lucide-react';
import { apiService } from '../services/api';
import './HVCDashboard.css';

const STALE_THRESHOLD_SECONDS = 5;
const HVC_RESET_CAN_ID = 0x004001F6;
const HVC_RESET_DATA = [0, 0, 0, 0, 0, 0, 0, 0];
const HVC_TEST_MIN_VOLTAGE = 2.5;
const HVC_TEST_MAX_VOLTAGE = 4.3;
const HVC_TEST_MIN_TEMP = 20;
const HVC_TEST_MAX_TEMP = 80;
const HVC_TEST_DEBOUNCE_MS = 180;

const EPOCH_SECONDS_MIN = 946684800; // 2000-01-01
const EPOCH_SECONDS_MAX = 4102444800; // 2100-01-01

const normalizeTimestampToEpochSeconds = (timestamp) => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return null;
  }

  // Support backends that accidentally send epoch milliseconds.
  if (timestamp > EPOCH_SECONDS_MAX * 1000) {
    const seconds = timestamp / 1000;
    if (seconds >= EPOCH_SECONDS_MIN && seconds <= EPOCH_SECONDS_MAX) {
      return seconds;
    }
    return null;
  }

  if (timestamp >= EPOCH_SECONDS_MIN && timestamp <= EPOCH_SECONDS_MAX) {
    return timestamp;
  }

  // Non-epoch timestamps (monotonic/device timebase) are not comparable.
  return null;
};

const getNumericSignalValue = (signal) => {
  if (signal === undefined || signal === null) {
    return null;
  }

  if (typeof signal === 'number') {
    return signal;
  }

  if (typeof signal === 'object') {
    if (typeof signal.raw === 'number') {
      return signal.raw;
    }
    if (typeof signal.value === 'number') {
      return signal.value;
    }
    if (typeof signal.raw === 'string' && signal.raw.trim() !== '' && !Number.isNaN(Number(signal.raw))) {
      return Number(signal.raw);
    }
    if (typeof signal.value === 'string' && signal.value.trim() !== '' && !Number.isNaN(Number(signal.value))) {
      return Number(signal.value);
    }
  }

  return null;
};

const getSignalDisplayValue = (signal, fallback = '--') => {
  if (signal === undefined || signal === null) {
    return fallback;
  }

  if (typeof signal === 'object') {
    if (typeof signal.value === 'string' && typeof signal.raw === 'number') {
      return `${signal.value} (${signal.raw})`;
    }
    if (signal.value !== undefined && signal.value !== null) {
      return String(signal.value);
    }
    if (signal.raw !== undefined && signal.raw !== null) {
      return String(signal.raw);
    }
    return fallback;
  }

  return String(signal);
};

const getSignalBooleanValue = (signal) => {
  const numericValue = getNumericSignalValue(signal);
  if (numericValue !== null) {
    return numericValue !== 0;
  }

  const textValue = getSignalDisplayValue(signal, '').toLowerCase();
  if (!textValue) {
    return null;
  }

  if (textValue.includes('inactive') || textValue.includes('false')) {
    return false;
  }
  if (textValue.includes('active') || textValue.includes('true')) {
    return true;
  }
  if (textValue.includes('ok') || textValue.includes('closed')) {
    return true;
  }
  if (textValue.includes('fault') || textValue.includes('error') || textValue.includes('open')) {
    return false;
  }

  return null;
};

const formatSoc = (signal) => {
  const value = getNumericSignalValue(signal);
  if (value === null) {
    return '--';
  }
  return `${value.toFixed(2)}%`;
};

const formatVoltsFromMilli = (signal) => {
  const value = getNumericSignalValue(signal);
  if (value === null) {
    return '--';
  }
  return `${(value / 1000).toFixed(2)} V`;
};

const formatAmpsFromMilli = (signal) => {
  const value = getNumericSignalValue(signal);
  if (value === null) {
    return '--';
  }
  return `${(value / 1000).toFixed(2)} A`;
};

const formatTemperature = (signal) => {
  const value = getNumericSignalValue(signal);
  if (value === null) {
    return '--';
  }
  return `${value.toFixed(1)} C`;
};

const formatCapacityAh = (signal) => {
  const value = getNumericSignalValue(signal);
  if (value === null) {
    return '--';
  }

  // DBC value is in A*s; convert to Ah for display.
  return `${(value / 3600).toFixed(2)} Ah`;
};

const HVC_BMS_STATES = ['INIT', 'IDLE', 'CHARGING', 'DISCHARGING', 'BALANCING', 'FAULT', 'SHUTDOWN'];

const normalizeBmsState = (stateText) => {
  const normalized = String(stateText || '').toUpperCase();
  return HVC_BMS_STATES.find((state) => normalized.includes(state)) || null;
};

const getBmsStateClass = (stateText) => {
  const normalized = normalizeBmsState(stateText);
  return normalized ? `hvc-state-${normalized.toLowerCase()}` : 'hvc-state-unknown';
};

const formatStateFlagLabel = (flagName) => {
  if (!flagName) {
    return '';
  }

  return flagName
    .replace(/^Err_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const getFreshness = (timestamp, nowSeconds) => {
  if (!timestamp) {
    return {
      label: 'No data',
      className: 'missing'
    };
  }

  const age = Math.max(0, nowSeconds - timestamp);
  if (age > STALE_THRESHOLD_SECONDS) {
    return {
      label: `${age.toFixed(1)}s old`,
      className: 'stale'
    };
  }

  return {
    label: `${age.toFixed(1)}s old`,
    className: 'fresh'
  };
};

const statusBadge = (label, isGood) => {
  if (isGood === null) {
    return <span className="hvc-badge unknown">{label}: ?</span>;
  }

  return <span className={`hvc-badge ${isGood ? 'good' : 'bad'}`}>{label}: {isGood ? 'OK' : 'FAULT'}</span>;
};

const faultBadge = (label, signal) => {
  const value = getNumericSignalValue(signal);
  if (value === null) {
    return <span className="hvc-badge unknown">{label}: ?</span>;
  }

  const isGood = value === 0;
  return <span className={`hvc-badge ${isGood ? 'good' : 'bad'}`}>{label}: {isGood ? 'OK' : 'FAULT'}</span>;
};

function HVCDashboard({ messages, onSendMessage }) {
  const [nowSeconds, setNowSeconds] = useState(() => Date.now() / 1000);
  const [isResetSending, setIsResetSending] = useState(false);
  const [resetStatus, setResetStatus] = useState(null);
  const [hvcTestModeEnabled, setHvcTestModeEnabled] = useState(false);
  const [hvcTestModeBusy, setHvcTestModeBusy] = useState(false);
  const [hvcTestStatus, setHvcTestStatus] = useState(null);
  const [hvcTestConfig, setHvcTestConfig] = useState({
    minVoltageV: 3.2,
    maxVoltageV: 4.1,
    minTempC: 28,
    maxTempC: 55,
    errorFlagsByte0: 0,
    errorFlagsByte1: 0,
    errorFlagsByte2: 0,
    errorFlagsByte3: 0,
    warningSummary: 0,
    faultCount: 0
  });
  const hvcTestHydratedRef = useRef(false);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowSeconds(Date.now() / 1000);
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadTestModeStatus = async () => {
      try {
        const status = await apiService.getHVCTestModeStatus();
        if (!isMounted || !status) {
          return;
        }

        setHvcTestModeEnabled(Boolean(status.enabled));

        if (status.all_modules) {
          const minVoltageV = Math.max(
            HVC_TEST_MIN_VOLTAGE,
            Math.min(HVC_TEST_MAX_VOLTAGE, Number(status.all_modules.min_voltage_v ?? 3.2))
          );
          const maxVoltageV = Math.max(
            minVoltageV,
            Math.min(HVC_TEST_MAX_VOLTAGE, Number(status.all_modules.max_voltage_v ?? 4.1))
          );
          const minTempC = Math.max(
            HVC_TEST_MIN_TEMP,
            Math.min(HVC_TEST_MAX_TEMP, Number(status.all_modules.min_temp_c ?? 28))
          );
          const maxTempC = Math.max(
            minTempC,
            Math.min(HVC_TEST_MAX_TEMP, Number(status.all_modules.max_temp_c ?? 55))
          );

          const heartbeatErrors = status.heartbeat_errors || {};
          const asByte = (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
              return 0;
            }
            return Math.max(0, Math.min(255, Math.round(parsed)));
          };

          setHvcTestConfig({
            minVoltageV,
            maxVoltageV,
            minTempC,
            maxTempC,
            errorFlagsByte0: asByte(heartbeatErrors.error_flags_byte0),
            errorFlagsByte1: asByte(heartbeatErrors.error_flags_byte1),
            errorFlagsByte2: asByte(heartbeatErrors.error_flags_byte2),
            errorFlagsByte3: asByte(heartbeatErrors.error_flags_byte3),
            warningSummary: asByte(heartbeatErrors.warning_summary),
            faultCount: asByte(heartbeatErrors.fault_count)
          });
        }
      } catch (error) {
        if (isMounted) {
          setHvcTestStatus({
            type: 'error',
            text: `Failed to load test mode status: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`
          });
        }
      } finally {
        if (isMounted) {
          hvcTestHydratedRef.current = true;
        }
      }
    };

    loadTestModeStatus();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!hvcTestHydratedRef.current) {
      return undefined;
    }

    const timeoutId = setTimeout(async () => {
      try {
        await apiService.setHVCTestModeConfig(hvcTestConfig);
      } catch (error) {
        setHvcTestStatus({
          type: 'error',
          text: `Failed to update test mode config: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`
        });
      }
    }, HVC_TEST_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [hvcTestConfig]);

  const hvcFrames = useMemo(() => {
    const byName = {
      ioSummary: null,
      bmsState: null,
      soc: null,
      accSummary: null,
      ioVSense: null,
      ioCurrent: null
    };

    messages.forEach((msg) => {
      if (!msg.decoded || !msg.decoded.signals) {
        return;
      }

      const messageName = msg.decoded.message_name;
      const frame = {
        signals: msg.decoded.signals,
        timestamp:
          normalizeTimestampToEpochSeconds(msg.timestamp)
          ?? normalizeTimestampToEpochSeconds(msg.clientTimestamp)
      };

      if (messageName === 'IO_Summary') {
        byName.ioSummary = frame;
      } else if (messageName === 'BMS_State') {
        byName.bmsState = frame;
      } else if (messageName === 'SOC') {
        byName.soc = frame;
      } else if (messageName === 'ACC_Summary') {
        byName.accSummary = frame;
      } else if (messageName === 'IO_VSense') {
        byName.ioVSense = frame;
      } else if (messageName === 'IO_Current') {
        byName.ioCurrent = frame;
      }
    });

    return byName;
  }, [messages]);

  const hasAnyData = Object.values(hvcFrames).some((frame) => frame !== null);

  const socSignals = hvcFrames.soc?.signals || {};
  const accSignals = hvcFrames.accSummary?.signals || {};
  const ioSummarySignals = hvcFrames.ioSummary?.signals || {};
  const bmsStateSignals = hvcFrames.bmsState?.signals || {};
  const ioVSenseSignals = hvcFrames.ioVSense?.signals || {};
  const ioCurrentSignals = hvcFrames.ioCurrent?.signals || {};

  const bmsStateText = getSignalDisplayValue(bmsStateSignals.BMS_State);
  const normalizedBmsState = normalizeBmsState(bmsStateText);
  const bmsStateFlags = Object.entries(bmsStateSignals)
    .filter(([signalName]) => signalName.startsWith('Err_'))
    .sort(([a], [b]) => a.localeCompare(b));

  const handleResetHVC = async () => {
    if (typeof onSendMessage !== 'function') {
      setResetStatus({
        type: 'error',
        text: 'Reset unavailable: send handler missing'
      });
      return;
    }

    const confirmed = window.confirm('Send HVC reset command now?');
    if (!confirmed) {
      return;
    }

    setIsResetSending(true);
    setResetStatus({ type: 'pending', text: 'Sending reset command...' });

    try {
      const success = await onSendMessage(HVC_RESET_CAN_ID, HVC_RESET_DATA, true, false);
      if (success) {
        setResetStatus({
          type: 'success',
          text: `Reset sent: 0x${HVC_RESET_CAN_ID.toString(16).toUpperCase()}`
        });
      } else {
        setResetStatus({ type: 'error', text: 'Failed to send reset command' });
      }
    } catch (error) {
      setResetStatus({
        type: 'error',
        text: `Failed to send reset command: ${error?.message || 'Unknown error'}`
      });
    } finally {
      setIsResetSending(false);
    }
  };

  const handleToggleHvcTestMode = async () => {
    const nextEnabled = !hvcTestModeEnabled;
    setHvcTestModeBusy(true);
    setHvcTestStatus({
      type: 'pending',
      text: nextEnabled ? 'Enabling HVC test mode...' : 'Disabling HVC test mode...'
    });

    try {
      const status = await apiService.setHVCTestModeEnabled(nextEnabled);
      const enabled = Boolean(status?.enabled);
      setHvcTestModeEnabled(enabled);

      setHvcTestStatus({
        type: 'success',
        text: enabled ? 'HVC test mode enabled' : 'HVC test mode disabled'
      });
    } catch (error) {
      setHvcTestStatus({
        type: 'error',
        text: `Failed to toggle test mode: ${error?.response?.data?.detail || error?.message || 'Unknown error'}`
      });
    } finally {
      setHvcTestModeBusy(false);
    }
  };

  const handleMinVoltageChange = (rawValue) => {
    const parsed = Number(rawValue);
    if (Number.isNaN(parsed)) {
      return;
    }

    setHvcTestConfig((prev) => ({
      ...prev,
      minVoltageV: Number(Math.min(parsed, prev.maxVoltageV).toFixed(2))
    }));
  };

  const handleMaxVoltageChange = (rawValue) => {
    const parsed = Number(rawValue);
    if (Number.isNaN(parsed)) {
      return;
    }

    setHvcTestConfig((prev) => ({
      ...prev,
      maxVoltageV: Number(Math.max(parsed, prev.minVoltageV).toFixed(2))
    }));
  };

  const handleMinTempChange = (rawValue) => {
    const parsed = Number(rawValue);
    if (Number.isNaN(parsed)) {
      return;
    }

    setHvcTestConfig((prev) => ({
      ...prev,
      minTempC: Math.min(parsed, prev.maxTempC)
    }));
  };

  const handleMaxTempChange = (rawValue) => {
    const parsed = Number(rawValue);
    if (Number.isNaN(parsed)) {
      return;
    }

    setHvcTestConfig((prev) => ({
      ...prev,
      maxTempC: Math.max(parsed, prev.minTempC)
    }));
  };

  const handleHeartbeatFieldChange = (field, rawValue) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return;
    }

    setHvcTestConfig((prev) => ({
      ...prev,
      [field]: Math.max(0, Math.min(255, Math.round(parsed)))
    }));
  };

  return (
    <div className="hvc-dashboard">
      <div className="hvc-header">
        <div className="hvc-header-left">
          <h2>HVC Dashboard</h2>
          <p>Realtime high-voltage controller telemetry and health.</p>
        </div>
        <div className="hvc-header-actions">
          <button
            type="button"
            className="hvc-reset-btn"
            onClick={handleResetHVC}
            disabled={isResetSending}
            title="Send HVC reset message"
          >
            <RotateCcw size={15} />
            {isResetSending ? 'Sending...' : 'Reset HVC'}
          </button>
          {resetStatus && (
            <span className={`hvc-reset-status ${resetStatus.type}`}>
              {resetStatus.text}
            </span>
          )}
        </div>
      </div>

      {!hasAnyData && (
        <div className="hvc-empty-state">
          <AlertTriangle size={30} />
          <div>
            <h3>No HVC data received yet</h3>
            <p>Connect to CAN and ensure io_messages.dbc is enabled to populate this dashboard.</p>
          </div>
        </div>
      )}

      <div className="hvc-kpi-grid">
        <div className="hvc-kpi-card">
          <div className="kpi-header">
            <Battery size={18} />
            <span>SOC</span>
            <span className={`freshness ${getFreshness(hvcFrames.soc?.timestamp, nowSeconds).className}`}>
              {getFreshness(hvcFrames.soc?.timestamp, nowSeconds).label}
            </span>
          </div>
          <div className="hvc-kpi-body">
            <div className="kpi-value">{formatSoc(socSignals.SOC_Percent)}</div>
            <div className="kpi-subline">Capacity: {formatCapacityAh(socSignals.SOC_Capacity_As)}</div>
            <div className="kpi-subline">Delta: {formatCapacityAh(socSignals.SOC_Delta_As)}</div>
          </div>
        </div>

        <div className="hvc-kpi-card">
          <div className="kpi-header">
            <Zap size={18} />
            <span>IO VSense</span>
            <span className={`freshness ${getFreshness(hvcFrames.ioVSense?.timestamp, nowSeconds).className}`}>
              {getFreshness(hvcFrames.ioVSense?.timestamp, nowSeconds).label}
            </span>
          </div>
          <div className="hvc-kpi-body">
            <div className="hvc-vsense-grid">
              <div className="hvc-vsense-row">
                <span className="hvc-vsense-label">Battery</span>
                <span className="hvc-vsense-value">{formatVoltsFromMilli(ioVSenseSignals.Batt_Voltage_mV)}</span>
              </div>
              <div className="hvc-vsense-row">
                <span className="hvc-vsense-label">Inverter</span>
                <span className="hvc-vsense-value">{formatVoltsFromMilli(ioVSenseSignals.Inv_Voltage_mV)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="hvc-kpi-card">
          <div className="kpi-header">
            <Activity size={18} />
            <span>IO Current</span>
            <span className={`freshness ${getFreshness(hvcFrames.ioCurrent?.timestamp, nowSeconds).className}`}>
              {getFreshness(hvcFrames.ioCurrent?.timestamp, nowSeconds).label}
            </span>
          </div>
          <div className="hvc-kpi-body">
            <div className="kpi-subline">Low: <strong>{formatAmpsFromMilli(ioCurrentSignals.Current_Low_mA)}</strong></div>
            <div className="kpi-subline">High: <strong>{formatAmpsFromMilli(ioCurrentSignals.Current_High_mA)}</strong></div>
          </div>
        </div>
      </div>

      <div className="hvc-section-grid">
        <section className="hvc-section-card">
          <div className="section-header">
            <Thermometer size={17} />
            <h3>ACC Summary</h3>
            <span className={`freshness ${getFreshness(hvcFrames.accSummary?.timestamp, nowSeconds).className}`}>
              {getFreshness(hvcFrames.accSummary?.timestamp, nowSeconds).label}
            </span>
          </div>
          <div className="metric-grid">
            <div className="metric-row">
              <span>Voltage Min</span>
              <strong>{formatVoltsFromMilli(accSignals.Acc_Volt_Min_mV)}</strong>
            </div>
            <div className="metric-row">
              <span>Voltage Max</span>
              <strong>{formatVoltsFromMilli(accSignals.Acc_Volt_Max_mV)}</strong>
            </div>
            <div className="metric-row">
              <span>Temp Min</span>
              <strong>{formatTemperature(accSignals.Acc_Temp_Min_C)}</strong>
            </div>
            <div className="metric-row">
              <span>Temp Max</span>
              <strong>{formatTemperature(accSignals.Acc_Temp_Max_C)}</strong>
            </div>
          </div>
        </section>

        <section className="hvc-section-card">
          <div className="section-header">
            <Gauge size={17} />
            <h3>IO Summary</h3>
            <span className={`freshness ${getFreshness(hvcFrames.ioSummary?.timestamp, nowSeconds).className}`}>
              {getFreshness(hvcFrames.ioSummary?.timestamp, nowSeconds).label}
            </span>
          </div>
          <div className="badge-row">
            {faultBadge('SDC Fault', ioSummarySignals.SDC_Closed)}
            {faultBadge('IMD Fault', ioSummarySignals.IMD_Ok)}
            {faultBadge('BMS Fault', ioSummarySignals.BMS_Fault_Ok)}
          </div>
          <div className="metric-row single">
            <span>Reference Temp</span>
            <strong>{formatTemperature(ioSummarySignals.Ref_Temp_C)}</strong>
          </div>
        </section>

        <section className="hvc-section-card">
          <div className="section-header">
            <AlertTriangle size={17} />
            <h3>BMS State and Flags</h3>
            <span className={`freshness ${getFreshness(hvcFrames.bmsState?.timestamp, nowSeconds).className}`}>
              {getFreshness(hvcFrames.bmsState?.timestamp, nowSeconds).label}
            </span>
          </div>
          <div className="metric-grid hvc-state-metric-grid">
            <div className={`hvc-state-active ${getBmsStateClass(bmsStateText)}`}>
              {bmsStateText}
            </div>
            <div className="hvc-state-chip-row">
              {HVC_BMS_STATES.map((stateName) => (
                <span
                  key={stateName}
                  className={`hvc-state-chip hvc-state-${stateName.toLowerCase()} ${normalizedBmsState === stateName ? 'active' : ''}`}
                >
                  {stateName}
                </span>
              ))}
            </div>

            {bmsStateFlags.length > 0 ? (
              <div className="hvc-flag-grid">
                {bmsStateFlags.map(([flagName, flagValue]) => {
                  const boolValue = getSignalBooleanValue(flagValue);
                  const flagClass = boolValue === true ? 'active' : boolValue === false ? 'clear' : 'unknown';

                  return (
                    <div key={flagName} className={`hvc-flag-item ${flagClass}`}>
                      <span className="hvc-flag-name">{formatStateFlagLabel(flagName)}</span>
                      <span className="hvc-flag-value">{getSignalDisplayValue(flagValue)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="hvc-flag-empty">No BMS state flags available</div>
            )}
          </div>
        </section>
      </div>

      <section className={`hvc-test-controls ${hvcTestModeEnabled ? 'enabled' : 'disabled'}`}>
        <div className="hvc-test-controls-header">
          <h3>HVC Test Mode</h3>
          <span>All modules</span>
        </div>

        <div className="hvc-test-controls-toolbar">
          <button
            type="button"
            className={`hvc-test-toggle-btn ${hvcTestModeEnabled ? 'enabled' : 'disabled'}`}
            onClick={handleToggleHvcTestMode}
            disabled={hvcTestModeBusy}
            title="Toggle backend HVC summary and heartbeat test mode"
          >
            {hvcTestModeBusy ? 'Working...' : `HVC Test Mode: ${hvcTestModeEnabled ? 'ON' : 'OFF'}`}
          </button>
          {hvcTestStatus && (
            <span className={`hvc-reset-status ${hvcTestStatus.type}`}>
              {hvcTestStatus.text}
            </span>
          )}
        </div>

        <div className="hvc-test-slider-grid">
          <div className="hvc-test-slider-row">
            <label htmlFor="hvc-test-min-voltage">Min Voltage</label>
            <input
              id="hvc-test-min-voltage"
              type="range"
              min={HVC_TEST_MIN_VOLTAGE}
              max={HVC_TEST_MAX_VOLTAGE}
              step="0.01"
              value={hvcTestConfig.minVoltageV}
              onChange={(event) => handleMinVoltageChange(event.target.value)}
            />
            <span>{hvcTestConfig.minVoltageV.toFixed(2)} V</span>
          </div>

          <div className="hvc-test-slider-row">
            <label htmlFor="hvc-test-max-voltage">Max Voltage</label>
            <input
              id="hvc-test-max-voltage"
              type="range"
              min={HVC_TEST_MIN_VOLTAGE}
              max={HVC_TEST_MAX_VOLTAGE}
              step="0.01"
              value={hvcTestConfig.maxVoltageV}
              onChange={(event) => handleMaxVoltageChange(event.target.value)}
            />
            <span>{hvcTestConfig.maxVoltageV.toFixed(2)} V</span>
          </div>

          <div className="hvc-test-slider-row">
            <label htmlFor="hvc-test-min-temp">Min Temp</label>
            <input
              id="hvc-test-min-temp"
              type="range"
              min={HVC_TEST_MIN_TEMP}
              max={HVC_TEST_MAX_TEMP}
              step="1"
              value={hvcTestConfig.minTempC}
              onChange={(event) => handleMinTempChange(event.target.value)}
            />
            <span>{hvcTestConfig.minTempC.toFixed(0)} C</span>
          </div>

          <div className="hvc-test-slider-row">
            <label htmlFor="hvc-test-max-temp">Max Temp</label>
            <input
              id="hvc-test-max-temp"
              type="range"
              min={HVC_TEST_MIN_TEMP}
              max={HVC_TEST_MAX_TEMP}
              step="1"
              value={hvcTestConfig.maxTempC}
              onChange={(event) => handleMaxTempChange(event.target.value)}
            />
            <span>{hvcTestConfig.maxTempC.toFixed(0)} C</span>
          </div>
        </div>

        <div className="hvc-test-heartbeat-grid">
          <div className="hvc-test-heartbeat-row">
            <label htmlFor="hvc-test-err0">Err Byte 0</label>
            <input
              id="hvc-test-err0"
              type="number"
              min="0"
              max="255"
              step="1"
              value={hvcTestConfig.errorFlagsByte0}
              onChange={(event) => handleHeartbeatFieldChange('errorFlagsByte0', event.target.value)}
            />
          </div>

          <div className="hvc-test-heartbeat-row">
            <label htmlFor="hvc-test-err1">Err Byte 1</label>
            <input
              id="hvc-test-err1"
              type="number"
              min="0"
              max="255"
              step="1"
              value={hvcTestConfig.errorFlagsByte1}
              onChange={(event) => handleHeartbeatFieldChange('errorFlagsByte1', event.target.value)}
            />
          </div>

          <div className="hvc-test-heartbeat-row">
            <label htmlFor="hvc-test-err2">Err Byte 2</label>
            <input
              id="hvc-test-err2"
              type="number"
              min="0"
              max="255"
              step="1"
              value={hvcTestConfig.errorFlagsByte2}
              onChange={(event) => handleHeartbeatFieldChange('errorFlagsByte2', event.target.value)}
            />
          </div>

          <div className="hvc-test-heartbeat-row">
            <label htmlFor="hvc-test-err3">Err Byte 3</label>
            <input
              id="hvc-test-err3"
              type="number"
              min="0"
              max="255"
              step="1"
              value={hvcTestConfig.errorFlagsByte3}
              onChange={(event) => handleHeartbeatFieldChange('errorFlagsByte3', event.target.value)}
            />
          </div>

          <div className="hvc-test-heartbeat-row">
            <label htmlFor="hvc-test-warning-summary">Warning</label>
            <input
              id="hvc-test-warning-summary"
              type="number"
              min="0"
              max="255"
              step="1"
              value={hvcTestConfig.warningSummary}
              onChange={(event) => handleHeartbeatFieldChange('warningSummary', event.target.value)}
            />
          </div>

          <div className="hvc-test-heartbeat-row">
            <label htmlFor="hvc-test-fault-count">Fault Count</label>
            <input
              id="hvc-test-fault-count"
              type="number"
              min="0"
              max="255"
              step="1"
              value={hvcTestConfig.faultCount}
              onChange={(event) => handleHeartbeatFieldChange('faultCount', event.target.value)}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

export default HVCDashboard;
