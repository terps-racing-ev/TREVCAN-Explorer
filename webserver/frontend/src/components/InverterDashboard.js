import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Activity, Power, AlertTriangle, Zap, Download, RotateCcw } from 'lucide-react';
import './InverterDashboard.css';
import { apiService } from '../services/api';

const MAX_TORQUE = 200;
const TORQUE_MIN = -MAX_TORQUE;
const TORQUE_INCREMENTS = [10, 5, 1];
const MAX_SPEED_RPM = 3000;
const SPEED_INCREMENTS = [100, 50, 10];

const CMD_ID = 0x0C0;
const FAULT_CLEAR_ID = 0x0C1;
const PARAM_RW_ID = 0x0C1;
const PARAM_RESPONSE_ID = 0x0C2;
const TORQUE_TIMER_ID = 0x0AC;
const INTERNAL_STATES_ID = 0x0AA;
const FAULT_STATUS_ID = 0x0AB;
const TEMP_1_ID = 0x0A0;
const TEMP_2_ID = 0x0A1;
const TEMP_3_ID = 0x0A2;
const MOTOR_POS_INFO_ID = 0x0A5; // 165
const MOTOR_POS_INFO_ID_EXT = 0x0CFFA501;
const BUS_CURRENT_INFO_ID = 0x0A6;
const BUS_VOLTAGE_INFO_ID = 0x0A7;
const HIGH_SPEED_INFO_ID = 0x0B0; // 176
const HIGH_SPEED_INFO_ID_EXT = 0x0CFFB001;

