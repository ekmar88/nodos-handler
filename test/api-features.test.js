import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import grpc from '@grpc/grpc-js';
import { NodosGraphClient } from '../src/lib/nodos-graph-client.js';
import { keepConnected } from '../src/lib/reconnect.js';
import { mergePinValue, pinValueKind } from '../src/lib/pin-values.js';
import { decodeEditorEvent } from '../src/lib/editor-protocol.js';
import { createApp } from '../src/create-app.js';

const nodeId = 'abababab-abab-abab-abab-abababababab';
const childId = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd';
const posId = '33333333-3333-3333-3333-333333333333';
const gainId = '44444444-4444-4444-4444-444444444444';

/** Graph client with an in-memory engine that applies writes on refresh. */
function fixture() {
  const c = new NodosGraphClient({ watchPins: false, confirmEventMs: 0 });
  c.connected = c.snapshotReceived = true;
  const pending = [];
  const writes = [];
  c.call = { write(bytes, callback) {
    const message = decodeEditorEvent(bytes);
    const requests = message.uint8(0) === 26 ? message.table(1).tables(0) : [message];
    for (const request of requests) {
      const event = request.table(1);
      writes.push(event.string(0));
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
  const parent = { id: nodeId, name: 'Group', displayName: 'Group', className: 'nos.Graph', description: '', appKey: '', pins: [] };
  const child = {
    id: childId, name: 'Transform', displayName: 'My Transform', className: 'nos.math.Transform', description: '', appKey: '',
    pins: [
      { id: posId, name: 'Position', typeName: 'nos.fb.vec3' },
      { id: gainId, name: 'Gain', typeName: 'double' },
    ],
  };
  c._nodes.set(nodeId, parent);
  c._nodes.set(childId, child);
  c._paths.set(nodeId, '/Group');
  c._paths.set(childId, '/Group.Transform');
  for (const pin of child.pins) c._recordEnginePath(`/Group.Transform.${pin.name}`, { node: child, pin });
  const vec = new Uint8Array(12);
  new DataView(vec.buffer).setFloat32(0, 1, true);
  new DataView(vec.buffer).setFloat32(4, 2, true);
  new DataView(vec.buffer).setFloat32(8, 3, true);
  c._rememberPinValue(child.pins[0], vec);
  return { c, writes };
}

async function withServer(options, run) {
  const app = createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

test('value kinds describe editable types; partial vectors merge with the current value', () => {
  assert.deepEqual(pinValueKind('nos.fb.vec3'), { kind: 'vector', scalar: 'float', components: ['x', 'y', 'z'] });
  assert.deepEqual(pinValueKind('int'), { kind: 'number', scalar: 'int', integer: true });
  assert.equal(pinValueKind('nos.sys.vulkan.Texture'), null);
  assert.deepEqual(mergePinValue({ y: 9 }, { x: 1, y: 2, z: 3 }, 'nos.fb.vec3'), { x: 1, y: 9, z: 3 });
  assert.equal(mergePinValue(5, 1, 'double'), 5);
  assert.throws(() => mergePinValue({ q: 1 }, { x: 1, y: 2, z: 3 }, 'nos.fb.vec3'), /no component/);
  assert.throws(() => mergePinValue({ x: 1 }, undefined, 'nos.fb.vec3'), e => e.status === 409);
});

test('HTTP: filters, tree, path lookup, pin metadata, and PATCH partial vector', async () => {
  const { c, writes } = fixture();
  await withServer({ graphClient: c }, async base => {
    const get = async path => (await fetch(base + path)).json();

    assert.equal((await get('/api/nodes?name=transform')).count, 1);
    assert.equal((await get('/api/nodes?class=nos.Graph')).nodes[0].id, nodeId);
    assert.equal((await get('/api/nodes?path=/Group')).count, 2);
    const summary = await get('/api/nodes?pins=false');
    assert.equal(summary.nodes[1].pinCount, 2);
    assert.equal(summary.nodes[1].pins, undefined);

    const tree = await get('/api/graph');
    assert.equal(tree.tree.length, 1);
    assert.equal(tree.tree[0].children[0].id, childId);

    const byPath = await get(`/api/nodes/${encodeURIComponent('/Group.Transform')}`);
    assert.equal(byPath.node.id, childId);
    assert.equal(byPath.node.parentId, nodeId);
    assert.deepEqual(byPath.node.pins[0].value, { x: 1, y: 2, z: 3 });
    assert.equal(byPath.node.pins[0].editable, true);

    const pin = await get(`/api/nodes/${childId}/pins/Position`);
    assert.equal(pin.pin.id, posId);
    assert.equal(pin.pin.path, '/Group.Transform.Position');

    // POST requires every component, PATCH merges.
    const post = await fetch(`${base}/api/nodes/${childId}/pin/Position`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { x: 5 } }),
    });
    assert.equal(post.status, 400);
    const patch = await fetch(`${base}/api/nodes/${childId}/pin/Position`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { x: 5 } }),
    });
    assert.equal(patch.status, 200, JSON.stringify(await patch.clone().json()));
    assert.deepEqual((await patch.json()).value, { x: 5, y: 2, z: 3 });
    assert.deepEqual(c.getPinValue(posId).value, { x: 5, y: 2, z: 3 });
    assert.deepEqual(writes, ['/Group.Transform.Position']);
  });
});

