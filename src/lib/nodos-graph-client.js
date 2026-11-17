/**
 * Nodos EditorService client (default port 50052).
 *
 * Keeps one persistent stream open: the initial ServerStatus snapshot gives
 * the graph, structural events keep it current, and WatchPin subscriptions
 * deliver pin values. Reads are served from this state; a fresh snapshot is
 * only fetched when a value is known to be stale, on request (?fresh=true),
 * periodically (resync), or to confirm a write.
 *
 * Emits: 'connected', 'disconnected', 'graphChanged', 'pinValue' (public)
 * and 'pinValueReceived', 'pinPathObserved', 'valuesRefreshed' (internal).
 */
import grpc from '@grpc/grpc-js';
import { EventEmitter } from 'node:events';
import config from '../../config/default.js';
import logger from './logger.js';
import { ApiError, normalizeUUID, encodePinValue, decodePinValue, pinValueKind, mergePinValue } from './pin-values.js';
import { extractNodeInfo, extractPinInfo } from './fb-extract.js';
import { Pin } from '../../sdk/generated/js/nos/fb/pin.js';
import { Node } from '../../sdk/generated/js/nos/fb/node.js';
import { Graph } from '../../sdk/generated/js/nos/fb/graph.js';
import { NodeContents } from '../../sdk/generated/js/nos/fb/node-contents.js';
import {
  EditorEvent, decodeEditorEvent, createEditorConnectionRequest, createEditorPinUpdates, createEditorWatchRequests,
} from './editor-protocol.js';

const log = logger.child('EditorService');
const SNAPSHOT_TIMEOUT_MS = 5000;
const PATH_DISCOVERY_TIMEOUT_MS = 2000;
const VALUE_EVENTS = new Set([EditorEvent.EditorPinValueChanged, EditorEvent.PinsWithChangedValues]);

function sameValue(a, b) {
  return a?.type === b?.type && JSON.stringify(a?.value) === JSON.stringify(b?.value);
}

