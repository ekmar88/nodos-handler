import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { NodosGraphClient } from '../src/lib/nodos-graph-client.js';
import { UUID } from '../sdk/generated/js/nos/fb/uuid.js';
import { Node } from '../sdk/generated/js/nos/fb/node.js';
import { Pin } from '../sdk/generated/js/nos/fb/pin.js';
import { encodePinValue, decodePinValue } from '../src/lib/pin-values.js';
import { decodeEditorEvent } from '../src/lib/editor-protocol.js';
import { initialize, getNodeById, updatePinValue, updateMultiplePins, getPinValue } from '../src/controllers/nodes.controller.js';

const nodeId = 'abababab-abab-abab-abab-abababababab';
const ids = Array.from({ length: 6 }, (_, i) => `${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-${String(i + 1).repeat(4)}-${String(i + 1).repeat(4)}-${String(i + 1).repeat(12)}`);
function fixture() {
  const writes = [];
  const c = new NodosGraphClient({ watchPins: false });
  c.connected = c.snapshotReceived = true;
  const pending = [];
  c.call = { write(bytes, callback) {
    const message = decodeEditorEvent(bytes);
    writes.push(message);
    const requests = message.uint8(0) === 26 ? message.table(1).tables(0) : [message];
    for (const request of requests) {
      const event = request.table(1);
      pending.push({ path: event.string(0), bytes: event.bytes(1) });
    }
    callback();
  } };
  c.refreshFromEngine = async () => {
    for (const { path, bytes } of pending.splice(0)) {
      const found = c._findPinByPath(path);
      if (found) c._rememberPinValue(found.pin, bytes);
    }
  };
  const pins = [
    { id: ids[0], name: 'x', typeName: 'float' },
    { id: ids[1], name: 'enabled', typeName: 'bool' },
    { id: ids[2], name: 'text', typeName: 'string' },
    { id: ids[3], name: 'position', typeName: 'nos.fb.vec3' },
    { id: ids[4], name: 'locked', typeName: 'double', readOnly: true },
    { id: ids[5], name: 'texture', typeName: 'nos.sys.vulkan.Texture' },
  ];
  c._nodes.set(nodeId, { id: nodeId, name: 'Gain', displayName: 'Gain control', pins });
  c._paths.set(nodeId, 'Root.Gain');
  for (const pin of pins) c._recordEnginePath(`Root.Gain.${pin.name}`, { node: c.getNodeById(nodeId), pin });
  initialize(null, c); // No AppService required for graph pin writes.
  return { c, writes, pins };
}
async function invoke(handler, params = {}, body) {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
  await handler({ params, body }, res);
  return res;
}

test('GET node by real UUID accepts uppercase and compact forms; absent node returns 404', async () => {
  fixture();
  for (const reference of [nodeId, nodeId.toUpperCase(), nodeId.replaceAll('-', ''), 'Gain']) {
    const res = await invoke(getNodeById, { nodeId: reference });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.node.id, nodeId);
    assert.equal(res.body.node.pins[0].id, ids[0]);
  }
  assert.equal((await invoke(getNodeById, { nodeId: ids[0] })).statusCode, 404);
});

test('ambiguous node names return 409 instead of selecting an arbitrary node', async () => {
  const { c } = fixture();
  c._nodes.set(ids[0], { id: ids[0], name: 'Gain', pins: [] });
  assert.equal((await invoke(getNodeById, { nodeId: 'Gain' })).statusCode, 409);
  assert.equal((await invoke(getNodeById, { nodeId })).statusCode, 200);
});

test('POST pin UUID resolves the real pin path and uses declared float width, even for x', async () => {
  const { writes } = fixture();
  const res = await invoke(updatePinValue, { nodeId, pinId: ids[0] }, { value: 1.25 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pin_id, ids[0]);
  assert.equal(res.body.type, 'float');
  assert.equal(res.body.status, 'confirmed');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uint8(0), 2);
  const event = writes[0].table(1);
  assert.equal(event.string(0), 'Root.Gain.x');
  const bytes = event.bytes(1);
  assert.equal(bytes.length, 4);
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true), 1.25);
});

