import React from 'react';
import { Activity, Clock, Hash } from 'lucide-react';
import './StatusBar.css';

function StatusBar({ connected, status, stats }) {
  const formatUptime = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="status-bar">
      <div className="status-content">
        <div className="status-section">
          <div className="status-item">
            <Activity size={16} />
            <span className="status-label">Status:</span>
            <span className={`status-value ${connected ? 'connected' : 'disconnected'}`}>
              {connected ? `Connected to ${status.device_type?.toUpperCase()} ${status.channel}` : 'Disconnected'}
            </span>
          </div>
          {connected && status.baudrate && (
            <div className="status-item">
              <span className="status-label">Baudrate:</span>
              <span className="status-value">{status.baudrate}</span>
            </div>
          )}
        </div>

        <div className="status-section">
          {connected && (
            <>
              <div className="status-item">
                <Hash size={16} />
                <span className="status-label">Messages:</span>
                <span className="status-value">{stats.message_count.toLocaleString()}</span>
              </div>
              <div className="status-item">
                <Activity size={16} />
                <span className="status-label">Rate:</span>
                <span className="status-value">{stats.message_rate.toFixed(1)} msg/s</span>
              </div>
              <div className="status-item">
                <Clock size={16} />
                <span className="status-label">Uptime:</span>
                <span className="status-value">{formatUptime(stats.uptime_seconds)}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default StatusBar;