function InverterDashboard({ messages, onSendMessage }) {
  const [controlMode, setControlMode] = useState('torque'); // 'torque' or 'speed'
  const [torqueValue, setTorqueValue] = useState(0.0);
  const [speedValue, setSpeedValue] = useState(0.0);
  const [inputTorque, setInputTorque] = useState("0");
  const [inputSpeed, setInputSpeed] = useState("0");
  const [direction, setDirection] = useState(1); // 1=Forward, 0=Reverse
  const [inverterEnabled, setInverterEnabled] = useState(false); // Track enable/disable state
  const [eepromParams, setEepromParams] = useState(null);
  const [readingEeprom, setReadingEeprom] = useState(false);
  const [eepromModalOpen, setEepromModalOpen] = useState(false);

  // Inverter State
  const stateRef = useRef({
    commandedTorque: 0.0,
    torqueFeedback: 0.0,
    commandedSpeed: 0.0,
    powerOnTimer: 0.0,
    motorRpm: null,
    rpmSource: "",
    busVoltage: null,
    busCurrent: null,
    busPower: null,
    internalStatesRaw: "",
    vsmState: null,
    inverterState: null,
    inverterEnabled: null,
    inverterEnableLockout: null,
    directionForward: null,
    activeLimiters: [],
    faultRawBytes: "",
    postFaultLo: null,
    postFaultHi: null,
    runFaultLo: null,
    runFaultHi: null,
    temps: {
      modA: 0.0, modB: 0.0, modC: 0.0, gate: 0.0,
      ctrlBrd: 0.0, rtd1: 0.0, rtd2: 0.0, rtd3: 0.0,
      coolant: 0.0, hotSpot: 0.0, motor: 0.0
    }
  });

  // Track the parameter responses
  const eepromResponsesRef = useRef({});

  useEffect(() => {
    messages.forEach(msg => {
      // Ignore decoded messages if they exist, we parse raw bytes just like the python app
      const { id, data, is_extended } = msg;

      if (!data || data.length === 0) return;
      const dataView = new DataView(new Uint8Array(data).buffer);

      if (id === TORQUE_TIMER_ID && data.length >= 8) {
        stateRef.current.commandedTorque = dataView.getInt16(0, true) * 0.1;
        stateRef.current.torqueFeedback = dataView.getInt16(2, true) * 0.1;
        stateRef.current.powerOnTimer = dataView.getUint32(4, true) * 0.003;
      } else if ((id === MOTOR_POS_INFO_ID || id === MOTOR_POS_INFO_ID_EXT) && data.length >= 4) {
        stateRef.current.motorRpm = dataView.getInt16(2, true);
        stateRef.current.rpmSource = `0x${id.toString(16).toUpperCase()}`;
      } else if ((id === HIGH_SPEED_INFO_ID || id === HIGH_SPEED_INFO_ID_EXT) && data.length >= 6) {
        stateRef.current.motorRpm = dataView.getInt16(4, true);
        stateRef.current.rpmSource = `0x${id.toString(16).toUpperCase()}`;
      } else if ((id === BUS_CURRENT_INFO_ID) && data.length >= 4) {
        stateRef.current.busCurrent = dataView.getInt16(2, true) * 0.1;
      } else if ((id === BUS_VOLTAGE_INFO_ID) && data.length >= 4) {
        stateRef.current.busVoltage = dataView.getInt16(2, true) * 0.1;
      } else if ((id === INTERNAL_STATES_ID) && data.length >= 8) {
        stateRef.current.internalStatesRaw = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        stateRef.current.vsmState = data[0];
        stateRef.current.inverterState = data[2];
        stateRef.current.inverterEnabled = (data[6] & 0x01) !== 0;
        stateRef.current.inverterEnableLockout = (data[6] & 0x80) !== 0;
        stateRef.current.directionForward = (data[7] & 0x01) !== 0;
        // Parse active limiters from byte 7 bits 2-7
        const limiterByte = data[7] >> 2;
        stateRef.current.activeLimiters = [];
        const limiterNames = ['Torque', 'Speed', 'Voltage', 'Current', 'Temp', 'Other'];
        for (let i = 0; i < 6; i++) {
          if (limiterByte & (1 << i)) {
            stateRef.current.activeLimiters.push(limiterNames[i]);
          }
        }
      } else if (id === FAULT_STATUS_ID && data.length >= 8) {
        stateRef.current.faultRawBytes = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        stateRef.current.postFaultLo = dataView.getUint16(0, true);
        stateRef.current.postFaultHi = dataView.getUint16(2, true);
        stateRef.current.runFaultLo = dataView.getUint16(4, true);
        stateRef.current.runFaultHi = dataView.getUint16(6, true);
      } else if (id === TEMP_1_ID && data.length >= 8) {
        stateRef.current.temps.modA = dataView.getInt16(0, true) / 100.0;
        stateRef.current.temps.modB = dataView.getInt16(2, true) / 100.0;
        stateRef.current.temps.modC = dataView.getInt16(4, true) / 100.0;
        stateRef.current.temps.gate = dataView.getInt16(6, true) / 100.0;
      } else if (id === TEMP_2_ID && data.length >= 8) {
        stateRef.current.temps.ctrlBrd = dataView.getInt16(0, true) / 100.0;
        stateRef.current.temps.rtd1 = dataView.getInt16(2, true) / 100.0;
        stateRef.current.temps.rtd2 = dataView.getInt16(4, true) / 100.0;
        stateRef.current.temps.rtd3 = dataView.getInt16(6, true) / 100.0;
      } else if (id === TEMP_3_ID && data.length >= 6) {
        stateRef.current.temps.coolant = dataView.getInt16(0, true) / 100.0;
        stateRef.current.temps.hotSpot = dataView.getInt16(2, true) / 100.0;
        stateRef.current.temps.motor = dataView.getInt16(4, true) / 100.0;
      } else if (id === PARAM_RESPONSE_ID && data.length >= 6) {
        const paramAddr = dataView.getUint16(0, true);
        const writeSuccess = data[2] !== 0;
        const paramValue = dataView.getInt16(4, true);
        eepromResponsesRef.current[paramAddr] = { writeSuccess, value: paramValue };
      }
    });

    // Calculate bus power if we have voltage and current
    const st = stateRef.current;
    if (st.busVoltage !== null && st.busCurrent !== null) {
      st.busPower = st.busVoltage * st.busCurrent;
    }

  }, [messages]);

// Transmit loop for Torque/Speed commands (10 Hz)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!onSendMessage) return;

      if (controlMode === 'torque') {
        const torqueNm = torqueValue;
        const torqueScaled = Math.round(torqueNm * 10);
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setInt16(0, torqueScaled, true);
        view.setInt16(2, 0, true);
        view.setUint8(4, direction); // Direction
        view.setUint8(5, inverterEnabled ? 1 : 0); // Enable/Disable
        view.setInt16(6, 0, true);

        onSendMessage(CMD_ID, Array.from(new Uint8Array(buf)), false);
      } else if (controlMode === 'speed') {
        const speedRpm = speedValue;
        const speedScaled = Math.round(speedRpm);
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint16(0, speedScaled, true); // Speed command
        view.setInt16(2, 0, true); // Feedforward torque
        view.setUint8(4, direction); // Direction
        view.setUint8(5, inverterEnabled ? 1 : 0); // Enable/Disable
        view.setInt16(6, 0, true);

        onSendMessage(CMD_ID, Array.from(new Uint8Array(buf)), false);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [torqueValue, speedValue, controlMode, direction, inverterEnabled, onSendMessage]);

  const handleClearFaults = () => {
    if (onSendMessage) {
      onSendMessage(FAULT_CLEAR_ID, [20, 0, 1, 0, 0, 0, 0, 0], false);
    }
  };

  const handleClearLockout = () => {
    if (onSendMessage) {
      // Send disable command to clear lockout
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      view.setUint8(4, direction); // Current direction
      view.setUint8(5, 0); // Disable
      onSendMessage(CMD_ID, Array.from(new Uint8Array(buf)), false);
    }
  };

  const handleEmergencyStop = () => {
    setTorqueValue(-5.0);
    setInputTorque("-5");
    setSpeedValue(0);
    setInputSpeed("0");
  };

  const handleToggleEnable = () => {
    setInverterEnabled(!inverterEnabled);
  };

  const handleToggleDirection = () => {
    // Send disable command first, then enable with new direction
    if (onSendMessage) {
      const newDirection = direction === 1 ? 0 : 1;
      
      // Disable with current direction
      const disableBuf = new ArrayBuffer(8);
      const disableView = new DataView(disableBuf);
      disableView.setUint8(4, direction);
      disableView.setUint8(5, 0); // Disable
      onSendMessage(CMD_ID, Array.from(new Uint8Array(disableBuf)), false);
      
      // Small delay then enable with new direction
      setTimeout(() => {
        const enableBuf = new ArrayBuffer(8);
        const enableView = new DataView(enableBuf);
        enableView.setUint8(4, newDirection);
        enableView.setUint8(5, 1); // Enable
        onSendMessage(CMD_ID, Array.from(new Uint8Array(enableBuf)), false);
        setDirection(newDirection);
      }, 50);
    }
  };

  const handleApplyTorque = () => {
    let val = parseFloat(inputTorque);
    if (isNaN(val)) return;
    val = Math.max(TORQUE_MIN, Math.min(MAX_TORQUE, val));
    setTorqueValue(val);
    setInputTorque(val.toString());
  };

  const handleApplySpeed = () => {
    let val = parseFloat(inputSpeed);
    if (isNaN(val)) return;
    val = Math.max(0, Math.min(MAX_SPEED_RPM, val));
    setSpeedValue(val);
    setInputSpeed(val.toString());
  };

  const handleAdjustTorque = (inc) => {
    let current = parseFloat(inputTorque);
    if (isNaN(current)) current = 0.0;
    current += inc;
    current = Math.max(TORQUE_MIN, Math.min(MAX_TORQUE, current));
    setTorqueValue(current);
    setInputTorque(current.toString());
  };

  const handleAdjustSpeed = (inc) => {
    let current = parseFloat(inputSpeed);
    if (isNaN(current)) current = 0.0;
    current += inc;
    current = Math.max(0, Math.min(MAX_SPEED_RPM, current));
    setSpeedValue(current);
    setInputSpeed(current.toString());
  };

  const handleResetTorque = () => {
    setTorqueValue(0.0);
    setInputTorque("0");
  };

  const handleResetSpeed = () => {
    setSpeedValue(0.0);
    setInputSpeed("0");
  };

  const readEepromParam = (addr) => {
    return new Promise((resolve) => {
      // Clear previous response before asking
      delete eepromResponsesRef.current[addr];
      
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      view.setUint16(0, addr, true);
      view.setUint8(2, 0x00); // Read
      
      if (onSendMessage) {
        onSendMessage(PARAM_RW_ID, Array.from(new Uint8Array(buf)), false);
      }
      
      // Wait up to 1 second for response
      let attempts = 0;
      const poll = setInterval(() => {
        if (eepromResponsesRef.current[addr]) {
          clearInterval(poll);
          resolve(eepromResponsesRef.current[addr].value);
        } else {
          attempts++;
          if (attempts >= 10) { // 10 * 100ms = 1s
            clearInterval(poll);
            resolve(null);
          }
        }
      }, 100);
    });
  };

  const handleReadEeprom = async () => {
    setReadingEeprom(true);
    const paramsList = [
      { addr: 0x0000, desc: "Torque Limit (Nm)" },
      { addr: 0x0001, desc: "Speed Limit (RPM)" },
      { addr: 0x0002, desc: "Over-temp Threshold (°C)" },
      { addr: 0x0003, desc: "Min Voltage (V)" },
      { addr: 0x0004, desc: "Max Voltage (V)" },
      { addr: 0x0005, desc: "Over-current Limit (A)" }
    ];

    const results = {};
    for (const p of paramsList) {
      const val = await readEepromParam(p.addr);
      if (val !== null) {
        results[p.addr] = { desc: p.desc, value: val };
      }
    }
    
    setEepromParams(results);
    setReadingEeprom(false);
    setEepromModalOpen(true);
  };

  // State snapshot for rendering
  const st = stateRef.current;
  const rpmText = st.motorRpm === null ? "N/A" : st.motorRpm;
  const busVoltageText = st.busVoltage === null ? "N/A" : `${st.busVoltage.toFixed(1)} V`;
  const busCurrentText = st.busCurrent === null ? "N/A" : `${st.busCurrent.toFixed(1)} A`;
  const busPowerText = st.busPower === null ? "N/A" : `${st.busPower.toFixed(2)} kW`;

  const vsmStateText = st.vsmState !== null ? 
    ['Wait State', 'Ready', 'Motor Running', 'Fault State'][st.vsmState] || 'Unknown' : 'Unknown';
  const inverterStateText = st.inverterState !== null ?
    ['Stop', 'Unknown', 'Closed Loop / Normal'][st.inverterState] || 'Unknown' : 'Unknown';

  return (
    <div className="inverter-dashboard">
      <div className="inverter-dashboard-header">
        <h2 className="title">
          <Activity size={24} />
          Inverter Dashboard (CM200DZ)
        </h2>
        <div className="header-actions">
          <button 
            className="action-button danger-button" 
            onClick={handleClearFaults}
          >
            <AlertTriangle size={18} />
            Clear Faults
          </button>
          <button 
            className="action-button warning-button" 
            onClick={handleClearLockout}
          >
            <RotateCcw size={18} />
            Clear Lockout
          </button>
          <button 
            className="action-button e-stop-button" 
            onClick={handleEmergencyStop}
          >
            <Power size={18} />
            🛑 EMERGENCY STOP
          </button>
          <button 
            className={`action-button ${inverterEnabled ? 'success-button' : 'secondary-button'}`} 
            onClick={handleToggleEnable}
          >
            <Power size={18} />
            {inverterEnabled ? 'Disable Inverter' : 'Enable Inverter'}
          </button>
          <button 
            className="action-button info-button" 
            onClick={handleReadEeprom}
            disabled={readingEeprom}
          >
            <Download size={18} />
            {readingEeprom ? 'Reading...' : 'Read EEPROM'}
          </button>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Control Mode Selector */}
        <div className="card mode-selector-card">
          <h3>Control Mode</h3>
          <div className="mode-buttons">
            <button 
              className={`mode-button ${controlMode === 'torque' ? 'active' : ''}`}
              onClick={() => setControlMode('torque')}
            >
              Torque Control
            </button>
            <button 
              className={`mode-button ${controlMode === 'speed' ? 'active' : ''}`}
              onClick={() => setControlMode('speed')}
            >
              Speed Control
            </button>
          </div>
        </div>

        {/* Torque Control Section */}
        {controlMode === 'torque' && (
          <div className="card torque-card">
            <h3>Torque Control (Nm) <span className="subtitle">[-200 to +200, negative = regen]</span></h3>
            <div className="torque-display">
              <span className="label">Current Torque:</span>
              <span className="value">{(torqueValue).toFixed(1)} Nm</span>
            </div>

            <div className="torque-input-row">
              <span className="label">Set Torque:</span>
              <input 
                type="text" 
                className="torque-input"
                value={inputTorque} 
                onChange={(e) => setInputTorque(e.target.value)} 
              />
              <button className="apply-button" onClick={handleApplyTorque}>Apply</button>
            </div>

            <div className="torque-buttons">
              <div className="neg-buttons">
                {[...TORQUE_INCREMENTS].reverse().map(inc => (
                  <button key={`neg-${inc}`} onClick={() => handleAdjustTorque(-inc)}>
                    ▼ -{inc}
                  </button>
                ))}
              </div>
              <div className="pos-buttons">
                {TORQUE_INCREMENTS.map(inc => (
                  <button key={`pos-${inc}`} onClick={() => handleAdjustTorque(inc)}>
                    ▲ +{inc}
                  </button>
                ))}
              </div>
              <button className="reset-button" onClick={handleResetTorque}>Reset</button>
            </div>
          </div>
        )}

        {/* Speed Control Section */}
        {controlMode === 'speed' && (
          <div className="card speed-card">
            <h3>Speed Control (RPM) <span className="subtitle">[0 to 3000]</span></h3>
            <div className="speed-display">
              <span className="label">Current Speed:</span>
              <span className="value">{speedValue.toFixed(0)} RPM</span>
            </div>

            <div className="speed-input-row">
              <span className="label">Set Speed:</span>
              <input 
                type="text" 
                className="speed-input"
                value={inputSpeed} 
                onChange={(e) => setInputSpeed(e.target.value)} 
              />
              <button className="apply-button" onClick={handleApplySpeed}>Apply</button>
            </div>

            <div className="speed-buttons">
              <div className="pos-buttons">
                {SPEED_INCREMENTS.map(inc => (
                  <button key={`pos-${inc}`} onClick={() => handleAdjustSpeed(inc)}>
                    ▲ +{inc}
                  </button>
                ))}
              </div>
              <button className="reset-button" onClick={handleResetSpeed}>Reset</button>
            </div>
          </div>
        )}

        {/* Direction Control */}
        <div className="card direction-card">
          <h3>Direction Control</h3>
          <div className="direction-display">
            <span className="label">Current Direction:</span>
            <span className="value">{direction === 1 ? 'Forward' : 'Reverse'}</span>
          </div>
          <button className="direction-toggle-button" onClick={handleToggleDirection}>
            <RotateCcw size={18} />
            Toggle Direction
          </button>
        </div>

        {/* Inverter Status Section */}
        <div className="card status-card">
          <h3>Inverter Status</h3>
          <div className="status-grid">
            <div className="status-item">
              <span className="status-label">Commanded {controlMode === 'torque' ? 'Torque' : 'Speed'}:</span>
              <span className="status-value">{controlMode === 'torque' ? st.commandedTorque.toFixed(1) + ' Nm' : st.commandedSpeed.toFixed(0) + ' RPM'}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Actual Torque:</span>
              <span className="status-value">{st.torqueFeedback.toFixed(1)} Nm</span>
            </div>
            <div className="status-item">
              <span className="status-label">Motor RPM:</span>
              <span className="status-value">{rpmText} {st.rpmSource && `(Src: ${st.rpmSource})`}</span>
            </div>
            <div className="status-item">
              <span className="status-label">DC Bus Voltage:</span>
              <span className="status-value">{busVoltageText}</span>
            </div>
            <div className="status-item">
              <span className="status-label">DC Bus Current:</span>
              <span className="status-value">{busCurrentText}</span>
            </div>
            <div className="status-item">
              <span className="status-label">DC Bus Power:</span>
              <span className="status-value">{busPowerText}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Power On Timer:</span>
              <span className="status-value">{st.powerOnTimer.toFixed(1)} s</span>
            </div>
            <div className="status-item">
              <span className="status-label">VSM State:</span>
              <span className="status-value">{vsmStateText}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Inverter State:</span>
              <span className="status-value">{inverterStateText}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Enable State:</span>
              <span className="status-value">{st.inverterEnabled === null ? 'Unknown' : (st.inverterEnabled ? 'Enabled' : 'Disabled')}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Control Enable:</span>
              <span className={`status-value ${inverterEnabled ? 'status-enabled' : 'status-disabled'}`}>
                {inverterEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="status-item">
              <span className="status-label">Enable Lockout:</span>
              <span className="status-value">{st.inverterEnableLockout === null ? 'Unknown' : (st.inverterEnableLockout ? 'Yes' : 'No')}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Direction Command:</span>
              <span className="status-value">{st.directionForward === null ? 'Unknown' : (st.directionForward ? 'Forward' : 'Reverse')}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Active Limiters:</span>
              <span className="status-value">{st.activeLimiters.length > 0 ? st.activeLimiters.join(', ') : 'None'}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Fault Status (0x0AB):</span>
              <span className="status-value status-raw">{st.faultRawBytes || 'None'}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Internal States (0x0AA):</span>
              <span className="status-value status-raw">{st.internalStatesRaw || 'None'}</span>
            </div>
          </div>
          
          <h4 className="temp-header"><Zap size={16}/> Temperatures</h4>
          <div className="temp-grid">
            {Object.entries({
               "ModA": st.temps.modA, "ModB": st.temps.modB, "ModC": st.temps.modC,
               "Gate": st.temps.gate, "CtrlBrd": st.temps.ctrlBrd, "RTD1": st.temps.rtd1,
               "RTD2": st.temps.rtd2, "RTD3": st.temps.rtd3, "Coolant": st.temps.coolant,
               "HotSpot": st.temps.hotSpot, "Motor": st.temps.motor
             }).map(([label, val]) => (
               val !== 0.0 && (
                 <div key={label} className="temp-item">
                   <span className="temp-label">{label}:</span>
                   <span className="temp-value">{val.toFixed(1)}°C</span>
                 </div>
               )
             ))}
          </div>
        </div>
      </div>

      {/* EEPROM Modal */}
      {eepromModalOpen && (
        <div className="eeprom-modal-overlay">
          <div className="eeprom-modal">
            <h3>EEPROM Parameters</h3>
            {eepromParams && Object.keys(eepromParams).length > 0 ? (
              <div className="eeprom-list">
                {Object.entries(eepromParams).map(([addrStr, data]) => {
                  const addr = parseInt(addrStr);
                  return (
                    <div key={addr} className="eeprom-item">
                      <span className="eeprom-addr">0x{addr.toString(16).padStart(4, '0').toUpperCase()}</span>
                      <span className="eeprom-desc">{data.desc}</span>
                      <span className="eeprom-value">{data.value}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>No parameters read successfully.</p>
            )}
            <button className="close-modal-button" onClick={() => setEepromModalOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default InverterDashboard;