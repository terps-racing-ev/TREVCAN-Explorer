import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Battery, CheckCircle, Cpu, Gauge, Power,
  Settings, ShieldAlert, SlidersHorizontal, ToggleRight, Zap,
} from 'lucide-react';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import './MoboDashboard.css';

const MOBO_DBC_FILENAME = 'Baby_MOBO.dbc';

const COMMAND_IDS = {
  vcu: 0x002001F0,
  reset: 0x002001F7,
  config: 0x002001F8,
};

const MOBO_MESSAGE_NAMES = new Set([
  'MOBO_Heartbeat',
  'MOBO_Errors',
  'MOBO_CAN_Stats',
  'MOBO_Power_Telemetry',
  'MOBO_Current_Telemetry',
  'MOBO_Safety_Status',
  'MOBO_Relay_Status',
]);

const RELAY_CHANNELS = [
  { key: 'pump', label: 'Pump', bit: 0, commanded: 'Pump_Commanded', actual: 'Pump_Actual', state: 'Pump_State' },
  { key: 'drs', label: 'DRS', bit: 1, commanded: 'DRS_Commanded', actual: 'DRS_Actual', state: 'DRS_State' },
  { key: 'fans', label: 'Fans', bit: 2, commanded: 'Fans_Commanded', actual: 'Fans_Actual', state: 'Fans_State' },
  { key: 'radiator', label: 'Radiator', bit: 3, commanded: 'Rad_Commanded', actual: 'Rad_Actual', state: 'Rad_State' },
];

const SAFETY_INPUTS = [
  { key: 'sdc1', label: 'SDC1', raw: 'SDC1_Raw', debounced: 'SDC1_Debounced', latched: 'SDC1_Latched' },
  { key: 'sdc2', label: 'SDC2', raw: 'SDC2_Raw', debounced: 'SDC2_Debounced', latched: 'SDC2_Latched' },
  { key: 'sdc3', label: 'SDC3', raw: 'SDC3_Raw', debounced: 'SDC3_Debounced', latched: 'SDC3_Latched' },
  { key: 'bms', label: 'BMS', raw: 'BMS_Raw', debounced: 'BMS_Debounced', latched: 'BMS_Latched' },
  { key: 'bspd', label: 'BSPD', raw: 'BSPD_Raw', debounced: 'BSPD_Debounced', latched: 'BSPD_Latched' },
  { key: 'imd', label: 'IMD', raw: 'IMD_Raw', debounced: 'IMD_Debounced', latched: 'IMD_Latched' },
];

const SYSTEM_STATES = {
  0: 'INIT',
  1: 'STANDBY',
  2: 'ACTIVE',
};

const RELAY_STATES = {
  0: 'OFF',
  1: 'TURNING_ON',
  2: 'ON',
  3: 'TURNING_OFF',
  4: 'FAULT',
};

const CONFIG_PARAMS = [
  { id: 0x01, label: 'LV offset', unit: 'mA', min: -2147483648, max: 2147483647, defaultValue: 0 },
  { id: 0x02, label: 'HC offset', unit: 'mA', min: -2147483648, max: 2147483647, defaultValue: 0 },
  { id: 0x03, label: 'VDIV numerator', unit: '', min: 0, max: 2147483647, defaultValue: 1 },
  { id: 0x04, label: 'VDIV denominator', unit: '', min: 1, max: 2147483647, defaultValue: 1 },
];

const isMoboMessage = (msg) => {
  const name = msg?.decoded?.message_name;
  if (name && MOBO_MESSAGE_NAMES.has(name)) return true;
  if (msg?.decoded?.source_dbc === MOBO_DBC_FILENAME) return true;
  return false;
};

const getNumeric = (signal) => {
  if (signal === undefined || signal === null) return null;
  if (typeof signal === 'number') return Number.isFinite(signal) ? signal : null;
  if (typeof signal === 'object') {
    if (typeof signal.raw === 'number') return signal.raw;
    if (typeof signal.value === 'number') return signal.value;
  }
  const parsed = Number(signal);
  return Number.isFinite(parsed) ? parsed : null;
};

