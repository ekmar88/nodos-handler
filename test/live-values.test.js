import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import grpc from '@grpc/grpc-js';
import * as flatbuffers from 'flatbuffers';
import { NodosGraphClient } from '../src/lib/nodos-graph-client.js';
import { Node } from '../sdk/generated/js/nos/fb/node.js';
import { Pin } from '../sdk/generated/js/nos/fb/pin.js';
import { UUID } from '../sdk/generated/js/nos/fb/uuid.js';
import { Graph } from '../sdk/generated/js/nos/fb/graph.js';
import { decodeEditorEvent, createEditorConnectionRequest } from '../src/lib/editor-protocol.js';
import { initialize, listNodes, updatePinValue } from '../src/controllers/nodes.controller.js';
import { readFileSync } from 'node:fs';

const nodeId = '11111111-1111-1111-1111-111111111111';
const pinId = '22222222-2222-2222-2222-222222222222';
function table(b, fields, offsets, type) {
  b.startObject(fields);
  for (const [i, value] of Object.entries(offsets)) b.addFieldOffset(Number(i), value, 0);
  if (type !== undefined) b.addFieldInt8(0, type, 0);
  return b.endObject();
}
function snapshot(value) {
  const b = new flatbuffers.Builder(512);
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat64(0, value, true);
  const bytes = Pin.createDataVector(b, data);
  const type = b.createString('double');
  const name = b.createString('Value');
  Pin.startPin(b);
  Pin.addName(b, name);
  Pin.addTypeName(b, type);
  Pin.addData(b, bytes);
  Pin.addId(b, UUID.createUUID(b, new Uint8Array(16).fill(0x22)));
  const pins = Node.createPinsVector(b, [Pin.endPin(b)]);
  const nodeName = b.createString('Make');
  Node.startNode(b);
  Node.addName(b, nodeName);
  Node.addPins(b, pins);
  Node.addId(b, UUID.createUUID(b, new Uint8Array(16).fill(0x11)));
  const nodes = Graph.createNodesVector(b, [Node.endNode(b)]);
  const graph = table(b, 4, { 0: nodes });
  const rootName = b.createString('MotherGraph');
  Node.startNode(b);
  Node.addName(b, rootName);
  Node.addContentsType(b, 1);
  Node.addContents(b, graph);
  const root = Node.endNode(b);
  const status = table(b, 11, { 4: root });
  const connected = table(b, 5, { 1: status });
  b.finish(table(b, 3, { 1: connected }, 1));
  return b.asUint8Array();
}
function change(path, value) {
  const b = new flatbuffers.Builder(128);
  const pathOffset = b.createString(path);
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat64(0, value, true);
  const bytes = Pin.createDataVector(b, data);
  const event = table(b, 2, { 0: pathOffset, 1: bytes });
  b.finish(table(b, 3, { 1: event }, 7));
  return decodeEditorEvent(b.asUint8Array());
}
function transport(t, { ignoreWrites = false, expectedPath = '/Make.Value' } = {}) {
  let value = 0;
  const connections = [];
  const requests = [];
  t.mock.getter(grpc, 'makeGenericClientConstructor', () => definition => function () {
    const stream = new EventEmitter();
    stream.end = () => { setImmediate(() => stream.emit('end')); };
    stream.cancel = () => {};
    stream.write = (bytes, cb) => {
      const request = decodeEditorEvent(bytes);
      const events = request.uint8(0) === 26 ? request.table(1).tables(0) : [request];
      for (const event of events) {
        const type = event.uint8(0);
        const body = event.table(1);
        requests.push({ type, path: type === 3 ? null : body.string(0) });
        if (type === 3) {
          setImmediate(() => stream.emit('data', definition.Connect.responseDeserialize(snapshot(value))));
        }
        if (type === 31 && body.string(0) === expectedPath) {
          setImmediate(() => stream.emit('data', change(expectedPath, value)));
        }
        if (type === 2 && body.string(0) === expectedPath && !ignoreWrites) {
          const data = body.bytes(1);
          value = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0, true);
        }
      }
      cb?.();
      return true;
    };
    const connection = { stream, closed: false, Connect() { return stream; }, close() { this.closed = true; } };
    connections.push(connection);
    return connection;
  });
  return { requests, connections, manualChange(n) { value = n; } };
}
async function invoke(handler, body) {
  const response = { code: 200, headers: {}, status(n) { this.code = n; return this; }, set(k, v) { this.headers[k] = v; }, json(body) { this.body = body; } };
  await handler({ params: { nodeId, pinId }, body }, response);
  return response;
}

test('Editor connection requests a nonzero update frequency and WatchPin tags match the SDK', () => {
  const request = decodeEditorEvent(createEditorConnectionRequest('test')).table(1);
  assert.equal(request.bb.readFloat32(request.field(1)), 30);
  const schema = readFileSync(new URL('../sdk/types/EditorEvents.fbs', import.meta.url), 'utf8');
  const tags = schema.match(/union FromEditorUnion\s*\{([^}]+)\}/)[1].split(',').map(s => s.trim());
  assert.equal(tags[30], 'WatchPin');
  assert.equal(tags[31], 'UnwatchPin');
});

test('snapshot subscribes to actual pin paths without the mother graph name; manual events update values', async t => {
  const engine = transport(t);
  const c = new NodosGraphClient();
  await c.connect();
  assert.ok(engine.requests.some(r => r.type === 31 && r.path === '/Make.Value'));
  c._handleEditorEvent(change('/Make.Value', 17));
  assert.equal(c.getNodeById(nodeId).pins[0].value, 17);
  assert.equal(c.getPinValue(pinId).value, 17);
  c.disconnect();
});

