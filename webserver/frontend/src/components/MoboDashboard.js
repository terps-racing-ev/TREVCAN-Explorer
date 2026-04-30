import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, Battery, Power, Cpu, Gauge, ToggleRight, AlertTriangle,
} from 'lucide-react';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import './MoboDashboard.css';

const MOBO_DBC_FILENAME = 'Baby_MOBO.dbc';

// VCU → MOBO output toggle command frame (extended ID, byte 0 = magic, byte 1 = bitmask).
// Not yet defined in Baby_MOBO.dbc, kept as raw bytes intentionally.
const VCU_MOBO_COMMAND_ID = 0x1002C0;

// Names of MOBO frames we care about (set of message_name from Baby_MOBO.dbc).
const MOBO_MESSAGE_NAMES = new Set([
  'MOBO_Summary',
  'MOBO_Power_Info',
  'MOBO_LC_Summary',
  'MOBO_HC_Summary',
]);

// Bit positions in the command-mask byte (matches firmware HC output map).
const HC_OUTPUTS = [
  { key: 'pump', label: 'Pump', bit: 0, signal: 'Pump_Cmd' },
  { key: 'drs', label: 'DRS', bit: 1, signal: 'DRS_Cmd' },
  { key: 'fans', label: 'Fans', bit: 2, signal: 'Fans_Cmd' },
  { key: 'rad', label: 'Radiator', bit: 3, signal: 'Rad_Cmd' },
];

const SDC_NODES = [
  { name: 'SDC_1', label: 'SDC Raw' },
  { name: 'SDC_2', label: 'SDC IL' },
  { name: 'SDC_3', label: 'SDC BTNs' },
];

const FAULT_NODES = [
  { name: 'BMS', label: 'BMS' },
  { name: 'BSPD', label: 'BSPD' },
  { name: 'IMD', label: 'IMD' },
];

const HEARTBEAT_HISTORY_LEN = 60;

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
  return null;
};

const getDisplay = (signal, fallback = '--') => {
  if (signal === undefined || signal === null) return fallback;
  if (typeof signal === 'object') {
    const value = signal.value;
    const unit = signal.unit;
    if (typeof value === 'number') {
      const precision = Number.isInteger(value) ? 0 : 3;
      return `${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`;
    }
    if (typeof value === 'string') return value;
    if (typeof signal.raw === 'number') return String(signal.raw);
    return fallback;
  }
  if (typeof signal === 'number') return signal.toString();
  return String(signal);
};

const isBinaryActive = (signal) => {
  const num = getNumeric(signal);
  if (num !== null) return num !== 0;
  if (typeof signal === 'object' && typeof signal?.value === 'string') {
    const v = signal.value.toLowerCase();
    if (v.includes('on') || v.includes('active')) return true;
    if (v.includes('off') || v.includes('inactive')) return false;
  }
  return null;
};

const freshnessClass = (ts, nowMs, staleMs) => {
  if (!ts) return 'missing';
  return isTimestampStale(ts, nowMs, staleMs) ? 'stale' : 'fresh';
};

const freshnessLabel = (ts, nowMs) => {
  if (!ts) return 'No data';
  const ageS = Math.max(0, (nowMs - ts * 1000) / 1000);
  return ageS < 60 ? `${ageS.toFixed(1)}s ago` : `${Math.round(ageS)}s ago`;
};