const getDisplay = (signal, fallback = '--', decimals = null) => {
  if (signal === undefined || signal === null) return fallback;
  if (typeof signal === 'object') {
    const { value, raw, unit } = signal;
    if (typeof value === 'number') {
      const precision = decimals !== null ? decimals : (Number.isInteger(value) ? 0 : 3);
      return `${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`;
    }
    if (typeof value === 'string') return value;
    if (typeof raw === 'number') return String(raw);
    return fallback;
  }
  if (typeof signal === 'number') {
    const precision = decimals !== null ? decimals : (Number.isInteger(signal) ? 0 : 3);
    return signal.toFixed(precision);
  }
  return String(signal);
};

const getEnumDisplay = (signal, labels, fallback = '--') => {
  const numeric = getNumeric(signal);
  if (numeric !== null && labels[numeric]) return labels[numeric];
  return getDisplay(signal, fallback);
};

const isBitSet = (signal) => {
  const num = getNumeric(signal);
  return num === null ? null : num !== 0;
};

const formatBool = (signal, trueLabel = 'ON', falseLabel = 'OFF') => {
  const value = isBitSet(signal);
  if (value === null) return '--';
  return value ? trueLabel : falseLabel;
};

const formatHex = (signal, width = 8) => {
  const value = getNumeric(signal);
  if (value === null) return '--';
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
};

const freshnessClass = (timestampSec, nowMs, staleTimeoutMs) => {
  if (!timestampSec) return 'missing';
  return isTimestampStale(timestampSec, nowMs, staleTimeoutMs) ? 'stale' : 'fresh';
};

const freshnessLabel = (timestampSec, nowMs) => {
  if (!timestampSec) return 'No data';
  const ageS = Math.max(0, (nowMs - timestampSec * 1000) / 1000);
  return ageS < 60 ? `${ageS.toFixed(1)}s ago` : `${Math.round(ageS)}s ago`;
};

const idLabel = (id) => `0x${id.toString(16).toUpperCase().padStart(8, '0')}`;
const maskLabel = (mask) => `0x${(mask & 0x0F).toString(16).toUpperCase()}`;

const maskFromSignals = (signals) => RELAY_CHANNELS.reduce((mask, channel) => {
  const active = isBitSet(signals?.[channel.commanded]);
  return active ? mask | (1 << channel.bit) : mask;
}, 0);

const signedInt32ToBytes = (value) => {
  const unsigned = value >>> 0;
  return [
    unsigned & 0xFF,
    (unsigned >>> 8) & 0xFF,
    (unsigned >>> 16) & 0xFF,
    (unsigned >>> 24) & 0xFF,
  ];
};

const clampInt = (value, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
};

function StatusPill({ value, variant = 'neutral' }) {
  return <span className={`mobo-status-pill ${variant}`}>{value}</span>;
}

function Freshness({ timestamp, nowMs, staleTimeoutMs }) {
  return (
    <span className={`freshness ${freshnessClass(timestamp, nowMs, staleTimeoutMs)}`}>
      {freshnessLabel(timestamp, nowMs)}
    </span>
  );
}