test('false, zero and empty strings are confirmed from the engine readback', async () => {
  const { writes } = fixture();
  for (const [pinId, value, bytes] of [['enabled', false, [0]], ['x', 0, [0, 0, 0, 0]], ['text', '', [0]]]) {
    assert.equal((await invoke(updatePinValue, { nodeId, pinId }, { value })).statusCode, 200);
    assert.deepEqual([...writes.at(-1).table(1).bytes(1)], bytes);
    assert.deepEqual((await invoke(getPinValue, { nodeId, pinId })).body.value, value);
  }
});

test('bad values, missing pins, other nodes pins, read-only and unsupported types send no writes', async () => {
  const { writes } = fixture();
  for (const [pinId, value, code] of [
    ['absent', 1, 404], [ids[0].replaceAll('1', '9'), 1, 404],
    ['enabled', 'false', 400], ['x', '1.25', 400], ['x', 1e40, 400],
    ['position', { x: 1 }, 400], ['locked', 1, 409], ['texture', {}, 422], ['text', null, 400],
  ]) {
    assert.equal((await invoke(updatePinValue, { nodeId, pinId }, { value })).statusCode, code, pinId);
  }
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' })).statusCode, 400);
  assert.equal(writes.length, 0);
});

test('batches validate every pin before writing and submit one Editor BatchRequest', async () => {
  const { writes } = fixture();
  assert.equal((await invoke(updateMultiplePins, { nodeId }, { pins: { x: 1, enabled: 'invalid' } })).statusCode, 400);
  assert.equal(writes.length, 0);
  const res = await invoke(updateMultiplePins, { nodeId }, { pins: { x: 2, enabled: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uint8(0), 26);
  const nested = writes[0].table(1).tables(0);
  assert.deepEqual(nested.map(e => e.table(1).string(0)), ['Root.Gain.x', 'Root.Gain.enabled']);
  assert.equal((await invoke(updateMultiplePins, { nodeId }, { pins: { x: 1, [ids[0]]: 2 } })).statusCode, 400);
  assert.equal(writes.length, 1);
});

test('disconnected graph and stream write failures return 503', async () => {
  const { c } = fixture();
  c.connected = false;
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' }, { value: 1 })).statusCode, 503);
  c.connected = true;
  c.call.write = (_, callback) => callback(new Error('stream closed'));
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' }, { value: 1 })).statusCode, 503);
  c.call.write = () => { throw new Error('stream destroyed'); };
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' }, { value: 1 })).statusCode, 503);
});

test('initial pin metadata and value are read from real FlatBuffers and later value events replace them', async () => {
  const { c } = fixture();
  const b = new flatbuffers.Builder(512);
  const pinName = b.createString('x');
  const type = b.createString('float');
  const data = Pin.createDataVector(b, new Uint8Array([0, 0, 128, 63])); // float32 1.0
  Pin.startPin(b);
  Pin.addName(b, pinName);
  Pin.addTypeName(b, type);
  Pin.addData(b, data);
  Pin.addId(b, UUID.createUUID(b, new Uint8Array(16).fill(0x11)));
  const rawPin = Pin.endPin(b);
  const pins = Node.createPinsVector(b, [rawPin]);
  const name = b.createString('RealNode');
  Node.startNode(b);
  Node.addName(b, name);
  Node.addPins(b, pins);
  Node.addId(b, UUID.createUUID(b, new Uint8Array(16).fill(0xab)));
  b.finish(Node.endNode(b));
  c._storeGraphTree(Node.getRootAsNode(new flatbuffers.ByteBuffer(b.asUint8Array())), 'Root');
  const res = await invoke(getNodeById, { nodeId });
  assert.equal(res.body.node.pins[0].value, 1);
  assert.equal(res.body.node.pins[0].typeName, 'float');
  assert.equal((await invoke(getPinValue, { nodeId, pinId: ids[0] })).body.value, 1);
  const event = new flatbuffers.Builder(128);
  const path = event.createString('Root.RealNode.x');
  const bytes = Pin.createDataVector(event, new Uint8Array([0, 0, 0, 64])); // float32 2.0
  event.startObject(2);
  event.addFieldOffset(0, path, 0);
  event.addFieldOffset(1, bytes, 0);
  const change = event.endObject();
  event.startObject(3);
  event.addFieldInt8(0, 7, 0);
  event.addFieldOffset(1, change, 0);
  event.finish(event.endObject());
  c._handleEditorEvent(decodeEditorEvent(event.asUint8Array()));
  assert.equal((await invoke(getPinValue, { nodeId, pinId: 'x' })).body.value, 2);
});

test('binary layout uses scalar widths, UTF-8 terminator, vector components and lossless 64-bit integers', () => {
  assert.deepEqual([...encodePinValue('ñ', 'string')], [195, 177, 0]);
  assert.deepEqual([...encodePinValue(65535, 'ushort')], [255, 255]);
  assert.equal(encodePinValue(1, 'double').length, 8);
  assert.equal(encodePinValue({ x: 1, y: 2, z: 3 }, 'nos.fb.vec3').length, 12);
  const max = '18446744073709551615';
  assert.equal(decodePinValue(encodePinValue(max, 'ulong'), 'ulong'), max);
  assert.throws(() => encodePinValue(4294967296, 'uint'));
  assert.throws(() => encodePinValue(Number.MAX_SAFE_INTEGER + 1, 'long'));
  assert.throws(() => encodePinValue({ x: 1, y: 2 }, 'nos.fb.Transform'));
});

test('write union tags agree with the bundled editor schema', () => {
  const schema = readFileSync(new URL('../sdk/types/EditorEvents.fbs', import.meta.url), 'utf8');
  const members = schema.match(/union FromEditorUnion\s*\{([^}]+)\}/)[1].split(',').map(x => x.trim()).filter(Boolean);
  assert.equal(members[1], 'EditorPinValueChanged');
  assert.equal(members[25], 'BatchRequest');
});

test('live pin type/read-only changes affect validation, and pin deletion invalidates cached values', async () => {
  const { c, writes } = fixture();
  c._rememberPinValue(c.getNodeById(nodeId).pins[0], new Uint8Array([0, 0, 128, 63]));
  function metadata(action, typeName) {
    const b = new flatbuffers.Builder(256);
    const path = b.createString('Root.Gain.x');
    let type = 0;
    if (typeName) {
      const name = b.createString(typeName);
      b.startObject(5);
      b.addFieldOffset(0, name, 0);
      type = b.endObject();
    }
    b.startObject(9);
    if (type) b.addFieldOffset(1, type, 0);
    b.addFieldInt32(2, action, 0);
    const update = b.endObject();
    b.startObject(7);
    b.addFieldOffset(0, path, 0);
    b.addFieldInt8(1, 2, 0);
    b.addFieldOffset(2, update, 0);
    const item = b.endObject();
    b.startObject(3);
    b.addFieldInt8(0, 33, 0);
    b.addFieldOffset(1, item, 0);
    b.finish(b.endObject());
    c._handleEditorEvent(decodeEditorEvent(b.asUint8Array()));
  }
  metadata(1, 'double');
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' }, { value: 1 })).statusCode, 409);
  assert.equal((await invoke(getPinValue, { nodeId, pinId: 'x' })).statusCode, 404);
  assert.equal(writes.length, 0);
  metadata(2);
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' }, { value: 1 })).statusCode, 200);
  assert.equal(writes[0].table(1).bytes(1).length, 8);
  const b = new flatbuffers.Builder(128);
  const path = b.createString('Root.Gain.x');
  b.startObject(1);
  b.addFieldOffset(0, path, 0);
  const deletion = b.endObject();
  b.startObject(3);
  b.addFieldInt8(0, 30, 0);
  b.addFieldOffset(1, deletion, 0);
  b.finish(b.endObject());
  c._handleEditorEvent(decodeEditorEvent(b.asUint8Array()));
  assert.equal((await invoke(updatePinValue, { nodeId, pinId: 'x' }, { value: 1 })).statusCode, 404);
});