function MoboDashboard({
  messages,
  dbcFiles = [],
  onRegisterRawCallback,
  onSendMessage,
  staleTimeoutMs = 30000,
}) {
  const nowMs = useNowTick(1000);
  const [heartbeatHistory, setHeartbeatHistory] = useState([]);
  const [commandMask, setCommandMask] = useState(0);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendStatus, setSendStatus] = useState(null);

  const moboDbc = dbcFiles.find((f) => f.filename === MOBO_DBC_FILENAME) || null;
  const moboDbcEnabled = Boolean(moboDbc?.enabled);

  // Collect the freshest MOBO frame per message_name plus the latest signal map.
  const { latestSignals, framesByName, latestTimestamp } = useMemo(() => {
    const sigMap = new Map();
    const frames = {};
    let latest = null;

    messages.forEach((msg) => {
      if (!isMoboMessage(msg) || !msg.decoded?.signals) return;
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
      const name = msg.decoded.message_name;
      if (!frames[name] || ts >= frames[name].timestamp) {
        frames[name] = { signals: msg.decoded.signals, timestamp: ts };
      }
      if (latest === null || ts > latest) latest = ts;

      Object.entries(msg.decoded.signals).forEach(([sigName, signal]) => {
        const prev = sigMap.get(sigName);
        if (!prev || ts >= prev.timestamp) {
          sigMap.set(sigName, { signal, timestamp: ts, messageName: name });
        }
      });
    });

    return { latestSignals: sigMap, framesByName: frames, latestTimestamp: latest };
  }, [messages]);

  const getSignal = (name) => latestSignals.get(name)?.signal;

  // Heartbeat history (subscribe to raw stream so 1Hz toggles are visible).
  useEffect(() => {
    if (typeof onRegisterRawCallback !== 'function') return undefined;
    const unregister = onRegisterRawCallback((msg) => {
      if (!isMoboMessage(msg)) return;
      const sig = msg.decoded?.signals?.Heartbeat_Toggle;
      const value = getNumeric(sig);
      if (value === null) return;
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now() / 1000;
      setHeartbeatHistory((prev) => {
        const next = [...prev, { timestamp: ts, value: value ? 1 : 0 }];
        return next.slice(-HEARTBEAT_HISTORY_LEN);
      });
    });
    return () => unregister();
  }, [onRegisterRawCallback]);

  // Sync command mask UI from the most recent reported HC outputs.
  useEffect(() => {
    const next = HC_OUTPUTS.reduce((mask, item) => {
      const active = isBinaryActive(getSignal(item.signal));
      return active === true ? mask | (1 << item.bit) : mask;
    }, 0);
    setCommandMask((prev) => (prev === next ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSignals]);

  const sendCommandMask = async (mask) => {
    if (typeof onSendMessage !== 'function') return;
    setSendBusy(true);
    setSendStatus({ type: 'pending', text: 'Sending...' });
    try {
      const ok = await onSendMessage(
        VCU_MOBO_COMMAND_ID,
        [1, mask & 0x0F, 0, 0, 0, 0, 0, 0],
        true,
        false,
      );
      if (ok) {
        setCommandMask(mask & 0x0F);
        setSendStatus({ type: 'success', text: `Sent mask 0x${(mask & 0x0F).toString(16).toUpperCase()}` });
      } else {
        setSendStatus({ type: 'error', text: 'Failed to send command' });
      }
    } catch (err) {
      setSendStatus({ type: 'error', text: `Send failed: ${err?.message || err}` });
    } finally {
      setSendBusy(false);
    }
  };

  const toggleBit = (bit) => sendCommandMask(commandMask ^ (1 << bit));

  // Heartbeat sparkline.
  const heartbeatChart = useMemo(() => {
    const width = 360;
    const height = 80;
    const padX = 8;
    const padY = 8;
    const usable = width - padX * 2;
    if (heartbeatHistory.length === 0) return { width, height, path: '', points: [] };

    const visible = Math.max(2, Math.min(20, heartbeatHistory.length));
    const step = usable / (visible - 1);
    const points = heartbeatHistory.slice(-visible).map((p, i) => ({
      x: padX + step * i,
      y: p.value === 1 ? padY : height - padY,
      value: p.value,
    }));

    let path = '';
    points.forEach((pt, i) => {
      if (i === 0) path += `M ${pt.x} ${pt.y}`;
      else path += ` H ${pt.x} V ${pt.y}`;
    });
    return { width, height, path, points };
  }, [heartbeatHistory]);

  const renderFreshness = (frameName) => {
    const frame = framesByName[frameName];
    return (
      <span className={`freshness ${freshnessClass(frame?.timestamp, nowMs, staleTimeoutMs)}`}>
        {freshnessLabel(frame?.timestamp, nowMs)}
      </span>
    );
  };

  const hasAnyData = Object.keys(framesByName).length > 0;

  return (
    <div className="mobo-dashboard">
      <div className="mobo-header">
        <div>
          <h2><Cpu size={22} /> MOBO Dashboard</h2>
          <p>Live decoded signals from {MOBO_DBC_FILENAME}.</p>
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
          {MOBO_DBC_FILENAME} is not in the uploaded DBC list. Upload it from the DBC panel.
        </div>
      )}
      {moboDbc && !moboDbcEnabled && (
        <div className="mobo-notice warning">
          {MOBO_DBC_FILENAME} is uploaded but disabled — enable it so MOBO frames decode here.
        </div>
      )}

      {!hasAnyData ? (
        <div className="mobo-empty">
          <Activity size={40} />
          <h3>No MOBO frames received yet</h3>
          <p>This page populates once MOBO_* messages start arriving on the bus.</p>
        </div>
      ) : (
        <>
          <div className="mobo-kpi-grid">
            <section className="mobo-card">
              <div className="mobo-card-header">
                <Battery size={18} /><span>Battery Voltage</span>
                {renderFreshness('MOBO_Power_Info')}
              </div>
              <div className="mobo-kpi-value">{getDisplay(getSignal('Battery_Voltage'))}</div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <Power size={18} /><span>Currents</span>
                {renderFreshness('MOBO_LC_Summary')}
              </div>
              <div className="mobo-split-grid">
                <div>
                  <span>LV Current</span>
                  <strong>{getDisplay(getSignal('LV_Current'))}</strong>
                </div>
                <div>
                  <span>HC Current</span>
                  <strong>{getDisplay(getSignal('HC_Current'))}</strong>
                </div>
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <Gauge size={18} /><span>Aux Inputs</span>
                {renderFreshness('MOBO_LC_Summary')}
              </div>
              <div className="mobo-split-grid">
                <div>
                  <span>5V Sense</span>
                  <strong>{getDisplay(getSignal('FiveV_Sense'))}</strong>
                </div>
                <div>
                  <span>Brake Input</span>
                  <strong>{getDisplay(getSignal('Brake_Input'))}</strong>
                </div>
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <Activity size={18} /><span>Heartbeat</span>
                {renderFreshness('MOBO_Summary')}
              </div>
              <div className="mobo-heartbeat-row">
                <span className="mobo-heartbeat-state">
                  {getDisplay(getSignal('Heartbeat_Toggle'))}
                </span>
                <svg
                  className="mobo-heartbeat-chart"
                  viewBox={`0 0 ${heartbeatChart.width} ${heartbeatChart.height}`}
                  preserveAspectRatio="none"
                  aria-label="Heartbeat history"
                >
                  <line x1="8" y1="8" x2={heartbeatChart.width - 8} y2="8" className="heartbeat-grid" />
                  <line
                    x1="8"
                    y1={heartbeatChart.height - 8}
                    x2={heartbeatChart.width - 8}
                    y2={heartbeatChart.height - 8}
                    className="heartbeat-grid"
                  />
                  {heartbeatChart.path && <path d={heartbeatChart.path} className="heartbeat-line" />}
                  {heartbeatChart.points.map((pt, i) => (
                    <circle
                      key={`${i}-${pt.x}`}
                      cx={pt.x}
                      cy={pt.y}
                      r="2.5"
                      className={`heartbeat-point ${pt.value === 1 ? 'high' : 'low'}`}
                    />
                  ))}
                </svg>
              </div>
            </section>
          </div>

          <div className="mobo-section-grid">
            <section className="mobo-card">
              <div className="mobo-card-header">
                <AlertTriangle size={17} /><h3>Faults</h3>
                {renderFreshness('MOBO_Summary')}
              </div>
              <div className="mobo-tile-grid">
                {FAULT_NODES.map(({ name, label }) => {
                  const sig = getSignal(name);
                  const active = isBinaryActive(sig);
                  const cls = active === null ? 'unknown' : active ? 'good' : 'bad';
                  return (
                    <div key={name} className={`mobo-status-tile ${cls}`}>
                      <span className="mobo-tile-label">{label}</span>
                      <span className="mobo-tile-value">{getDisplay(sig)}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="mobo-card">
              <div className="mobo-card-header">
                <ToggleRight size={17} /><h3>Shutdown Circuit</h3>
                {renderFreshness('MOBO_Summary')}
              </div>
              <div className="mobo-tile-grid">
                {SDC_NODES.map(({ name, label }) => {
                  const sig = getSignal(name);
                  const active = isBinaryActive(sig);
                  const cls = active === null ? 'unknown' : active ? 'good' : 'bad';
                  return (
                    <div key={name} className={`mobo-status-tile ${cls}`}>
                      <span className="mobo-tile-label">{label}</span>
                      <span className="mobo-tile-value">{getDisplay(sig)}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="mobo-card mobo-card-wide">
              <div className="mobo-card-header">
                <Power size={17} /><h3>HC Outputs</h3>
                {renderFreshness('MOBO_HC_Summary')}
                {sendStatus && (
                  <span className={`mobo-status-pill ${sendStatus.type}`}>{sendStatus.text}</span>
                )}
              </div>
              <div className="mobo-output-grid">
                {HC_OUTPUTS.map(({ key, label, bit, signal }) => {
                  const reported = isBinaryActive(getSignal(signal));
                  const commanded = (commandMask & (1 << bit)) !== 0;
                  return (
                    <div key={key} className="mobo-output-row">
                      <div className="mobo-output-info">
                        <span className="mobo-output-label">{label}</span>
                        <span className="mobo-output-value">
                          Reported: <strong>{getDisplay(getSignal(signal))}</strong>
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`mobo-toggle-btn ${commanded ? 'on' : 'off'} ${reported === commanded ? 'matched' : 'mismatch'}`}
                        onClick={() => toggleBit(bit)}
                        disabled={sendBusy || typeof onSendMessage !== 'function'}
                      >
                        {commanded ? 'Cmd ON' : 'Cmd OFF'}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="mobo-output-actions">
                <button
                  type="button"
                  className="mobo-utility-btn"
                  onClick={() => sendCommandMask(0x0F)}
                  disabled={sendBusy || typeof onSendMessage !== 'function'}
                >
                  All On
                </button>
                <button
                  type="button"
                  className="mobo-utility-btn"
                  onClick={() => sendCommandMask(0)}
                  disabled={sendBusy || typeof onSendMessage !== 'function'}
                >
                  All Off
                </button>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default MoboDashboard;