function MoboDashboard({
  messages,
  dbcFiles = [],
  onSendMessage,
  staleTimeoutMs = 30000,
}) {
  const nowMs = useNowTick(1000);
  const [requestMask, setRequestMask] = useState(0);
  const [requestDirty, setRequestDirty] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendStatus, setSendStatus] = useState(null);
  const [configParamId, setConfigParamId] = useState(CONFIG_PARAMS[0].id);
  const [configValue, setConfigValue] = useState(String(CONFIG_PARAMS[0].defaultValue));

  const moboDbc = dbcFiles.find((file) => file.filename === MOBO_DBC_FILENAME) || null;
  const moboDbcEnabled = Boolean(moboDbc?.enabled);

  const { latestSignals, framesByName, latestTimestamp } = useMemo(() => {
    const sigMap = new Map();
    const frames = {};
    let latest = null;

    messages.forEach((msg) => {
      if (!isMoboMessage(msg) || !msg.decoded?.signals) return;
      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
      const name = msg.decoded.message_name;

      if (!frames[name] || timestamp >= frames[name].timestamp) {
        frames[name] = { signals: msg.decoded.signals, timestamp };
      }
      if (latest === null || timestamp > latest) latest = timestamp;

      Object.entries(msg.decoded.signals).forEach(([signalName, signal]) => {
        const previous = sigMap.get(signalName);
        if (!previous || timestamp >= previous.timestamp) {
          sigMap.set(signalName, { signal, timestamp, messageName: name });
        }
      });
    });

    return { latestSignals: sigMap, framesByName: frames, latestTimestamp: latest };
  }, [messages]);

  const getSignal = (name) => latestSignals.get(name)?.signal;
  const getFrame = (name) => framesByName[name] || null;

  useEffect(() => {
    if (sendBusy || requestDirty) return;
    const relaySignals = framesByName.MOBO_Relay_Status?.signals;
    if (!relaySignals) return;
    setRequestMask((prev) => {
      const next = maskFromSignals(relaySignals);
      return prev === next ? prev : next;
    });
  }, [framesByName, requestDirty, sendBusy]);

  useEffect(() => {
    const selected = CONFIG_PARAMS.find((param) => param.id === configParamId) || CONFIG_PARAMS[0];
    setConfigValue(String(selected.defaultValue));
  }, [configParamId]);

  const renderFreshness = (frameName) => {
    const frame = getFrame(frameName);
    return <Freshness timestamp={frame?.timestamp} nowMs={nowMs} staleTimeoutMs={staleTimeoutMs} />;
  };

  const sendFrame = async (canId, data, successText) => {
    if (typeof onSendMessage !== 'function') {
      setSendStatus({ type: 'error', text: 'Send unavailable' });
      return false;
    }

    setSendBusy(true);
    setSendStatus({ type: 'pending', text: 'Sending...' });
    try {
      const ok = await onSendMessage(canId, data, true, false);
      setSendStatus(ok
        ? { type: 'success', text: successText }
        : { type: 'error', text: 'Frame rejected by backend' });
      return Boolean(ok);
    } catch (err) {
      setSendStatus({ type: 'error', text: `Send failed: ${err?.message || err}` });
      return false;
    } finally {
      setSendBusy(false);
    }
  };

  const sendRelayCommand = async (mask = requestMask) => {
    const safeMask = mask & 0x0F;
    const ok = await sendFrame(
      COMMAND_IDS.vcu,
      [0x01, safeMask, 0, 0, 0, 0, 0, 0],
      `VCU ${maskLabel(safeMask)} sent`,
    );
    if (ok) {
      setRequestMask(safeMask);
      setRequestDirty(false);
    }
  };

  const setMaskAndSend = (mask) => {
    const next = mask & 0x0F;
    setRequestMask(next);
    setRequestDirty(true);
    sendRelayCommand(next);
  };

  const sendRelayBit = (bit, enabled) => {
    const next = enabled ? (requestMask | (1 << bit)) : (requestMask & ~(1 << bit));
    const safeNext = next & 0x0F;
    setRequestMask(safeNext);
    setRequestDirty(true);
    sendRelayCommand(safeNext);
  };

  const resetMobo = () => {
    if (!window.confirm('Send MOBO reset command now?')) return;
    sendFrame(COMMAND_IDS.reset, [0x5A, 0xA5, 0, 0, 0, 0, 0, 0], 'MOBO reset sent');
  };

  const sendConfig = () => {
    const param = CONFIG_PARAMS.find((item) => item.id === configParamId) || CONFIG_PARAMS[0];
    const value = clampInt(configValue, param.min, param.max);
    if (value === null) {
      setSendStatus({ type: 'error', text: 'Config value must be an integer' });
      return;
    }
    sendFrame(
      COMMAND_IDS.config,
      [param.id, ...signedInt32ToBytes(value), 0, 0, 0],
      `${param.label} set to ${value}${param.unit ? ` ${param.unit}` : ''}`,
    );
  };

  const hasAnyData = Object.keys(framesByName).length > 0;
  const heartbeat = getFrame('MOBO_Heartbeat');
  const relayStatus = getFrame('MOBO_Relay_Status');
  const errors = getFrame('MOBO_Errors');
  const safety = getFrame('MOBO_Safety_Status');
  const canStats = getFrame('MOBO_CAN_Stats');
  const systemState = getEnumDisplay(getSignal('System_State'), SYSTEM_STATES);
  const heartbeatIsStale = isTimestampStale(heartbeat?.timestamp, nowMs, staleTimeoutMs);
  const heartbeatStatus = !heartbeat ? 'Heartbeat missing' : heartbeatIsStale ? 'Heartbeat stale' : 'Heartbeat good';
  const heartbeatVariant = !heartbeat ? 'neutral' : heartbeatIsStale ? 'error' : 'success';
  const errorFlagsValue = getNumeric(errors?.signals?.Error_Flags) ?? getNumeric(getSignal('Error_Summary'));
  const errorsClear = errorFlagsValue === 0;
  const errorHealthText = errorFlagsValue === null ? 'Errors unknown' : errorsClear ? 'Errors clear' : 'Errors active';
  const errorHealthVariant = errorFlagsValue === null ? 'neutral' : errorsClear ? 'success' : 'error';
  const selectedConfigParam = CONFIG_PARAMS.find((param) => param.id === configParamId) || CONFIG_PARAMS[0];

  return (
    <div className="mobo-dashboard">
      <div className="mobo-header">
        <div>
          <h2><Cpu size={22} /> MOBO Dashboard</h2>
          <p>Extended MOBO control and telemetry from {MOBO_DBC_FILENAME}.</p>
        </div>
        <div className="mobo-header-actions">
          <span className={`mobo-dbc-pill ${moboDbcEnabled ? 'enabled' : 'disabled'}`}>
            {moboDbcEnabled ? 'DBC enabled' : moboDbc ? 'DBC disabled' : 'DBC missing'}
          </span>
          {latestTimestamp && (
            <span className="mobo-last-update">
              Last frame: {new Date(latestTimestamp * 1000).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {!moboDbc && (
        <div className="mobo-notice warning">
          {MOBO_DBC_FILENAME} is not in the uploaded DBC list. Raw command sends are still available.
        </div>
      )}
      {moboDbc && !moboDbcEnabled && (
        <div className="mobo-notice warning">
          {MOBO_DBC_FILENAME} is uploaded but disabled. Enable it for decoded MOBO telemetry.
        </div>
      )}

      <section className="mobo-card mobo-command-card">
        <div className="mobo-card-header">
          <Power size={17} /><h3>Relay Control</h3>
          <StatusPill value={idLabel(COMMAND_IDS.vcu)} />
          {sendStatus && <StatusPill value={sendStatus.text} variant={sendStatus.type} />}
        </div>

        <div className="mobo-relay-command-grid">
          {RELAY_CHANNELS.map((channel) => {
            const requested = (requestMask & (1 << channel.bit)) !== 0;
            const accepted = isBitSet(relayStatus?.signals?.[channel.commanded]);
            const actual = isBitSet(relayStatus?.signals?.[channel.actual]);
            const state = getEnumDisplay(relayStatus?.signals?.[channel.state], RELAY_STATES);
            const commandMatchesRequest = accepted !== null && accepted === requested;
            const feedbackMatchesCommand = accepted !== null && actual !== null && accepted === actual;
            return (
              <div
                key={channel.key}
                className={`mobo-relay-card ${actual ? 'actual-on' : 'actual-off'} ${feedbackMatchesCommand ? 'matched' : 'mismatch'}`}
              >
                <div className="mobo-relay-top">
                  <span className="mobo-relay-name">{channel.label}</span>
                  <span className={`mobo-relay-indicator ${actual ? 'on' : actual === false ? 'off' : 'unknown'}`}>
                    {actual === null ? 'No feedback' : actual ? 'ON' : 'OFF'}
                  </span>
                </div>

                <div className="mobo-relay-actions" role="group" aria-label={`${channel.label} relay control`}>
                  <button
                    type="button"
                    className={!requested ? 'active' : ''}
                    onClick={() => sendRelayBit(channel.bit, false)}
                    disabled={sendBusy}
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    className={requested ? 'active' : ''}
                    onClick={() => sendRelayBit(channel.bit, true)}
                    disabled={sendBusy}
                  >
                    On
                  </button>
                </div>

                <div className="mobo-relay-feedback-grid">
                  <div><span>Commanded</span><strong>{formatBool(relayStatus?.signals?.[channel.commanded])}</strong></div>
                  <div><span>Actual</span><strong>{formatBool(relayStatus?.signals?.[channel.actual])}</strong></div>
                  <div><span>State</span><strong>{state}</strong></div>
                  <div><span>Send</span><strong>{commandMatchesRequest ? 'ACK' : 'PENDING'}</strong></div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mobo-command-footer">
          <div className="mobo-mask-readout">
            <span>Request mask</span>
            <strong>{maskLabel(requestMask)}</strong>
          </div>
          <div className="mobo-command-actions">
            <button type="button" className="mobo-utility-btn" onClick={() => setMaskAndSend(0x0F)} disabled={sendBusy}>All On</button>
            <button type="button" className="mobo-utility-btn" onClick={() => setMaskAndSend(0)} disabled={sendBusy}>All Off</button>
          </div>
        </div>
      </section>

      {!hasAnyData ? (
        <div className="mobo-empty">
          <Activity size={40} />
          <div>
            <h3>No MOBO frames received yet</h3>
            <p>This page populates once MOBO_* messages start arriving on the bus.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="mobo-kpi-grid">
            <section className="mobo-card">
              <div className="mobo-card-header">
                <Activity size={18} /><span>System State</span>
                {renderFreshness('MOBO_Heartbeat')}
              </div>
              <div className={`mobo-kpi-value state-${systemState.toLowerCase()}`}>{systemState}</div>
              <div className="mobo-heartbeat-summary">
                <StatusPill value={heartbeatStatus} variant={heartbeatVariant} />
                <StatusPill value={errorHealthText} variant={errorHealthVariant} />
                <span>Fault count {getDisplay(getSignal('Fault_Count'))}</span>
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <ToggleRight size={18} /><span>Relay Telemetry</span>
                {renderFreshness('MOBO_Relay_Status')}
              </div>
              <div className="mobo-kpi-row">
                <div className="mobo-kpi-value">{maskLabel(maskFromSignals(relayStatus?.signals))}</div>
                <StatusPill value={`${getDisplay(getSignal('Ms_Since_Cmd'))} ms since command`} />
              </div>
              <div className="mobo-split-grid">
                <div><span>Accepted Mask</span><strong>{maskLabel(maskFromSignals(relayStatus?.signals))}</strong></div>
                <div><span>Actual Source</span><strong>Relay readback</strong></div>
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <Battery size={18} /><span>Power</span>
                {renderFreshness('MOBO_Power_Telemetry')}
              </div>
              <div className="mobo-split-grid">
                <div><span>Battery</span><strong>{getDisplay(getSignal('Battery_Voltage'), '--', 3)}</strong></div>
                <div><span>5V Rail</span><strong>{getDisplay(getSignal('FiveV_Sense'), '--', 3)}</strong></div>
                <div><span>Brake</span><strong>{getDisplay(getSignal('Brake_Input'), '--', 3)}</strong></div>
                <div><span>LV ADC</span><strong>{getDisplay(getSignal('LV_Current_Raw'))}</strong></div>
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <Gauge size={18} /><span>Currents</span>
                {renderFreshness('MOBO_Current_Telemetry')}
              </div>
              <div className="mobo-split-grid">
                <div><span>LV</span><strong>{getDisplay(getSignal('LV_Current'), '--', 3)}</strong></div>
                <div><span>HC</span><strong>{getDisplay(getSignal('HC_Current'), '--', 3)}</strong></div>
                <div><span>LV Peak</span><strong>{getDisplay(getSignal('LV_Current_Peak'), '--', 3)}</strong></div>
                <div><span>HC Peak</span><strong>{getDisplay(getSignal('HC_Current_Peak'), '--', 3)}</strong></div>
              </div>
            </section>
          </div>

          <div className="mobo-section-grid">
            <section className="mobo-card">
              <div className="mobo-card-header">
                <ShieldAlert size={17} /><h3>Safety Inputs</h3>
                {renderFreshness('MOBO_Safety_Status')}
              </div>
              <div className="mobo-safety-table">
                <div className="mobo-safety-head"><span>Input</span><span>Raw</span><span>Debounced</span><span>Latched</span></div>
                {SAFETY_INPUTS.map((input) => {
                  const values = [input.raw, input.debounced, input.latched].map((name) => isBitSet(safety?.signals?.[name]));
                  return (
                    <div key={input.key} className="mobo-safety-row">
                      <span>{input.label}</span>
                      {values.map((value, index) => (
                        <span key={`${input.key}-${index}`} className={`mobo-safety-cell ${value === null ? 'unknown' : value ? 'bad' : 'good'}`}>
                          {value === null ? '--' : value ? 'FAULT' : 'CLEAR'}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <AlertTriangle size={17} /><h3>Errors</h3>
                {renderFreshness('MOBO_Errors')}
              </div>
              <div className="mobo-split-grid">
                <div><span>Summary</span><strong>{formatHex(getSignal('Error_Summary'))}</strong></div>
                <div><span>Error Flags</span><strong>{formatHex(errors?.signals?.Error_Flags)}</strong></div>
                <div><span>Warning Flags</span><strong>{formatHex(errors?.signals?.Warning_Flags)}</strong></div>
                <div><span>Has Warnings</span><strong>{formatBool(getSignal('Has_Warnings'), 'YES', 'NO')}</strong></div>
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <Zap size={17} /><h3>CAN Stats</h3>
                {renderFreshness('MOBO_CAN_Stats')}
              </div>
              <div className="mobo-split-grid">
                <div><span>TX Success</span><strong>{getDisplay(canStats?.signals?.TX_Success)}</strong></div>
                <div><span>TX Failures</span><strong>{getDisplay(canStats?.signals?.TX_Failures)}</strong></div>
                <div><span>RX Messages</span><strong>{getDisplay(canStats?.signals?.RX_Messages)}</strong></div>
                <div><span>RX Drops</span><strong>{getDisplay(canStats?.signals?.RX_Drops)}</strong></div>
              </div>
            </section>

            <section className="mobo-card mobo-card-wide">
              <div className="mobo-card-header">
                <Settings size={17} /><h3>Service Commands</h3>
              </div>
              <div className="mobo-service-grid">
                <div className="mobo-service-panel">
                  <div className="mobo-service-title"><AlertTriangle size={16} /> Reset</div>
                  <StatusPill value={idLabel(COMMAND_IDS.reset)} />
                  <button type="button" className="mobo-danger-btn" onClick={resetMobo} disabled={sendBusy || typeof onSendMessage !== 'function'}>
                    Reset MOBO
                  </button>
                </div>

                <div className="mobo-service-panel config">
                  <div className="mobo-service-title"><SlidersHorizontal size={16} /> Runtime Config</div>
                  <StatusPill value={idLabel(COMMAND_IDS.config)} />
                  <div className="mobo-config-row">
                    <select value={configParamId} onChange={(event) => setConfigParamId(Number(event.target.value))} disabled={sendBusy}>
                      {CONFIG_PARAMS.map((param) => (
                        <option key={param.id} value={param.id}>{`0x${param.id.toString(16).toUpperCase().padStart(2, '0')} ${param.label}`}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={configValue}
                      min={selectedConfigParam.min}
                      max={selectedConfigParam.max}
                      onChange={(event) => setConfigValue(event.target.value)}
                      disabled={sendBusy}
                    />
                    {selectedConfigParam.unit && <span className="mobo-config-unit">{selectedConfigParam.unit}</span>}
                  </div>
                  <button type="button" className="mobo-primary-btn" onClick={sendConfig} disabled={sendBusy || typeof onSendMessage !== 'function'}>
                    <CheckCircle size={15} /> Apply
                  </button>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default MoboDashboard;