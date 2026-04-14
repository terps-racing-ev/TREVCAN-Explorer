import React from 'react';
import { Activity } from 'lucide-react';
import './Header.css';

function Header() {
  return (
    <header className="header">
      <div className="header-content">
        <div className="header-left">
          <div className="logo">
            <Activity size={32} strokeWidth={2.5} />
          </div>
          <div className="header-title">
            <h1>CAN Explorer</h1>
            <p>Modern CAN Bus Communication Tool</p>
          </div>
        </div>
        <div className="header-right">
          <div className="header-version">v1.0.0</div>
        </div>
      </div>
    </header>
  );
}

export default Header;