test('HTTP: API key is required when configured; health stays public', async () => {
  const { c } = fixture();
  await withServer({ graphClient: c, apiKey: 'secret' }, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/nodes`)).status, 401);
    assert.equal((await fetch(`${base}/api/nodes`, { headers: { 'X-API-Key': 'wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/api/nodes`, { headers: { 'X-API-Key': 'secret' } })).status, 200);
    assert.equal((await fetch(`${base}/api/nodes?api_key=secret`)).status, 200);
  });
});

test('HTTP: /api/events streams status, pin value changes (filtered by node) and graph changes', async () => {
  const { c } = fixture();
  await withServer({ graphClient: c }, async base => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events?node=${childId}`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (type) => {
      for (;;) {
        const match = buffer.match(new RegExp(`event: ${type}\\ndata: (.*)\\n\\n`));
        if (match) {
          buffer = buffer.slice(buffer.indexOf(match[0]) + match[0].length);
          return JSON.parse(match[1]);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    assert.equal((await next('status')).graph_ready, true);

    const gain = c.getNodeById(childId).pins[1];
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, 0.5, true);
    c._rememberPinValue(gain, bytes);
    const event = await next('pin');
    assert.equal(event.pin_id, gainId);
    assert.equal(event.value, 0.5);
    assert.equal(event.node_path, '/Group.Transform');

    // Same value again: no duplicate event. Different value: event.
    c._rememberPinValue(gain, bytes);
    new DataView(bytes.buffer).setFloat64(0, 0.75, true);
    c._rememberPinValue(gain, bytes);
    assert.equal((await next('pin')).value, 0.75);

    c.emit('graphChanged', { reason: 'event' });
    assert.equal((await next('graph')).reason, 'event');
    controller.abort();
    await reader.cancel().catch(() => {});
  });
  for (let i = 0; i < 50 && c.listenerCount('pinValue'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(c.listenerCount('pinValue'), 0);
});

test('graph client emits disconnected after a stream loss and ignores events from the replaced stream', async t => {
  const streams = [];
  t.mock.getter(grpc, 'makeGenericClientConstructor', () => definition => function () {
    const stream = new EventEmitter();
    stream.write = () => {};
    stream.cancel = () => {};
    stream.end = () => {};
    streams.push({ stream, definition });
    return { close() {}, Connect() { return stream; } };
  });
  const { snapshotBytes } = await import('./helpers/snapshot.js');
  const c = new NodosGraphClient({ watchPins: false });
  const deliverSnapshot = ({ stream, definition }) =>
    stream.emit('data', definition.Connect.responseDeserialize(snapshotBytes()));

  let connecting = c.connect();
  deliverSnapshot(streams[0]);
  await connecting;
  const lost = once(c, 'disconnected');
  streams[0].stream.emit('error', new Error('engine restarted'));
  assert.equal((await lost)[0].error, 'engine restarted');
  assert.equal(c.isReady(), false);

  connecting = c.connect();
  // Late events from the old stream must not affect the new connection.
  streams[0].stream.emit('end');
  deliverSnapshot(streams[1]);
  await connecting;
  assert.equal(c.isReady(), true);
  assert.equal(c.getNodes().length, 1);
  c.disconnect();
});

test('keepConnected retries with backoff and reconnects after disconnection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new EventEmitter();
  const results = [false, true, true];
  let attempts = 0;
  client.connect = async () => {
    const ok = results[attempts++];
    if (!ok) throw new Error('unavailable');
  };
  const silent = { info() {}, warn() {}, debug() {} };
  const keeper = keepConnected(client, { minDelay: 100, maxDelay: 1000, log: silent });
  await keeper.ready;
  assert.equal(attempts, 1);
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  client.emit('disconnected', { error: 'lost' });
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3);
  keeper.stop();
  client.emit('disconnected', {});
  t.mock.timers.tick(10000);
  assert.equal(attempts, 3);
});
