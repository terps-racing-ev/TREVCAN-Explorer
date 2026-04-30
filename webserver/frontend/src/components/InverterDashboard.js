import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap, Activity, Power, Gauge, Thermometer, AlertTriangle,
  RotateCcw, RefreshCw, ShieldAlert, Play, Square,
} from 'lucide-react';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import './InverterDashboard.css';

const INVERTER_DBC_FILENAME = 'BMS-Inverter-Only.dbc';

// CM200DZ command/response message IDs (standard CAN IDs).
const CMD_MESSAGE_ID = 0xC0; // Command_Message
const PARAM_RW_ID    = 0xC1; // Parameter_Read_Write_Command
// Parameter_Response (0xC2) is consumed via decoded signals.

// Set of message_name strings produced by the inverter DBC.
const INVERTER_MESSAGE_NAMES = new Set([
  'Temperatures_1', 'Temperatures_2', 'Temperatures_3',
  'Analog_Input_Voltages', 'Digital_Input_Status',
  'Motor_Position_Info', 'Current_Info', 'Voltage_Info', 'Flux_Info',
  'Internal_Voltages', 'Internal_States', 'Fault_Codes',
  'Torque_Timer_Info', 'Mod_Index_Flux_Weakening', 'Firmware_Info',
  'High_Speed_Message', 'Torque_Capability',
  'Command_Message', 'Parameter_Read_Write_Command', 'Parameter_Response',
]);

const TORQUE_INCREMENTS = [10, 5, 1];
const SPEED_INCREMENTS = [100, 50, 10];
const MAX_TORQUE_NM = 200;
const MAX_SPEED_RPM = 3000;
const TX_RATE_HZ = 10;

const LIMIT_FLAGS = [
  { signal: 'INV_BMS_Limit_Regen',     label: 'BMS Regen' },
  { signal: 'INV_Limit_Motor_Temp',    label: 'Motor Temp' },
  { signal: 'INV_Limit_Hot_Spot_Mtr',  label: 'Hot Spot Mtr' },
  { signal: 'INV_BMS_Limit_Mot_Trq',   label: 'BMS Motor Trq' },
  { signal: 'INV_Limit_Max_Speed',     label: 'Max Speed' },
  { signal: 'INV_Limit_Hot_Spot_Inv',  label: 'Hot Spot Inv' },
  { signal: 'INV_Low_Speed_Limit',     label: 'Low Speed' },
  { signal: 'INV_Limit_Coolant_Derat', label: 'Coolant Derate' },
  { signal: 'INV_Limit_Stall_Burst',   label: 'Stall Burst' },
];

const TEMP_SIGNALS = [
  { signal: 'INV_Module_A_Temp',         label: 'Module A',     msg: 'Temperatures_1' },
  { signal: 'INV_Module_B_Temp',         label: 'Module B',     msg: 'Temperatures_1' },
  { signal: 'INV_Module_C_Temp',         label: 'Module C',     msg: 'Temperatures_1' },
  { signal: 'INV_GDB_Temp',              label: 'Gate Driver',  msg: 'Temperatures_1' },
  { signal: 'INV_Control_Board_Temp',    label: 'Control Brd',  msg: 'Temperatures_2' },
  { signal: 'INV_RTD1_Temperature',      label: 'RTD 1',        msg: 'Temperatures_2' },
  { signal: 'INV_RTD2_Temperature',      label: 'RTD 2',        msg: 'Temperatures_2' },
  { signal: 'INV_Hot_Spot_Temp_Motor',   label: 'HS Motor',     msg: 'Temperatures_2' },
  { signal: 'INV_Coolant_Temp',          label: 'Coolant',      msg: 'Temperatures_3' },
  { signal: 'INV_Hot_Spot_Temp_Inverter',label: 'HS Inverter',  msg: 'Temperatures_3' },
  { signal: 'INV_Motor_Temp',            label: 'Motor',        msg: 'Temperatures_3' },
];

