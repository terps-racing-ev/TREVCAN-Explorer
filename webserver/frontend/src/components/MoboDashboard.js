import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Battery, Power } from 'lucide-react';
import './MoboDashboard.css';

const MOBO_DBC_FILENAME = 'Baby_MOBO.dbc';
const VCU_MOBO_COMMAND_ID = 0x1002C0;

const SDC_SIGNAL_LAYOUT = [
  { name: 'SDC_1', label: 'SDC Raw' },
  { name: 'SDC_2', label: 'SDC IL' },
  { name: 'SDC_3', label: 'SDC BTNs' },
];

const getSignalPayload = (signal) => {
  if (signal && typeof signal === 'object' && !Array.isArray(signal)) {
    return {
      value: signal.value,
      unit: signal.unit || '',
      raw: signal.raw,
    };
  }

  return {
    value: signal,
    unit: '',
    raw: undefined,
  };
};

const formatSignalValue = (signal) => {
  const { value, unit, raw } = getSignalPayload(signal);

  if (typeof value === 'number') {
    const precision = Number.isInteger(value) ? 0 : 3;
    return `${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`;
  }

  if (typeof value === 'string' && raw !== undefined && raw !== null) {
    return `${value} (${raw})`;
  }

  if (value === undefined || value === null || value === '') {
    return '--';
  }

  return `${value}${unit ? ` ${unit}` : ''}`;
};

const getStatusTone = (signal) => {
  const { value, raw } = getSignalPayload(signal);
  const normalized = typeof value === 'string' ? value.toLowerCase() : value;

  if (normalized === 'on' || normalized === 'active' || normalized === 1 || raw === 1) {
    return 'good';
  }

  if (normalized === 'off' || normalized === 'inactive' || normalized === 0 || raw === 0) {
    return 'muted';
  }

  return 'neutral';
};

const getBinarySignalValue = (signal) => {
  const { value, raw } = getSignalPayload(signal);

  if (raw === 0 || raw === 1) {
    return raw;
  }

  if (value === 0 || value === 1) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'on' || normalized === 'active') {
      return 1;
    }
    if (normalized === 'off' || normalized === 'inactive') {
      return 0;
    }
  }

  return null;
};

const isMoboMessage = (message) => {
  const messageName = message?.decoded?.message_name || '';
  const sourceDbc = message?.decoded?.source_dbc || '';

  return sourceDbc === MOBO_DBC_FILENAME || messageName.startsWith('MOBO_');
};