export class NodosGraphClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.host = options.host || config.nodos.host;
    this.port = options.port || config.nodos.editorPort;
    this.appName = options.appName || config.nodos.appName;
    this.confirmEventMs = options.confirmEventMs ?? 250;
    this.channel = null;
    this.call = null;
    this.connected = false;
    this.snapshotReceived = false;
    this.lastError = null;
    this.lastRefresh = null;
    this.engineVersion = null;
    this.engineApiVersion = null;
    this._nodes = new Map();          // nodeId -> node info (with pins)
    this._paths = new Map();          // nodeId -> inferred editor path
    this._pinValueStore = new Map();  // pinId -> { value, type }
    this._invalidPins = new Set();    // pins whose cached value is known to be stale
    this._enginePinPaths = new Map(); // pinId -> { path, inferred } as reported by the engine
    this._observedPaths = new Set();
    this._watchedPaths = new Set();
    this._watchPins = options.watchPins !== false;
    this._watchesDirty = true;
    this._pathIndex = null;
    this._refreshPromise = null;
    this._resyncTimer = null;
    this._rootName = '';
    this._lastWrite = null;
  }

  // ---------------------------------------------------------------- state

  isConnected() {
    return this.connected && this.call !== null;
  }

  isReady() {
    return this.isConnected() && this.snapshotReceived;
  }

  _invalidateIndex() {
    this._pathIndex = null;
    this._watchesDirty = true;
  }

  /** Lazily built lookups: pin path -> {node, pin} and pin id -> {node, pin}. */
  _index() {
    if (this._pathIndex) return this._pathIndex;
    const byPath = new Map();
    const byPin = new Map();
    for (const node of this._nodes.values()) {
      for (const pin of node.pins) {
        const entry = { node, pin };
        byPin.set(pin.id, entry);
        const path = this._pinPath(node, pin);
        if (!byPath.has(path)) byPath.set(path, entry);
      }
    }
    this._pathIndex = { byPath, byPin };
    return this._pathIndex;
  }

  _structureSignature() {
    let signature = '';
    for (const [id, node] of this._nodes) {
      signature += `${id}:${this._paths.get(id)}:${node.displayName}:${node.pins.map(p => `${p.id}/${p.name}/${p.typeName}/${p.readOnly}`).join(',')};`;
    }
    return signature;
  }

  // ---------------------------------------------------------------- reads

  /** Request a brand-new snapshot over a short-lived second stream. */
  refreshFromEngine() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      const reader = new NodosGraphClient({
        host: this.host, port: this.port, appName: this.appName, watchPins: false,
      });
      try {
        await reader.connect();
        if (!this.isReady()) throw new Error('EditorService disconnected during refresh');
        this._adoptSnapshot(reader);
      } catch (error) {
        throw new ApiError(503, `Could not read current values from Nodos: ${error.message}`);
      } finally {
        reader.disconnect();
      }
    })().finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  _adoptSnapshot(reader) {
    const before = this._structureSignature();
    const previous = this._pinValueStore;
    this._nodes = reader._nodes;
    this._paths = reader._paths;
    this._rootName = reader._rootName;
    this._pinValueStore = reader._pinValueStore;
    this._invalidPins.clear();
    this._invalidateIndex();
    this.lastRefresh = new Date().toISOString();
    if (before !== this._structureSignature()) this.emit('graphChanged', { reason: 'refresh' });
    for (const [pinId, stored] of this._pinValueStore) {
      if (!sameValue(previous.get(pinId), stored)) this._emitPinValue(pinId, stored);
    }
    this._syncWatches();
    this.emit('valuesRefreshed', {});
  }

  /**
   * Make cached state safe to serve. Refreshes when forced or when the engine
   * reported a change whose value has not arrived yet. Unforced refresh
   * failures fall back to the cached graph (stale values are already removed).
   */
  async ensureFresh({ force = false } = {}) {
    if (!this.isReady()) throw new ApiError(503, 'Nodos EditorService graph is unavailable');
    if (!force && !this._invalidPins.size) return false;
    try {
      await this.refreshFromEngine();
      return true;
    } catch (error) {
      if (force) throw error;
      log.debug(`Refresh failed, serving cached graph: ${error.message}`);
      return false;
    }
  }

  /** Periodically resynchronise from a fresh snapshot (covers missed events). */
  startResync(intervalMs) {
    this.stopResync();
    if (!intervalMs) return;
    this._resyncTimer = setInterval(() => {
      if (!this.isReady() || this._refreshPromise) return;
      this.refreshFromEngine().catch(error => log.debug(`Resync failed: ${error.message}`));
    }, intervalMs);
    this._resyncTimer.unref?.();
  }

  stopResync() {
    clearInterval(this._resyncTimer);
    this._resyncTimer = null;
  }

  getNodes() {
    return Array.from(this._nodes.values());
  }

  getNodeById(nodeId) {
    return this._nodes.get(normalizeUUID(nodeId) || nodeId) || null;
  }

  getNodeByName(name) {
    return this.getNodes().find(n => n.name === name || n.displayName === name) || null;
  }

  getNodesByClassName(className) {
    const wanted = className.toLowerCase();
    return this.getNodes().filter(n => n.className.toLowerCase() === wanted);
  }

  getNodePath(nodeId) {
    return this._paths.get(nodeId) ?? null;
  }

  getPinValue(pinId) {
    const stored = this._pinValueStore.get(normalizeUUID(pinId) || pinId);
    return stored ? { ...stored } : null;
  }

  /** Filter nodes. name: substring of name/displayName; className: exact; path: prefix. */
  findNodes({ name, className, path } = {}) {
    const needle = name?.toLowerCase();
    return this.getNodes().filter(node =>
      (!needle || node.name.toLowerCase().includes(needle) || node.displayName.toLowerCase().includes(needle)) &&
      (!className || node.className.toLowerCase() === className.toLowerCase()) &&
      (!path || (this._paths.get(node.id) ?? '').startsWith(path)));
  }

  /** Public JSON shape of a node: adds path, parent, and per-pin value kind. */
  describeNode(node, { pins = true } = {}) {
    const path = this._paths.get(node.id) ?? null;
    const description = {
      id: node.id,
      name: node.name,
      displayName: node.displayName,
      className: node.className,
      description: node.description,
      appKey: node.appKey,
      path,
      parentId: this._parentId(path),
    };
    if (pins) description.pins = node.pins.map(pin => this.describePin(node, pin));
    else description.pinCount = node.pins.length;
    return description;
  }

  describePin(node, pin) {
    const stored = this._pinValueStore.get(pin.id);
    const kind = pinValueKind(pin.typeName);
    return {
      id: pin.id,
      name: pin.name,
      displayName: pin.displayName,
      description: pin.description,
      typeName: pin.typeName,
      readOnly: Boolean(pin.readOnly),
      live: pin.live,
      step: pin.step,
      editable: Boolean(kind) && !pin.readOnly,
      valueKind: kind,
      path: this._pinPath(node, pin),
      ...(stored ? { value: stored.value } : {}),
    };
  }

  _parentId(path) {
    if (!path) return null;
    const separator = path.lastIndexOf('.');
    if (separator < 0) return null;
    const parentPath = path.slice(0, separator);
    for (const [id, candidate] of this._paths) if (candidate === parentPath) return id;
    return null;
  }

  /** Nested tree of nodes (by path), without pins. */
  getTree() {
    const items = new Map(this.getNodes().map(node => [node.id, { ...this.describeNode(node, { pins: false }), children: [] }]));
    const roots = [];
    for (const item of items.values()) {
      const parent = item.parentId && items.get(item.parentId);
      (parent ? parent.children : roots).push(item);
    }
    return roots;
  }

  resolveNode(reference) {
    const byId = this.getNodeById(reference);
    if (byId) return byId;
    if (typeof reference === 'string' && reference.startsWith('/')) {
      for (const [id, path] of this._paths) if (path === reference) return this._nodes.get(id);
    }
    const matches = this.getNodes().filter(n => n.name === reference || n.displayName === reference);
    if (matches.length > 1) throw new ApiError(409, 'Ambiguous node name; use its UUID or path');
    if (!matches.length) throw new ApiError(404, `Node not found: ${reference}`);
    return matches[0];
  }

  resolvePin(nodeReference, pinReference) {
    const node = this.resolveNode(nodeReference);
    const id = normalizeUUID(pinReference);
    const byId = node.pins.find(p => p.id === id);
    const matches = byId ? [byId] : node.pins.filter(p => p.name === pinReference || p.displayName === pinReference);
    if (matches.length > 1) throw new ApiError(409, 'Ambiguous pin name; use its UUID');
    if (!matches.length) throw new ApiError(404, `Pin not found on node ${node.id}: ${pinReference}`);
    return { node, pin: matches[0] };
  }

  // ---------------------------------------------------------------- writes

  /**
   * Validate every pin, send one (batched) write, and resolve only once the
   * engine reports the requested values. With merge=true, vector values may
   * be partial (e.g. {x: 1}) and are merged with the current value.
   */
  async updatePins(nodeReference, values, { merge = false } = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
      throw new ApiError(400, 'Expected a non-empty pins object');
    }
    await this.ensureFresh();
    const seen = new Set();
    const updates = Object.entries(values).map(([reference, requested]) => {
      const { node, pin } = this.resolvePin(nodeReference, reference);
      if (pin.readOnly) throw new ApiError(409, `Pin is read-only: ${pin.name}`);
      if (seen.has(pin.id)) throw new ApiError(400, `Pin specified more than once: ${pin.name}`);
      seen.add(pin.id);
      if (this._paths.get(node.id) === undefined) throw new ApiError(503, 'Node path is unavailable');
      const value = merge ? mergePinValue(requested, this.getPinValue(pin.id)?.value, pin.typeName) : requested;
      return { node, pin, value, bytes: encodePinValue(value, pin.typeName) };
    });
    await this._discoverPinPaths(updates);
    for (const update of updates) update.path = this._pinPath(update.node, update.pin);
    this._lastWrite = {
      state: 'sending',
      at: new Date().toISOString(),
      pins: updates.map(({ node, pin, path, bytes, value }) => ({
        node_id: node.id, pin_id: pin.id, path, type: pin.typeName,
        requested: value, wire_hex: Buffer.from(bytes).toString('hex'),
      })),
    };
    try {
      await new Promise((resolve, reject) => {
        this.call.write(createEditorPinUpdates(updates), error => error ? reject(error) : resolve());
      });
    } catch (error) {
      this._lastWrite.state = 'failed';
      throw new ApiError(503, error.message);
    }

    // Only a value reported by the engine after the write may confirm it.
    for (const { pin } of updates) this._invalidatePin(pin);
    this._lastWrite.state = 'reading-back';
    const matches = () => updates.every(({ pin, bytes }) => this._storedMatches(pin, bytes));
    if (!(await this._waitFor(matches, this.confirmEventMs))) {
      await this.refreshFromEngine();
      if (!matches() && !(await this._waitFor(matches, 1000))) await this.refreshFromEngine();
    }
    this._lastWrite.pins = this._lastWrite.pins.map(p => ({ ...p, actual: this.getPinValue(p.pin_id)?.value ?? null }));
    if (!matches()) {
      this._lastWrite.state = 'unconfirmed';
      const mismatch = updates.find(({ pin, bytes }) => !this._storedMatches(pin, bytes));
      throw new ApiError(502, `Nodos did not confirm the change to ${mismatch.path}; current engine value: ${JSON.stringify(this.getPinValue(mismatch.pin.id)?.value ?? null)}`);
    }
    this._lastWrite.state = 'confirmed';
    return updates.map(({ node, pin, value }) => ({
      node_id: node.id, pin_id: pin.id, pin: pin.name, value, type: pin.typeName, status: 'confirmed',
    }));
  }

  _storedMatches(pin, bytes) {
    const stored = this.getPinValue(pin.id);
    if (!stored || stored.type !== pin.typeName) return false;
    const actual = encodePinValue(stored.value, pin.typeName);
    return actual.length === bytes.length && actual.every((n, i) => n === bytes[i]);
  }

  /** Resolve true as soon as predicate() holds after a value event, false on timeout. */
  _waitFor(predicate, timeoutMs) {
    if (predicate()) return Promise.resolve(true);
    if (!timeoutMs) return Promise.resolve(false);
    return new Promise(resolve => {
      const finish = (result) => {
        clearTimeout(timer);
        this.off('pinValueReceived', onValue);
        resolve(result);
      };
      const onValue = () => { if (predicate()) finish(true); };
      const timer = setTimeout(() => finish(predicate()), timeoutMs);
      this.on('pinValueReceived', onValue);
    });
  }

  async _discoverPinPaths(updates) {
    const known = () => updates.every(({ node, pin }) => {
      this._pinPath(node, pin); // Discard obsolete observations after a rename.
      return this._enginePinPaths.has(pin.id);
    });
    if (known()) return;
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.off('pinPathObserved', onPath);
        resolve();
      };
      const onPath = () => { if (known()) finish(); };
      const timer = setTimeout(finish, PATH_DISCOVERY_TIMEOUT_MS);
      this.on('pinPathObserved', onPath);
      // These are read-only WatchPin requests. Mutations are only sent after
      // the engine has identified an unambiguous, valid path in its response.
      this._watchesDirty = true;
      this._syncWatches();
    });
    if (!known()) {
      throw new ApiError(503, 'Nodos has not reported a valid path for this pin; no change was sent. Check graph_paths in /api/nodes/status and the Nodos EditorService SDK version.');
    }
  }

  // ---------------------------------------------------------------- pin paths

  _pinPath(node, pin) {
    const inferred = `${this._paths.get(node.id)}.${pin.name}`;
    const observed = this._enginePinPaths.get(pin.id);
    // Snapshot refreshes may reveal renames/reparenting; discard obsolete paths.
    if (observed?.inferred === inferred) return observed.path;
    if (observed) this._enginePinPaths.delete(pin.id);
    return inferred;
  }

  /**
   * Candidate addresses for a pin whose engine path is unknown. The engine's
   * path syntax is learned from its WatchPin responses; once observed, only
   * that exact path is used (see getPathDiagnostics().observed_paths).
   */
  _pinPathCandidates(node, pin) {
    const segments = (this._paths.get(node.id) || node.name).replace(/^\/+/, '').split('.').concat(pin.name);
    const variants = new Set([this._pinPath(node, pin), pin.id]);
    for (const delimiter of ['.', '/', '::', '|']) {
      const relative = segments.join(delimiter);
      variants.add(relative);
      if (delimiter === '/') variants.add('/' + relative);
      if (this._rootName) {
        const absolute = [this._rootName, ...segments].join(delimiter);
        variants.add(absolute);
        if (delimiter === '/') variants.add('/' + absolute);
      }
    }
    return [...variants];
  }

  _syncWatches() {
    if (!this._watchPins || !this._watchesDirty || !this.call?.write || !this.isConnected()) return;
    this._watchesDirty = false;
    const wanted = new Set();
    for (const node of this._nodes.values()) {
      for (const pin of node.pins) {
        const path = this._pinPath(node, pin);
        const paths = this._enginePinPaths.has(pin.id) ? [path] : this._pinPathCandidates(node, pin);
        for (const candidate of paths) wanted.add(candidate);
      }
    }
    const watch = [...wanted].filter(path => !this._watchedPaths.has(path));
    const unwatch = [...this._watchedPaths].filter(path => !wanted.has(path));
    if (!watch.length && !unwatch.length) return;
    this._watchedPaths = wanted;
    const call = this.call;
    try {
      call.write(createEditorWatchRequests(watch, unwatch), error => {
        if (error) {
          this.lastError = `Pin subscription failed: ${error.message}`;
          call.cancel?.();
        }
      });
    } catch (error) {
      this.lastError = `Pin subscription failed: ${error.message}`;
      call.cancel?.();
    }
  }

  getPathDiagnostics() {
    return {
      engine_version: this.engineVersion,
      engine_api_version: this.engineApiVersion,
      last_refresh: this.lastRefresh,
      last_write: this._lastWrite,
      root_name: this._rootName,
      watched_paths: this._watchedPaths.size,
      observed_paths: [...this._observedPaths],
      pins: this.getNodes().flatMap(node => node.pins.map(pin => ({
        node_id: node.id, pin_id: pin.id, path: this._pinPath(node, pin),
        source: this._enginePinPaths.has(pin.id) ? 'engine' : 'inferred',
      }))),
    };
  }

  _recordEnginePath(path, found) {
    if (!this._observedPaths.has(path) && this._observedPaths.size < 50) {
      this._observedPaths.add(path);
      log.debug(`Engine pin path: ${path}`);
    }
    if (!found) return;
    const inferred = `${this._paths.get(found.node.id)}.${found.pin.name}`;
    const current = this._enginePinPaths.get(found.pin.id);
    if (current?.path === path && current.inferred === inferred) return;
    this._enginePinPaths.set(found.pin.id, { path, inferred });
    this._invalidateIndex();
    this.emit('pinPathObserved', { pinId: found.pin.id, path });
  }

  _findPinByPath(path) {
    if (typeof path !== 'string') return null;
    const { byPath } = this._index();
    if (byPath.has(path)) {
      const found = byPath.get(path);
      if (found) this._recordEnginePath(path, found);
      return found;
    }
    // A snapshot supplies names, not serialized editor paths. When the engine
    // supplies a path, preserve that exact string. Never select an ambiguous
    // suffix (e.g. two nested nodes with the same name and pin name).
    const candidates = [];
    for (const node of this._nodes.values()) {
      for (const pin of node.pins) {
        const beforePin = pin.name && path.endsWith(pin.name) ? path.slice(0, -pin.name.length) : '';
        const separator = beforePin.match(/[./:|]+$/)?.[0];
        const beforeNode = separator ? beforePin.slice(0, -separator.length) : '';
        const matchesName = separator && node.name && (beforeNode === node.name ||
          ['.', '/', ':', '|'].some(s => beforeNode.endsWith(`${s}${node.name}`)));
        if (normalizeUUID(path) === pin.id || matchesName) candidates.push({ node, pin });
      }
    }
    const found = candidates.length === 1 ? candidates[0] : null;
    this._recordEnginePath(path, found);
    // Cache misses too (until the graph structure changes): value events for
    // unknown paths can arrive at the watch frequency.
    if (!found) this._index().byPath.set(path, null);
    return found;
  }

  // ---------------------------------------------------------------- pin values

  _rememberPinValue(pin, bytes, { notify = true } = {}) {
    const previous = this._pinValueStore.get(pin.id);
    this._pinValueStore.delete(pin.id);
    delete pin.value;
    if (!bytes) return;
    this._invalidPins.delete(pin.id);
    let value;
    try {
      value = decodePinValue(bytes, pin.typeName);
    } catch {
      return; // Complex/resource types remain discoverable without a JSON decoder.
    }
    const stored = { value, type: pin.typeName };
    pin.value = value;
    this._pinValueStore.set(pin.id, stored);
    this.emit('pinValueReceived', { pinId: pin.id });
    if (notify && !sameValue(previous, stored)) this._emitPinValue(pin.id, stored);
  }

  /** The engine says this value changed; drop it until a new value arrives. */
  _invalidatePin(pin) {
    this._rememberPinValue(pin, null);
    this._invalidPins.add(pin.id);
  }

  _emitPinValue(pinId, stored) {
    if (!this.listenerCount('pinValue')) return;
    const owner = this._index().byPin.get(pinId);
    if (!owner) return;
    this.emit('pinValue', {
      node_id: owner.node.id, node_name: owner.node.name, node_path: this._paths.get(owner.node.id) ?? null,
      pin_id: pinId, pin: owner.pin.name, value: stored.value, type: stored.type,
    });
  }

  // ---------------------------------------------------------------- graph events

  _storeGraphTree(node, parentPath) {
    if (!node) return;
    const info = extractNodeInfo(node);
    if (!info) return;
    // Nodos reports root pins as /Make.Value, not Make.Value.
    const path = !parentPath || parentPath === '/' ? `/${info.name}` : `${parentPath}.${info.name}`;
    this._paths.set(info.id, path);
    this._nodes.set(info.id, info);
    this._invalidateIndex();
    for (let i = 0; i < node.pinsLength(); i++) {
      this._rememberPinValue(info.pins[i], node.pins(i, new Pin()).dataArray(), { notify: false });
    }
    this._storeChildren(node, path);
  }

  _storeChildren(node, parentPath) {
    if (node.contentsType() === NodeContents.Graph) {
      const graph = node.contents(new Graph());
      for (let i = 0; graph && i < graph.nodesLength(); i++) {
        this._storeGraphTree(graph.nodes(i, new Node()), parentPath);
      }
    }
    for (let i = 0; i < node.functionsLength(); i++) {
      this._storeGraphTree(node.functions(i, new Node()), parentPath);
    }
  }

  _removePath(path) {
    for (const [id, storedPath] of this._paths) {
      if (storedPath === path || storedPath.startsWith(`${path}.`)) {
        this._paths.delete(id);
        for (const pin of this._nodes.get(id)?.pins || []) {
          this._pinValueStore.delete(pin.id);
          this._invalidPins.delete(pin.id);
          this._enginePinPaths.delete(pin.id);
        }
        this._nodes.delete(id);
      }
    }
  }

  _applyStatus(status) {
    if (!status) return;
    // ServerStatus.mother_graph is field 4. registered_nodes is a class
    // catalogue, not the set of instances currently present in the graph.
    const root = status.table(4, new Node());
    if (!root) return; // Other status messages may omit the graph.
    this._rootName = root.name() || '';
    this._nodes.clear();
    this._paths.clear();
    this._pinValueStore.clear();
    this._invalidPins.clear();
    // The mother graph is a container whose name is implicit: editor paths
    // start with /. List its instances, not the container itself.
    this._storeChildren(root, '');
    this._invalidateIndex();
    this.snapshotReceived = true;
    this._syncWatches();
    this._onSnapshot?.();
  }

  _handleEditorEvent(message, nested = false) {
    const type = message.uint8(0);
    const event = message.table(1);
    if (!event) return false;
    const structural = !VALUE_EVENTS.has(type);
    if (structural) this._invalidateIndex();
    switch (type) {
      case EditorEvent.ClientConnected: {
        this.connected = true;
        this.lastError = null;
        this.engineVersion = event.string(4);
        const version = event.field(2);
        if (version) this.engineApiVersion = [0, 4, 8].map(offset => event.bb.readUint32(version + offset)).join('.');
        this._applyStatus(event.table(1));
        break;
      }
      case EditorEvent.ServerStatus:
        this._applyStatus(event);
        break;
      case EditorEvent.BatchEvent:
        for (const inner of event.tables(0)) this._handleEditorEvent(inner, true);
        break;
      case EditorEvent.NodeCreated:
      case EditorEvent.FunctionCreated:
        this._storeGraphTree(event.table(1, new Node()), event.string(0) || '');
        break;
      case EditorEvent.NodeDeleted:
        this._removePath(event.string(0));
        break;
      case EditorEvent.PinsWithChangedValues:
        // A change notification contains paths, not values. Invalidate these
        // values until the watched sample or the next fresh snapshot arrives.
        for (const path of event.strings(0)) {
          const found = this._findPinByPath(path);
          if (found) this._invalidatePin(found.pin);
        }
        break;
      case EditorEvent.EditorPinValueChanged: {
        const found = this._findPinByPath(event.string(0));
        if (found) this._rememberPinValue(found.pin, event.bytes(1));
        break;
      }
      case EditorEvent.PinCreated: {
        const parent = [...this._paths].find(([, path]) => path === event.string(0));
        const rawPin = event.table(1, new Pin());
        if (parent && rawPin) {
          const node = this._nodes.get(parent[0]);
          const pin = extractPinInfo(rawPin);
          node.pins = node.pins.filter(p => p.id !== pin.id);
          node.pins.push(pin);
          this._invalidateIndex();
          this._rememberPinValue(pin, rawPin.dataArray(), { notify: false });
        }
        break;
      }
      case EditorEvent.PinDeleted: {
        const found = this._findPinByPath(event.string(0));
        if (found) {
          found.node.pins = found.node.pins.filter(p => p.id !== found.pin.id);
          this._pinValueStore.delete(found.pin.id);
          this._invalidPins.delete(found.pin.id);
          this._enginePinPaths.delete(found.pin.id);
        }
        break;
      }
      case EditorEvent.EditorPartialItemUpdate:
        this._applyPartialItemUpdate(event);
        break;
      default:
        log.debug(`Unhandled editor event ${type}`);
    }
    if (structural) this._invalidateIndex();
    if (!nested) {
      if (structural && type !== EditorEvent.ServerStatus && type !== EditorEvent.ClientConnected) {
        this.emit('graphChanged', { reason: 'event', event: type });
      } else if (structural && this.snapshotReceived) {
        this.emit('graphChanged', { reason: 'snapshot' });
      }
      this._syncWatches();
    }
    return structural;
  }

  _applyPartialItemUpdate(event) {
    const oldPath = event.string(0);
    const found = this._findPinByPath(oldPath);
    if (found) {
      const { pin } = found;
      if (event.string(3) !== null) pin.displayName = event.string(3);
      if (event.string(4) !== null) pin.name = event.string(4);
      if (event.uint8(1) === 2) {
        const update = event.table(2);
        const type = update?.table(1)?.string(0);
        if (type !== undefined && type !== null) {
          pin.typeName = type;
          this._invalidatePin(pin);
        }
        const action = update?.field(2);
        if (action) {
          // nos.Action: NOP=0, SET=1, RESET=2.
          const value = update.bb.readUint32(action);
          if (value === 1 || value === 2) pin.readOnly = value === 1;
        }
      }
      return;
    }
    const uniqueName = event.string(4);
    const displayName = event.string(3);
    // EditorPartialNodeUpdate is union tag 1; new_parent_path is field 4.
    const update = event.uint8(1) === 1 ? event.table(2) : null;
    const newParent = update?.string(4);
    const separator = oldPath?.lastIndexOf('.') ?? -1;
    const oldParent = separator < 0 ? '' : oldPath.slice(0, separator);
    const oldName = oldPath?.slice(oldPath.lastIndexOf('.') + 1);
    const parent = newParent ?? oldParent;
    const newPath = parent ? `${parent}.${uniqueName ?? oldName}` : (uniqueName ?? oldName);
    for (const [id, path] of this._paths) {
      if (path === oldPath) {
        const node = this._nodes.get(id);
        if (displayName !== null) node.displayName = displayName;
        if (uniqueName !== null) node.name = uniqueName;
        const className = update?.string(7);
        if (className != null) node.className = className;
      }
      if (path === oldPath || path.startsWith(`${oldPath}.`)) {
        this._paths.set(id, newPath + path.slice(oldPath.length));
      }
    }
  }

  // ---------------------------------------------------------------- connection

  /** Open the stream; resolves once the first graph snapshot has arrived. */
  connect() {
    this._closeStream();
    return new Promise((resolve, reject) => {
      this._watchedPaths.clear();
      this._watchesDirty = true;
      this.snapshotReceived = false;
      let settled = false;
      let opened = false;
      let call = null;
      let channel = null;
      const timeout = setTimeout(() => {
        fail(new Error(`EditorService did not deliver a graph snapshot at ${this.host}:${this.port}`));
      }, SNAPSHOT_TIMEOUT_MS);

      const fail = (error) => {
        if (call && this.call !== call) return; // Event from a replaced or closed stream.
        clearTimeout(timeout);
        this.connected = false;
        this.snapshotReceived = false;
        this.lastError = error.message;
        this.call = null;
        this.channel = null;
        call?.cancel?.();
        channel?.close?.();
        if (!settled) {
          settled = true;
          reject(error);
        } else if (opened) {
          this.emit('disconnected', { error: error.message });
        }
      };

      this._onSnapshot = () => {
        if (settled || !this.connected) return;
        settled = true;
        opened = true;
        clearTimeout(timeout);
        this.emit('connected', { nodes: this._nodes.size });
        resolve(this);
      };

      try {
        const EditorService = grpc.makeGenericClientConstructor({
          Connect: {
            path: '/nos.editor.EditorService/Connect',
            requestStream: true,
            responseStream: true,
            requestSerialize: (bytes) => Buffer.from(bytes),
            responseDeserialize: decodeEditorEvent,
          },
        });
        channel = this.channel = new EditorService(`${this.host}:${this.port}`, grpc.credentials.createInsecure());
        call = this.call = channel.Connect();
        call.on('data', (message) => {
          if (this.call !== call) return;
          try {
            this._handleEditorEvent(message);
          } catch (error) {
            fail(error);
          }
        });
        call.on('error', (error) => fail(error));
        call.on('end', () => fail(new Error('EditorService stream ended')));
        call.write(createEditorConnectionRequest(this.appName));
      } catch (error) {
        fail(error);
      }
    });
  }

  _closeStream() {
    // Detach first: end/close can trigger stream callbacks synchronously or later.
    const { call, channel } = this;
    this.call = null;
    this.channel = null;
    this.connected = false;
    call?.end?.();
    channel?.close?.();
  }

  disconnect() {
    this._closeStream();
  }

  /** Stop background work and close the stream (for shutdown). */
  close() {
    this.stopResync();
    this._closeStream();
  }
}
