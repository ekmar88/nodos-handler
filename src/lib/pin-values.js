/** Nodos scalar/struct layouts: sdk/types/Builtins.fbs and Common.fbs. */
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function normalizeUUID(value) {
  const hex = typeof value === 'string' ? value.replace(/-/g, '').toLowerCase() : '';
  return /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}

const scalars = {
  float: [4, 'Float32'], double: [8, 'Float64'],
  byte: [1, 'Int8', -128, 127], ubyte: [1, 'Uint8', 0, 255],
  short: [2, 'Int16', -32768, 32767], ushort: [2, 'Uint16', 0, 65535],
  int: [4, 'Int32', -2147483648, 2147483647], uint: [4, 'Uint32', 0, 4294967295],
  long: [8, 'BigInt64', -(1n << 63n), (1n << 63n) - 1n],
  ulong: [8, 'BigUint64', 0n, (1n << 64n) - 1n],
};

function layout(typeName) {
  const type = typeName?.replace(/^nos\.fb\./, '');
  if (type === 'bool' || type === 'string' || scalars[type]) return { type, scalar: type, keys: null };
  const vector = /^vec([234])(d|i|u|u8)?$/.exec(type);
  if (vector && (vector[2] !== 'u8' || vector[1] === '4')) {
    return { type, scalar: ({ d: 'double', i: 'int', u: 'uint', u8: 'ubyte' })[vector[2]] || 'float', keys: ['x', 'y', 'z', 'w'].slice(0, Number(vector[1])) };
  }
  throw new ApiError(422, `Unsupported pin type: ${typeName}. No value was sent.`);
}

function scalarValue(value, type) {
  const [, , min, max] = scalars[type];
  if (type === 'long' || type === 'ulong') {
    if (!((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^-?\d+$/.test(value)))) {
      throw new ApiError(400, `${type} requires a safe integer or decimal integer string`);
    }
    const n = BigInt(value);
    if (n < min || n > max) throw new ApiError(400, `${type} value out of range`);
    return n;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ApiError(400, `${type} requires a finite number`);
  if (min !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw new ApiError(400, `${type} requires an integer between ${min} and ${max}`);
  if (type === 'float' && !Number.isFinite(Math.fround(value))) throw new ApiError(400, 'float value out of range');
  return value;
}

export function encodePinValue(value, typeName) {
  const { type, scalar, keys } = layout(typeName);
  if (type === 'string') {
    if (typeof value !== 'string' || value.includes('\0')) throw new ApiError(400, 'string requires text without embedded null bytes');
    return new TextEncoder().encode(value + '\0'); // Nodos exposes strings as const char*.
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new ApiError(400, 'bool requires true or false');
    return new Uint8Array([value ? 1 : 0]);
  }
  if (keys && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k)))) {
    throw new ApiError(400, `${type} requires all components: ${keys.join(', ')}`);
  }
  const [size, method] = scalars[scalar];
  const bytes = new Uint8Array(size * (keys?.length || 1));
  const view = new DataView(bytes.buffer);
  for (const [i, item] of (keys ? keys.map(k => value[k]) : [value]).entries()) {
    view[`set${method}`](i * size, scalarValue(item, scalar), true);
  }
  return bytes;
}

export function decodePinValue(bytes, typeName) {
  const { type, scalar, keys } = layout(typeName);
  if (type === 'string') {
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
  }
  if (type === 'bool') {
    if (bytes.length !== 1) throw new Error('Invalid bool size');
    return bytes[0] !== 0;
  }
  const [size, method] = scalars[scalar];
  if (bytes.length !== size * (keys?.length || 1)) throw new Error(`Invalid ${type} size`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = i => {
    const n = view[`get${method}`](i * size, true);
    if (typeof n === 'number' && !Number.isFinite(n)) throw new Error('Non-finite pin value');
    return typeof n === 'bigint' ? n.toString() : n;
  };
  return keys ? Object.fromEntries(keys.map((k, i) => [k, read(i)])) : read(0);
}
