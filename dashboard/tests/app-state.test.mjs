import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodePacket, SERVICE_UUID, DATA_UUID } from '../dist/protocol.js';
import {ACTIVITY_NAMES, Recorder, parseSerialSample, trainingCsv} from '../dist/training.js';

test('connect, real-format notifications, unit changes, stale data and disconnect', async () => {
  let now = 10000, ticker;
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', className: '', style: {}, value: id === 'unitSelect' ? 'ms2' : id === 'transportSelect' ? 'ble' : '60',
      classList: {toggle() {}}, listeners: {},
      addEventListener(type, handler) {this.listeners[type] = handler;},
      getBoundingClientRect() {return {width: 0, height: 0};}
    });
    return elements.get(id);
  }
  let receive, onDisconnect;
  const characteristic = {
    addEventListener(type, handler) {receive = handler;},
    removeEventListener() {}, async startNotifications() {}
  };
  const device = {
    name: 'SmartSport-ESP32', addEventListener(type, handler) {onDisconnect = handler;},
    removeEventListener() {},
    gatt: {connected: false,
      async connect() {this.connected = true; return {async getPrimaryService() {return {async getCharacteristic() {return characteristic;}};}};},
      disconnect() {this.connected = false; onDisconnect?.();}
    }
  };
  const context = vm.createContext({
    decodePacket, SERVICE_UUID, DATA_UUID, ACTIVITY_NAMES, Recorder, parseSerialSample, trainingCsv, DataView, Date: {now: () => now},
    document: {getElementById: element}, navigator: {bluetooth: {async requestDevice() {return device;}}},
    window: {isSecureContext: true, addEventListener() {}},
    setInterval(handler) {ticker = handler;}, requestAnimationFrame(handler) {handler();}
  });
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '');
  vm.runInContext(source, context);
  await element('connectButton').listeners.click();
  assert.equal(element('connectButton').textContent, '断开连接');
  const packet = new DataView(new ArrayBuffer(20));
  packet.setUint8(0, 1); packet.setUint8(1, 1); packet.setUint8(2, 47);
  packet.setUint16(6, 720, true); packet.setInt16(12, 981, true);
  packet.setUint32(14, 123456, true); packet.setInt16(18, 2650, true);
  receive({target: {value: packet}});
  assert.equal(element('heartValue').textContent, '72');
  assert.equal(element('accelValue').textContent, '9.81');
  assert.equal(element('magnitudeValue').textContent, '9.81');
  assert.equal(element('tempValue').textContent, '26.5');
  packet.setUint8(1, 2); packet.setInt16(6, -100, true); packet.setUint32(12, 65000, true);
  receive({target: {value: packet}});
  assert.equal(element('gxValue').textContent, '-0.100');
  assert.equal(element('uptimeValue').textContent, '00:01:05');
  element('unitSelect').value = 'g'; element('unitSelect').listeners.change();
  assert.equal(element('accelValue').textContent, '1.00');
  assert.equal(element('magnitudeValue').textContent, '1.00');
  assert.equal(element('magnitudeUnit').textContent, 'g');
  now += 2501; ticker();
  assert.equal(element('heartValue').textContent, '—');
  assert.equal(element('accelValue').textContent, '—');
  assert.equal(element('magnitudeValue').textContent, '—');
  assert.equal(element('gxValue').textContent, '—');
  assert.equal(element('connectionStatus').textContent, '数据中断');
  device.gatt.disconnect();
  assert.equal(element('connectionStatus').textContent, '已断开');
  assert.equal(element('connectButton').textContent, '重新连接');
});
