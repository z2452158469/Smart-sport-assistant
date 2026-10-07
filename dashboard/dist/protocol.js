export const SERVICE_UUID = '5a4f0001-9b7d-4f3a-8c2e-6d1b0a9f3456';
export const DATA_UUID = '5a4f0002-9b7d-4f3a-8c2e-6d1b0a9f3456';

// Every notification fits the default 20-byte BLE payload. All fields little-endian.
export function decodePacket(view) {
  if (!(view instanceof DataView) || view.byteLength !== 20 || view.getUint8(0) !== 1) return null;
  const type = view.getUint8(1);
  if (type !== 1 && type !== 2) return null;
  const flags = view.getUint8(2);
  const common = { type, seq: view.getUint16(4, true), mpuOK: !!(flags & 1), pulseOK: !!(flags & 2), finger: !!(flags & 4), heartValid: !!(flags & 8), tftUsesG: !!(flags & 16), pulseFresh: !!(flags & 32) };
  if (type === 1) return { ...common, bpm: common.heartValid ? view.getUint16(6, true) / 10 : null, ax: view.getInt16(8, true) / 100, ay: view.getInt16(10, true) / 100, az: view.getInt16(12, true) / 100, ir: view.getUint32(14, true), temperature: view.getInt16(18, true) / 100 };
  return { ...common, gx: view.getInt16(6, true) / 1000, gy: view.getInt16(8, true) / 1000, gz: view.getInt16(10, true) / 1000, uptime: view.getUint32(12, true) };
}
