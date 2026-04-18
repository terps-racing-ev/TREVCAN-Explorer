import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Battery, Thermometer, TrendingUp, TrendingDown, Zap, Scale } from 'lucide-react';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import './BalanceManager.css';

// CAN IDs for balance messages (29-bit extended)
const CAN_BALANCE_CMD_BASE = 0x08F00F05;
const CAN_BALANCE_CFG_BASE = 0x08F00F07;

const SEND_INTERVAL_MS = 4000;

function BalanceManager({ messages, onSendMessage, staleTimeoutMs = 30000 }) {
  const nowMs = useNowTick(1000);

  // Per-module freshest CAN timestamp (in seconds) for stale detection.
  const moduleFreshestTimestamp = useMemo(() => {
    const timestamps = Array(6).fill(null);
    if (!messages) return timestamps;
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
  // Per-module balance config state
  const [moduleConfigs, setModuleConfigs] = useState(() =>
    Array(6).fill(null).map(() => ({
      targetVoltageMv: 3500,
      maxCellsPerChip: 4,
      bms1Enable: false,
      bms2Enable: false,
      active: false,
    }))
  );

  const intervalsRef = useRef({});

  // Build CAN ID with module offset
  const canId = (base, moduleId) => base | (moduleId << 12);

  // Send both balance messages for a module
  const sendBalanceMessages = useCallback((moduleId, config) => {
    if (!onSendMessage) return;

    const targetMv = Math.max(0, Math.min(5000, config.targetVoltageMv));
    const maxCells = Math.max(1, Math.min(9, config.maxCellsPerChip));

    // Balance Config: [targetMv_lo, targetMv_hi, maxCells, 0, 0, 0, 0, 0]
    const cfgData = [
      targetMv & 0xFF,
      (targetMv >> 8) & 0xFF,
      maxCells,
      0, 0, 0, 0, 0,
    ];
    onSendMessage(canId(CAN_BALANCE_CFG_BASE, moduleId), cfgData, true, false);

    // Balance Command: [bms1_enable, bms2_enable]
    const cmdData = [
      config.bms1Enable ? 1 : 0,
      config.bms2Enable ? 1 : 0,
    ];
    onSendMessage(canId(CAN_BALANCE_CMD_BASE, moduleId), cmdData, true, false);
  }, [onSendMessage]);

  // Start/stop periodic sending when toggle changes
  const toggleModule = useCallback((moduleId) => {
    setModuleConfigs(prev =>
      prev.map((c, i) => i === moduleId ? { ...c, active: !c.active } : c)
    );
  }, []);

  // Keep a ref to moduleConfigs for interval callbacks
  const configsRef = useRef(moduleConfigs);
  useEffect(() => {
    configsRef.current = moduleConfigs;
  }, [moduleConfigs]);

  // Manage intervals based on active state
  useEffect(() => {
    moduleConfigs.forEach((config, moduleId) => {
      const hasInterval = !!intervalsRef.current[moduleId];

      if (config.active && !hasInterval) {
        // Send immediately
        sendBalanceMessages(moduleId, config);
        intervalsRef.current[moduleId] = setInterval(() => {
          const latest = configsRef.current[moduleId];
          if (latest && latest.active) {
            sendBalanceMessages(moduleId, latest);
          }
        }, SEND_INTERVAL_MS);
      } else if (!config.active && hasInterval) {
        clearInterval(intervalsRef.current[moduleId]);
        delete intervalsRef.current[moduleId];
      }
    });
  }, [moduleConfigs, sendBalanceMessages]);

  // Cleanup all intervals on unmount
  useEffect(() => {
    const refs = intervalsRef;
    return () => {
      Object.values(refs.current).forEach(id => clearInterval(id));
      refs.current = {};
    };
  }, []);

  const updateModuleConfig = (moduleId, field, value) => {
    setModuleConfigs(prev =>
      prev.map((c, i) => i === moduleId ? { ...c, [field]: value } : c)
    );
  };

  // Extract cell voltage data from CAN messages
  const cellData = useMemo(() => {
    const modules = Array(6).fill(null).map(() => Array(18).fill(null));
    const bmsStackVoltages = Array(6).fill(null).map(() => ({ bms1: null, bms2: null }));

    messages.forEach(msg => {
      if (msg.decoded && msg.decoded.signals) {
        const signals = msg.decoded.signals;
        const msgName = msg.decoded.message_name || '';
        const moduleMatch = msgName.match(/_(\d)$/);
        const moduleId = moduleMatch ? parseInt(moduleMatch[1]) : null;

        Object.entries(signals).forEach(([key, signalData]) => {
          const value = typeof signalData === 'object' && signalData !== null
            ? signalData.value
            : signalData;

          const cellMatch = key.match(/Cell_(\d+)_Voltage/);
          if (cellMatch) {
            const cellNum = parseInt(cellMatch[1]) - 1;
            const cellModuleId = Math.floor(cellNum / 18);
            const cellIdx = cellNum % 18;
            if (cellModuleId >= 0 && cellModuleId < 6 && cellIdx >= 0 && cellIdx < 18 && typeof value === 'number') {
              modules[cellModuleId][cellIdx] = value > 100 ? value / 1000 : value;
            }
          }

          if (key === 'BMS1_Stack_Voltage' && typeof value === 'number' && moduleId !== null && moduleId < 6) {
            bmsStackVoltages[moduleId].bms1 = value > 1000 ? value / 1000 : value;
          }
          if (key === 'BMS2_Stack_Voltage' && typeof value === 'number' && moduleId !== null && moduleId < 6) {
            bmsStackVoltages[moduleId].bms2 = value > 1000 ? value / 1000 : value;
          }
        });
      }
    });

    let totalStackVoltage = 0;
    let hasAnyStackVoltage = false;
    bmsStackVoltages.forEach(module => {
      if (module.bms1 !== null) { totalStackVoltage += module.bms1; hasAnyStackVoltage = true; }
      if (module.bms2 !== null) { totalStackVoltage += module.bms2; hasAnyStackVoltage = true; }
    });

    return {
      modules,
      stackVoltage: hasAnyStackVoltage ? totalStackVoltage : null,
      bmsStackVoltages,
    };
  }, [messages]);

  // Extract thermistor data from CAN messages
  const thermistorData = useMemo(() => {
    const modules = Array(6).fill(null).map(() => Array(56).fill(null));

    messages.forEach(msg => {
      if (msg.decoded && msg.decoded.signals) {
        const signals = msg.decoded.signals;

        Object.entries(signals).forEach(([key, signalData]) => {
          let tempNum = null;
          const tempMatch = key.match(/^Temp_(\d+)$/);
          if (tempMatch) {
            tempNum = parseInt(tempMatch[1], 10);
          } else {
            const ambientMatch = key.match(/^Ambient_Temp_[12]_(\d+)$/);
            if (ambientMatch) {
              tempNum = parseInt(ambientMatch[1], 10);
            }
          }
          if (tempNum === null || Number.isNaN(tempNum)) return;

          const moduleId = Math.floor(tempNum / 56);
          const channel = tempNum % 56;
          if (moduleId >= 0 && moduleId < 6 && channel >= 0 && channel < 56) {
            const value = typeof signalData === 'object' && signalData !== null
              ? signalData.value
              : signalData;
            modules[moduleId][channel] = typeof value === 'number' ? value : null;
          }
        });
      }
    });

    return modules;
  }, [messages]);

  // Organize thermistor data into cell groups (18 groups of 3 each)
  const organizedTempData = useMemo(() => {
    return thermistorData.map(module => {
      const cellGroups = [];
      for (let i = 0; i < 18; i++) {
        cellGroups.push({
          groupNum: i + 1,
          temps: [module[i * 3], module[i * 3 + 1], module[i * 3 + 2]]
        });
      }
      return cellGroups;
    });
  }, [thermistorData]);

  const isDisplayableTemp = (temp) => temp !== null && temp >= -30;

  // Extract balancing state from CAN messages
  const balancingData = useMemo(() => {
    const modules = Array(6).fill(null).map(() => Array(18).fill(false));

    messages.forEach(msg => {
      if (msg.decoded && msg.decoded.signals) {
        const signals = msg.decoded.signals;
        const msgName = msg.decoded.message_name || '';
        const balanceMatch = msgName.match(/BMS([12])_Balance_Detail_([0-5])$/);
        if (balanceMatch) {
          const moduleId = parseInt(balanceMatch[2]);
          Object.entries(signals).forEach(([key, signalData]) => {
            const cellBalMatch = key.match(/BMS[12]_Cell(\d+)_Bal/);
            if (cellBalMatch) {
              const cellNum = parseInt(cellBalMatch[1]);
              const value = typeof signalData === 'object' && signalData !== null
                ? signalData.value
                : signalData;
              const cellIdx = cellNum - 1;
              if (cellIdx >= 0 && cellIdx < 18) {
                const isBalancing = Number(value) === 1 ||
                  (typeof value === 'string' && value.toLowerCase().includes('balancing'));
                if (isBalancing) {
                  modules[moduleId][cellIdx] = true;
                }
              }
            }
          });
        }
      }
    });

    return modules;
  }, [messages]);

  // Extract module BMS state from heartbeat messages
  const moduleStates = useMemo(() => {
    const states = Array(6).fill('OFFLINE');
    messages.forEach(msg => {
      if (!msg.decoded || !msg.decoded.signals) return;
      const msgName = msg.decoded.message_name || '';
      const heartbeatMatch = msgName.match(/^BMS_Heartbeat_(\d)$/);
      if (!heartbeatMatch) return;
      const moduleId = parseInt(heartbeatMatch[1], 10);
      if (moduleId < 0 || moduleId > 5) return;
      const stateSignal = msg.decoded.signals.BMS_State;
      if (stateSignal === undefined || stateSignal === null) {
        states[moduleId] = 'UNKNOWN';
        return;
      }
      if (typeof stateSignal === 'object') {
        if (typeof stateSignal.value === 'string') states[moduleId] = stateSignal.value;
        else if (stateSignal.value !== undefined) states[moduleId] = String(stateSignal.value);
        else if (stateSignal.raw !== undefined) states[moduleId] = String(stateSignal.raw);
        else states[moduleId] = 'UNKNOWN';
      } else {
        states[moduleId] = String(stateSignal);
      }
    });
    return states;
  }, [messages]);

  // Extract balance status feedback from BMS_Balance_Status_N and BMS_Balance_ACK_N
  const balanceStatus = useMemo(() => {
    const statuses = Array(6).fill(null).map(() => ({
      ackStatus: null,
      targetEcho: null,
      maxCellsEcho: null,
      bms1CellCount: null,
      bms2CellCount: null,
      bms1IcTemp: null,
      bms2IcTemp: null,
    }));

    messages.forEach(msg => {
      if (!msg.decoded || !msg.decoded.signals) return;
      const msgName = msg.decoded.message_name || '';
      const signals = msg.decoded.signals;

      const getVal = (sig) => {
        if (sig === undefined || sig === null) return null;
        const v = typeof sig === 'object' && sig !== null ? sig.value : sig;
        return typeof v === 'number' ? v : null;
      };

      const getStrVal = (sig) => {
        if (sig === undefined || sig === null) return null;
        if (typeof sig === 'object' && sig !== null) {
          return typeof sig.value === 'string' ? sig.value : sig.value != null ? String(sig.value) : null;
        }
        return String(sig);
      };

      // BMS_Balance_ACK_N
      const ackMatch = msgName.match(/^BMS_Balance_ACK_(\d)$/);
      if (ackMatch) {
        const moduleId = parseInt(ackMatch[1]);
        if (moduleId >= 0 && moduleId < 6) {
          const raw = getStrVal(signals.Balance_Status);
          statuses[moduleId].ackStatus = raw;
        }
      }

      // BMS_Balance_Status_N
      const statusMatch = msgName.match(/^BMS_Balance_Status_(\d)$/);
      if (statusMatch) {
        const moduleId = parseInt(statusMatch[1]);
        if (moduleId >= 0 && moduleId < 6) {
          statuses[moduleId].targetEcho = getVal(signals.Target_Voltage_mV);
          statuses[moduleId].maxCellsEcho = getVal(signals.Max_Cells_Per_Chip);
          statuses[moduleId].bms1CellCount = getVal(signals.BMS1_Cell_Count);
          statuses[moduleId].bms2CellCount = getVal(signals.BMS2_Cell_Count);
          statuses[moduleId].bms1IcTemp = getVal(signals.BMS1_IC_Temp);
          statuses[moduleId].bms2IcTemp = getVal(signals.BMS2_IC_Temp);
        }
      }
    });

    return statuses;
  }, [messages]);

  // Voltage statistics
  const voltageStats = useMemo(() => {
    const allVoltages = cellData.modules.flat().filter(v => v !== null);
    if (allVoltages.length === 0) {
      return { active: 0, min: null, max: null, avg: null, delta: null };
    }
    const min = Math.min(...allVoltages);
    const max = Math.max(...allVoltages);
    const avg = allVoltages.reduce((a, b) => a + b, 0) / allVoltages.length;
    return { active: allVoltages.length, min, max, avg, delta: max - min };
  }, [cellData]);

  const moduleVoltageStats = useMemo(() => {
    return cellData.modules.map(module => {
      const valid = module.filter(v => v !== null);
      if (valid.length === 0) return { min: null, max: null, delta: null };
      const min = Math.min(...valid);
      const max = Math.max(...valid);
      return { min, max, delta: max - min };
    });
  }, [cellData]);

  // Voltage color gradient
  const getVoltageColor = (voltage) => {
    if (voltage === null) return '#2d3748';
    const minV = 2.5;
    const maxV = 4.35;
    const t = (Math.max(minV, Math.min(maxV, voltage)) - minV) / (maxV - minV);
    const colors = [
      { pos: 0,    r: 180, g: 50,  b: 50  },
      { pos: 0.27, r: 180, g: 85,  b: 16  },
      { pos: 0.43, r: 190, g: 155, b: 16  },
      { pos: 0.65, r: 25,  g: 145, b: 70  },
      { pos: 0.92, r: 45,  g: 100, b: 185 },
      { pos: 1,    r: 125, g: 65,  b: 185 },
    ];
    let lower = colors[0];
    let upper = colors[colors.length - 1];
    for (let i = 0; i < colors.length - 1; i++) {
      if (t >= colors[i].pos && t <= colors[i + 1].pos) {
        lower = colors[i];
        upper = colors[i + 1];
        break;
      }
    }
    const range = upper.pos - lower.pos;
    const localT = range > 0 ? (t - lower.pos) / range : 0;
    const r = Math.round(lower.r + (upper.r - lower.r) * localT);
    const g = Math.round(lower.g + (upper.g - lower.g) * localT);
    const b = Math.round(lower.b + (upper.b - lower.b) * localT);
    return `rgb(${r}, ${g}, ${b})`;
  };

  // Temperature color gradient
  const getTempColor = (temp) => {
    if (temp === null) return '#2d3748';
    const minTemp = 15;
    const maxTemp = 60;
    const t = (Math.max(minTemp, Math.min(maxTemp, temp)) - minTemp) / (maxTemp - minTemp);
    const colors = [
      { pos: 0,    r: 139, g: 92,  b: 246 },
      { pos: 0.33, r: 59,  g: 130, b: 246 },
      { pos: 0.5,  r: 34,  g: 197, b: 94  },
      { pos: 0.67, r: 250, g: 204, b: 21  },
      { pos: 1,    r: 239, g: 68,  b: 68  },
    ];
    let lower = colors[0];
    let upper = colors[colors.length - 1];
    for (let i = 0; i < colors.length - 1; i++) {
      if (t >= colors[i].pos && t <= colors[i + 1].pos) {
        lower = colors[i];
        upper = colors[i + 1];
        break;
      }
    }
    const range = upper.pos - lower.pos;
    const localT = range > 0 ? (t - lower.pos) / range : 0;
    const r = Math.round(lower.r + (upper.r - lower.r) * localT);
    const g = Math.round(lower.g + (upper.g - lower.g) * localT);
    const b = Math.round(lower.b + (upper.b - lower.b) * localT);
    return `rgb(${r}, ${g}, ${b})`;
  };

  // Temperature statistics (cell temps only, excluding ambient channels 54-55)
  const tempStats = useMemo(() => {
    const cellTemps = thermistorData.flatMap(module => module.slice(0, 54)).filter(t => t !== null);
    const validMinMaxTemps = cellTemps.filter(t => t >= -30);
    if (cellTemps.length === 0) {
      return { active: 0, min: null, max: null, avg: null };
    }
    return {
      active: cellTemps.length,
      min: validMinMaxTemps.length > 0 ? Math.min(...validMinMaxTemps) : null,
      max: validMinMaxTemps.length > 0 ? Math.max(...validMinMaxTemps) : null,
      avg: cellTemps.reduce((a, b) => a + b, 0) / cellTemps.length,
    };
  }, [thermistorData]);

  // Track hottest and coldest per module (cell thermistors only)
  const moduleTempExtremes = useMemo(() => {
    return thermistorData.map(module => {
      const validTemps = module.slice(0, 54).filter(temp => temp !== null && temp >= -30);
      if (validTemps.length === 0) return { min: null, max: null };
      return { min: Math.min(...validTemps), max: Math.max(...validTemps) };
    });
  }, [thermistorData]);

  // Count active balancing cells per module
  const balancingCounts = useMemo(() => {
    return balancingData.map(module => module.filter(b => b).length);
  }, [balancingData]);

  return (
    <div className="balance-manager">
      <div className="card">
        <div className="stats-bar">
          <div className="stat-group">
            <Battery size={14} />
            <div className="stat-item">
              <span className="stat-label">Cells:</span>
              <span className="stat-value">{voltageStats.active}/108</span>
            </div>
            {cellData.stackVoltage !== null && (
              <div className="stat-item highlight">
                <Zap size={14} />
                <span className="stat-value">{cellData.stackVoltage.toFixed(1)}V</span>
              </div>
            )}
            {voltageStats.min !== null && (
              <>
                <div className="stat-item">
                  <TrendingDown size={14} />
                  <span className="stat-value">{voltageStats.min.toFixed(3)}V</span>
                </div>
                <div className="stat-item">
                  <TrendingUp size={14} />
                  <span className="stat-value">{voltageStats.max.toFixed(3)}V</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Δ:</span>
                  <span className="stat-value">{voltageStats.delta.toFixed(3)}V</span>
                </div>
              </>
            )}
          </div>
          <div className="stat-group">
            <Thermometer size={14} />
            <div className="stat-item">
              <span className="stat-label">Temps:</span>
              <span className="stat-value">{tempStats.active}/324</span>
            </div>
            {tempStats.min !== null && (
              <>
                <div className="stat-item">
                  <TrendingDown size={14} />
                  <span className="stat-value">{tempStats.min.toFixed(1)}°C</span>
                </div>
                <div className="stat-item">
                  <TrendingUp size={14} />
                  <span className="stat-value">{tempStats.max.toFixed(1)}°C</span>
                </div>
              </>
            )}
          </div>
          <div className="stat-group">
            <Scale size={14} />
            <div className="stat-item">
              <span className="stat-label">Balancing:</span>
              <span className="stat-value">{balancingCounts.reduce((a, b) => a + b, 0)} cells</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Modules Active:</span>
              <span className="stat-value">{moduleConfigs.filter(c => c.active).length}/6</span>
            </div>
          </div>
        </div>

        <div className="overview-grid-container">
          <div className="overview-grid">
            {cellData.modules.map((module, moduleId) => {
              const config = moduleConfigs[moduleId];
              const status = balanceStatus[moduleId];

              return (
                <div key={moduleId} className={`module-column ${moduleStale[moduleId] ? 'stale' : ''}`} title={moduleStale[moduleId] ? `Stale — no data received in the last ${Math.round(staleTimeoutMs / 1000)}s` : undefined}>
                  <div className={`module-header ${config.active ? 'active-balancing' : ''}`}>
                    <div className="module-title">
                      Module {moduleId} <span className="module-state">{moduleStale[moduleId] ? `${moduleStates[moduleId]} (stale)` : moduleStates[moduleId]}</span>
                    </div>
                    <div className="module-ambient">
                      ΔV {moduleVoltageStats[moduleId]?.delta !== null ? `${(moduleVoltageStats[moduleId].delta * 1000).toFixed(0)}mV` : '--'}
                      {balancingCounts[moduleId] > 0 && ` | ${balancingCounts[moduleId]} balancing`}
                    </div>
                  </div>

                  <div className="cell-groups-list">
                    {module.map((voltage, cellIdx) => {
                      const isBalancing = balancingData[moduleId]?.[cellIdx] || false;
                      const temps = organizedTempData[moduleId]?.[cellIdx]?.temps || [null, null, null];
                      const getDisplayTempColor = (temp) => (isDisplayableTemp(temp) ? getTempColor(temp) : '#000000');
                      const tempGradient = `linear-gradient(90deg, ${getDisplayTempColor(temps[0])} 0%, ${getDisplayTempColor(temps[0])} 33.33%, ${getDisplayTempColor(temps[1])} 33.33%, ${getDisplayTempColor(temps[1])} 66.66%, ${getDisplayTempColor(temps[2])} 66.66%, ${getDisplayTempColor(temps[2])} 100%)`;
                      return (
                        <div
                          key={cellIdx}
                          className={`cell-row ${isBalancing ? 'balancing' : ''}`}
                          style={{ borderLeftColor: getVoltageColor(voltage) }}
                        >
                          <span className="cell-label">C{cellIdx + 1}</span>
                          <span
                            className="voltage-chip"
                            style={{ backgroundColor: getVoltageColor(voltage) }}
                            title={`Module ${moduleId}, Cell ${cellIdx + 1}: ${voltage !== null ? voltage.toFixed(4) + ' V' : 'No data'}`}
                          >
                            {voltage !== null ? `${voltage.toFixed(3)}V` : '--'}
                          </span>
                          <div className="temp-chips" style={{ background: tempGradient }}>
                            {temps.map((temp, tempIdx) => {
                              const displayable = isDisplayableTemp(temp);
                              const moduleMin = moduleTempExtremes[moduleId]?.min;
                              const moduleMax = moduleTempExtremes[moduleId]?.max;
                              const isColdest = displayable && moduleMin !== null && temp === moduleMin;
                              const isHottest = displayable && moduleMax !== null && temp === moduleMax;
                              return (
                                <span
                                  key={tempIdx}
                                  className={`temp-chip ${isHottest ? 'hottest' : ''} ${isColdest ? 'coldest' : ''}`.trim()}
                                  style={{ backgroundColor: getTempColor(temp) }}
                                  title={`Thermistor ${cellIdx * 3 + tempIdx}: ${displayable ? temp.toFixed(1) + '°C' : 'No data'}`}
                                >
                                  {displayable ? `${temp.toFixed(1)}°C` : '--'}
                                </span>
                              );
                            })}
                          </div>
                          {isBalancing && <span className="bal-indicator" title="Balancing active">⚡</span>}
                        </div>
                      );
                    })}
                  </div>

                  <div className="balance-controls">
                    <div className="control-row">
                      <label className="control-label">Target (mV)</label>
                      <input
                        type="number"
                        className="control-input"
                        min={0}
                        max={5000}
                        value={config.targetVoltageMv}
                        onChange={e => updateModuleConfig(moduleId, 'targetVoltageMv', parseInt(e.target.value) || 0)}
                        disabled={config.active}
                      />
                    </div>
                    <div className="control-row">
                      <label className="control-label">Max Cells/Chip</label>
                      <input
                        type="number"
                        className="control-input"
                        min={1}
                        max={9}
                        value={config.maxCellsPerChip}
                        onChange={e => updateModuleConfig(moduleId, 'maxCellsPerChip', parseInt(e.target.value) || 1)}
                        disabled={config.active}
                      />
                    </div>
                    <div className="control-row chips-row">
                      <label className="chip-checkbox">
                        <input
                          type="checkbox"
                          checked={config.bms1Enable}
                          onChange={e => updateModuleConfig(moduleId, 'bms1Enable', e.target.checked)}
                          disabled={config.active}
                        />
                        <span>Chip 1</span>
                      </label>
                      <label className="chip-checkbox">
                        <input
                          type="checkbox"
                          checked={config.bms2Enable}
                          onChange={e => updateModuleConfig(moduleId, 'bms2Enable', e.target.checked)}
                          disabled={config.active}
                        />
                        <span>Chip 2</span>
                      </label>
                    </div>
                    <div className="control-row toggle-row">
                      <button
                        className={`balance-toggle ${config.active ? 'active' : ''}`}
                        onClick={() => toggleModule(moduleId)}
                      >
                        {config.active ? 'Stop' : 'Start'} Balancing
                      </button>
                    </div>

                    {status && (status.ackStatus !== null || status.bms1CellCount !== null) && (
                      <div className="balance-feedback">
                        {status.ackStatus !== null && (
                          <div className={`feedback-row ${status.ackStatus === 'SUCCESS' || status.ackStatus === '0' ? 'ok' : 'err'}`}>
                            ACK: {status.ackStatus}
                          </div>
                        )}
                        {status.bms1CellCount !== null && (
                          <div className="feedback-row">
                            Cells: {status.bms1CellCount}/{status.bms2CellCount}
                          </div>
                        )}
                        {status.bms1IcTemp !== null && (
                          <div className="feedback-row">
                            IC: {status.bms1IcTemp.toFixed(1)}°C / {status.bms2IcTemp !== null ? status.bms2IcTemp.toFixed(1) + '°C' : '--'}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default BalanceManager;
