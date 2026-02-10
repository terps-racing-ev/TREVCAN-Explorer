import React, { useState, useEffect } from 'react';
import { Wifi, WifiOff, RefreshCw, Zap, Globe, Bluetooth } from 'lucide-react';
import './ConnectionPanel.css';

function ConnectionPanel({ connected, devices, onConnect, onDisconnect, onRefreshDevices }) {
  const [deviceType, setDeviceType] = useState('canable');
  const [channel, setChannel] = useState('Device 0');
  const [baudrate, setBaudrate] = useState('BAUD_500K');
  const [connecting, setConnecting] = useState(false);
  
  // Network device specific state - load from localStorage or use defaults
  const [networkHost, setNetworkHost] = useState(() => {
    const saved = localStorage.getItem('networkDeviceHost');
    console.log('[ConnectionPanel] Loading networkHost from localStorage:', saved);
    return saved || '192.168.1.100';
  });
  const [networkPort, setNetworkPort] = useState(() => {
    const saved = localStorage.getItem('networkDevicePort');
    console.log('[ConnectionPanel] Loading networkPort from localStorage:', saved);
    return saved || '8080';
  });

  // Save network settings to localStorage when they change
  useEffect(() => {
    console.log('[ConnectionPanel] Saving networkHost to localStorage:', networkHost);
    localStorage.setItem('networkDeviceHost', networkHost);
  }, [networkHost]);

  useEffect(() => {
    console.log('[ConnectionPanel] Saving networkPort to localStorage:', networkPort);
    localStorage.setItem('networkDevicePort', networkPort);
  }, [networkPort]);

  const baudrates = [
    'BAUD_1M', 'BAUD_800K', 'BAUD_500K', 'BAUD_250K',
    'BAUD_125K', 'BAUD_100K', 'BAUD_50K', 'BAUD_20K', 'BAUD_10K'
  ];

  // Split devices by type
  const pcanDevices = devices.filter(d => d.device_type === 'pcan');
  const canableDevices = devices.filter(d => d.device_type === 'canable');
  const networkDevices = devices.filter(d => d.device_type === 'network');
  // Filter bluetooth devices - exclude the manual entry placeholder
  const bluetoothDevices = devices.filter(d => d.device_type === 'bluetooth' && d.name !== 'Bluetooth CAN Server');

  // Bluetooth specific state - address and RFCOMM channel
  const [bluetoothAddress, setBluetoothAddress] = useState(() => {
    const saved = localStorage.getItem('bluetoothAddress');
    return saved || '';
  });
  const [bluetoothChannel, setBluetoothChannel] = useState(() => {
    const saved = localStorage.getItem('bluetoothChannel');
    return saved || '1';
  });

  // Save bluetooth settings to localStorage
  useEffect(() => {
    localStorage.setItem('bluetoothAddress', bluetoothAddress);
  }, [bluetoothAddress]);

  useEffect(() => {
    localStorage.setItem('bluetoothChannel', bluetoothChannel);
  }, [bluetoothChannel]);

  // Update channel when devices are loaded or device type changes
  useEffect(() => {
    console.log('[ConnectionPanel] useEffect triggered:', { 
      deviceType, 
      devicesLength: devices.length,
      devices: devices 
    });
    
    if (deviceType === 'canable') {
      const canable = devices.filter(d => d.device_type === 'canable');
      console.log('[ConnectionPanel] CANable devices found:', canable);
      if (canable.length > 0) {
        const firstDevice = canable[0];
        const newChannel = `Device ${firstDevice.index}: ${firstDevice.description}`;
        console.log('[ConnectionPanel] Setting CANable channel to:', newChannel);
        setChannel(newChannel);
      }
    } else if (deviceType === 'pcan') {
      const pcan = devices.filter(d => d.device_type === 'pcan');
      console.log('[ConnectionPanel] PCAN devices found:', pcan);
      if (pcan.length > 0) {
        const newChannel = pcan[0].name;
        console.log('[ConnectionPanel] Setting PCAN channel to:', newChannel);
        setChannel(newChannel);
      }
    }
    // Network devices don't need channel selection - they use host:port
  }, [devices, deviceType]);

  const handleConnect = async () => {
    setConnecting(true);
    
    console.log('[ConnectionPanel] handleConnect called:', { deviceType, channel, baudrate });
    
    let channelToSend = channel;
    
    // Handle network device - combine host and port
    if (deviceType === 'network') {
      channelToSend = `${networkHost}:${networkPort}`;
      console.log('[ConnectionPanel] Network channel:', channelToSend);
    }
    // Handle Bluetooth device - combine address and channel
    else if (deviceType === 'bluetooth') {
      // Format: address:channel (e.g., "XX:XX:XX:XX:XX:XX:1")
      channelToSend = `${bluetoothAddress}:${bluetoothChannel}`;
      console.log('[ConnectionPanel] Bluetooth channel:', channelToSend);
    }
    // For CANable, extract the device index from "Device X: Description" format
    else if (deviceType === 'canable') {
      if (typeof channel === 'string' && channel.startsWith('Device ')) {
        try {
          const parts = channel.split(':')[0].split(' ');
          channelToSend = parts[1]; // Extract just the number
          console.log('[ConnectionPanel] Parsed CANable channel:', channelToSend);
        } catch (e) {
          console.error('[ConnectionPanel] Failed to parse CANable channel:', e);
          alert('Invalid channel format. Please select a device from the dropdown.');
          setConnecting(false);
          return;
        }
      } else {
        // If channel doesn't match expected format, try to use it as-is
        console.warn('[ConnectionPanel] Channel does not match expected format:', channel);
        // Assume it's just a number
        channelToSend = channel.replace(/\\D/g, ''); // Extract only digits
        if (!channelToSend) {
          alert('Invalid channel. Please select a CANable device.');
          setConnecting(false);
          return;
        }
      }
    }
    
    console.log('[ConnectionPanel] Connecting with:', { deviceType, channelToSend, baudrate });
    const success = await onConnect(deviceType, channelToSend, baudrate);
    setConnecting(false);
    if (!success) {
      alert('Failed to connect. Check device and settings.');
    }
  };

  const handleDisconnect = async () => {
    setConnecting(true);
    await onDisconnect();
    setConnecting(false);
  };

  return (
    <div className="connection-panel">
      <div className="connection-content">
        <div className="connection-controls">
          <div className="form-group device-type-group">
            <label>Device Type</label>
            <select
              className="device-type-select"
              value={deviceType}
              onChange={(e) => {
                const newDeviceType = e.target.value;
                setDeviceType(newDeviceType);
                
                // Update channel based on available devices
                if (newDeviceType === 'pcan') {
                  const pcan = devices.filter(d => d.device_type === 'pcan');
                  if (pcan.length > 0) {
                    setChannel(pcan[0].name);
                  } else {
                    setChannel('USB1');
                  }
                } else if (newDeviceType === 'canable') {
                  const canable = devices.filter(d => d.device_type === 'canable');
                  if (canable.length > 0) {
                    const firstDevice = canable[0];
                    setChannel(`Device ${firstDevice.index}: ${firstDevice.description}`);
                  } else {
                    setChannel('Device 0');
                  }
                } else if (newDeviceType === 'bluetooth') {
                  // Check for paired Bluetooth devices - use first one if available
                  const btDevices = devices.filter(d => d.device_type === 'bluetooth' && d.name !== 'Bluetooth CAN Server');
                  if (btDevices.length > 0 && btDevices[0].name.includes(':')) {
                    // It's a MAC address
                    setBluetoothAddress(btDevices[0].name);
                  }
                }
                // Network device uses host:port fields, no channel needed
              }}
              disabled={connected}
            >
              <option value="pcan">PCAN</option>
              <option value="canable">CANable</option>
              <option value="network">Network</option>
              <option value="bluetooth">Bluetooth (Experimental)</option>
            </select>
          </div>

          {deviceType === 'network' ? (
            <div className="form-group network-inputs">
              <label>Server Address</label>
              <div className="network-address-group">
                <input
                  type="text"
                  className="network-host-input"
                  value={networkHost}
                  onChange={(e) => setNetworkHost(e.target.value)}
                  placeholder="IP Address"
                  disabled={connected}
                />
                <span className="network-separator">:</span>
                <input
                  type="text"
                  className="network-port-input"
                  value={networkPort}
                  onChange={(e) => setNetworkPort(e.target.value)}
                  placeholder="Port"
                  disabled={connected}
                />
              </div>
            </div>
          ) : deviceType === 'bluetooth' ? (
            <div className="form-group bluetooth-inputs">
              <label>Bluetooth Address</label>
              <div className="bluetooth-address-group">
                {bluetoothDevices.length > 0 ? (
                  <select
                    className="bluetooth-device-select"
                    value={bluetoothAddress}
                    onChange={(e) => setBluetoothAddress(e.target.value)}
                    disabled={connected}
                  >
                    <option value="">-- Select paired device --</option>
                    {bluetoothDevices.map(device => (
                      <option key={device.name} value={device.name}>
                        {device.description}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="bluetooth-address-input"
                    value={bluetoothAddress}
                    onChange={(e) => setBluetoothAddress(e.target.value.toUpperCase())}
                    placeholder="XX:XX:XX:XX:XX:XX"
                    disabled={connected}
                  />
                )}
                <span className="bluetooth-separator">Ch:</span>
                <input
                  type="number"
                  className="bluetooth-channel-input"
                  value={bluetoothChannel}
                  onChange={(e) => setBluetoothChannel(e.target.value)}
                  min="1"
                  max="30"
                  placeholder="1"
                  disabled={connected}
                />
              </div>
              <small className="bluetooth-hint">
                {bluetoothDevices.length > 0 
                  ? 'Select a paired device or enter address manually' 
                  : 'Pair device in Windows first, then enter MAC address'}
              </small>
            </div>
          ) : (
            <div className="form-group">
              <label>Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                disabled={connected}
              >
                {deviceType === 'pcan' ? (
                  pcanDevices.length > 0 ? (
                    pcanDevices.map(device => (
                      <option key={device.name} value={device.name}>
                        {device.name} {device.occupied && '(Occupied)'}
                      </option>
                    ))
                  ) : (
                    <option value="USB1">USB1</option>
                  )
                ) : (
                  canableDevices.length > 0 ? (
                    canableDevices.map(device => {
                      const fullName = `Device ${device.index}: ${device.description}`;
                      return (
                        <option key={device.index} value={fullName}>
                          {fullName}
                        </option>
                      );
                    })
                  ) : (
                    <option value="Device 0">Device 0</option>
                  )
                )}
              </select>
            </div>
          )}

          <div className="form-group">
            <label>Baudrate</label>
            <select
              value={baudrate}
              onChange={(e) => setBaudrate(e.target.value)}
              disabled={connected}
            >
              {baudrates.map(br => (
                <option key={br} value={br}>{br}</option>
              ))}
            </select>
          </div>

          <button
            className="btn-refresh"
            onClick={onRefreshDevices}
            disabled={connected || connecting}
            title="Refresh Devices"
          >
            <RefreshCw size={18} />
          </button>

          {!connected ? (
            <button
              className="btn btn-success btn-connect"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <>
                  <div className="spinner-small"></div>
                  Connecting...
                </>
              ) : (
                <>
                  <Wifi size={18} />
                  Connect
                </>
              )}
            </button>
          ) : (
            <button
              className="btn btn-danger btn-connect"
              onClick={handleDisconnect}
              disabled={connecting}
            >
              <WifiOff size={18} />
              Disconnect
            </button>
          )}
        </div>

        <div className="connection-status">
          <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
            <Zap size={16} />
            <span>{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
          {devices.length > 0 && (
            <div className="devices-found">
              {devices.length} device(s) available
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ConnectionPanel;
