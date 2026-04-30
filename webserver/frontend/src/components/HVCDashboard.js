import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Battery, Activity, Gauge, Thermometer, AlertTriangle, Zap, RotateCcw, Settings,
} from 'lucide-react';
import { apiService } from '../services/api';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import './HVCDashboard.css';

// HVC firmware reset trigger (extended ID, not currently in hvc.dbc).
const HVC_RESET_CAN_ID = 0x004001F6;
const HVC_RESET_DATA = [0, 0, 0, 0, 0, 0, 0, 0];

const HVC_TEST_VOLTAGE_MIN = 2.5;
const HVC_TEST_VOLTAGE_MAX = 4.3;
const HVC_TEST_TEMP_MIN = 20;
const HVC_TEST_TEMP_MAX = 80;
const HVC_TEST_DEBOUNCE_MS = 250;

// Map DBC message names → state key on this component.
const HVC_MESSAGE_MAP = {
  IO_Summary: 'ioSummary',
  IO_Current: 'ioCurrent',
  IO_VSense: 'ioVSense',
  BMS_State: 'bmsState',
  SOC: 'soc',
  ACC_Summary: 'accSummary',
  Current_Limit: 'currentLimit',
  PL_Signal: 'plSignal',
};

// Known BMS_State enum names from hvc.dbc.
const HVC_BMS_STATES = ['PRE_INIT', 'RUNNING', 'CHARGING', 'BALANCING', 'ERRORED'];

// Extract numeric value from server-decoded signal payload (object {value, raw, unit}).
const getNumeric = (signal) => {
  if (signal === undefined || signal === null) return null;
  if (typeof signal === 'number') return Number.isFinite(signal) ? signal : null;
  if (typeof signal === 'object') {
    if (typeof signal.raw === 'number') return signal.raw;
    if (typeof signal.value === 'number') return signal.value;
  }
  const num = Number(signal);
  return Number.isFinite(num) ? num : null;
};

// Extract display string (enum label etc.) from a decoded signal.
const getDisplay = (signal, fallback = '--') => {
  if (signal === undefined || signal === null) return fallback;
  if (typeof signal === 'object') {
    if (typeof signal.value === 'string') return signal.value;
    if (signal.value !== undefined && signal.value !== null) return String(signal.value);
    if (signal.raw !== undefined && signal.raw !== null) return String(signal.raw);
    return fallback;
  }
  return String(signal);
};

const formatVoltsFromMv = (signal) => {
  const v = getNumeric(signal);
  return v === null ? '--' : `${(v / 1000).toFixed(2)} V`;
};

const formatAmpsFromMa = (signal) => {
  const v = getNumeric(signal);
  return v === null ? '--' : `${(v / 1000).toFixed(2)} A`;
};

const formatTempC = (signal) => {
  const v = getNumeric(signal);
  return v === null ? '--' : `${v.toFixed(1)} °C`;
};

const formatPercent = (signal) => {
  const v = getNumeric(signal);
  return v === null ? '--' : `${v.toFixed(2)} %`;
};

const formatCapacityAh = (signal) => {
  const v = getNumeric(signal);
  return v === null ? '--' : `${(v / 3600).toFixed(2)} Ah`;
};

const normalizeStateName = (raw) => {
  const upper = String(raw || '').toUpperCase();
  return HVC_BMS_STATES.find((s) => upper.includes(s)) || null;
};

const formatFlagLabel = (name) => name
  .replace(/^Err_/, '')
  .replace(/([A-Z])/g, ' $1')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const freshnessClass = (timestampSec, nowMs, staleMs) => {
  if (!timestampSec) return 'missing';
  return isTimestampStale(timestampSec, nowMs, staleMs) ? 'stale' : 'fresh';
};

const freshnessLabel = (timestampSec, nowMs) => {
  if (!timestampSec) return 'No data';
  const ageS = Math.max(0, (nowMs - timestampSec * 1000) / 1000);
  if (ageS < 60) return `${ageS.toFixed(1)}s ago`;
  return `${Math.round(ageS)}s ago`;
};

