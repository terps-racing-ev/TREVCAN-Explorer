import React, { useMemo } from 'react';
import { Battery, Thermometer, TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { useNowTick, isTimestampStale } from '../hooks/useStaleness';
import './BMSOverview.css';

function BMSOverview({ messages, staleTimeoutMs = 30000 }) {
  const isDisplayableTemp = (temp) => temp !== null && temp >= -30;
  const nowMs = useNowTick(1000);

  // Extract cell voltage data from CAN messages
  const cellData = useMemo(() => {
    const modules = Array(6).fill(null).map(() => Array(18).fill(null));
    // Track BMS1 and BMS2 stack voltages per module (6 modules x 2 chips)
    const bmsStackVoltages = Array(6).fill(null).map(() => ({ bms1: null, bms2: null }));
    
    messages.forEach(msg => {
      if (msg.decoded && msg.decoded.signals) {
        const signals = msg.decoded.signals;
        const msgName = msg.decoded.message_name || '';
        
        // Extract module ID from message name (e.g., "BQ76952_Stack_Voltage_0" -> module 0)
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
              const voltage = value > 100 ? value / 1000 : value;
              modules[cellModuleId][cellIdx] = voltage;
            }
          }
          
          // Match BMS1_Stack_Voltage or BMS2_Stack_Voltage
          if (key === 'BMS1_Stack_Voltage' && typeof value === 'number' && moduleId !== null && moduleId < 6) {
            bmsStackVoltages[moduleId].bms1 = value > 1000 ? value / 1000 : value;
          }
          if (key === 'BMS2_Stack_Voltage' && typeof value === 'number' && moduleId !== null && moduleId < 6) {
            bmsStackVoltages[moduleId].bms2 = value > 1000 ? value / 1000 : value;
          }
        });
      }
    });
    
    // Calculate total stack voltage as sum of all BMS1 + BMS2 voltages across all modules
    let totalStackVoltage = 0;
    let hasAnyStackVoltage = false;
    bmsStackVoltages.forEach(module => {
      if (module.bms1 !== null) {
        totalStackVoltage += module.bms1;
        hasAnyStackVoltage = true;
      }
      if (module.bms2 !== null) {
        totalStackVoltage += module.bms2;
        hasAnyStackVoltage = true;
      }
    });
    
    return { 
      modules, 
      stackVoltage: hasAnyStackVoltage ? totalStackVoltage : null,
      bmsStackVoltages 
    };
  }, [messages]);

  // Extract balancing state from CAN messages
  const balancingData = useMemo(() => {
    // 6 modules x 18 cells each
    const modules = Array(6).fill(null).map(() => Array(18).fill(false));
    
    messages.forEach(msg => {
      if (msg.decoded && msg.decoded.signals) {
        const signals = msg.decoded.signals;
        const msgName = msg.decoded.message_name || '';
        
        // Match BMS1_Balance_Detail_X or BMS2_Balance_Detail_X for modules 0-5
        const balanceMatch = msgName.match(/BMS([12])_Balance_Detail_([0-5])$/);
        if (balanceMatch) {
          const moduleId = parseInt(balanceMatch[2]);
          
          Object.entries(signals).forEach(([key, signalData]) => {
            // Match BMS1_Cell1_Bal through BMS1_Cell9_Bal or BMS2_Cell10_Bal through BMS2_Cell18_Bal
            const cellBalMatch = key.match(/BMS[12]_Cell(\d+)_Bal/);
            if (cellBalMatch) {
              const cellNum = parseInt(cellBalMatch[1]);
              const value = typeof signalData === 'object' && signalData !== null 
                ? signalData.value 
                : signalData;
              
              // DBC cell numbering is 1-18; map to zero-based index 0-17 for UI arrays.
              const cellIdx = cellNum - 1;
              if (cellIdx >= 0 && cellIdx < 18) {
                // value can be: 1, 1.0, "1", "Balancing (1)", or object with value property
                // Check for numeric 1 or string containing "Balancing"
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
            // New DBC naming for ambient channels (e.g., Ambient_Temp_1_054).
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

  // Organize thermistor data into cell groups (18 groups of 3 cells each)
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

  // Track hottest and coldest displayable thermistor per module (cell thermistors only)
  const moduleTempExtremes = useMemo(() => {
    return thermistorData.map(module => {
      const validTemps = module.slice(0, 54).filter(temp => temp !== null && temp >= -30);
      if (validTemps.length === 0) {
        return { min: null, max: null };
      }

      return {
        min: Math.min(...validTemps),
        max: Math.max(...validTemps)
      };
    });
  }, [thermistorData]);

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
        if (typeof stateSignal.value === 'string') {
          states[moduleId] = stateSignal.value;
        } else if (stateSignal.value !== undefined && stateSignal.value !== null) {
          states[moduleId] = String(stateSignal.value);
        } else if (stateSignal.raw !== undefined && stateSignal.raw !== null) {
          states[moduleId] = String(stateSignal.raw);
        } else {
          states[moduleId] = 'UNKNOWN';
        }
      } else {
        states[moduleId] = String(stateSignal);
      }
    });

    return states;
  }, [messages]);

  // Per-module freshest message timestamp (seconds). A module's data is
  // considered stale when no message naming that module (e.g. *_0, Cell_X_*
  // mapping to module 0, etc.) has been seen within the stale timeout window.
  const moduleFreshestTimestamp = useMemo(() => {
    const timestamps = Array(6).fill(null);
    messages.forEach(msg => {
      const t = typeof msg?.timestamp === 'number' ? msg.timestamp : null;
      if (t === null) return;
      const msgName = msg?.decoded?.message_name || '';

      const moduleIds = new Set();

      // Cell_Voltage_<cell>_<idx> — derive from cell number (1-based, 18 per module).
      const cellVoltMatch = msgName.match(/Cell_Voltage_(\d+)_/);
      if (cellVoltMatch) {
        moduleIds.add(Math.floor((parseInt(cellVoltMatch[1], 10) - 1) / 18));
      }
      // Cell_Temp_<therm>_<idx> — derive from thermistor number (0-based, 56 per module).
      const cellTempMatch = msgName.match(/Cell_Temp_(\d+)_/);
      if (cellTempMatch) {
        moduleIds.add(Math.floor(parseInt(cellTempMatch[1], 10) / 56));
      }
      // Generic module suffix (BMS_Heartbeat_0, BQ76952_Stack_Voltage_3, BMS1_Balance_Detail_2, ...).
      const suffixMatch = msgName.match(/_(\d)$/);
      if (suffixMatch) {
        moduleIds.add(parseInt(suffixMatch[1], 10));
      }

      moduleIds.forEach(id => {
        if (id >= 0 && id < 6) {
          if (timestamps[id] === null || t > timestamps[id]) {
            timestamps[id] = t;
          }
        }
      });
    });
    return timestamps;
  }, [messages]);

  const moduleStale = useMemo(() => (
    moduleFreshestTimestamp.map(ts => isTimestampStale(ts, nowMs, staleTimeoutMs))
  ), [moduleFreshestTimestamp, nowMs, staleTimeoutMs]);

  // Pack-level current message staleness (Current_Sensor_Data, ID 0xCC).
  const currentSensorTimestamp = useMemo(() => {
    let latest = null;
    messages.forEach(msg => {
      if (msg?.decoded?.message_name !== 'Current_Sensor_Data') return;
      const t = typeof msg?.timestamp === 'number' ? msg.timestamp : null;
      if (t !== null && (latest === null || t > latest)) latest = t;
    });
    return latest;
  }, [messages]);
  const currentSensorStale = isTimestampStale(currentSensorTimestamp, nowMs, staleTimeoutMs);

  // Calculate voltage statistics
  const voltageStats = useMemo(() => {
    const allVoltages = cellData.modules.flat().filter(v => v !== null);
    
    if (allVoltages.length === 0) {
      return { active: 0, min: null, max: null, avg: null, delta: null };
    }
    
    const min = Math.min(...allVoltages);
    const max = Math.max(...allVoltages);
    const avg = allVoltages.reduce((a, b) => a + b, 0) / allVoltages.length;
    const delta = max - min;
    
    return { active: allVoltages.length, min, max, avg, delta };
  }, [cellData]);

  const moduleVoltageStats = useMemo(() => {
    return cellData.modules.map(module => {
      const validVoltages = module.filter(voltage => voltage !== null);
      if (validVoltages.length === 0) {
        return { min: null, max: null, delta: null };
      }

      const min = Math.min(...validVoltages);
      const max = Math.max(...validVoltages);
      return {
        min,
        max,
        delta: max - min
      };
    });
  }, [cellData]);

  // Extract latest LC/HC currents from the current sensor message.
  const packCurrents = useMemo(() => {
    let latestCurrents = { lc: null, hc: null };
    let latestTimestamp = -Infinity;

    messages.forEach(msg => {
      if (!msg?.decoded?.signals) return;

      const msgName = msg.decoded.message_name || '';
      if (msgName !== 'Current_Sensor_Data') return;

      const signals = msg.decoded.signals;
      const lcRaw = signals.LC_Current;
      const hcRaw = signals.HC_Current;
      const lcValue = typeof lcRaw === 'object' && lcRaw !== null ? lcRaw.value : lcRaw;
      const hcValue = typeof hcRaw === 'object' && hcRaw !== null ? hcRaw.value : hcRaw;

      const hasLc = typeof lcValue === 'number';
      const hasHc = typeof hcValue === 'number';
      if (!hasLc && !hasHc) return;

      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
      if (timestamp >= latestTimestamp) {
        latestTimestamp = timestamp;
        latestCurrents = {
          lc: hasLc ? lcValue : null,
          hc: hasHc ? hcValue : null
        };
      }
    });

    return latestCurrents;
  }, [messages]);

  // Calculate temperature statistics (cell temps only, excluding ambient)
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
      avg: cellTemps.reduce((a, b) => a + b, 0) / cellTemps.length
    };
  }, [thermistorData]);

  // Voltage color gradient (darker rainbow)
  const getVoltageColor = (voltage) => {
    if (voltage === null) return '#2d3748';
    
    const minV = 2.5;
    const maxV = 4.35;
    const clampedV = Math.max(minV, Math.min(maxV, voltage));
    const t = (clampedV - minV) / (maxV - minV);
    
    // Darker rainbow gradient
    const colors = [
      { pos: 0,    r: 180, g: 50,  b: 50  },  // Dark red - critical
      { pos: 0.27, r: 180, g: 85,  b: 16  },  // Dark orange - very low
      { pos: 0.43, r: 190, g: 155, b: 16  },  // Dark yellow - low
      { pos: 0.65, r: 25,  g: 145, b: 70  },  // Dark green - ideal
      { pos: 0.92, r: 45,  g: 100, b: 185 },  // Dark blue - high
      { pos: 1,    r: 125, g: 65,  b: 185 }   // Dark purple - very high
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
    const clampedTemp = Math.max(minTemp, Math.min(maxTemp, temp));
    const t = (clampedTemp - minTemp) / (maxTemp - minTemp);
    
    const colors = [
      { pos: 0,    r: 139, g: 92,  b: 246 },
      { pos: 0.33, r: 59,  g: 130, b: 246 },
      { pos: 0.5,  r: 34,  g: 197, b: 94  },
      { pos: 0.67, r: 250, g: 204, b: 21  },
      { pos: 1,    r: 239, g: 68,  b: 68  }
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

  // Calculate average temp for a cell group
  const getGroupAvgTemp = (temps) => {
    const validTemps = temps.filter(t => t !== null);
    if (validTemps.length === 0) return null;
    return validTemps.reduce((a, b) => a + b, 0) / validTemps.length;
  };

  return (
    <div className="bms-overview">
      <div className="card">
        <div className="stats-bar">
          <div className="stat-group">
            <Battery size={14} />
            <div className="stat-item">
              <span className="stat-label">Cells:</span>
              <span className="stat-value">{voltageStats.active}/108</span>
            </div>
            <div className={`stat-item ${currentSensorStale ? 'stale' : ''}`}>
              <span className="stat-label">LC Current:</span>
              <span className="stat-value">{packCurrents.lc !== null ? `${packCurrents.lc.toFixed(1)}A` : '--'}</span>
            </div>
            <div className={`stat-item ${currentSensorStale ? 'stale' : ''}`}>
              <span className="stat-label">HC Current:</span>
              <span className="stat-value">{packCurrents.hc !== null ? `${packCurrents.hc.toFixed(1)}A` : '--'}</span>
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
        </div>

        <div className="overview-grid-container">
          <div className="overview-grid">
            {cellData.modules.map((module, moduleId) => (
              <div key={moduleId} className={`module-column ${moduleStale[moduleId] ? 'stale' : ''}`} title={moduleStale[moduleId] ? `Stale — no data received in the last ${Math.round(staleTimeoutMs / 1000)}s` : undefined}>
                <div className="module-header">
                  <div className="module-title">Module {moduleId} <span className="module-state">{moduleStale[moduleId] ? `${moduleStates[moduleId]} (stale)` : moduleStates[moduleId]}</span></div>
                  <div className="module-ambient">
                    Amb (MPlug Side) {isDisplayableTemp(thermistorData[moduleId]?.[54]) ? `${thermistorData[moduleId][54].toFixed(1)}°C` : '--'} / (STM Side) {isDisplayableTemp(thermistorData[moduleId]?.[55]) ? `${thermistorData[moduleId][55].toFixed(1)}°C` : '--'}
                    {' | '}
                    ΔV {moduleVoltageStats[moduleId]?.delta !== null ? `${(moduleVoltageStats[moduleId].delta * 1000).toFixed(0)}mV` : '--'}
                  </div>
                </div>
                <div className="cell-groups-list">
                  {module.map((voltage, cellIdx) => {
                    const temps = organizedTempData[moduleId]?.[cellIdx]?.temps || [null, null, null];
                    const isBalancing = balancingData[moduleId]?.[cellIdx] || false;
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
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default BMSOverview;
