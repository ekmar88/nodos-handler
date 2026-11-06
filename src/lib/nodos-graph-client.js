import grpc from '@grpc/grpc-js';
import config from '../../config/default.js';
import { NodosClient } from './nodos-client.js';
import { ApiError, normalizeUUID, encodePinValue, decodePinValue } from './pin-values.js';
import { Pin } from '../../sdk/generated/js/nos/fb/pin.js';
import { Node } from '../../sdk/generated/js/nos/fb/node.js';
import { Graph } from '../../sdk/generated/js/nos/fb/graph.js';
import { NodeContents } from '../../sdk/generated/js/nos/fb/node-contents.js';
import { EditorEvent, decodeEditorEvent, createEditorConnectionRequest, createEditorPinUpdates, createEditorWatchRequests } from './editor-protocol.js';

/** Discover and edit graph nodes through EditorService. */
export class NodosGraphClient extends NodosClient {
  constructor(options = {}) {
    super({ ...options, port: options.port || config.nodos.editorPort });
    this.snapshotReceived = false;
    this.lastError = null;
    this._paths = new Map();
    this._watchedPaths = new Set();
    this._enginePinPaths = new Map();
    this._observedPaths = new Set();
    this._watchPins = options.watchPins !== false;
    this._refreshPromise = null;
    this._rootName = '';
    this.engineVersion = null;
    this.engineApiVersion = null;
    this._lastWrite = null;
  }

  isReady() {
    return this.isConnected() && this.snapshotReceived;
  }