function MoboDashboard({ messages, dbcFiles = [], onRegisterRawCallback, onSendMessage }) {
  const babyMoboDbc = dbcFiles.find((file) => file.filename === MOBO_DBC_FILENAME) || null;
  const isBabyMoboEnabled = Boolean(babyMoboDbc?.enabled);
  const [heartbeatHistory, setHeartbeatHistory] = useState([]);
  const [commandMask, setCommandMask] = useState(0);
  const [isSendingCommand, setIsSendingCommand] = useState(false);

  const {
    latestSignals,
    mostRecentTimestamp,
  } = useMemo(() => {
    const latestSignalMap = new Map();

    messages.forEach((message) => {
      if (!isMoboMessage(message) || !message?.decoded?.signals) {
        return;
      }

      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 0;

      Object.entries(message.decoded.signals).forEach(([signalName, signal]) => {
        const previousSignal = latestSignalMap.get(signalName);
        if (!previousSignal || timestamp >= previousSignal.timestamp) {
          latestSignalMap.set(signalName, {
            signalName,
            signal,
            messageName: message.decoded.message_name || `0x${message.id.toString(16).toUpperCase()}`,
            timestamp,
          });
        }
      });
    });

    const timestamps = Array.from(latestSignalMap.values())
      .map((row) => row.timestamp)
      .filter((value) => value > 0);

    return {
      latestSignals: latestSignalMap,
      mostRecentTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : null,
    };
  }, [messages]);

  const formatTimestamp = (timestamp) => {
    if (!timestamp) {
      return '--';
    }

    return new Date(timestamp * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const batteryVoltage = latestSignals.get('Battery_Voltage')?.signal;
  const lvCurrent = latestSignals.get('LV_Current')?.signal;
  const hvCurrent = latestSignals.get('HC_Current')?.signal;
  const imdSignal = latestSignals.get('IMD')?.signal;
  const bspdSignal = latestSignals.get('BSPD')?.signal;
  const bmsSignal = latestSignals.get('BMS')?.signal;
  const heartbeatSignal = latestSignals.get('Heartbeat_Toggle')?.signal;
  const fiveVSense = latestSignals.get('FiveV_Sense')?.signal;
  const brakeInput = latestSignals.get('Brake_Input')?.signal;
  const pumpCmdSignal = latestSignals.get('Pump_Cmd')?.signal;
  const drsCmdSignal = latestSignals.get('DRS_Cmd')?.signal;
  const fansCmdSignal = latestSignals.get('Fans_Cmd')?.signal;
  const radCmdSignal = latestSignals.get('Rad_Cmd')?.signal;

  const outputStates = useMemo(() => ([
    { key: 'drs', label: 'DRS', bit: 1, signal: drsCmdSignal },
    { key: 'fans', label: 'FANS', bit: 2, signal: fansCmdSignal },
    { key: 'pump', label: 'PUMP', bit: 0, signal: pumpCmdSignal },
    { key: 'rad', label: 'RAD_CTRL', bit: 3, signal: radCmdSignal },
  ]), [drsCmdSignal, fansCmdSignal, pumpCmdSignal, radCmdSignal]);

  useEffect(() => {
    if (!onRegisterRawCallback) {
      return undefined;
    }

    const unregister = onRegisterRawCallback((message) => {
      if (!isMoboMessage(message) || !message?.decoded?.signals?.Heartbeat_Toggle) {
        return;
      }

      const heartbeatValue = getBinarySignalValue(message.decoded.signals.Heartbeat_Toggle);
      if (heartbeatValue === null) {
        return;
      }

      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now() / 1000;

      setHeartbeatHistory((previous) => {
        const next = [...previous, { timestamp, value: heartbeatValue }];
        return next.slice(-120);
      });
    });

    return () => unregister();
  }, [onRegisterRawCallback]);

  useEffect(() => {
    const fallbackHeartbeat = getBinarySignalValue(heartbeatSignal);
    if (fallbackHeartbeat === null) {
      return;
    }

    setHeartbeatHistory((previous) => {
      if (previous.length > 0) {
        return previous;
      }

      return [{
        timestamp: mostRecentTimestamp || Date.now() / 1000,
        value: fallbackHeartbeat,
      }];
    });
  }, [heartbeatSignal, mostRecentTimestamp]);

  useEffect(() => {
    const nextMask = outputStates.reduce((mask, item) => {
      const value = getBinarySignalValue(item.signal);
      if (value === 1) {
        return mask | (1 << item.bit);
      }
      return mask;
    }, 0);

    setCommandMask((previous) => (previous === nextMask ? previous : nextMask));
  }, [outputStates]);

  const heartbeatChart = useMemo(() => {
    const width = 360;
    const height = 140;
    const leftPad = 14;
    const rightPad = 14;
    const topPad = 18;
    const bottomPad = 18;
    const usableWidth = width - leftPad - rightPad;
    const visibleSamples = 12;
    const sampleStep = usableWidth / (visibleSamples - 1);
    const lowY = height - bottomPad;
    const highY = topPad;

    if (heartbeatHistory.length === 0) {
      return {
        width,
        height,
        path: '',
        points: [],
      };
    }

    const xForIndex = (index) => {
      return leftPad + (sampleStep * index);
    };

    const yForValue = (value) => (value === 1 ? highY : lowY);

    let path = '';
    const points = heartbeatHistory.map((point, index) => ({
      x: xForIndex(index),
      y: yForValue(point.value),
      value: point.value,
    }));

    points.forEach((point, index) => {
      if (index === 0) {
        path += `M ${point.x} ${point.y}`;
        return;
      }

      path += ` H ${point.x} V ${point.y}`;
    });

    return {
      width,
      height,
      path,
      points,
    };
  }, [heartbeatHistory]);

  const sendCommandMask = async (mask) => {
    if (!onSendMessage) {
      return;
    }

    setIsSendingCommand(true);

    try {
      const ok = await onSendMessage(
        VCU_MOBO_COMMAND_ID,
        [1, mask & 0x0f, 0, 0, 0, 0, 0, 0],
        true,
        false
      );

      if (ok) {
        setCommandMask(mask & 0x0f);
      }
    } finally {
      setIsSendingCommand(false);
    }
  };

  const toggleCommandBit = async (bit) => {
    const nextMask = commandMask ^ (1 << bit);
    await sendCommandMask(nextMask);
  };

  return (
    <div className="mobo-dashboard">
      <div className="card">
        <div className="mobo-header">
          <div>
            <h2>MOBO</h2>
            <p>Live decoded signals from {MOBO_DBC_FILENAME}</p>
          </div>
          <div className={`mobo-dbc-badge ${isBabyMoboEnabled ? 'enabled' : 'disabled'}`}>
            {isBabyMoboEnabled ? 'DBC enabled' : 'Enable Baby_MOBO.dbc'}
          </div>
        </div>

        {!babyMoboDbc && (
          <div className="mobo-notice warning">
            {MOBO_DBC_FILENAME} is not in the uploaded DBC list yet. Upload it in the DBC section to decode MOBO frames.
          </div>
        )}

        {babyMoboDbc && !isBabyMoboEnabled && (
          <div className="mobo-notice warning">
            {MOBO_DBC_FILENAME} is uploaded but disabled. Turn it on in the DBC section so this tab can decode and display MOBO signals.
          </div>
        )}

        {!batteryVoltage && !lvCurrent && !hvCurrent && !fiveVSense && !brakeInput && !latestSignals.get('SDC_1') && !latestSignals.get('SDC_2') && !latestSignals.get('SDC_3') ? (
          <div className="mobo-empty-state">
            <Activity size={42} />
            <h3>No MOBO frames received yet</h3>
            <p>This tab will populate once decoded `MOBO_*` messages start arriving on the CAN bus.</p>
          </div>
        ) : (
          <>
            <div className="mobo-last-update">Last update: {formatTimestamp(mostRecentTimestamp)}</div>

            <div className="mobo-custom-layout">
              <div className="mobo-main-column">
                <div className="mobo-top-grid">
                  <section className="mobo-value-card battery">
                    <div className="mobo-value-header">
                      <Battery size={18} />
                      <span>Battery Voltage</span>
                    </div>
                    <div className="mobo-value-readout">{formatSignalValue(batteryVoltage)}</div>
                  </section>

                  <section className="mobo-value-card heartbeat">
                    <div className="mobo-value-header">
                      <Power size={18} />
                      <span>Heartbeat Toggle</span>
                    </div>
                    <div className="mobo-heartbeat-status">{formatSignalValue(heartbeatSignal)}</div>
                    <div className="mobo-heartbeat-graph">
                      <svg viewBox={`0 0 ${heartbeatChart.width} ${heartbeatChart.height}`} preserveAspectRatio="none" aria-label="Heartbeat toggle graph">
                        <line x1="14" y1="18" x2={heartbeatChart.width - 14} y2="18" className="heartbeat-grid" />
                        <line x1="14" y1={heartbeatChart.height - 18} x2={heartbeatChart.width - 14} y2={heartbeatChart.height - 18} className="heartbeat-grid" />
                        {heartbeatChart.path && (
                          <path d={heartbeatChart.path} className="heartbeat-line" />
                        )}
                        {heartbeatChart.points.map((point, index) => (
                          <circle
                            key={`${index}-${point.x}-${point.y}`}
                            cx={point.x}
                            cy={point.y}
                            r="3"
                            className={`heartbeat-point ${point.value === 1 ? 'high' : 'low'}`}
                          />
                        ))}
                      </svg>
                    </div>
                  </section>
                </div>

                <div className="mobo-bottom-grid">
                  <section className="mobo-value-card current combined">
                    <div className="mobo-value-header">
                      <Power size={18} />
                      <span>Currents</span>
                    </div>
                    <div className="mobo-split-readout">
                      <div className="mobo-split-item">
                        <span className="mobo-dual-label">LV Current</span>
                        <span className="mobo-dual-value">{formatSignalValue(lvCurrent)}</span>
                      </div>
                      <div className="mobo-split-divider" aria-hidden="true" />
                      <div className="mobo-split-item">
                        <span className="mobo-dual-label">HV Current</span>
                        <span className="mobo-dual-value">{formatSignalValue(hvCurrent)}</span>
                      </div>
                    </div>
                  </section>

                  <section className="mobo-value-card aux">
                    <div className="mobo-value-header">
                      <Activity size={18} />
                      <span>Aux Inputs</span>
                    </div>
                    <div className="mobo-dual-readout compact">
                      <div className="mobo-dual-item">
                        <span className="mobo-dual-label">FiveV Sense</span>
                        <span className="mobo-dual-value">{formatSignalValue(fiveVSense)}</span>
                      </div>
                      <div className="mobo-dual-item">
                        <span className="mobo-dual-label">Brake Input</span>
                        <span className="mobo-dual-value">{formatSignalValue(brakeInput)}</span>
                      </div>
                    </div>
                  </section>

                  <section className="mobo-status-panel">
                    <div className="mobo-panel-header">Faults</div>
                    <div className="mobo-status-row">
                      {[
                        { label: 'IMD', signal: imdSignal },
                        { label: 'BSPD', signal: bspdSignal },
                        { label: 'BMS', signal: bmsSignal },
                      ].map(({ label, signal }) => {
                        const tone = getStatusTone(signal);

                        return (
                          <div key={label} className="mobo-status-node">
                            <section className={`mobo-status-card ${tone === 'good' ? 'active' : 'inactive'}`}>
                              <div className="mobo-status-card-label">{label}</div>
                              <div className="mobo-status-card-value">{formatSignalValue(signal)}</div>
                            </section>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </div>

              <aside className="mobo-sdc-panel">
                <div className="mobo-panel-header">SDC</div>
                <div className="mobo-sdc-stack">
                  {SDC_SIGNAL_LAYOUT.map(({ name, label }) => {
                    const entry = latestSignals.get(name);
                    const tone = getStatusTone(entry?.signal);

                    return (
                      <div key={name} className="mobo-sdc-node">
                        <div className={`mobo-sdc-block ${tone === 'good' ? 'active' : 'inactive'}`}>
                          <span className="mobo-sdc-label">{label}</span>
                          <span className="mobo-sdc-value">{entry ? formatSignalValue(entry.signal) : '--'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </aside>
            </div>

            <section className="mobo-control-strip">
              <div className="mobo-control-row">
                <section className="mobo-control-panel">
                  <div className="mobo-panel-header">HC Toggle</div>
                  <div className="mobo-control-status-list">
                    {outputStates.map((item) => {
                      const tone = getStatusTone(item.signal);
                      return (
                        <div key={item.key} className={`mobo-control-status ${tone === 'good' ? 'active' : 'inactive'}`}>
                          <span className="mobo-control-status-label">{item.label}</span>
                          <span className="mobo-control-status-value">{formatSignalValue(item.signal)}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="mobo-control-panel">
                  <div className="mobo-panel-header">Toggle Controls</div>
                  <div className="mobo-control-actions">
                    {outputStates.map((item) => {
                      const isActive = (commandMask & (1 << item.bit)) !== 0;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={`mobo-command-btn ${isActive ? 'active' : ''}`}
                          onClick={() => toggleCommandBit(item.bit)}
                          disabled={isSendingCommand}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="mobo-command-btn utility"
                      onClick={() => sendCommandMask(0x0f)}
                      disabled={isSendingCommand}
                    >
                      All On
                    </button>
                    <button
                      type="button"
                      className="mobo-command-btn utility"
                      onClick={() => sendCommandMask(0)}
                      disabled={isSendingCommand}
                    >
                      All Off
                    </button>
                  </div>
                </section>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default MoboDashboard;
