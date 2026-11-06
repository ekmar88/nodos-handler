import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import grpc from '@grpc/grpc-js';
import * as flatbuffers from 'flatbuffers';
import { NodosClient, UUID } from '../src/lib/nodos-client.js';
import { NodosGraphClient } from '../src/lib/nodos-graph-client.js';
import { Node } from '../sdk/generated/js/nos/fb/node.js';
import { Graph } from '../sdk/generated/js/nos/fb/graph.js';
import { NodeContents } from '../sdk/generated/js/nos/fb/node-contents.js';
import { AppEvent } from '../sdk/generated/js/nos/app/app-event.js';
import { AppConnectionRequest } from '../sdk/generated/js/nos/app/app-connection-request.js';
import { EditorEvent, decodeEditorEvent } from '../src/lib/editor-protocol.js';
import { initialize, listNodes, getNodeById, getNodesByClassName, getStatus } from '../src/controllers/nodes.controller.js';

// Build fixtures directly from sdk/types/EditorEvents.fbs, independently of
// the read codec. Schema field positions include both union tag and value.
function table(builder, fieldCount, offsets = {}, bytes = {}) {
  builder.startObject(fieldCount);
  for (const [field, offset] of Object.entries(offsets)) builder.addFieldOffset(Number(field), offset, 0);
  for (const [field, value] of Object.entries(bytes)) builder.addFieldInt8(Number(field), value, 0);
  return builder.endObject();
}
function vector(builder, offsets) {
  builder.startVector(4, offsets.length, 4);
  for (const offset of [...offsets].reverse()) builder.addOffset(offset);
  return builder.endVector();
}
function makeNode(b, id, children = [], functions = []) {
  const name = b.createString(`node-${id}`);
  const className = b.createString('double');
  const childVector = Graph.createNodesVector(b, children);
  const graph = table(b, 4, { 0: childVector });
  const functionVector = Node.createFunctionsVector(b, functions);
  Node.startNode(b);
  Node.addName(b, name);
  Node.addClassName(b, className);
  Node.addFunctions(b, functionVector);
  Node.addContentsType(b, NodeContents.Graph);
  Node.addContents(b, graph);
  Node.addId(b, UUID.createUUID(b, new Uint8Array(16).fill(id)));
  return Node.endNode(b);
}
function envelope(b, type, event) {
  return table(b, 3, { 1: event }, { 0: type });
}
function message(type, build) {
  const b = new flatbuffers.Builder(2048);
  const event = build(b);
  b.finish(envelope(b, type, event));
  return b.asUint8Array();
}
function snapshot(ids = [1, 2, 3, 4], type = EditorEvent.ClientConnected) {
  return message(type, b => {
    const instances = ids.map(id => makeNode(b, id));
    const root = makeNode(b, 99, instances);
    const catalogue = vector(b, [makeNode(b, 88)]);
    const status = table(b, 11, { 1: catalogue, 4: root });
    return type === EditorEvent.ClientConnected ? table(b, 5, { 1: status }) : status;
  });
}
function deliver(c, bytes) { c._handleEditorEvent(decodeEditorEvent(bytes)); }
async function response(handler, params = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await handler({ params }, res);
  return res;
}

test('editor union tags agree with the bundled schema', () => {
  const schema = readFileSync(new URL('../sdk/types/EditorEvents.fbs', import.meta.url), 'utf8');
  const members = schema.match(/union FromEngineUnion\s*\{([^}]+)\}/)[1].split(',').map(x => x.trim()).filter(Boolean);
  for (const [name, tag] of Object.entries(EditorEvent)) assert.equal(members[tag - 1], name);
});

test('initial editor snapshot returns four instances, excluding catalogue and mother graph', async () => {
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  c.call = {};
  deliver(c, snapshot());
  initialize(new NodosClient(), c);
  const res = await response(listNodes);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 4);
  assert.deepEqual(res.body.nodes.map(n => n.name), ['node-1', 'node-2', 'node-3', 'node-4']);
  assert.equal((await response(getNodeById, { nodeId: 'node-3' })).body.node.name, 'node-3');
  assert.equal((await response(getNodesByClassName, { className: 'double' })).body.count, 4);
  assert.equal((await response(getStatus)).body.graph_ready, true);
});

test('missing/disconnected snapshot returns 503; genuinely empty graph returns success', async () => {
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  c.call = {};
  initialize(new NodosClient(), c);
  assert.equal((await response(listNodes)).statusCode, 503);
  deliver(c, snapshot([]));
  assert.equal((await response(listNodes)).body.count, 0);
  assert.equal((await response(listNodes)).statusCode, 200);
  c.connected = false;
  assert.equal((await response(listNodes)).statusCode, 503);
  assert.equal((await response(getNodeById, { nodeId: 'node-1' })).statusCode, 503);
  assert.equal((await response(getNodesByClassName, { className: 'double' })).statusCode, 503);
});

