/**
 * Nodos FlatBuffers gRPC Client
 * Connects to a running Nodos engine via the App service (port 50053)
 * and provides methods to interact with nodes and their pins.
 * 
 * Uses FlatBuffers wire format over gRPC bidirectional streaming.
 */

import grpc from '@grpc/grpc-js';
import * as flatbuffers from 'flatbuffers';
import config from '../../config/default.js';
import { normalizeUUID } from './pin-values.js';

// Import generated FlatBuffers classes
import { AppEvent } from '../../sdk/generated/js/nos/app/app-event.js';
import { AppEventUnion } from '../../sdk/generated/js/nos/app/app-event-union.js';
import { AppConnectionRequest } from '../../sdk/generated/js/nos/app/app-connection-request.js';
import { SetPinValue } from '../../sdk/generated/js/nos/app/set-pin-value.js';
import { PinDirtied } from '../../sdk/generated/js/nos/app/pin-dirtied.js';
import { EngineEvent } from '../../sdk/generated/js/nos/app/engine-event.js';
import { EngineEventUnion } from '../../sdk/generated/js/nos/app/engine-event-union.js';
import { AppConnectedEvent } from '../../sdk/generated/js/nos/app/app-connected-event.js';
import { AppPinValueChanged } from '../../sdk/generated/js/nos/app/app-pin-value-changed.js';
import { StateChanged } from '../../sdk/generated/js/nos/app/state-changed.js';
import { ExecutionState } from '../../sdk/generated/js/nos/app/execution-state.js';
import { PartialNodeUpdate } from '../../sdk/generated/js/nos/partial-node-update.js';
import { BatchEngineEvent } from '../../sdk/generated/js/nos/app/batch-engine-event.js';
import { NodeImported } from '../../sdk/generated/js/nos/app/node-imported.js';
import { UUID } from '../../sdk/generated/js/nos/fb/uuid.js';
import { SemVer } from '../../sdk/generated/js/nos/fb/sem-ver.js';
import { Node } from '../../sdk/generated/js/nos/fb/node.js';
import { Pin } from '../../sdk/generated/js/nos/fb/pin.js';
import { Graph } from '../../sdk/generated/js/nos/fb/graph.js';
import { NodeContents } from '../../sdk/generated/js/nos/fb/node-contents.js';

/**
 * Helper to convert a hex string to a UUID bytes array
 */
function hexStringToUUIDBytes(hexString) {
  const hex = hexString.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Helper to convert a UUID bytes array to a hex string
 */
function uuidBytesToHexString(bytes) {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}

/**
 * Generate a deterministic UUID from a pin name (same as controller)
 */
function pinNameToUUID(pinName) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pinName);
  const hash = crypto.createHash('md5').update(data).digest();
  
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = hash[i];
  }
  
  return uuidBytesToHexString(bytes);
}

/**
 * Deserialize a pin value based on its type
 * Converts Uint8Array back to JavaScript value
 */
function deserializePinValue(bytes, type) {
  if (!bytes || bytes.length === 0) {
    return null;
  }
  
  switch (type) {
    case 'vec3': {
      if (bytes.length < 12) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        x: view.getFloat32(0, true),
        y: view.getFloat32(4, true),
        z: view.getFloat32(8, true),
      };
    }
    
    case 'double': {
      if (bytes.length < 8) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return view.getFloat64(0, true);
    }
    
    case 'string': {
      const decoder = new TextDecoder();
      return decoder.decode(bytes);
    }
    
    case 'bool': {
      return bytes[0] !== 0;
    }
    
    default:
      if (bytes.length < 8) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return view.getFloat64(0, true);
  }
}

/**
 * Serialize a pin value based on its type
 * Returns a Uint8Array that can be passed to SetPinValue.createValueVector()
 */
function serializePinValue(value, type) {
  switch (type) {
    case 'vec3': {
      const buffer = new ArrayBuffer(12);
      const view = new DataView(buffer);
      view.setFloat32(0, Number(value.x || 0), true);
      view.setFloat32(4, Number(value.y || 0), true);
      view.setFloat32(8, Number(value.z || 0), true);
      return new Uint8Array(buffer);
    }
    
    case 'double': {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setFloat64(0, Number(value), true);
      return new Uint8Array(buffer);
    }
    
    case 'string': {
      const encoder = new TextEncoder();
      return encoder.encode(String(value));
    }
    
    case 'bool': {
      return new Uint8Array([Boolean(value) ? 1 : 0]);
    }
    
    default:
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setFloat64(0, Number(value), true);
      return new Uint8Array(buffer);
  }
}

