// CM200DZ wire format from inverter-testing/src/pcan_interface.py.
export const COMMAND_ID = 0xC0;
export const PARAMETER_ID = 0xC1;
export const PARAMETER_RESPONSE_ID = 0xC2;
export const MAX_TORQUE = 200;
export const EEPROM_PARAMETERS = [
  'Torque Limit (Nm)', 'Speed Limit (RPM)', 'Over-temp Threshold (°C)',
  'Min Voltage (V)', 'Max Voltage (V)', 'Over-current Limit (A)',
];

export function buildTorqueCommand(torque, direction = 1, enabled = true) {
  const data = new Uint8Array(8);
  if (!Number.isFinite(torque)) throw new Error('Please enter a valid torque.');
  const value = Math.max(-MAX_TORQUE, Math.min(MAX_TORQUE, torque));
  new DataView(data.buffer).setInt16(0, Math.trunc(value * 10), true);
  data[4] = direction ? 1 : 0;
  data[5] = enabled ? 1 : 0;
  return Array.from(data);
}

export const buildParameterRead = (address) => [address & 0xFF, address >> 8, 0, 0, 0, 0, 0, 0];

export function parseParameterResponse(message, busId, address) {
  if ((message.bus_id || 'bus1') !== busId || message.id !== PARAMETER_RESPONSE_ID
      || message.is_extended || message.is_remote || message.is_error_frame || !message.data || message.data.length < 6) return null;
  const view = new DataView(Uint8Array.from(message.data).buffer);
  return view.getUint16(0, true) === address ? view.getInt16(4, true) : null;
}

const rawHex = (bytes) => bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const wordHex = (value) => `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
const extendedIds = new Map([
  [0x0CFFA501, 0xA5], [0x0CFFA601, 0xA6], [0x0CFFA701, 0xA7],
  [0x0CFFAA01, 0xAA], [0x0CFFAB01, 0xAB], [0x0CFFB001, 0xB0],
]);

export function decodeInverterFrames(messages, busId) {
  const groups = {};
  let voltage = null;
  let current = null;
  const frames = messages.filter((message) => (message.bus_id || 'bus1') === busId
    && !message.is_remote && !message.is_error_frame && message.data?.length)
    .sort((a, b) => (a.received_at || a.timestamp || 0) - (b.received_at || b.timestamp || 0));

  frames.forEach((frame) => {
    const id = frame.is_extended ? extendedIds.get(frame.id) : frame.id;
    const bytes = Array.from(frame.data);
    const view = new DataView(Uint8Array.from(bytes).buffer);
    const signed = (offset) => view.getInt16(offset, true);
    const group = (key, title, rows) => { groups[key] = { title, rows, frame }; };
    if (id === 0xAC && bytes.length >= 8) {
      group('torque', 'Torque & Timer', [
        ['Actual Torque', `${(signed(2) / 10).toFixed(1)} Nm`],
        ['Commanded Torque', `${(signed(0) / 10).toFixed(1)} Nm`],
        ['Power-on Timer', `${(view.getUint32(4, true) * 0.003).toFixed(1)} s`],
      ]);
    }
    if ((id === 0xA5 && bytes.length >= 4) || (id === 0xB0 && bytes.length >= 6)) {
      group('speed', 'Motor Speed', [
        ['Motor RPM', `${signed(id === 0xA5 ? 2 : 4)} RPM`],
        ['RPM Source', `0x${frame.id.toString(16).toUpperCase()}`],
      ]);
    }
    if ((id === 0xA7 && bytes.length >= 2) || (id === 0xB0 && bytes.length >= 8)) {
      voltage = signed(id === 0xA7 ? 0 : 6) / 10;
      group('voltage', 'DC Bus Voltage', [['Voltage', `${voltage.toFixed(1)} V`]]);
    }
    if (id === 0xA6 && bytes.length >= 8) {
      current = signed(6) / 10;
      group('current', 'DC Bus Current', [['Current', `${current.toFixed(1)} A`]]);
    }
    if (id === 0xAA && bytes.length >= 8) {
      const limiters = ['Limiter Bit2', 'Max Speed Limit', 'Inverter Hot Spot Limit',
        'Limiter Bit5', 'Coolant Temperature Derating', 'Limiter Bit7'];
      group('internal', 'Internal States (0x0AA)', [
        ['VSM State', `${bytes[0]} (${({ 4: 'Wait State', 5: 'Ready', 6: 'Motor Running', 7: 'Fault State' })[bytes[0]] || 'Unknown'})`],
        ['Inverter State', `${bytes[2]} (${({ 1: 'Stop', 3: 'Closed Loop / Normal' })[bytes[2]] || 'Unknown'})`],
        ['Enable State', bytes[6] & 1 ? 'Enabled' : 'Disabled'],
        ['Enable Lockout', bytes[6] & 0x80 ? 'Yes' : 'No'],
        ['Direction Command', bytes[7] & 1 ? 'Forward' : 'Reverse'],
        ['Active Limiters', limiters.filter((_, index) => bytes[7] & (1 << (index + 2))).join(', ') || 'None'],
        ['Raw', rawHex(bytes)],
      ]);
    }
    if (id === 0xAB && bytes.length >= 8) {
      const words = [0, 2, 4, 6].map((offset) => view.getUint16(offset, true));
      group('faults', 'Fault Status (0x0AB)', [
        ['Any Active Fault', words.some(Boolean) ? 'Yes' : 'No'],
        ...['POST Lo', 'POST Hi', 'RUN Lo', 'RUN Hi'].map((label, index) => [label, wordHex(words[index])]),
        ['Raw', rawHex(bytes)],
      ]);
    }
    const temperatures = {
      0xA0: ['Module A', 'Module B', 'Module C', 'Gate Driver'],
      0xA1: ['Control Board', 'RTD 1', 'RTD 2', 'RTD 3'],
      0xA2: ['Coolant', 'Hot Spot', 'Motor'],
    }[id];
    if (temperatures && bytes.length >= temperatures.length * 2) {
      group(`temp${id}`, `Temperatures (0x${id.toString(16).toUpperCase()})`,
        temperatures.map((label, index) => [label, `${(signed(index * 2) / 100).toFixed(1)} °C`]));
    }
  });
  if (voltage !== null && current !== null) {
    groups.power = {
      title: 'DC Bus Power', rows: [['Power', `${(voltage * current / 1000).toFixed(2)} kW`]],
      frame: [groups.voltage.frame, groups.current.frame]
        .sort((a, b) => (a.received_at || a.timestamp || 0) - (b.received_at || b.timestamp || 0))[0],
    };
  }
  return groups;
}