const isInverterMessage = (msg) => {
  const name = msg?.decoded?.message_name;
  if (name && INVERTER_MESSAGE_NAMES.has(name)) return true;
  return msg?.decoded?.source_dbc === INVERTER_DBC_FILENAME;
};

const getNumeric = (signal) => {
  if (signal === undefined || signal === null) return null;
  if (typeof signal === 'number') return Number.isFinite(signal) ? signal : null;
  if (typeof signal === 'object') {
    if (typeof signal.value === 'number') return signal.value;
    if (typeof signal.raw === 'number') return signal.raw;
  }
  return null;
};

const getDisplay = (signal, fallback = '--', precision = 2) => {
  if (signal === undefined || signal === null) return fallback;
  if (typeof signal === 'object') {
    const value = signal.value;
    const unit = signal.unit;
    if (typeof value === 'number') {
      const p = Number.isInteger(value) ? 0 : precision;
      return `${value.toFixed(p)}${unit ? ` ${unit}` : ''}`;
    }
    if (typeof value === 'string') return value;
    if (typeof signal.raw === 'number') return String(signal.raw);
    return fallback;
  }
  if (typeof signal === 'number') return signal.toFixed(precision);
  return String(signal);
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

// --- Command_Message byte builder ---
// Layout (Motorola/Intel little-endian per DBC): all signals are little-endian.
//   bytes 0-1: torque command (int16, scale 0.1 Nm)
//   bytes 2-3: speed command  (int16, RPM)
//   byte 4:    direction (0=reverse, 1=forward)
//   byte 5 bit0: inverter enable
//   byte 5 bit1: inverter discharge
//   byte 5 bit2: speed mode enable
//   byte 5 bits4-7: rolling counter
//   bytes 6-7: torque limit (int16, scale 0.1 Nm)
const buildCommandFrame = ({
  torqueNm,
  speedRpm,
  direction,        // 0 or 1
  inverterEnable,   // bool
  discharge,        // bool
  speedMode,        // bool
  rollingCounter,   // 0..15
  torqueLimitNm,
}) => {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setInt16(0, Math.round(torqueNm * 10), true);
  view.setInt16(2, Math.round(speedRpm), true);
  buf[4] = direction & 0xFF;
  buf[5] = (
    (inverterEnable ? 0x01 : 0)
    | (discharge ? 0x02 : 0)
    | (speedMode ? 0x04 : 0)
    | ((rollingCounter & 0x0F) << 4)
  ) & 0xFF;
  view.setInt16(6, Math.round(torqueLimitNm * 10), true);
  return Array.from(buf);
};

// Parameter_Read_Write_Command byte builder.
//   bytes 0-1: address (uint16)
//   byte 2:    rw command (0=read, 1=write)
//   byte 3:    reserved
//   bytes 4-5: data (int16)
//   bytes 6-7: reserved
const buildParameterFrame = ({ address, rw, data }) => {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint16(0, address & 0xFFFF, true);
  buf[2] = rw & 0xFF;
  view.setInt16(4, Math.round(data) & 0xFFFF, true);
  return Array.from(buf);
};

// EEPROM addresses for "clear faults".
const PARAM_ADDR_CLEAR_FAULTS = 20;

function InverterDashboard({
  messages,
  dbcFiles = [],
  onSendMessage,
  staleTimeoutMs = 30000,
}) {
  const nowMs = useNowTick(1000);

  const inverterDbc = dbcFiles.find((f) => f.filename === INVERTER_DBC_FILENAME) || null;
  const inverterDbcEnabled = Boolean(inverterDbc?.enabled);

  // --- TX state ---
  const [enabled, setEnabled] = useState(false);
  const [direction, setDirection] = useState(1); // 1=forward, 0=reverse
  const [speedMode, setSpeedMode] = useState(false);
  const [torqueSetpoint, setTorqueSetpoint] = useState(0);
  const [speedSetpoint, setSpeedSetpoint] = useState(0);
  const [torqueLimit, setTorqueLimit] = useState(50);
  const [txStatus, setTxStatus] = useState({ type: 'idle', text: 'Stopped' });
  const [txBusy, setTxBusy] = useState(false);
  const [txTickCount, setTxTickCount] = useState(0);

  const txStateRef = useRef({});
  txStateRef.current = {
    enabled,
    direction,
    speedMode,
    torqueSetpoint,
    speedSetpoint,
    torqueLimit,
  };

  const rollingCounterRef = useRef(0);
  const txIntervalRef = useRef(null);
  const txInFlightRef = useRef(false);

  const sendingRef = useRef(false);

  // Aggregate latest signal values per signal name from inverter frames only.
  const { latestSignals, framesByName } = useMemo(() => {
    const sigMap = new Map();
    const frames = {};
    messages.forEach((msg) => {
      if (!isInverterMessage(msg) || !msg.decoded?.signals) return;
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
      const name = msg.decoded.message_name;
      if (!frames[name] || ts >= frames[name].timestamp) {
        frames[name] = { signals: msg.decoded.signals, timestamp: ts };
      }
      Object.entries(msg.decoded.signals).forEach(([sigName, signal]) => {
        const prev = sigMap.get(sigName);
        if (!prev || ts >= prev.timestamp) {
          sigMap.set(sigName, { signal, timestamp: ts });
        }
      });
    });
    return { latestSignals: sigMap, framesByName: frames };
  }, [messages]);

  const getSignal = (name) => latestSignals.get(name)?.signal;

  // 10Hz Command_Message transmit loop.
  useEffect(() => {
    if (!enabled) {
      if (txIntervalRef.current) {
        clearInterval(txIntervalRef.current);
        txIntervalRef.current = null;
      }
      return undefined;
    }
    if (typeof onSendMessage !== 'function') {
      setTxStatus({ type: 'error', text: 'Send is unavailable' });
      setEnabled(false);
      return undefined;
    }

    setTxStatus({ type: 'pending', text: 'Streaming command @ 10Hz' });

    const tick = async () => {
      if (txInFlightRef.current) return;
      txInFlightRef.current = true;
      try {
        const s = txStateRef.current;
        const data = buildCommandFrame({
          torqueNm: s.speedMode ? 0 : s.torqueSetpoint,
          speedRpm: s.speedMode ? s.speedSetpoint : 0,
          direction: s.direction,
          inverterEnable: true,
          discharge: false,
          speedMode: s.speedMode,
          rollingCounter: rollingCounterRef.current,
          torqueLimitNm: s.torqueLimit,
        });
        rollingCounterRef.current = (rollingCounterRef.current + 1) & 0x0F;
        await onSendMessage(CMD_MESSAGE_ID, data, false, false);
        setTxTickCount((c) => c + 1);
      } catch (err) {
        setTxStatus({ type: 'error', text: `TX error: ${err?.message || err}` });
      } finally {
        txInFlightRef.current = false;
      }
    };

    txIntervalRef.current = setInterval(tick, Math.round(1000 / TX_RATE_HZ));
    tick();

    return () => {
      if (txIntervalRef.current) {
        clearInterval(txIntervalRef.current);
        txIntervalRef.current = null;
      }
    };
  }, [enabled, onSendMessage]);

  useEffect(() => () => {
    if (txIntervalRef.current) clearInterval(txIntervalRef.current);
  }, []);

  const sendDisableCommand = async () => {
    // One-shot frame with everything zeroed and enable cleared (to release lockout).
    if (typeof onSendMessage !== 'function') return;
    const data = buildCommandFrame({
      torqueNm: 0,
      speedRpm: 0,
      direction: 0,
      inverterEnable: false,
      discharge: false,
      speedMode: false,
      rollingCounter: rollingCounterRef.current,
      torqueLimitNm: 0,
    });
    rollingCounterRef.current = (rollingCounterRef.current + 1) & 0x0F;
    await onSendMessage(CMD_MESSAGE_ID, data, false, false);
  };

  const handleStart = () => {
    setTorqueSetpoint(0);
    setSpeedSetpoint(0);
    setEnabled(true);
  };

  const handleStop = async () => {
    setEnabled(false);
    setTorqueSetpoint(0);
    setSpeedSetpoint(0);
    setTxStatus({ type: 'idle', text: 'Stopped' });
    if (sendingRef.current) return;
    sendingRef.current = true;
    try { await sendDisableCommand(); } finally { sendingRef.current = false; }
  };

  const handleEmergencyStop = async () => {
    setEnabled(false);
    setTorqueSetpoint(0);
    setSpeedSetpoint(0);
    setTxStatus({ type: 'error', text: 'Emergency stop sent' });
    if (typeof onSendMessage !== 'function') return;
    const data = buildCommandFrame({
      torqueNm: -5,
      speedRpm: 0,
      direction: txStateRef.current.direction,
      inverterEnable: false,
      discharge: false,
      speedMode: false,
      rollingCounter: rollingCounterRef.current,
      torqueLimitNm: 0,
    });
    rollingCounterRef.current = (rollingCounterRef.current + 1) & 0x0F;
    await onSendMessage(CMD_MESSAGE_ID, data, false, false);
  };

  const handleClearFaults = async () => {
    if (typeof onSendMessage !== 'function') return;
    setTxBusy(true);
    setTxStatus({ type: 'pending', text: 'Clearing faults...' });
    try {
      // Standard "clear faults" sequence: write 0 then 1 to address 20.
      const w0 = buildParameterFrame({ address: PARAM_ADDR_CLEAR_FAULTS, rw: 1, data: 0 });
      const w1 = buildParameterFrame({ address: PARAM_ADDR_CLEAR_FAULTS, rw: 1, data: 1 });
      await onSendMessage(PARAM_RW_ID, w0, false, false);
      await onSendMessage(PARAM_RW_ID, w1, false, false);
      setTxStatus({ type: 'success', text: 'Clear-fault command sent' });
    } catch (err) {
      setTxStatus({ type: 'error', text: `Clear failed: ${err?.message || err}` });
    } finally {
      setTxBusy(false);
    }
  };

  const handleClearLockout = async () => {
    setTxBusy(true);
    setTxStatus({ type: 'pending', text: 'Releasing lockout...' });
    try {
      await sendDisableCommand();
      setTxStatus({ type: 'success', text: 'Lockout release frame sent' });
    } catch (err) {
      setTxStatus({ type: 'error', text: `Lockout release failed: ${err?.message || err}` });
    } finally {
      setTxBusy(false);
    }
  };

  const adjustTorque = (delta) => {
    setTorqueSetpoint((prev) => {
      const next = Math.max(-MAX_TORQUE_NM, Math.min(MAX_TORQUE_NM, prev + delta));
      return Number(next.toFixed(1));
    });
  };

  const adjustSpeed = (delta) => {
    setSpeedSetpoint((prev) => {
      const next = Math.max(-MAX_SPEED_RPM, Math.min(MAX_SPEED_RPM, prev + delta));
      return Math.round(next);
    });
  };

  const renderFreshness = (frameName) => {
    const ts = framesByName[frameName]?.timestamp;
    return (
      <span className={`freshness ${freshnessClass(ts, nowMs, staleTimeoutMs)}`}>
        {freshnessLabel(ts, nowMs)}
      </span>
    );
  };

  const dcVoltage = getNumeric(getSignal('INV_DC_Bus_Voltage'));
  const dcCurrent = getNumeric(getSignal('INV_DC_Bus_Current'));
  const dcPower = (dcVoltage !== null && dcCurrent !== null) ? dcVoltage * dcCurrent : null;

  const activeLimits = LIMIT_FLAGS.filter((f) => getNumeric(getSignal(f.signal)) === 1);

  const postFaultLo = getNumeric(getSignal('INV_Post_Fault_Lo')) || 0;
  const postFaultHi = getNumeric(getSignal('INV_Post_Fault_Hi')) || 0;
  const runFaultLo = getNumeric(getSignal('INV_Run_Fault_Lo')) || 0;
  const runFaultHi = getNumeric(getSignal('INV_Run_Fault_Hi')) || 0;
  const anyFault = postFaultLo || postFaultHi || runFaultLo || runFaultHi;

  const hasAnyData = Object.keys(framesByName).length > 0;

  return (
    <div className="inv-dashboard">
      <div className="inv-header">
        <div>
          <h2><Zap size={22} /> Inverter (CM200DZ)</h2>
          <p>DBC-decoded telemetry from {INVERTER_DBC_FILENAME} • TX 10Hz</p>
        </div>
        <div className="inv-header-actions">
          <span className={`inv-dbc-pill ${inverterDbcEnabled ? 'enabled' : 'disabled'}`}>
            {inverterDbcEnabled ? 'DBC enabled' : inverterDbc ? 'DBC disabled' : 'DBC missing'}
          </span>
          <span className={`inv-status-pill ${txStatus.type}`}>{txStatus.text}</span>
        </div>
      </div>

      {!inverterDbc && (
        <div className="inv-notice warning">
          {INVERTER_DBC_FILENAME} is not in the uploaded DBC list.
        </div>
      )}
      {inverterDbc && !inverterDbcEnabled && (
        <div className="inv-notice warning">
          {INVERTER_DBC_FILENAME} is uploaded but disabled — enable it for decoded values.
        </div>
      )}

      {/* ---------- COMMAND PANEL ---------- */}
      <section className="inv-card inv-command-panel">
        <div className="inv-card-header">
          <Power size={18} /><h3>Command</h3>
          <span className="inv-tx-counter">TX frames: {txTickCount}</span>
        </div>

        <div className="inv-mode-row">
          <button
            type="button"
            className={`inv-mode-btn ${!speedMode ? 'active' : ''}`}
            onClick={() => setSpeedMode(false)}
            disabled={enabled}
          >
            Torque Mode
          </button>
          <button
            type="button"
            className={`inv-mode-btn ${speedMode ? 'active' : ''}`}
            onClick={() => setSpeedMode(true)}
            disabled={enabled}
          >
            Speed Mode
          </button>
          <button
            type="button"
            className={`inv-dir-btn ${direction === 1 ? 'forward' : 'reverse'}`}
            onClick={() => setDirection((d) => (d ? 0 : 1))}
            disabled={enabled}
          >
            {direction === 1 ? 'Forward ▶' : '◀ Reverse'}
          </button>
        </div>

        {!speedMode ? (
          <div className="inv-setpoint">
            <label>Torque Setpoint (Nm)</label>
            <div className="inv-setpoint-display">{torqueSetpoint.toFixed(1)}</div>
            <input
              type="range"
              min={-MAX_TORQUE_NM}
              max={MAX_TORQUE_NM}
              step="0.1"
              value={torqueSetpoint}
              onChange={(e) => setTorqueSetpoint(Number(e.target.value))}
            />
            <div className="inv-step-row">
              {TORQUE_INCREMENTS.map((inc) => (
                <button key={`-${inc}`} type="button" onClick={() => adjustTorque(-inc)}>
                  -{inc}
                </button>
              ))}
              <button type="button" onClick={() => setTorqueSetpoint(0)}>0</button>
              {TORQUE_INCREMENTS.map((inc) => (
                <button key={`+${inc}`} type="button" onClick={() => adjustTorque(inc)}>
                  +{inc}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="inv-setpoint">
            <label>Speed Setpoint (RPM)</label>
            <div className="inv-setpoint-display">{speedSetpoint}</div>
            <input
              type="range"
              min={-MAX_SPEED_RPM}
              max={MAX_SPEED_RPM}
              step="1"
              value={speedSetpoint}
              onChange={(e) => setSpeedSetpoint(Number(e.target.value))}
            />
            <div className="inv-step-row">
              {SPEED_INCREMENTS.map((inc) => (
                <button key={`-${inc}`} type="button" onClick={() => adjustSpeed(-inc)}>
                  -{inc}
                </button>
              ))}
              <button type="button" onClick={() => setSpeedSetpoint(0)}>0</button>
              {SPEED_INCREMENTS.map((inc) => (
                <button key={`+${inc}`} type="button" onClick={() => adjustSpeed(inc)}>
                  +{inc}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="inv-limit-row">
          <label>Torque Limit (Nm)</label>
          <input
            type="number"
            step="0.1"
            min="0"
            max={MAX_TORQUE_NM}
            value={torqueLimit}
            onChange={(e) => setTorqueLimit(Math.max(0, Math.min(MAX_TORQUE_NM, Number(e.target.value) || 0)))}
          />
        </div>

        <div className="inv-button-row">
          {!enabled ? (
            <button type="button" className="inv-action-btn start" onClick={handleStart} disabled={txBusy || typeof onSendMessage !== 'function'}>
              <Play size={16} /> Start TX
            </button>
          ) : (
            <button type="button" className="inv-action-btn stop" onClick={handleStop} disabled={txBusy}>
              <Square size={16} /> Stop TX
            </button>
          )}
          <button type="button" className="inv-action-btn estop" onClick={handleEmergencyStop} disabled={typeof onSendMessage !== 'function'}>
            <ShieldAlert size={16} /> Emergency Stop
          </button>
          <button type="button" className="inv-action-btn clear" onClick={handleClearFaults} disabled={txBusy || typeof onSendMessage !== 'function'}>
            <RefreshCw size={16} /> Clear Faults
          </button>
          <button type="button" className="inv-action-btn lockout" onClick={handleClearLockout} disabled={txBusy || typeof onSendMessage !== 'function'}>
            <RotateCcw size={16} /> Release Lockout
          </button>
        </div>
      </section>

      {!hasAnyData ? (
        <div className="inv-empty">
          <Activity size={40} />
          <h3>No inverter telemetry yet</h3>
          <p>Telemetry frames from the CM200DZ will appear here once they decode.</p>
        </div>
      ) : (
        <>
          <div className="inv-kpi-grid">
            <section className="inv-card">
              <div className="inv-card-header">
                <Gauge size={18} /><h3>Motor</h3>
                {renderFreshness('Motor_Position_Info')}
              </div>
              <div className="inv-kpi-value">
                {getDisplay(getSignal('INV_Motor_Speed'), '--', 0)}
              </div>
              <div className="inv-split-grid">
                <div>
                  <span>Commanded Trq</span>
                  <strong>{getDisplay(getSignal('INV_Commanded_Torque'))}</strong>
                </div>
                <div>
                  <span>Feedback Trq</span>
                  <strong>{getDisplay(getSignal('INV_Torque_Feedback'))}</strong>
                </div>
              </div>
            </section>

            <section className="inv-card">
              <div className="inv-card-header">
                <Zap size={18} /><h3>DC Bus</h3>
                {renderFreshness('Voltage_Info')}
              </div>
              <div className="inv-kpi-value">{getDisplay(getSignal('INV_DC_Bus_Voltage'))}</div>
              <div className="inv-split-grid">
                <div>
                  <span>DC Current</span>
                  <strong>{getDisplay(getSignal('INV_DC_Bus_Current'))}</strong>
                </div>
                <div>
                  <span>DC Power</span>
                  <strong>{dcPower !== null ? `${(dcPower / 1000).toFixed(2)} kW` : '--'}</strong>
                </div>
              </div>
            </section>

            <section className="inv-card">
              <div className="inv-card-header">
                <Activity size={18} /><h3>Phase Currents</h3>
                {renderFreshness('Current_Info')}
              </div>
              <div className="inv-three-grid">
                <div><span>A</span><strong>{getDisplay(getSignal('INV_Phase_A_Current'))}</strong></div>
                <div><span>B</span><strong>{getDisplay(getSignal('INV_Phase_B_Current'))}</strong></div>
                <div><span>C</span><strong>{getDisplay(getSignal('INV_Phase_C_Current'))}</strong></div>
              </div>
            </section>

            <section className="inv-card">
              <div className="inv-card-header">
                <Power size={18} /><h3>State</h3>
                {renderFreshness('Internal_States')}
              </div>
              <div className="inv-state-grid">
                <div><span>VSM</span><strong>{getDisplay(getSignal('INV_VSM_State'), '--', 0)}</strong></div>
                <div><span>Inverter</span><strong>{getDisplay(getSignal('INV_Inverter_State'), '--', 0)}</strong></div>
                <div>
                  <span>Enable</span>
                  <strong className={getNumeric(getSignal('INV_Enable_State')) ? 'good' : 'bad'}>
                    {getNumeric(getSignal('INV_Enable_State')) ? 'ON' : 'OFF'}
                  </strong>
                </div>
                <div>
                  <span>Lockout</span>
                  <strong className={getNumeric(getSignal('INV_Enable_Lockout')) ? 'bad' : 'good'}>
                    {getNumeric(getSignal('INV_Enable_Lockout')) ? 'LOCKED' : 'CLEAR'}
                  </strong>
                </div>
                <div>
                  <span>Direction</span>
                  <strong>{getNumeric(getSignal('INV_Direction_Command')) === 0 ? 'REV' : 'FWD'}</strong>
                </div>
                <div>
                  <span>Power-On</span>
                  <strong>{getDisplay(getSignal('INV_Power_On_Timer'), '--', 1)}</strong>
                </div>
              </div>
            </section>
          </div>

          <div className="inv-section-grid">
            <section className="inv-card">
              <div className="inv-card-header">
                <Thermometer size={18} /><h3>Temperatures</h3>
                {renderFreshness('Temperatures_1')}
              </div>
              <div className="inv-temp-grid">
                {TEMP_SIGNALS.map((t) => (
                  <div key={t.signal} className="inv-temp-tile">
                    <span>{t.label}</span>
                    <strong>{getDisplay(getSignal(t.signal))}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="inv-card">
              <div className="inv-card-header">
                <AlertTriangle size={18} /><h3>Active Limits</h3>
                {renderFreshness('Internal_States')}
              </div>
              {activeLimits.length === 0 ? (
                <div className="inv-empty-line">No active limiters</div>
              ) : (
                <div className="inv-badge-row">
                  {activeLimits.map((f) => (
                    <span key={f.signal} className="inv-badge bad">{f.label}</span>
                  ))}
                </div>
              )}
            </section>

            <section className={`inv-card ${anyFault ? 'inv-card-alert' : ''}`}>
              <div className="inv-card-header">
                <AlertTriangle size={18} /><h3>Fault Codes</h3>
                {renderFreshness('Fault_Codes')}
              </div>
              <div className="inv-fault-grid">
                <div>
                  <span>POST Lo</span>
                  <strong className={postFaultLo ? 'bad' : ''}>0x{postFaultLo.toString(16).toUpperCase().padStart(4, '0')}</strong>
                </div>
                <div>
                  <span>POST Hi</span>
                  <strong className={postFaultHi ? 'bad' : ''}>0x{postFaultHi.toString(16).toUpperCase().padStart(4, '0')}</strong>
                </div>
                <div>
                  <span>RUN Lo</span>
                  <strong className={runFaultLo ? 'bad' : ''}>0x{runFaultLo.toString(16).toUpperCase().padStart(4, '0')}</strong>
                </div>
                <div>
                  <span>RUN Hi</span>
                  <strong className={runFaultHi ? 'bad' : ''}>0x{runFaultHi.toString(16).toUpperCase().padStart(4, '0')}</strong>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default InverterDashboard;