  /** Each HTTP read requests a new engine snapshot, rather than trusting old values. */
  refreshFromEngine() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      const reader = new NodosGraphClient({
        host: this.host, port: this.port, appName: this.appName, watchPins: false,
      });
      try {
        await reader.connect();
        if (!this.isReady()) throw new ApiError(503, 'EditorService disconnected during refresh');
        this._nodes = reader._nodes;
        this._paths = reader._paths;
        this._rootName = reader._rootName;
        this._pinValueStore = reader._pinValueStore;
        this._syncWatches();
        this._emit('valuesRefreshed', {});
      } catch (error) {
        throw new ApiError(503, `Could not read current values from Nodos: ${error.message}`);
      } finally {
        reader.disconnect();
      }
    })().finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  _syncWatches() {
    if (!this._watchPins || !this.call?.write || !this.isConnected()) return;
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
    try {
      this.call.write(createEditorWatchRequests(watch, unwatch), error => {
        if (error) {
          this.lastError = `Pin subscription failed: ${error.message}`;
          this.call?.cancel();
        }
      });
    } catch (error) {
      this.lastError = `Pin subscription failed: ${error.message}`;
      this.connected = false;
      this.call?.cancel();
    }
  }

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
      const timer = setTimeout(finish, 2000);
      this.on('pinPathObserved', onPath);
      // These are read-only WatchPin requests. Mutations are only sent after
      // the engine has identified an unambiguous, valid path in its response.
      this._syncWatches();
    });
    if (!known()) {
      throw new ApiError(503, 'Nodos has not reported a valid path for this pin; no change was sent. Check graph_paths in /api/nodes/status and the Nodos EditorService SDK version.');
    }
  }

  resolveNode(reference) {
    const byId = this.getNodeById(reference);
    if (byId) return byId;
    const matches = this.getNodes().filter(n => n.name === reference || n.displayName === reference);
    if (matches.length > 1) throw new ApiError(409, 'Ambiguous node name; use its UUID');
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

  async updatePins(nodeReference, values) {
    if (!this.isReady()) throw new ApiError(503, 'Nodos EditorService graph is unavailable');
    await this.refreshFromEngine();
    // Validate every pin before sending any changes.
    const seen = new Set();
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
      throw new ApiError(400, 'Expected a non-empty pins object');
    }
    const updates = Object.entries(values).map(([reference, value]) => {
      const { node, pin } = this.resolvePin(nodeReference, reference);
      if (pin.readOnly) throw new ApiError(409, `Pin is read-only: ${pin.name}`);
      if (seen.has(pin.id)) throw new ApiError(400, `Pin specified more than once: ${pin.name}`);
      seen.add(pin.id);
      const path = this._paths.get(node.id);
      if (path === undefined) throw new ApiError(503, 'Node path is unavailable');
      return { node, pin, value, path: this._pinPath(node, pin), bytes: encodePinValue(value, pin.typeName) };
    });
    await this._discoverPinPaths(updates);
    for (const update of updates) update.path = this._pinPath(update.node, update.pin);
    this._lastWrite = {
      state: 'sending',
      pins: updates.map(({ node, pin, path, bytes, value }) => ({
        node_id: node.id, pin_id: pin.id, path, type: pin.typeName,
        requested: value, wire_hex: Buffer.from(bytes).toString('hex'),
      })),
    };
    const message = createEditorPinUpdates(updates);
    try {
      await new Promise((resolve, reject) => {
        this.call.write(message, error => error ? reject(error) : resolve());
      });
    } catch (error) {
      throw new ApiError(503, error.message);
    }
    this._lastWrite.state = 'reading-back';
    // Read back from the engine; accepting a stream write is not confirmation.
    await this.refreshFromEngine();
    const matches = () => updates.every(({ pin, bytes }) => {
      const actual = this.getPinValue(pin.id);
      if (!actual || actual.type !== pin.typeName) return false;
      const received = encodePinValue(actual.value, pin.typeName);
      return received.length === bytes.length && received.every((n, i) => n === bytes[i]);
    });
    if (!matches()) {
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer);
          this.off('pinValueReceived', onValue);
          resolve();
        };
        const onValue = () => { if (matches()) finish(); };
        const timer = setTimeout(finish, 1000);
        this.on('pinValueReceived', onValue);
      });
      await this.refreshFromEngine();
    }
    this._lastWrite.pins = this._lastWrite.pins.map(pin => ({ ...pin, actual: this.getPinValue(pin.pin_id)?.value ?? null }));
    if (!matches()) {
      this._lastWrite.state = 'unconfirmed';
      const mismatch = updates.find(({ pin, bytes }) => {
        const stored = this.getPinValue(pin.id);
        if (!stored || stored.type !== pin.typeName) return true;
        const actual = encodePinValue(stored.value, pin.typeName);
        return actual.length !== bytes.length || actual.some((n, i) => n !== bytes[i]);
      });
      throw new ApiError(502, `Nodos did not confirm the change to ${mismatch.path}; current engine value: ${JSON.stringify(this.getPinValue(mismatch.pin.id)?.value ?? null)}`);
    }
    this._lastWrite.state = 'confirmed';
    return updates.map(({ node, pin, value }) => ({
      node_id: node.id, pin_id: pin.id, pin: pin.name, value, type: pin.typeName, status: 'confirmed',
    }));
  }

  _pinPath(node, pin) {
    const inferred = `${this._paths.get(node.id)}.${pin.name}`;
    const observed = this._enginePinPaths.get(pin.id);
    // Snapshot refreshes may reveal renames/reparenting; discard obsolete paths.
    if (observed?.inferred === inferred) return observed.path;
    this._enginePinPaths.delete(pin.id);
    return inferred;
  }

  getPathDiagnostics() {
    return {
      engine_version: this.engineVersion,
      engine_api_version: this.engineApiVersion,
      last_write: this._lastWrite,
      root_name: this._rootName,
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
      console.log(`[NodosGraphClient] Engine pin path: ${path}`);
    }
    if (!found) return;
    this._enginePinPaths.set(found.pin.id, {
      path, inferred: `${this._paths.get(found.node.id)}.${found.pin.name}`,
    });
    this._emit('pinPathObserved', { pinId: found.pin.id, path });
  }

  _findPinByPath(path) {
    if (typeof path !== 'string') return null;
    for (const node of this._nodes.values()) {
      const pin = node.pins.find(p => this._pinPath(node, p) === path);
      if (pin) {
        const found = { node, pin };
        this._recordEnginePath(path, found);
        return found;
      }
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
    return found;
  }

  _rememberPinValue(pin, bytes) {
    this._pinValueStore.delete(pin.id);
    delete pin.value;
    if (!bytes) return;
    try {
      const value = decodePinValue(bytes, pin.typeName);
      pin.value = value;
      this._pinValueStore.set(pin.id, { value, type: pin.typeName });
      this._emit('pinValueReceived', { pinId: pin.id });
    } catch {
      // Complex/resource types remain discoverable without a JSON decoder.
    }
  }

  _storeGraphTree(node, parentPath) {
    if (!node) return;
    const info = this._extractNodeInfo(node);
    if (!info) return;
    // Nodos reports root pins as /Make.Value, not Make.Value.
    const path = !parentPath || parentPath === '/' ? `/${info.name}` : `${parentPath}.${info.name}`;
    this._paths.set(info.id, path);
    this._nodes.set(info.id, info);
    for (let i = 0; i < node.pinsLength(); i++) {
      this._rememberPinValue(info.pins[i], node.pins(i, new Pin()).dataArray());
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
    // The mother graph is a container; list its instances, not the container.
    // The mother graph name is implicit; editor paths start with /.
    // Including its display/unique name produces an unresolvable pin path.
    this._storeChildren(root, '');
    this.snapshotReceived = true;
    this._syncWatches();
    this._onSnapshot?.();
  }

  _handleEditorEvent(message) {
    const type = message.uint8(0);
    const event = message.table(1);
    if (!event) return;
    switch (type) {
      case EditorEvent.ClientConnected:
        this.connected = true;
        this.lastError = null;
        this.engineVersion = event.string(4);
        const version = event.field(2);
        if (version) this.engineApiVersion = [0, 4, 8].map(offset => event.bb.readUint32(version + offset)).join('.');
        this._applyStatus(event.table(1));
        break;
      case EditorEvent.ServerStatus:
        this._applyStatus(event);
        break;
      case EditorEvent.BatchEvent:
        for (const nested of event.tables(0)) this._handleEditorEvent(nested);
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
          if (found) this._rememberPinValue(found.pin, null);
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
          const pin = this._extractPinInfo(rawPin);
          node.pins = node.pins.filter(p => p.id !== pin.id);
          node.pins.push(pin);
          this._rememberPinValue(pin, rawPin.dataArray());
        }
        break;
      }
      case EditorEvent.PinDeleted: {
        const found = this._findPinByPath(event.string(0));
        if (found) {
          found.node.pins = found.node.pins.filter(p => p.id !== found.pin.id);
          this._pinValueStore.delete(found.pin.id);
          this._enginePinPaths.delete(found.pin.id);
        }
        break;
      }
      case EditorEvent.EditorPartialItemUpdate: {
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
              this._rememberPinValue(pin, null);
            }
            const action = update?.field(2);
            if (action) {
              // nos.Action: NOP=0, SET=1, RESET=2.
              const value = update.bb.readUint32(action);
              if (value === 1 || value === 2) pin.readOnly = value === 1;
            }
          }
          break;
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
        break;
      }
    }
    this._syncWatches();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._watchedPaths.clear();
      let failed = false;
      const timeout = setTimeout(() => {
        fail(new Error(`EditorService did not deliver a graph snapshot at ${this.host}:${this.port}`));
        this.call?.cancel();
        this.channel?.close();
      }, 5000);
      const fail = (error) => {
        if (failed) return;
        failed = true;
        clearTimeout(timeout);
        this.connected = false;
        this.snapshotReceived = false;
        this.lastError = error.message;
        reject(error);
      };
      this._onSnapshot = () => {
        if (failed || !this.connected) return;
        clearTimeout(timeout);
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
        this.channel = new EditorService(`${this.host}:${this.port}`, grpc.credentials.createInsecure());
        this.call = this.channel.Connect();
        this.call.on('data', (message) => {
          if (failed) return;
          try {
            this._handleEditorEvent(message);
          } catch (error) {
            fail(error);
            this.call?.cancel();
            this.channel?.close();
          }
        });
        this.call.on('error', (error) => {
          fail(error);
          this.channel?.close();
        });
        this.call.on('end', () => {
          fail(new Error('EditorService stream ended'));
          this.channel?.close();
        });
        this.call.write(createEditorConnectionRequest(this.appName));
      } catch (error) {
        fail(error);
        this.call?.cancel();
        this.channel?.close();
      }
    });
  }
}
