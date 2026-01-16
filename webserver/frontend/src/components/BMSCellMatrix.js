import React, { useMemo } from 'react';
import { Battery, TrendingUp, TrendingDown, Zap } from 'lucide-react';
import './BMSCellMatrix.css';

function BMSCellMatrix({ messages }) {

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

  // Voltage color gradient (darker rainbow)
  const getVoltageColor = (voltage) => {
    if (voltage === null) return '#1a1a1a';
    
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

  return (
    <div className="bms-cell-matrix">
      {/* Stats Bar */}
      <div className="matrix-stats-bar">
        <div className="stats-left">
          <div className="stat-group">
            <Battery size={12} />
            <span className="stat-label">Cells:</span>
            <span className="stat-value">{voltageStats.active}/108</span>
            {cellData.stackVoltage !== null && (
              <span className="stat-highlight">
                <Zap size={10} />
                {cellData.stackVoltage.toFixed(1)}V
              </span>
            )}
            {voltageStats.min !== null && (
              <>
                <TrendingDown size={10} />
                <span className="stat-value">{voltageStats.min.toFixed(3)}V</span>
                <TrendingUp size={10} />
                <span className="stat-value">{voltageStats.max.toFixed(3)}V</span>
                <span className="stat-label">Δ</span>
                <span className="stat-value">{voltageStats.delta.toFixed(3)}V</span>
              </>
            )}
          </div>
        </div>
        <div className="stats-right">
        </div>
      </div>

      {/* Matrix Grid */}
      <div className="matrix-container">
        <div className="matrix-grid">
          {/* Header Row */}
          <div className="matrix-header-row">
            <div className="matrix-corner"></div>
            {Array.from({ length: 18 }, (_, i) => (
              <div key={i} className="matrix-col-header">C{i}</div>
            ))}
          </div>

          {/* Module Rows */}
          {cellData.modules.map((module, moduleId) => (
            <div key={moduleId} className="matrix-module-row">
              <div className="matrix-row-header">M{moduleId}</div>
              {module.map((voltage, cellIdx) => {
                const globalCellNum = moduleId * 18 + cellIdx + 1;
                
                return (
                  <div 
                    key={cellIdx} 
                    className="matrix-cell voltage"
                    title={`Cell ${globalCellNum} (M${moduleId}C${cellIdx})\nVoltage: ${voltage !== null ? voltage.toFixed(4) + 'V' : 'N/A'}`}
                  >
                    <div 
                      className="cell-voltage"
                      style={{ backgroundColor: getVoltageColor(voltage) }}
                    >
                      {voltage !== null ? voltage.toFixed(3) : '--'}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Color Legend */}
        <div className="matrix-legend">
          <div className="legend-section">
            <span className="legend-title">Voltage</span>
            <div className="legend-gradient voltage-gradient"></div>
            <div className="legend-labels">
              <span>2.5V</span>
              <span>3.0V</span>
              <span>3.5V</span>
              <span>4.0V</span>
              <span>4.35V</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BMSCellMatrix;