/**
 * NodosClient — manages the gRPC connection to Nodos using FlatBuffers
 */
class NodosClient {
  constructor(options = {}) {
    this.host = options.host || config.nodos.host;
    this.port = options.port || config.nodos.port;
    this.appKey = options.appKey || config.nodos.appKey;
    this.appName = options.appName || config.nodos.appName;

    this.channel = null;
    this.call = null;
    this.connected = false;
    this.engineProcessId = null;
    this.eventListeners = new Map();
    this._pinValueStore = new Map(); // Track last known pin values: pinId -> { value, type }
    this._pinNameStore = new Map();  // Track pin name -> pinId: pinName -> pinIdHex
    this._nodes = new Map();         // Track discovered nodes: nodeIdHex -> node info
  }

  /**
   * Create a FlatBuffers AppConnectionRequest message
   */
  _createConnectionRequest() {
    const builder = new flatbuffers.Builder(1024);
    
    const appKeyOffset = builder.createString(this.appKey);
    const appNameOffset = builder.createString(this.appName);
    
    AppConnectionRequest.startAppConnectionRequest(builder);
    AppConnectionRequest.addAppKey(builder, appKeyOffset);
    AppConnectionRequest.addAppName(builder, appNameOffset);
    AppConnectionRequest.addUsedApiVersion(builder, SemVer.createSemVer(builder, 1, 3, 3));
    AppConnectionRequest.addAppProcessId(builder, BigInt(process.pid));
    const connectionRequestOffset = AppConnectionRequest.endAppConnectionRequest(builder);
    
    AppEvent.startAppEvent(builder);
    AppEvent.addEventType(builder, AppEventUnion.AppConnectionRequest);
    AppEvent.addEvent(builder, connectionRequestOffset);
    const appEventOffset = AppEvent.endAppEvent(builder);
    
    builder.finish(appEventOffset);
    return builder.asUint8Array();
  }

  /**
   * Create a FlatBuffers SetPinValue message
   */
  _createSetPinValueMessage(pinIdHex, value, type) {
    const builder = new flatbuffers.Builder(1024);
    
    // Serialize the pin value (vector - offset field)
    const valueBytes = serializePinValue(value, type);
    const valueOffset = SetPinValue.createValueVector(builder, valueBytes);
    
    // Create SetPinValue - structs must be serialized inline in reverse order
    SetPinValue.startSetPinValue(builder);
    SetPinValue.addValue(builder, valueOffset);
    
    // Write UUID struct inline (must be after value because structs are inline)
    const pinBytes = hexStringToUUIDBytes(pinIdHex);
    SetPinValue.addPinId(builder, UUID.createUUID(builder, pinBytes));
    
    const setPinValueOffset = SetPinValue.endSetPinValue(builder);
    
    // Create AppEvent
    AppEvent.startAppEvent(builder);
    AppEvent.addEventType(builder, AppEventUnion.SetPinValue);
    AppEvent.addEvent(builder, setPinValueOffset);
    const appEventOffset = AppEvent.endAppEvent(builder);
    
    builder.finish(appEventOffset);
    return builder.asUint8Array();
  }

  /**
   * Create a FlatBuffers PinDirtied message
   */
  _createPinDirtiedMessage(pinIdHex) {
    const builder = new flatbuffers.Builder(1024);
    
    // Create UUID for pin ID
    const pinBytes = hexStringToUUIDBytes(pinIdHex);
    const pinIdOffset = UUID.createUUID(builder, pinBytes);
    
    // Create PinDirtied
    const pinDirtiedOffset = PinDirtied.createPinDirtied(builder, pinIdOffset, 0n);
    
    // Create AppEvent
    AppEvent.startAppEvent(builder);
    AppEvent.addEventType(builder, AppEventUnion.PinDirtied);
    AppEvent.addEvent(builder, pinDirtiedOffset);
    const appEventOffset = AppEvent.endAppEvent(builder);
    
    builder.finish(appEventOffset);
    return builder.asUint8Array();
  }

  /**
   * Deserialize an EngineEvent from FlatBuffers
   */
  _deserializeEngineEvent(buffer) {
    const bb = new flatbuffers.ByteBuffer(buffer);
    const engineEvent = new EngineEvent();
    engineEvent.__init(bb.readInt32(bb.position()) + bb.position(), bb);
    return engineEvent;
  }

