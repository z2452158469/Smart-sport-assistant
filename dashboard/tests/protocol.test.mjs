import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket } from '../dist/protocol.js';

test('sensor packet preserves signed axes, temperature, flags and 32-bit IR', () => {
  const p = new DataView(new ArrayBuffer(20));
  p.setUint8(0, 1); p.setUint8(1, 1); p.setUint8(2, 63);
  p.setUint16(4, 65535, true); p.setUint16(6, 725, true);
  p.setInt16(8, -981, true); p.setInt16(10, 123, true); p.setInt16(12, 0, true);
  p.setUint32(14, 180000, true); p.setInt16(18, -1250, true);
  const result = decodePacket(p);
  assert.equal(result.bpm, 72.5); assert.equal(result.ax, -9.81);
  assert.equal(result.ay, 1.23); assert.equal(result.ir, 180000);
  assert.equal(result.temperature, -12.5); assert.equal(result.seq, 65535);
  assert.equal(result.tftUsesG, true); assert.equal(result.pulseFresh, true);
});
test('invalid heart-rate flag yields missing data rather than a zero reading', () => {
  const p = new DataView(new ArrayBuffer(20));
  p.setUint8(0, 1); p.setUint8(1, 1); p.setUint16(6, 990, true);
  assert.equal(decodePacket(p).bpm, null);
  assert.equal(decodePacket(p).mpuOK, false);
});
test('motion packet preserves negative angular velocity and unsigned uptime', () => {
  const p = new DataView(new ArrayBuffer(20));
  p.setUint8(0, 1); p.setUint8(1, 2); p.setUint8(2, 1);
  p.setInt16(6, -8726, true); p.setInt16(8, 1500, true); p.setInt16(10, 0, true);
  p.setUint32(12, 4000000000, true);
  const result = decodePacket(p);
  assert.equal(result.gx, -8.726); assert.equal(result.gy, 1.5);
  assert.equal(result.uptime, 4000000000);
});
test('reject malformed packets and decode views with a nonzero buffer offset', () => {
  assert.equal(decodePacket(new DataView(new ArrayBuffer(19))), null);
  assert.equal(decodePacket(new DataView(new ArrayBuffer(20))), null);
  assert.equal(decodePacket(null), null);
  const buffer = new ArrayBuffer(30), view = new DataView(buffer, 5, 20);
  view.setUint8(0, 1); view.setUint8(1, 1); view.setUint8(2, 8);
  view.setUint16(6, 600, true);
  assert.equal(decodePacket(view).bpm, 60);
});