test('nested graphs/functions, batch creation, recursive deletion, and replacement snapshots', () => {
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  deliver(c, snapshot([1]));
  deliver(c, message(EditorEvent.BatchEvent, b => {
    const grandchild = makeNode(b, 3);
    const fn = makeNode(b, 4);
    const parent = makeNode(b, 2, [grandchild], [fn]);
    const path = b.createString('node-99');
    const created = table(b, 2, { 0: path, 1: parent });
    const event = envelope(b, EditorEvent.NodeCreated, created);
    return table(b, 1, { 0: vector(b, [event]) });
  }));
  assert.equal(c.getNodes().length, 4);
  deliver(c, message(EditorEvent.NodeDeleted, b => table(b, 1, { 0: b.createString('node-99.node-2') })));
  assert.deepEqual(c.getNodes().map(n => n.name), ['node-1']);
  deliver(c, snapshot([5], EditorEvent.ServerStatus));
  assert.deepEqual(c.getNodes().map(n => n.name), ['node-5']);
  // Status messages without mother_graph must not clear the snapshot.
  deliver(c, message(EditorEvent.ServerStatus, b => table(b, 11)));
  assert.equal(c.getNodes().length, 1);
});

test('rename/move updates preserve descendants and subsequent deletes', () => {
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  deliver(c, snapshot([]));
  deliver(c, message(EditorEvent.NodeCreated, b => {
    const parent = makeNode(b, 2, [makeNode(b, 3)]);
    return table(b, 2, { 0: b.createString('node-99'), 1: parent });
  }));
  deliver(c, message(EditorEvent.EditorPartialItemUpdate, b => {
    const update = table(b, 11, { 4: b.createString('node-99.group') });
    return table(b, 7, {
      0: b.createString('node-99.node-2'), 2: update,
      3: b.createString('Renamed'), 4: b.createString('new-name'),
    }, { 1: 1 });
  }));
  assert.equal(c.getNodeByName('new-name').displayName, 'Renamed');
  deliver(c, message(EditorEvent.NodeDeleted, b => table(b, 1, { 0: b.createString('node-99.group.new-name') })));
  assert.equal(c.getNodes().length, 0);
});

test('App connection request encodes API SemVer inline', () => {
  const c = new NodosClient();
  const bb = new flatbuffers.ByteBuffer(c._createConnectionRequest());
  const request = AppEvent.getRootAsAppEvent(bb).event(new AppConnectionRequest());
  assert.equal(request.appKey(), c.appKey);
  const version = request.usedApiVersion();
  assert.deepEqual([version.major(), version.minor(), version.patch()], [1, 3, 3]);
});

test('graph connection waits for snapshot and uses EditorService protocol', async t => {
  let wireDefinition;
  let request;
  const stream = new EventEmitter();
  stream.write = bytes => { request = decodeEditorEvent(bytes); };
  stream.cancel = () => {};
  const channel = { close() {}, Connect() { return stream; } };
  t.mock.getter(grpc, 'makeGenericClientConstructor', () => definition => {
    wireDefinition = definition.Connect;
    return function () { return channel; };
  });
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  const connection = c.connect();
  assert.equal(c.isReady(), false);
  assert.equal(wireDefinition.path, '/nos.editor.EditorService/Connect');
  assert.equal(request.uint8(0), 3);
  assert.equal(request.table(1).string(0), c.appName);
  stream.emit('data', wireDefinition.responseDeserialize(snapshot()));
  await connection;
  assert.equal(c.isReady(), true);
  stream.emit('error', new Error('connection lost'));
  assert.equal(c.isReady(), false);
  assert.equal(c.lastError, 'connection lost');
});

test('graph connection errors reject instead of reporting an empty graph', async t => {
  const stream = new EventEmitter();
  stream.write = () => {};
  const channel = { close() {}, Connect() { return stream; } };
  t.mock.getter(grpc, 'makeGenericClientConstructor', () => () => function () { return channel; });
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  const promise = c.connect();
  stream.emit('error', new Error('unavailable'));
  await assert.rejects(promise, /unavailable/);
  assert.equal(c.isReady(), false);
});

test('App connection waits for the engine acknowledgement', async t => {
  let wire;
  const stream = new EventEmitter();
  stream.write = () => {};
  const channel = { close() {}, Connect() { return stream; } };
  t.mock.getter(grpc, 'makeGenericClientConstructor', () => definition => {
    wire = definition.Connect;
    return function () { return channel; };
  });
  const c = new NodosClient();
  const promise = c.connect();
  assert.equal(c.isConnected(), false);
  assert.equal(wire.path, '/nos.app.AppService/Connect');
  const b = new flatbuffers.Builder(128);
  const ack = table(b, 2);
  b.finish(envelope(b, 1, ack));
  stream.emit('data', wire.responseDeserialize(b.asUint8Array()));
  await promise;
  assert.equal(c.isConnected(), true);
  stream.emit('end');
  assert.equal(c.isConnected(), false);
});

test('graph snapshot timeout rejects and cancels the stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new EventEmitter();
  let cancelled = false;
  stream.write = () => {};
  stream.cancel = () => { cancelled = true; stream.emit('error', new Error('cancelled')); };
  const channel = { close() {}, Connect() { return stream; } };
  t.mock.getter(grpc, 'makeGenericClientConstructor', () => () => function () { return channel; });
  const c = new NodosGraphClient();
  c.refreshFromEngine = async () => {};
  const connection = c.connect();
  t.mock.timers.tick(5000);
  await assert.rejects(connection, /did not deliver a graph snapshot/);
  assert.equal(cancelled, true);
  assert.match(c.lastError, /did not deliver a graph snapshot/);
  assert.equal(c.isReady(), false);
});
