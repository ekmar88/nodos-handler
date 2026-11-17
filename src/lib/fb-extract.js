/** Conversions from generated FlatBuffers Node/Pin tables to plain objects. */
import { Pin } from '../../sdk/generated/js/nos/fb/pin.js';

export function uuidToHex(uuid) {
  if (!uuid) return null;
  const hex = Array.from({ length: 16 }, (_, i) => uuid.bytes(i).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidHexToBytes(hex) {
  const compact = hex.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(compact.slice(i * 2, i * 2 + 2), 16));
}

export function extractPinInfo(pin) {
  return {
    id: uuidToHex(pin.id()),
    name: pin.name() || '',
    typeName: pin.typeName() || '',
    displayName: pin.displayName() || '',
    description: pin.description() || '',
    readOnly: pin.readonly(),
    step: pin.step(),
    live: pin.live(),
  };
}

export function extractNodeInfo(node) {
  if (!node) return null;
  const id = uuidToHex(node.id());
  if (!id) return null;
  const pins = [];
  for (let i = 0; i < node.pinsLength(); i++) {
    const pin = node.pins(i, new Pin());
    if (pin) pins.push(extractPinInfo(pin));
  }
  return {
    id,
    name: node.name() || '',
    className: node.className() || '',
    displayName: node.displayName() || '',
    description: node.description() || '',
    appKey: node.appKey() || '',
    pins,
  };
}