function HVCDashboard({ messages, onSendMessage, staleTimeoutMs = 30000 }) {
  const nowMs = useNowTick(1000);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetStatus, setResetStatus] = useState(null);

  // ---- HVC test-mode backend controls --------------------------------------
  const [testEnabled, setTestEnabled] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [testConfig, setTestConfig] = useState({
    minVoltageV: 3.2,
    maxVoltageV: 4.1,
    minTempC: 28,
    maxTempC: 55,
    errorFlagsByte0: 0,
    errorFlagsByte1: 0,
    errorFlagsByte2: 0,
    errorFlagsByte3: 0,
    warningSummary: 0,
    faultCount: 0,
  });
  const testHydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiService.getHVCTestModeStatus();
        if (cancelled || !status) return;

        setTestEnabled(Boolean(status.enabled));
        if (status.all_modules) {
          const a = status.all_modules;
          const e = status.heartbeat_errors || {};
          const clamp = (val, lo, hi, fallback) => {
            const num = Number(val);
            return Number.isFinite(num) ? Math.max(lo, Math.min(hi, num)) : fallback;
          };
          const minV = clamp(a.min_voltage_v, HVC_TEST_VOLTAGE_MIN, HVC_TEST_VOLTAGE_MAX, 3.2);
          const maxV = clamp(a.max_voltage_v, minV, HVC_TEST_VOLTAGE_MAX, 4.1);
          const minT = clamp(a.min_temp_c, HVC_TEST_TEMP_MIN, HVC_TEST_TEMP_MAX, 28);
          const maxT = clamp(a.max_temp_c, minT, HVC_TEST_TEMP_MAX, 55);
          setTestConfig({
            minVoltageV: minV,
            maxVoltageV: maxV,
            minTempC: minT,
            maxTempC: maxT,
            errorFlagsByte0: clamp(e.error_flags_byte0, 0, 255, 0),
            errorFlagsByte1: clamp(e.error_flags_byte1, 0, 255, 0),
            errorFlagsByte2: clamp(e.error_flags_byte2, 0, 255, 0),
            errorFlagsByte3: clamp(e.error_flags_byte3, 0, 255, 0),
            warningSummary: clamp(e.warning_summary, 0, 255, 0),
            faultCount: clamp(e.fault_count, 0, 255, 0),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setTestStatus({ type: 'error', text: `Failed to load test mode: ${err?.message || err}` });
        }
      } finally {
        if (!cancelled) testHydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!testHydratedRef.current) return undefined;
    const id = setTimeout(() => {
      apiService.setHVCTestModeConfig(testConfig).catch((err) => {
        setTestStatus({
          type: 'error',
          text: `Failed to update test mode config: ${err?.response?.data?.detail || err?.message || err}`,
        });
      });
    }, HVC_TEST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [testConfig]);

  // ---- Aggregate latest HVC frames ----------------------------------------
  const frames = useMemo(() => {
    const acc = {
      ioSummary: null, ioCurrent: null, ioVSense: null,
      bmsState: null, soc: null, accSummary: null,
      currentLimit: null, plSignal: null,
    };
    if (!messages || messages.length === 0) return acc;

    messages.forEach((msg) => {
      const decoded = msg?.decoded;
      if (!decoded || !decoded.signals) return;
      const key = HVC_MESSAGE_MAP[decoded.message_name];
      if (!key) return;
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : null;
      const existing = acc[key];
      if (!existing || (ts !== null && ts > existing.timestamp)) {
        acc[key] = { signals: decoded.signals, timestamp: ts };
      }
    });
    return acc;
  }, [messages]);

  const hasAnyFrame = Object.values(frames).some((f) => f !== null);

  // ---- Handlers ------------------------------------------------------------
  const handleResetHVC = async () => {
    if (typeof onSendMessage !== 'function') {
      setResetStatus({ type: 'error', text: 'Reset unavailable: send handler missing' });
      return;
    }
    if (!window.confirm('Send HVC reset command now?')) return;

    setResetBusy(true);
    setResetStatus({ type: 'pending', text: 'Sending reset command...' });
    try {
      const ok = await onSendMessage(HVC_RESET_CAN_ID, HVC_RESET_DATA, true, false);
      setResetStatus(ok
        ? { type: 'success', text: `Reset sent: 0x${HVC_RESET_CAN_ID.toString(16).toUpperCase()}` }
        : { type: 'error', text: 'Failed to send reset command' });
    } catch (err) {
      setResetStatus({ type: 'error', text: `Failed to send reset: ${err?.message || err}` });
    } finally {
      setResetBusy(false);
    }
  };

  const handleToggleTestMode = async () => {
    const next = !testEnabled;
    setTestBusy(true);
    setTestStatus({ type: 'pending', text: next ? 'Enabling HVC test mode...' : 'Disabling HVC test mode...' });
    try {
      const status = await apiService.setHVCTestModeEnabled(next);
      const enabled = Boolean(status?.enabled);
      setTestEnabled(enabled);
      setTestStatus({ type: 'success', text: enabled ? 'HVC test mode enabled' : 'HVC test mode disabled' });
    } catch (err) {
      setTestStatus({
        type: 'error',
        text: `Failed to toggle test mode: ${err?.response?.data?.detail || err?.message || err}`,
      });
    } finally {
      setTestBusy(false);
    }
  };

  const updateTestNumber = (key, raw, lo, hi, decimals = 2) => {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    setTestConfig((prev) => ({
      ...prev,
      [key]: Number(Math.max(lo, Math.min(hi, num)).toFixed(decimals)),
    }));
  };

  const updateTestByte = (key, raw) => {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    setTestConfig((prev) => ({
      ...prev,
      [key]: Math.max(0, Math.min(255, Math.round(num))),
    }));
  };

  // ---- Derived signals -----------------------------------------------------
  const soc = frames.soc?.signals || {};
  const acc = frames.accSummary?.signals || {};
  const ioSummary = frames.ioSummary?.signals || {};
  const ioVSense = frames.ioVSense?.signals || {};
  const ioCurrent = frames.ioCurrent?.signals || {};
  const bmsState = frames.bmsState?.signals || {};
  const currentLimit = frames.currentLimit?.signals || {};
  const plSignal = frames.plSignal?.signals || {};

  const stateText = getDisplay(bmsState.BMS_State, '--');
  const normalizedState = normalizeStateName(stateText);
  const stateFlags = Object.entries(bmsState)
    .filter(([name]) => name.startsWith('Err_'))
    .sort(([a], [b]) => a.localeCompare(b));

  const renderFreshness = (frame) => (
    <span className={`freshness ${freshnessClass(frame?.timestamp, nowMs, staleTimeoutMs)}`}>
      {freshnessLabel(frame?.timestamp, nowMs)}
    </span>
  );

  const renderFaultBadge = (label, signal) => {
    const num = getNumeric(signal);
    if (num === null) return <span className="hvc-badge unknown">{label}: ?</span>;
    const ok = num !== 0;
    return <span className={`hvc-badge ${ok ? 'good' : 'bad'}`}>{label}: {ok ? 'OK' : 'FAULT'}</span>;
  };

  return (
    <div className="hvc-dashboard">
      <div className="hvc-header">
        <div className="hvc-header-left">
          <h2><Gauge size={22} /> HVC Dashboard</h2>
          <p>Real-time high-voltage controller telemetry decoded from hvc.dbc.</p>
        </div>
        <div className="hvc-header-actions">
          <button
            type="button"
            className="hvc-reset-btn"
            onClick={handleResetHVC}
            disabled={resetBusy}
            title="Send HVC firmware reset frame"
          >
            <RotateCcw size={15} />
            {resetBusy ? 'Sending...' : 'Reset HVC'}
          </button>
          {resetStatus && (
            <span className={`hvc-status-pill ${resetStatus.type}`}>{resetStatus.text}</span>
          )}
        </div>
      </div>

      {!hasAnyFrame && (
        <div className="hvc-empty">
          <AlertTriangle size={28} />
          <div>
            <h3>No HVC frames received yet</h3>
            <p>Connect to CAN with hvc.dbc enabled to populate this dashboard.</p>
          </div>
        </div>
      )}

      <div className="hvc-kpi-grid">
        <div className="hvc-kpi-card">
          <div className="hvc-card-header">
            <Battery size={18} /><span>State of Charge</span>{renderFreshness(frames.soc)}
          </div>
          <div className="hvc-kpi-value">{formatPercent(soc.SOC_Percent)}</div>
          <div className="hvc-kpi-sub">Capacity: <strong>{formatCapacityAh(soc.SOC_Capacity_As)}</strong></div>
          <div className="hvc-kpi-sub">Delta: <strong>{formatCapacityAh(soc.SOC_Delta_As)}</strong></div>
        </div>

        <div className="hvc-kpi-card">
          <div className="hvc-card-header">
            <Zap size={18} /><span>Voltage Sense</span>{renderFreshness(frames.ioVSense)}
          </div>
          <div className="hvc-split-grid">
            <div><span>Battery</span><strong>{formatVoltsFromMv(ioVSense.Batt_Voltage_mV)}</strong></div>
            <div><span>Inverter</span><strong>{formatVoltsFromMv(ioVSense.Inv_Voltage_mV)}</strong></div>
          </div>
        </div>

        <div className="hvc-kpi-card">
          <div className="hvc-card-header">
            <Activity size={18} /><span>Bus Current</span>{renderFreshness(frames.ioCurrent)}
          </div>
          <div className="hvc-split-grid">
            <div><span>Low Channel</span><strong>{formatAmpsFromMa(ioCurrent.Current_Low_mA)}</strong></div>
            <div><span>High Channel</span><strong>{formatAmpsFromMa(ioCurrent.Current_High_mA)}</strong></div>
          </div>
        </div>
      </div>

      <div className="hvc-section-grid">
        <section className="hvc-card">
          <div className="hvc-card-header">
            <Thermometer size={17} /><h3>Pack Extremes</h3>{renderFreshness(frames.accSummary)}
          </div>
          <div className="hvc-metric-grid">
            <div className="hvc-metric"><span>V Min</span><strong>{formatVoltsFromMv(acc.Acc_Volt_Min_mV)}</strong></div>
            <div className="hvc-metric"><span>V Max</span><strong>{formatVoltsFromMv(acc.Acc_Volt_Max_mV)}</strong></div>
            <div className="hvc-metric"><span>T Min</span><strong>{formatTempC(acc.Acc_Temp_Min_C)}</strong></div>
            <div className="hvc-metric"><span>T Max</span><strong>{formatTempC(acc.Acc_Temp_Max_C)}</strong></div>
          </div>
        </section>

        <section className="hvc-card">
          <div className="hvc-card-header">
            <Gauge size={17} /><h3>IO Summary</h3>{renderFreshness(frames.ioSummary)}
          </div>
          <div className="hvc-badge-row">
            {renderFaultBadge('SDC', ioSummary.SDC_Closed)}
            {renderFaultBadge('IMD', ioSummary.IMD_Ok)}
            {renderFaultBadge('BMS', ioSummary.BMS_Fault_Ok)}
          </div>
          <div className="hvc-metric single">
            <span>Reference Temp</span>
            <strong>{formatTempC(ioSummary.Ref_Temp_C)}</strong>
          </div>
        </section>

        <section className="hvc-card">
          <div className="hvc-card-header">
            <AlertTriangle size={17} /><h3>BMS State</h3>{renderFreshness(frames.bmsState)}
          </div>
          <div className={`hvc-state-banner state-${(normalizedState || 'unknown').toLowerCase()}`}>
            {stateText}
          </div>
          <div className="hvc-state-chip-row">
            {HVC_BMS_STATES.map((s) => (
              <span
                key={s}
                className={`hvc-state-chip state-${s.toLowerCase()} ${normalizedState === s ? 'active' : ''}`}
              >
                {s}
              </span>
            ))}
          </div>
          {stateFlags.length > 0 ? (
            <div className="hvc-flag-grid">
              {stateFlags.map(([name, value]) => {
                const num = getNumeric(value);
                const cls = num === null ? 'unknown' : num !== 0 ? 'active' : 'clear';
                return (
                  <div key={name} className={`hvc-flag ${cls}`}>
                    <span className="hvc-flag-label">{formatFlagLabel(name)}</span>
                    <span className="hvc-flag-value">{getDisplay(value)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="hvc-flag-empty">No BMS state flags decoded yet.</div>
          )}
        </section>

        <section className="hvc-card">
          <div className="hvc-card-header">
            <Activity size={17} /><h3>Current Limits</h3>{renderFreshness(frames.currentLimit)}
          </div>
          <div className="hvc-metric-grid">
            <div className="hvc-metric"><span>Charge Limit</span><strong>{formatAmpsFromMa(currentLimit.Positive_Current_Limit_mA)}</strong></div>
            <div className="hvc-metric"><span>Discharge Limit</span><strong>{formatAmpsFromMa(currentLimit.Negative_Current_Limit_mA)}</strong></div>
          </div>
        </section>

        <section className="hvc-card">
          <div className="hvc-card-header">
            <AlertTriangle size={17} /><h3>Precharge / PL Signal</h3>{renderFreshness(frames.plSignal)}
          </div>
          <div className="hvc-metric single">
            <span>Reason</span>
            <strong>{getDisplay(plSignal.PL_Signal_Reason)}</strong>
          </div>
        </section>
      </div>

      <section className={`hvc-test-card ${testEnabled ? 'enabled' : ''}`}>
        <div className="hvc-card-header">
          <Settings size={17} /><h3>Test Mode (synthetic BMS heartbeats)</h3>
        </div>
        <p className="hvc-test-help">
          Drives synthetic <code>Cell_Temp_Summary</code>, <code>BMS_Voltage_Summary</code> and
          <code> BMS_Heartbeat</code> frames out the active CAN bus for all 6 modules so the HVC
          can be exercised without a real pack. Requires an active CAN connection and the
          BMS DBC loaded.
        </p>

        <div className="hvc-test-toolbar">
          <button
            type="button"
            className={`hvc-test-toggle ${testEnabled ? 'on' : 'off'}`}
            onClick={handleToggleTestMode}
            disabled={testBusy}
          >
            {testBusy ? 'Working...' : `Test Mode: ${testEnabled ? 'ON' : 'OFF'}`}
          </button>
          {testStatus && (
            <span className={`hvc-status-pill ${testStatus.type}`}>{testStatus.text}</span>
          )}
        </div>

        <div className="hvc-test-sliders">
          {[
            { key: 'minVoltageV', label: 'Min Voltage', min: HVC_TEST_VOLTAGE_MIN, max: HVC_TEST_VOLTAGE_MAX, step: 0.01, suffix: 'V', dec: 2 },
            { key: 'maxVoltageV', label: 'Max Voltage', min: HVC_TEST_VOLTAGE_MIN, max: HVC_TEST_VOLTAGE_MAX, step: 0.01, suffix: 'V', dec: 2 },
            { key: 'minTempC', label: 'Min Temp', min: HVC_TEST_TEMP_MIN, max: HVC_TEST_TEMP_MAX, step: 1, suffix: '°C', dec: 0 },
            { key: 'maxTempC', label: 'Max Temp', min: HVC_TEST_TEMP_MIN, max: HVC_TEST_TEMP_MAX, step: 1, suffix: '°C', dec: 0 },
          ].map(({ key, label, min, max, step, suffix, dec }) => (
            <div className="hvc-slider-row" key={key}>
              <label htmlFor={`hvc-test-${key}`}>{label}</label>
              <input
                id={`hvc-test-${key}`}
                type="range"
                min={min}
                max={max}
                step={step}
                value={testConfig[key]}
                onChange={(e) => updateTestNumber(key, e.target.value, min, max, dec)}
              />
              <span>{Number(testConfig[key]).toFixed(dec)} {suffix}</span>
            </div>
          ))}
        </div>

        <div className="hvc-test-bytes">
          {[
            ['errorFlagsByte0', 'Err Byte 0'],
            ['errorFlagsByte1', 'Err Byte 1'],
            ['errorFlagsByte2', 'Err Byte 2'],
            ['errorFlagsByte3', 'Err Byte 3'],
            ['warningSummary', 'Warning'],
            ['faultCount', 'Fault Count'],
          ].map(([key, label]) => (
            <div className="hvc-byte-row" key={key}>
              <label htmlFor={`hvc-test-${key}`}>{label}</label>
              <input
                id={`hvc-test-${key}`}
                type="number"
                min="0"
                max="255"
                step="1"
                value={testConfig[key]}
                onChange={(e) => updateTestByte(key, e.target.value)}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default HVCDashboard;
