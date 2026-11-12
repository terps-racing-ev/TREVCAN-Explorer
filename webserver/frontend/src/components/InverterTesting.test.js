import React from 'react';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react-dom/test-utils';
import InverterTesting from './InverterTesting';

const act = React.act || domAct;

let root;
let container;
let send;
let callbacks;
let props;
const disabledFrame = [0, 0, 0, 0, 1, 0, 0, 0];
const enabledFrame = [0, 0, 0, 0, 1, 1, 0, 0];

beforeEach(() => {
  jest.useFakeTimers();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  send = jest.fn().mockResolvedValue(true);
  callbacks = new Set();
  props = {
    onSendMessage: send,
    onRegisterRawCallback: (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    transmitBusId: 'bus1',
    connectionStatus: { buses: [
      { bus_id: 'bus1', connected: true, device_type: 'pcan', channel: 'USB1', status: 'Connected' },
      { bus_id: 'bus2', connected: true, device_type: 'pcan', channel: 'USB2', status: 'Connected' },
    ] },
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.useRealTimers();
});

const render = async (extra = {}) => {
  props = { ...props, ...extra };
  await act(async () => root.render(<InverterTesting {...props} />));
};
const click = async (text) => {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button.click());
};
const advance = async (milliseconds) => {
  await act(async () => jest.advanceTimersByTime(milliseconds));
};

test('opening the tab does not send; explicit torque sends at 10 Hz and Stop disables it', async () => {
  await render();
  await advance(500);
  expect(send).not.toHaveBeenCalled();
  await click('+10 Nm');
  expect(send).toHaveBeenLastCalledWith(0xC0, [100, 0, 0, 0, 1, 1, 0, 0], false, false);
  await advance(100);
  expect(send).toHaveBeenCalledTimes(2);
  await click('Stop Testing');
  expect(send).toHaveBeenLastCalledWith(0xC0, disabledFrame, false, false);
  const count = send.mock.calls.length;
  await advance(500);
  expect(send).toHaveBeenCalledTimes(count);
});

test('direction changes disable first, wait 50 ms, and re-enable at zero torque', async () => {
  await render();
  await click('+10 Nm');
  send.mockClear();
  await click('Direction: Forward');
  expect(send).toHaveBeenLastCalledWith(0xC0, disabledFrame, false, false);
  await advance(49);
  expect(send).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(send).toHaveBeenLastCalledWith(0xC0, [0, 0, 0, 0, 0, 1, 0, 0], false, false);
  expect(container.textContent).toContain('Direction: Reverse');
  expect(container.textContent).toContain('0.0 Nm');
});

test('fault clear, lockout clear, and emergency braking use desktop command bytes', async () => {
  await render();
  await click('Clear Faults');
  expect(send).toHaveBeenLastCalledWith(0xC1, [20, 0, 1, 0, 0, 0, 0, 0], false, false);
  await click('Clear Lockout');
  await advance(100);
  expect(send).toHaveBeenLastCalledWith(0xC0, disabledFrame, false, false);
  await click('Emergency Stop (−5 Nm)');
  await advance(100);
  expect(send).toHaveBeenLastCalledWith(0xC0, [206, 255, 0, 0, 1, 1, 0, 0], false, false);
  await click('Reset');
  expect(send).toHaveBeenLastCalledWith(0xC0, enabledFrame, false, false);
});

test('a failed periodic send stops the stream instead of reporting success', async () => {
  await render();
  await click('+10 Nm');
  send.mockResolvedValue(false);
  await advance(100);
  expect(container.textContent).toContain('CAN send failed');
  const count = send.mock.calls.length;
  await advance(500);
  expect(send).toHaveBeenCalledTimes(count);
});

test('switching buses sends the final disable to the old bus and resets the controls', async () => {
  await render();
  await click('+10 Nm');
  const nextBusSend = jest.fn().mockResolvedValue(true);
  await render({ transmitBusId: 'bus2', onSendMessage: nextBusSend });
  expect(send).toHaveBeenLastCalledWith(0xC0, disabledFrame, false, false);
  await advance(500);
  expect(nextBusSend).not.toHaveBeenCalled();
  expect(container.textContent).toContain('0.0 Nm');
});

test('leaving during direction change never sends a subsequent enable', async () => {
  await render();
  await click('+10 Nm');
  let finishSend;
  send.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve; }));
  await advance(100);
  await click('Direction: Forward');
  await act(async () => finishSend(true));
  send.mockClear();
  await act(async () => root.unmount());
  await advance(100);
  expect(send.mock.calls.every(([, data]) => data[5] === 0)).toBe(true);
  expect(send).toHaveBeenLastCalledWith(0xC0, disabledFrame, false, false);
  root = createRoot(container);
});

test('disconnecting stops transmission and keeps controls disabled after reconnect', async () => {
  await render();
  await click('+10 Nm');
  const originalStatus = props.connectionStatus;
  await render({ connectionStatus: { buses: [] } });
  expect(container.querySelector('button[type="submit"]').disabled).toBe(true);
  await render({ connectionStatus: originalStatus });
  send.mockClear();
  await advance(500);
  expect(send).not.toHaveBeenCalled();
});

test('EEPROM reads match bus/address, show zero values and timeouts, and release callbacks', async () => {
  await render();
  await click('Read EEPROM');
  const emit = async (address, data, bus_id = 'bus1') => act(async () => {
    callbacks.forEach((callback) => callback({ id: 0xC2, bus_id, data: [address, 0, 0, 0, ...data, 0, 0] }));
  });
  await emit(0, [0, 0], 'bus2');
  await emit(1, [0, 0]);
  expect(send).toHaveBeenCalledTimes(1);
  await emit(0, [0, 0]);
  expect(send).toHaveBeenLastCalledWith(0xC1, [1, 0, 0, 0, 0, 0, 0, 0], false, false);
  await emit(1, [206, 255]);
  for (let index = 2; index < 6; index += 1) await advance(1000);
  expect(container.textContent).toContain('-50');
  expect(container.textContent).toContain('No response');
  expect(Array.from(container.querySelectorAll('dd')).some((node) => node.textContent === '0')).toBe(true);
  expect(callbacks.size).toBe(0);
});