  /**
   * Convert a UUID FlatBuffers object to hex string
   */
  _uuidToHex(uuidObj) {
    if (!uuidObj) return null;
    // UUID is 16 bytes; bytes() without index returns a single byte (0 if undefined)
    // We need to read all 16 bytes manually
    const allBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      allBytes[i] = uuidObj.bytes(i);
    }
    return uuidBytesToHexString(allBytes);
  }

  /**
   * Extract node info from FlatBuffers Node object
   */
  _extractNodeInfo(node) {
    if (!node) return null;
    
    const nodeUuid = node.id();
    const nodeId = this._uuidToHex(nodeUuid);
    console.log(`[NodosClient] _extractNodeInfo: node id obj=${!!nodeUuid}, nodeId hex=${nodeId}, name=${node.name()}, className=${node.className()}, pinsLength=${node.pinsLength()}`);
    if (!nodeId) return null;
    
    const pins = [];
    for (let i = 0; i < node.pinsLength(); i++) {
      const pin = node.pins(i, new Pin());
      if (pin) {
        pins.push(this._extractPinInfo(pin));
      }
    }
    
    return {
      id: nodeId,
      name: node.name() || '',
      className: node.className() || '',
      displayName: node.displayName() || '',
      description: node.description() || '',
      appKey: node.appKey() || '',
      pins: pins,
    };
  }

  _extractPinInfo(pin) {
    return {
      id: this._uuidToHex(pin.id()),
      name: pin.name() || '',
      typeName: pin.typeName() || '',
      displayName: pin.displayName() || '',
      description: pin.description() || '',
      readOnly: pin.readonly(),
      step: pin.step(),
      live: pin.live(),
    };
  }

  /** Register a node and every node nested in its graph or functions. */
  _storeNodeTree(node) {
    if (!node) return null;
    const info = this._extractNodeInfo(node);
    if (info) {
      this._nodes.set(info.id, info);
      this._emit('nodeDiscovered', info);
    }

    if (node.contentsType() === NodeContents.Graph) {
      const graph = node.contents(new Graph());
      if (graph) {
        for (let i = 0; i < graph.nodesLength(); i++) {
          this._storeNodeTree(graph.nodes(i, new Node()));
        }
      }
    }
    for (let i = 0; i < node.functionsLength(); i++) {
      this._storeNodeTree(node.functions(i, new Node()));
    }
    return info;
  }

  /**
   * Handle incoming EngineEvent from Nodos
   */
  _handleEngineEvent(engineEvent) {
    const eventType = engineEvent.eventType();
    console.log(`[NodosClient] Received EngineEvent: ${eventType}`);
    
    switch (eventType) {
      case EngineEventUnion.AppConnectedEvent: {
        const event = engineEvent.event(new AppConnectedEvent());
        if (event) {
          this.connected = true;
          this.engineProcessId = event.engineProcessId();
          console.log(`[NodosClient] Connected to Nodos engine process: ${this.engineProcessId}`);
          this._emit('connected', { engineProcessId: this.engineProcessId });
        }
        break;
      }
      
      case EngineEventUnion.AppPinValueChanged: {
        const event = engineEvent.event(new AppPinValueChanged());
        if (event) {
          const pinIdObj = event.pinId();
          const pinIdHex = pinIdObj ? this._uuidToHex(pinIdObj) : 'unknown';
          console.log(`[NodosClient] Pin value changed: ${pinIdHex}`);
          this._emit('pinValueChanged', { pinId: pinIdHex, value: event.valueArray() });
        }
        break;
      }
      
      case EngineEventUnion.StateChanged: {
        const event = engineEvent.event(new StateChanged());
        if (event) {
          const state = event.state();
          console.log(`[NodosClient] State changed: ${state} (${state === ExecutionState.IDLE ? 'IDLE' : state === ExecutionState.SYNCED ? 'SYNCED' : 'UNKNOWN'})`);
          this._emit('stateChanged', { state });
        }
        break;
      }
      
      case EngineEventUnion.nos_PartialNodeUpdate: {
        const event = engineEvent.event(new PartialNodeUpdate());
        if (event) {
          console.log(`[NodosClient] PartialNodeUpdate: nodesToAdd=${event.nodesToAddLength()}, functionsToAdd=${event.functionsToAddLength()}, nodesToDelete=${event.nodesToDeleteLength()}, functionsToDelete=${event.functionsToDeleteLength()}`);
          // Process nodes_to_add
          for (let i = 0; i < event.nodesToAddLength(); i++) {
            const nodeObj = event.nodesToAdd(i, new Node());
            const nodeInfo = this._storeNodeTree(nodeObj);
            if (nodeInfo) {
              console.log(`[NodosClient] Node discovered: ${nodeInfo.name} (${nodeInfo.className}) - ID: ${nodeInfo.id}`);
            }
          }
          
          // Process functions_to_add (nested nodes)
          for (let i = 0; i < event.functionsToAddLength(); i++) {
            const nodeObj = event.functionsToAdd(i, new Node());
            const nodeInfo = this._storeNodeTree(nodeObj);
            if (nodeInfo) {
              console.log(`[NodosClient] Function node discovered: ${nodeInfo.name} (${nodeInfo.className}) - ID: ${nodeInfo.id}`);
            }
          }
          
          // Process nodes_to_delete
          for (let i = 0; i < event.nodesToDeleteLength(); i++) {
            const nodeObj = event.nodesToDelete(i, new UUID());
            const nodeId = this._uuidToHex(nodeObj);
            if (nodeId) {
              this._nodes.delete(nodeId);
              console.log(`[NodosClient] Node removed: ${nodeId}`);
              this._emit('nodeRemoved', { nodeId });
            }
          }
          
          // Process functions_to_delete
          for (let i = 0; i < event.functionsToDeleteLength(); i++) {
            const nodeObj = event.functionsToDelete(i, new UUID());
            const nodeId = this._uuidToHex(nodeObj);
            if (nodeId) {
              this._nodes.delete(nodeId);
              console.log(`[NodosClient] Function node removed: ${nodeId}`);
              this._emit('nodeRemoved', { nodeId });
            }
          }
          
          // Emit total node count
          this._emit('nodesUpdated', { count: this._nodes.size, nodes: Array.from(this._nodes.values()) });
        }
        break;
      }
      
      case EngineEventUnion.BatchEngineEvent: {
        const event = engineEvent.event(new BatchEngineEvent());
        if (event) {
          console.log(`[NodosClient] BatchEngineEvent with ${event.eventsLength()} nested events`);
          for (let i = 0; i < event.eventsLength(); i++) {
            const nestedEvent = event.events(i, new EngineEvent());
            if (nestedEvent) {
              console.log(`[NodosClient] Processing nested event type: ${nestedEvent.eventType()}`);
              this._handleEngineEvent(nestedEvent);
            }
          }
        }
        break;
      }
      
      case EngineEventUnion.NodeImported: {
        const event = engineEvent.event(new NodeImported());
        if (event) {
          const nodeObj = event.node();
          if (nodeObj) {
            const nodeInfo = this._storeNodeTree(nodeObj);
            if (nodeInfo) {
              console.log(`[NodosClient] Node imported: ${nodeInfo.name} (${nodeInfo.className}) - ID: ${nodeInfo.id}`);
              this._emit('nodesUpdated', { count: this._nodes.size, nodes: Array.from(this._nodes.values()) });
            }
          }
        }
        break;
      }
      
      default:
        console.log(`[NodosClient] Unknown EngineEvent type: ${eventType}`);
    }
  }

  /**
   * Emit an event to listeners
   */
  _emit(event, data) {
    const listeners = this.eventListeners.get(event) || [];
    listeners.forEach(listener => listener(data));
  }

  /**
   * Listen for events from Nodos
   */
  on(event, listener) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(listener);
    return this;
  }

  /**
   * Remove an event listener
   */
  off(event, listener) {
    const listeners = this.eventListeners.get(event) || [];
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
    return this;
  }

  /**
   * Establish connection to the Nodos App service via bidirectional streaming
   */
  connect() {
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('connected', onConnected);
      };
      const fail = (error) => {
        cleanup();
        this.connected = false;
        reject(error);
      };
      const onConnected = () => {
        cleanup();
        resolve(this);
      };
      this.on('connected', onConnected);
      try {
        const address = `${this.host}:${this.port}`;
        const AppService = grpc.makeGenericClientConstructor({
          Connect: {
            path: '/nos.app.AppService/Connect',
            requestStream: true,
            responseStream: true,
            requestSerialize: (appEvent) => Buffer.from(appEvent),
            responseDeserialize: (buffer) => this._deserializeEngineEvent(buffer),
          },
        });
        this.channel = new AppService(address, grpc.credentials.createInsecure());
        this.call = this.channel.Connect();
        this.call.on('data', (event) => {
          try {
            this._handleEngineEvent(event);
          } catch (error) {
            fail(error);
            this.call?.cancel();
            this.channel?.close();
          }
        });
        this.call.on('error', (error) => {
          console.error('[NodosClient] Stream error:', error.message);
          fail(error);
          this.channel?.close();
        });
        this.call.on('end', () => {
          fail(new Error('AppService stream ended'));
          this.channel?.close();
        });
        timeout = setTimeout(() => {
          fail(new Error(`AppService did not confirm connection at ${address}`));
          this.call?.cancel();
          this.channel?.close();
        }, 5000);
        this.call.write(this._createConnectionRequest());
      } catch (error) {
        fail(error);
        this.call?.cancel();
        this.channel?.close();
      }
    });
  }

  /**
   * Set a pin value on a node
   * @param {string} pinIdHex - The pin ID as a hex string (with or without dashes)
   * @param {any} value - The value to set
   * @param {string} type - The type of the value: 'vec3', 'double', 'string', 'bool'
   * @param {string} pinName - Optional pin name for lookup
   * @returns {Promise<Object>} Status response
   */
  setPinValue(pinIdHex, value, type = 'double', pinName = null) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.call) {
        return reject(new Error('Not connected to Nodos'));
      }

      try {
        const appEvent = this._createSetPinValueMessage(pinIdHex, value, type);
        this.call.write(appEvent);
        this._pinValueStore.set(pinIdHex, { value, type });
        if (pinName) {
          this._pinNameStore.set(pinName, pinIdHex);
        }
        resolve({ success: true, pinId: pinIdHex, value, type });
      } catch (error) {
        console.error('[NodosClient] setPinValue error:', error.message);
        reject(error);
      }
    });
  }

  /**
   * Get the last known value for a pin
   */
  getPinValue(pinIdHex) {
    const stored = this._pinValueStore.get(pinIdHex);
    if (stored) {
      return { ...stored };
    }
    return null;
  }

  /**
   * Get the last known value for a pin by pin name
   */
  getPinValueByName(pinName) {
    const pinIdHex = pinNameToUUID(pinName);
    return this.getPinValue(pinIdHex);
  }

  /**
   * Get all stored pin values
   */
  getAllPinValues() {
    return this._pinValueStore.entries();
  }

  /**
   * Get the pin name for a pin ID
   */
  getPinName(pinIdHex) {
    for (const [pinName, id] of this._pinNameStore.entries()) {
      if (id === pinIdHex) {
        return pinName;
      }
    }
    return null;
  }

  /**
   * Mark a pin as dirty (needs recomputation)
   */
  pinDirtied(pinIdHex) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.call) {
        return reject(new Error('Not connected to Nodos'));
      }

      try {
        const appEvent = this._createPinDirtiedMessage(pinIdHex);
        this.call.write(appEvent);
        resolve({ success: true, pinId: pinIdHex });
      } catch (error) {
        console.error('[NodosClient] pinDirtied error:', error.message);
        reject(error);
      }
    });
  }

  /**
   * Check if connected to Nodos
   */
  isConnected() {
    return this.connected && this.call !== null;
  }

  /**
   * Get all discovered nodes
   * @returns {Array} Array of node objects
   */
  getNodes() {
    return Array.from(this._nodes.values());
  }

  /**
   * Get a specific node by ID
   * @param {string} nodeId - The node ID (hex string)
   * @returns {Object|null} Node info or null
   */
  getNodeById(nodeId) {
    return this._nodes.get(normalizeUUID(nodeId) || nodeId) || null;
  }

  /**
   * Get a specific node by name
   * @param {string} name - The node name
   * @returns {Object|null} Node info or null
   */
  getNodeByName(name) {
    for (const node of this._nodes.values()) {
      if (node.name === name || node.displayName === name) {
        return node;
      }
    }
    return null;
  }

  /**
   * Search nodes by className
   * @param {string} className - The node class name (e.g., 'double', 'string', 'bool', 'location')
   * @returns {Array} Array of matching nodes
   */
  getNodesByClassName(className) {
    return Array.from(this._nodes.values()).filter(
      node => node.className.toLowerCase() === className.toLowerCase()
    );
  }

  /**
   * Disconnect from Nodos
   */
  disconnect() {
    // Detach first: end/close can trigger stream callbacks synchronously or later.
    const call = this.call;
    const channel = this.channel;
    this.call = null;
    this.channel = null;
    this.connected = false;
    call?.end();
    channel?.close();
    console.log('[NodosClient] Disconnected from Nodos');
  }
}

export { NodosClient, UUID };