test('GET reads a new engine snapshot after manual changes even without value events; a failed refresh is not stale success', async t => {
  const engine = transport(t);
  const c = new NodosGraphClient();
  await c.connect();
  initialize(null, c);
  assert.equal((await invoke(listNodes)).body.nodes[0].pins[0].value, 0);
  engine.manualChange(53);
  const res = await invoke(listNodes);
  assert.equal(res.body.nodes[0].pins[0].value, 53);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(engine.connections.slice(1).every(c => c.closed));
  t.mock.method(c, 'refreshFromEngine', async () => { throw Object.assign(new Error('engine unavailable'), { status: 503 }); });
  assert.equal((await invoke(listNodes)).code, 503);
  c.disconnect();
});

test('POST Make double sends the right path and reports success only after engine readback is 40', async t => {
  const engine = transport(t);
  const c = new NodosGraphClient();
  await c.connect();
  initialize(null, c);
  const response = await invoke(updatePinValue, { value: 40 });
  assert.equal(response.code, 200);
  assert.equal(response.body.status, 'confirmed');
  assert.equal((await invoke(listNodes)).body.nodes[0].pins[0].value, 40);
  assert.ok(engine.requests.some(r => r.type === 2 && r.path === '/Make.Value'));
  c.disconnect();
});

test('ignored writes return 502 and keep the real value rather than the requested one', async t => {
  transport(t, { ignoreWrites: true });
  const c = new NodosGraphClient();
  await c.connect();
  initialize(null, c);
  const response = await invoke(updatePinValue, { value: 40 });
  assert.equal(response.code, 502);
  assert.match(response.body.error, /current engine value: 0/);
  assert.equal(c.getPinValue(pinId).value, 0);
  c.disconnect();
});


test('late end/error events after disconnect and repeated GETs do not close a null channel', async t => {
  const engine = transport(t);
  const c = new NodosGraphClient();
  await c.connect();
  initialize(null, c);
  for (let i = 0; i < 3; i++) {
    assert.equal((await invoke(listNodes)).code, 200);
    await new Promise(resolve => setImmediate(resolve));
  }
  for (const connection of engine.connections.slice(1)) {
    assert.equal(connection.closed, true);
    assert.doesNotThrow(() => connection.stream.emit('end'));
    assert.doesNotThrow(() => connection.stream.emit('error', new Error('late cancellation')));
  }
  assert.equal(c.isReady(), true);
  c.disconnect();
  assert.doesNotThrow(() => c.disconnect());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.channel, null);
});


test('writes and watches preserve an unambiguous path supplied by the engine across snapshot refreshes', async t => {
  const path = '/Project/Make/Value';
  const engine = transport(t, { expectedPath: path });
  const c = new NodosGraphClient();
  await c.connect();
  c._handleEditorEvent(change(path, 22));
  assert.equal(c.getPinValue(pinId).value, 22);
  assert.equal(c.getPathDiagnostics().pins[0].path, path);
  assert.equal(c.getPathDiagnostics().pins[0].source, 'engine');
  assert.ok(engine.requests.some(r => r.type === 31 && r.path === path));
  initialize(null, c);
  const response = await invoke(updatePinValue, { value: 40 });
  assert.equal(response.code, 200);
  assert.ok(engine.requests.some(r => r.type === 2 && r.path === path));
  c.disconnect();
});

test('ambiguous engine path suffixes are not assigned to an arbitrary node', () => {
  const c = new NodosGraphClient({ watchPins: false });
  for (const id of ['one', 'two']) {
    c._nodes.set(id, { id, name: 'Make', pins: [{ id: id + '-pin', name: 'Value' }] });
    c._paths.set(id, id + '.Make');
  }
  assert.equal(c._findPinByPath('/Project/Make/Value'), null);
  assert.equal(c._enginePinPaths.size, 0);
});


test('read-only watches discover the root-qualified slash path before sending a mutation', async t => {
  const path = '/MotherGraph/Make/Value';
  const engine = transport(t, { expectedPath: path });
  const c = new NodosGraphClient();
  await c.connect();
  initialize(null, c);
  const response = await invoke(updatePinValue, { value: 200 });
  assert.equal(response.code, 200);
  const watchIndex = engine.requests.findIndex(r => r.type === 31 && r.path === path);
  const writeIndex = engine.requests.findIndex(r => r.type === 2);
  assert.ok(watchIndex >= 0 && writeIndex > watchIndex);
  assert.equal(engine.requests[writeIndex].path, path);
  assert.equal(c.getPinValue(pinId).value, 200);
  c.disconnect();
});

test('an exact inferred path received from the engine is recorded as observed', async t => {
  transport(t);
  const c = new NodosGraphClient();
  await c.connect();
  c._handleEditorEvent(change('/Make.Value', 22));
  assert.equal(c.getPathDiagnostics().pins[0].source, 'engine');
  assert.ok(c.getPathDiagnostics().observed_paths.includes('/Make.Value'));
  c.disconnect();
});

test('without a valid path response discovery times out without sending writes', async t => {
  const engine = transport(t, { expectedPath: 'unsupported-address-format' });
  const c = new NodosGraphClient();
  await c.connect();
  initialize(null, c);
  const response = await invoke(updatePinValue, { value: 200 });
  assert.equal(response.code, 503);
  assert.match(response.body.error, /no change was sent/);
  assert.equal(engine.requests.filter(r => r.type === 2).length, 0);
  c.disconnect();
});
