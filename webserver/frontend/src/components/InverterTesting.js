import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNowTick, isTimestampStale, messageFreshnessTimestamp } from '../hooks/useStaleness';
import {
  COMMAND_ID, PARAMETER_ID, MAX_TORQUE, EEPROM_PARAMETERS,
  buildTorqueCommand, buildParameterRead, parseParameterResponse, decodeInverterFrames,
} from './inverterTestingProtocol';
import './InverterDashboard.css';
import './InverterTesting.css';

const initialCommand = () => ({ torque: 0, direction: 1, enabled: false, active: false });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function InverterTesting({
  messages = [], connectionStatus, simulationActive = false, transmitBusId = 'bus1',
  onSendMessage, onRegisterRawCallback, staleTimeoutMs = 30000,
}) {
  const bus = connectionStatus?.buses?.find((entry) => entry.bus_id === transmitBusId);
  const connected = Boolean(bus?.connected && !simulationActive);
  const busIdentity = `${transmitBusId}:${bus?.device_type || ''}:${bus?.channel || ''}`;
  const [command, setCommand] = useState(initialCommand);
  const [input, setInput] = useState('0');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ type: 'idle', text: 'Stopped' });
  const [reading, setReading] = useState(false);
  const [parameters, setParameters] = useState(null);
  const sessionRef = useRef(null);
  const senderRef = useRef(onSendMessage);
  senderRef.current = onSendMessage;
  const nowMs = useNowTick();
  const groups = useMemo(() => decodeInverterFrames(messages, transmitBusId), [messages, transmitBusId]);

  // Use the existing /send route and 100 ms cadence, as the other web controls do.
  useEffect(() => {
    const sender = senderRef.current;
    const session = {
      command: initialCommand(), disposed: false, busy: false, used: false, inFlight: null,
      cancelRead: null,
      async send(id, data) {
        if (id === COMMAND_ID) session.used = true;
        const result = await sender(id, data, false, false);
        if (result !== true && !result?.success) throw new Error('CAN send failed. Check the selected bus.');
      },
    };
    sessionRef.current = session;
    setCommand(session.command);
    setInput('0');
    setBusy(false);
    setReading(false);
    setParameters(null);
    setStatus({ type: 'idle', text: 'Stopped' });

    const timer = setInterval(() => {
      if (!connected || session.disposed || session.busy || session.inFlight || !session.command.active) return;
      const { torque, direction, enabled } = session.command;
      const pending = session.send(COMMAND_ID, buildTorqueCommand(torque, direction, enabled))
        .catch((error) => {
          session.command = { ...session.command, torque: 0, enabled: false, active: false };
          if (!session.disposed) {
            setCommand(session.command);
            setStatus({ type: 'error', text: error.message });
          }
          return session.send(COMMAND_ID, buildTorqueCommand(0, direction, false)).catch(() => {});
        });
      session.inFlight = pending;
      pending.finally(() => { if (session.inFlight === pending) session.inFlight = null; });
    }, 100);

    return () => {
      clearInterval(timer);
      session.disposed = true;
      session.cancelRead?.();
      // Wait for any earlier command before the final disable, including a direction change.
      if (session.used) {
        Promise.resolve(session.inFlight).catch(() => {}).then(() =>
          session.send(COMMAND_ID, buildTorqueCommand(0, session.command.direction, false))
        ).catch(() => {});
      }
    };
  }, [busIdentity, connected]);

  const runCommand = async (action, text) => {
    const session = sessionRef.current;
    if (!connected || !session || session.disposed || session.busy) return;
    session.busy = true;
    setBusy(true);
    // Store the action as well as periodic sends so cleanup can send disable last.
    const pending = session.inFlight;
    const operation = (async () => {
      await pending;
      if (session.disposed) return;
      await action(session);
      if (!session.disposed) {
        setCommand({ ...session.command });
        setInput(String(session.command.torque));
        setStatus({ type: 'success', text });
      }
    })();
    session.inFlight = operation;
    try {
      await operation;
    } catch (error) {
      session.command = { ...session.command, torque: 0, enabled: false, active: false };
      await session.send(COMMAND_ID, buildTorqueCommand(0, session.command.direction, false)).catch(() => {});
      if (!session.disposed) {
        setCommand(session.command);
        setStatus({ type: 'error', text: error.message });
      }
    } finally {
      if (session.inFlight === operation) session.inFlight = null;
      session.busy = false;
      if (!session.disposed) setBusy(false);
    }
  };

  const applyTorque = (value) => {
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) {
      setStatus({ type: 'error', text: 'Please enter a valid torque.' });
      return;
    }
    const torque = Math.round(Math.max(-MAX_TORQUE, Math.min(MAX_TORQUE, Number(value))) * 10) / 10;
    return runCommand(async (session) => {
      session.command = { ...session.command, torque, enabled: true, active: true };
      await session.send(COMMAND_ID, buildTorqueCommand(torque, session.command.direction));
    }, torque === -5 ? 'Applying −5 Nm braking torque at 10 Hz' : `Sending ${torque.toFixed(1)} Nm at 10 Hz`);
  };

  const disable = (keepStreaming) => runCommand(async (session) => {
    session.command = { ...session.command, torque: 0, enabled: false, active: keepStreaming };
    await session.send(COMMAND_ID, buildTorqueCommand(0, session.command.direction, false));
  }, keepStreaming ? 'Disable command sent. Apply torque to re-enable.' : 'Stopped; inverter disabled');

  const toggleDirection = () => runCommand(async (session) => {
    session.command = { ...session.command, torque: 0, enabled: false, active: false };
    await session.send(COMMAND_ID, buildTorqueCommand(0, session.command.direction, false));
    await delay(50);
    if (session.disposed) return;
    session.command = { torque: 0, direction: session.command.direction ? 0 : 1, enabled: true, active: true };
    await session.send(COMMAND_ID, buildTorqueCommand(0, session.command.direction));
  }, 'Direction changed with zero torque');

  const readEEPROM = async () => {
    const session = sessionRef.current;
    if (!connected || !session || reading || typeof onRegisterRawCallback !== 'function') return;
    setReading(true);
    setParameters({});
    try {
      for (let address = 0; address < EEPROM_PARAMETERS.length && !session.disposed; address += 1) {
        const value = await new Promise((resolve, reject) => {
          let unsubscribe = () => {};
          let timeout;
          let settled = false;
          const finish = (value, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe();
            session.cancelRead = null;
            if (error) reject(error); else resolve(value);
          };
          session.cancelRead = () => finish(null);
          unsubscribe = onRegisterRawCallback((message) => {
            const result = parseParameterResponse(message, transmitBusId, address);
            if (result !== null) finish(result);
          });
          timeout = setTimeout(() => finish(null), 1000);
          session.send(PARAMETER_ID, buildParameterRead(address)).catch((error) => finish(null, error));
        });
        if (!session.disposed) setParameters((previous) => ({ ...previous, [address]: value }));
      }
    } catch (error) {
      if (!session.disposed) setStatus({ type: 'error', text: error.message });
    } finally {
      if (!session.disposed) setReading(false);
    }
  };

  const renderGroup = (key, title) => {
    const group = groups[key];
    const stale = group && isTimestampStale(messageFreshnessTimestamp(group.frame), nowMs, staleTimeoutMs);
    return (
      <section className={`inv-card ${stale ? 'testing-stale' : ''}`} key={key}>
        <div className="inv-card-header"><h3>{group?.title || title}</h3>
          <span className={`freshness ${group ? (stale ? 'stale' : 'fresh') : 'missing'}`}>
            {group ? (stale ? 'Stale' : 'Received') : 'No data'}
          </span>
        </div>
        {group ? <dl className="testing-readings">{group.rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}</dl> : <div className="inv-empty-line">Waiting for inverter feedback</div>}
      </section>
    );
  };

  return (
    <div className="inv-dashboard inverter-testing">
      <div className="inv-header">
        <div><h2>Inverter Testing</h2><p>CM200DZ Inverter Controller</p></div>
        <span className={`inv-status-pill ${status.type}`} role="status">{status.text}</span>
      </div>
      <div className="inv-notice">
        {connected ? `Using ${transmitBusId === 'bus2' ? 'Bus 2' : 'Bus 1'} · ${bus.channel} · ${bus.status}`
          : 'Connect the selected transmit bus using the sidebar to control the inverter.'}
      </div>
      <section className="inv-card inv-command-panel">
        <div className="inv-card-header"><h3>Torque Control</h3>
          <span className="inv-tx-counter">{command.active ? (command.enabled ? 'Enabled · 10 Hz' : 'Disabled · 10 Hz') : 'Stopped'}</span>
        </div>
        <div className="inv-setpoint-display">{command.torque.toFixed(1)} Nm</div>
        <form className="testing-torque-input" noValidate onSubmit={(event) => { event.preventDefault(); applyTorque(input); }}>
          <label htmlFor="testing-torque">Set Torque (Nm)</label>
          <input id="testing-torque" type="number" step="0.1" min={-MAX_TORQUE} max={MAX_TORQUE}
            value={input} onChange={(event) => setInput(event.target.value)} disabled={!connected || busy} />
          <button className="inv-action-btn" type="submit" disabled={!connected || busy}>Apply</button>
        </form>
        <div className="inv-button-row">
          {[-1, -5, -10, 10, 5, 1].map((increment) => (
            <button className="inv-action-btn" key={increment} disabled={!connected || busy}
              onClick={() => applyTorque((Number(input) || 0) + increment)}>
              {increment > 0 ? '+' : ''}{increment} Nm
            </button>
          ))}
          <button className="inv-action-btn" disabled={!connected || busy} onClick={() => applyTorque(0)}>Reset</button>
        </div>
        <div className="inv-button-row">
          <button className="inv-action-btn" disabled={!connected || busy} onClick={toggleDirection}>
            Direction: {command.direction ? 'Forward' : 'Reverse'}
          </button>
          <button className="inv-action-btn" disabled={!connected || busy}
            onClick={() => runCommand((session) => session.send(PARAMETER_ID, [20, 0, 1, 0, 0, 0, 0, 0]), 'Fault clear command sent')}>
            Clear Faults
          </button>
          <button className="inv-action-btn" disabled={!connected || busy} onClick={() => disable(true)}>Clear Lockout</button>
          <button className="inv-action-btn" disabled={!connected || reading} onClick={readEEPROM}>
            {reading ? 'Reading EEPROM…' : 'Read EEPROM'}
          </button>
          <button className="inv-action-btn stop" disabled={!connected || busy} onClick={() => disable(false)}>Stop Testing</button>
          <button className="inv-action-btn estop" disabled={!connected || busy} onClick={() => applyTorque(-5)}>Emergency Stop (−5 Nm)</button>
        </div>
      </section>
      <div className="inv-section-grid">
        {[
          ['torque', 'Torque & Timer'], ['speed', 'Motor Speed'], ['voltage', 'DC Bus Voltage'],
          ['current', 'DC Bus Current'], ['power', 'DC Bus Power'], ['internal', 'Internal States (0x0AA)'],
          ['faults', 'Fault Status (0x0AB)'], ['temp160', 'Temperatures (0x0A0)'],
          ['temp161', 'Temperatures (0x0A1)'], ['temp162', 'Temperatures (0x0A2)'],
        ].map(([key, title]) => renderGroup(key, title))}
      </div>
      {parameters && <section className="inv-card">
        <div className="inv-card-header"><h3>EEPROM Parameters</h3></div>
        <dl className="testing-readings">{EEPROM_PARAMETERS.map((description, address) => (
          <div key={address}><dt>0x{address.toString(16).padStart(4, '0')} · {description}</dt>
            <dd>{parameters[address] === undefined ? 'Waiting…' : parameters[address] === null ? 'No response' : parameters[address]}</dd>
          </div>
        ))}</dl>
      </section>}
    </div>
  );
}

export default InverterTesting;
