import {
  buildTorqueCommand, buildParameterRead, parseParameterResponse, decodeInverterFrames,
} from './inverterTestingProtocol';

const frame = (id, data, extra = {}) => ({ id, data, bus_id: 'bus1', received_at: 100, ...extra });

test('torque frames retain signed little-endian scaling, limits, direction, and enable', () => {
  expect(buildTorqueCommand(-5)).toEqual([206, 255, 0, 0, 1, 1, 0, 0]);
  expect(buildTorqueCommand(500, 0)).toEqual([208, 7, 0, 0, 0, 1, 0, 0]);
  expect(buildTorqueCommand(-500)).toEqual([48, 248, 0, 0, 1, 1, 0, 0]);
  expect(buildTorqueCommand(0, 1, false)).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  expect(() => buildTorqueCommand(NaN)).toThrow();
  expect(() => buildTorqueCommand(Infinity)).toThrow();
});

test('EEPROM reads accept only the matching address and bus, including signed zero/negative values', () => {
  expect(buildParameterRead(0x1234)).toEqual([0x34, 0x12, 0, 0, 0, 0, 0, 0]);
  const response = frame(0xC2, [2, 0, 0, 0, 206, 255, 0, 0]);
  expect(parseParameterResponse(response, 'bus1', 2)).toBe(-50);
  expect(parseParameterResponse(response, 'bus2', 2)).toBeNull();
  expect(parseParameterResponse(response, 'bus1', 3)).toBeNull();
  expect(parseParameterResponse({ ...response, is_extended: true }, 'bus1', 2)).toBeNull();
  expect(parseParameterResponse({ ...response, data: [] }, 'bus1', 2)).toBeNull();
  expect(parseParameterResponse({ ...response, data: undefined }, 'bus1', 2)).toBeNull();
  expect(parseParameterResponse(frame(0xC2, [2, 0, 0, 0, 0, 0]), 'bus1', 2)).toBe(0);
});

test('raw telemetry decodes without a DBC and ignores the other bus and short frames', () => {
  const groups = decodeInverterFrames([
    frame(0xAC, [100, 0, 206, 255, 0xE8, 3, 0, 0]),
    frame(0xA5, [0, 0, 0xD4, 0xFE]),
    frame(0xA7, [0xA0, 0x0F]),
    frame(0xA6, [0, 0, 0, 0, 0, 0, 206, 255]),
    frame(0xA0, [0xC4, 9, 0, 0, 0x9C, 0xFF, 0x88, 0x13]),
    frame(0xAC, [0, 0, 0, 0, 0, 0, 0, 0], { bus_id: 'bus2', received_at: 101 }),
    frame(0xA5, [0], { received_at: 102 }),
  ], 'bus1');
  expect(groups.torque.rows).toEqual([
    ['Actual Torque', '-5.0 Nm'], ['Commanded Torque', '10.0 Nm'], ['Power-on Timer', '3.0 s'],
  ]);
  expect(groups.speed.rows[0]).toEqual(['Motor RPM', '-300 RPM']);
  expect(groups.power.rows).toEqual([['Power', '-2.00 kW']]);
  expect(groups.temp160.rows).toEqual([
    ['Module A', '25.0 °C'], ['Module B', '0.0 °C'], ['Module C', '-1.0 °C'], ['Gate Driver', '50.0 °C'],
  ]);
});

test('the newest standard or extended speed/voltage source wins', () => {
  const groups = decodeInverterFrames([
    frame(0x0CFFB001, [0, 0, 0, 0, 0xE8, 3, 0xA0, 0x0F], { is_extended: true, received_at: 102 }),
    frame(0xA5, [0, 0, 20, 0], { received_at: 101 }),
    frame(0xA7, [0, 0], { received_at: 100 }),
    frame(0xA5, [0, 0, 30, 0], { is_remote: true, received_at: 103 }),
  ], 'bus1');
  expect(groups.speed.rows).toEqual([['Motor RPM', '1000 RPM'], ['RPM Source', '0xCFFB001']]);
  expect(groups.voltage.rows).toEqual([['Voltage', '400.0 V']]);
});

test('internal states, limiter flags and all four fault words preserve the desktop layout', () => {
  const groups = decodeInverterFrames([
    frame(0xAA, [6, 0, 3, 0, 0, 0, 0x81, 0x49]),
    frame(0x0CFFAB01, [1, 0, 0, 0, 0, 0, 0, 0x80], { is_extended: true }),
  ], 'bus1');
  expect(groups.internal.rows).toEqual(expect.arrayContaining([
    ['VSM State', '6 (Motor Running)'], ['Enable State', 'Enabled'], ['Enable Lockout', 'Yes'],
    ['Direction Command', 'Forward'], ['Active Limiters', 'Max Speed Limit, Coolant Temperature Derating'],
  ]));
  expect(groups.faults.rows).toEqual(expect.arrayContaining([
    ['Any Active Fault', 'Yes'], ['POST Lo', '0x0001'], ['RUN Hi', '0x8000'],
  ]));
});
