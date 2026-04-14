import React, { useMemo } from 'react';
import { Thermometer, TrendingUp, TrendingDown, Wind } from 'lucide-react';
import './ThermistorMonitor.css';

function ThermistorMonitor({ messages }) {
  // Extract thermistor data from CAN messages
  const thermistorData = useMemo(() => {
    const modules = Array(6).fill(null).map(() => Array(56).fill(null));
    
    messages.forEach(msg => {
      if (msg.decoded && msg.decoded.signals) {
        const signals = msg.decoded.signals;
        
        // Look for Temp_XXX signals
        Object.entries(signals).forEach(([key, signalData]) => {
          if (key.startsWith('Temp_')) {
            const tempNum = parseInt(key.split('_')[1]);
            const moduleId = Math.floor(tempNum / 56);
            const channel = tempNum % 56;
            
            if (moduleId >= 0 && moduleId < 6 && channel >= 0 && channel < 56) {
              // Extract numeric value from signal metadata object
              const value = typeof signalData === 'object' && signalData !== null 
                ? signalData.value 
                : signalData;
              modules[moduleId][channel] = typeof value === 'number' ? value : null;
            }
          }
        });
      }
    });
    
    return modules;
  }, [messages]);

  // Organize data into cell groups (18 groups of 3 cells each) and ambient temps
  const organizedData = useMemo(() => {
    return thermistorData.map(module => {
      // First 54 temps (0-53) are cell temps, grouped into 18 groups of 3
      const cellGroups = [];
      for (let i = 0; i < 18; i++) {
        cellGroups.push({
          groupNum: i + 1, // 1-indexed for display
          cells: [
            { index: i * 3, temp: module[i * 3] },
            { index: i * 3 + 1, temp: module[i * 3 + 1] },
            { index: i * 3 + 2, temp: module[i * 3 + 2] }
          ]
        });
      }
      
      // Last 2 temps (54-55) are ambient air temps
      const ambientTemps = [
        { index: 54, temp: module[54] },
        { index: 55, temp: module[55] }
      ];
      
      return { cellGroups, ambientTemps };
    });
  }, [thermistorData]);

  // Calculate statistics (cell temps only, excluding ambient sensors 54-55)
  const stats = useMemo(() => {
    // Only use first 54 temps per module (indices 0-53), exclude ambient (54-55)
    const cellTemps = thermistorData.flatMap(module => module.slice(0, 54)).filter(t => t !== null);
    
    if (cellTemps.length === 0) {
      return { active: 0, min: null, max: null, avg: null };
    }
    
    return {
      active: cellTemps.length,
      min: Math.min(...cellTemps),
      max: Math.max(...cellTemps),
      avg: cellTemps.reduce((a, b) => a + b, 0) / cellTemps.length
    };
  }, [thermistorData]);

  // Dynamic gradient from purple (cold) through green (ideal) to red (hot)
  // Range: 15°C (purple) -> 30°C (blue) -> 37.5°C (green/ideal) -> 45°C (yellow) -> 60°C+ (red)
  const getTempColor = (temp) => {
    if (temp === null) return '#2d3748';
    
    // Clamp temperature to gradient range
    const minTemp = 15;
    const maxTemp = 60;
    const clampedTemp = Math.max(minTemp, Math.min(maxTemp, temp));
    
    // Normalize to 0-1 range
    const t = (clampedTemp - minTemp) / (maxTemp - minTemp);
    
    // Color stops: purple (0) -> blue (0.33) -> green (0.5) -> yellow (0.67) -> red (1)
    // These correspond to: 15°C -> 30°C -> 37.5°C -> 45°C -> 60°C
    const colors = [
      { pos: 0,    r: 139, g: 92,  b: 246 }, // Purple (#8b5cf6) - cold ambient
      { pos: 0.33, r: 59,  g: 130, b: 246 }, // Blue (#3b82f6) - normal ambient
      { pos: 0.5,  r: 34,  g: 197, b: 94  }, // Green (#22c55e) - ideal operating
      { pos: 0.67, r: 250, g: 204, b: 21  }, // Yellow (#facc15) - warm
      { pos: 1,    r: 239, g: 68,  b: 68  }  // Red (#ef4444) - hot
    ];
    
    // Find the two colors to interpolate between
    let lower = colors[0];
    let upper = colors[colors.length - 1];
    
    for (let i = 0; i < colors.length - 1; i++) {
      if (t >= colors[i].pos && t <= colors[i + 1].pos) {
        lower = colors[i];
        upper = colors[i + 1];
        break;
      }
    }
    
    // Interpolate between the two colors
    const range = upper.pos - lower.pos;
    const localT = range > 0 ? (t - lower.pos) / range : 0;
    
    const r = Math.round(lower.r + (upper.r - lower.r) * localT);
    const g = Math.round(lower.g + (upper.g - lower.g) * localT);
    const b = Math.round(lower.b + (upper.b - lower.b) * localT);
    
    return `rgb(${r}, ${g}, ${b})`;
  };

  // Calculate average temp for a cell group
  const getGroupAvgTemp = (cells) => {
    const validTemps = cells.map(c => c.temp).filter(t => t !== null);
    if (validTemps.length === 0) return null;
    return validTemps.reduce((a, b) => a + b, 0) / validTemps.length;
  };

  return (
    <div className="thermistor-monitor">
      <div className="card">
        <div className="stats-bar">
          <div className="stat-item">
            <span className="stat-label">Active:</span>
            <span className="stat-value">{stats.active}/324</span>
          </div>
          {stats.min !== null && (
            <>
              <div className="stat-item">
                <TrendingDown size={16} />
                <span className="stat-label">Min:</span>
                <span className="stat-value">{stats.min.toFixed(1)}°C</span>
              </div>
              <div className="stat-item">
                <TrendingUp size={16} />
                <span className="stat-label">Max:</span>
                <span className="stat-value">{stats.max.toFixed(1)}°C</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Avg:</span>
                <span className="stat-value">{stats.avg.toFixed(1)}°C</span>
              </div>
            </>
          )}
        </div>

        <div className="thermistor-grid-container">
          <div className="thermistor-grid">
            {organizedData.map((moduleData, moduleId) => (
              <div key={moduleId} className="module-column">
                <div className="module-header">Module {moduleId}</div>
                
                {/* Cell Groups Section */}
                <div className="cell-groups-list">
                  {moduleData.cellGroups.map((group) => {
                    const avgTemp = getGroupAvgTemp(group.cells);
                    return (
                      <div 
                        key={group.groupNum} 
                        className="cell-group"
                        style={{ borderLeftColor: getTempColor(avgTemp) }}
                      >
                        <span className="group-label">C{group.groupNum}</span>
                        <div className="cell-group-temps">
                          {group.cells.map((cell) => (
                            <span
                              key={cell.index}
                              className="temp-chip"
                              style={{ backgroundColor: getTempColor(cell.temp) }}
                              title={`Module ${moduleId}, Thermistor ${cell.index}: ${cell.temp !== null ? cell.temp.toFixed(1) + '°C' : 'No data'}`}
                            >
                              {cell.temp !== null ? cell.temp.toFixed(1) : '--'}
                            </span>
                          ))}
                        </div>
                        <span className="group-avg" style={{ color: getTempColor(avgTemp) }}>
                          {avgTemp !== null ? avgTemp.toFixed(1) : '--'}
                        </span>
                      </div>
                    );
                  })}
                </div>
                
                {/* Ambient Temps Section */}
                <div className="ambient-row">
                  <span className="ambient-label"><Wind size={10} /> Amb</span>
                  <div className="ambient-temps">
                    {moduleData.ambientTemps.map((ambient, idx) => (
                      <span
                        key={ambient.index}
                        className="temp-chip ambient-chip"
                        style={{ backgroundColor: getTempColor(ambient.temp) }}
                        title={`Module ${moduleId}, Ambient ${idx + 1}: ${ambient.temp !== null ? ambient.temp.toFixed(1) + '°C' : 'No data'}`}
                      >
                        {ambient.temp !== null ? ambient.temp.toFixed(1) : '--'}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ThermistorMonitor;
