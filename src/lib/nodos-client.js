/**
 * Nodos AppService client (default port 50053).
 *
 * AppService connects this process to Nodos as an *application*. It does not
 * expose the full graph (see NodosGraphClient for that); it is used here for
 * PinDirtied and to observe nodes owned by this app.
 */
import grpc from '@grpc/grpc-js';
import * as flatbuffers from 'flatbuffers';
import { EventEmitter } from 'node:events';
import config from '../../config/default.js';
import logger from './logger.js';
import { normalizeUUID } from './pin-values.js';
import { uuidToHex, uuidHexToBytes, extractNodeInfo } from './fb-extract.js';

import { AppEvent } from '../../sdk/generated/js/nos/app/app-event.js';
import { AppEventUnion } from '../../sdk/generated/js/nos/app/app-event-union.js';
import { AppConnectionRequest } from '../../sdk/generated/js/nos/app/app-connection-request.js';
import { PinDirtied } from '../../sdk/generated/js/nos/app/pin-dirtied.js';
import { EngineEvent } from '../../sdk/generated/js/nos/app/engine-event.js';
import { EngineEventUnion } from '../../sdk/generated/js/nos/app/engine-event-union.js';
import { AppConnectedEvent } from '../../sdk/generated/js/nos/app/app-connected-event.js';
import { AppPinValueChanged } from '../../sdk/generated/js/nos/app/app-pin-value-changed.js';
import { StateChanged } from '../../sdk/generated/js/nos/app/state-changed.js';
import { PartialNodeUpdate } from '../../sdk/generated/js/nos/partial-node-update.js';
import { BatchEngineEvent } from '../../sdk/generated/js/nos/app/batch-engine-event.js';
import { NodeImported } from '../../sdk/generated/js/nos/app/node-imported.js';
import { UUID } from '../../sdk/generated/js/nos/fb/uuid.js';
import { SemVer } from '../../sdk/generated/js/nos/fb/sem-ver.js';
import { Node } from '../../sdk/generated/js/nos/fb/node.js';
import { Graph } from '../../sdk/generated/js/nos/fb/graph.js';
import { NodeContents } from '../../sdk/generated/js/nos/fb/node-contents.js';

const log = logger.child('AppService');
const CONNECT_TIMEOUT_MS = 5000;

class NodosClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.host = options.host || config.nodos.host;
    this.port = options.port || config.nodos.port;
    this.appKey = options.appKey || config.nodos.appKey;
    this.appName = options.appName || config.nodos.appName;
    this.channel = null;
    this.call = null;
    this.connected = false;
    this.lastError = null;
    this.engineProcessId = null;
    this._nodes = new Map();
  }

  _createConnectionRequest() {
    const builder = new flatbuffers.Builder(1024);
    const appKey = builder.createString(this.appKey);
    const appName = builder.createString(this.appName);
    AppConnectionRequest.startAppConnectionRequest(builder);
    AppConnectionRequest.addAppKey(builder, appKey);
    AppConnectionRequest.addAppName(builder, appName);
    AppConnectionRequest.addUsedApiVersion(builder, SemVer.createSemVer(builder, 1, 3, 3));
    AppConnectionRequest.addAppProcessId(builder, BigInt(process.pid));
    const request = AppConnectionRequest.endAppConnectionRequest(builder);
    return this._finishAppEvent(builder, AppEventUnion.AppConnectionRequest, request);
  }

  _createPinDirtiedMessage(pinIdHex) {
    const builder = new flatbuffers.Builder(256);
    const event = PinDirtied.createPinDirtied(builder, UUID.createUUID(builder, uuidHexToBytes(pinIdHex)), 0n);
    return this._finishAppEvent(builder, AppEventUnion.PinDirtied, event);
  }

  _finishAppEvent(builder, type, event) {
    AppEvent.startAppEvent(builder);
    AppEvent.addEventType(builder, type);
    AppEvent.addEvent(builder, event);
    builder.finish(AppEvent.endAppEvent(builder));
    return builder.asUint8Array();
  }

  _deserializeEngineEvent(buffer) {
    const bb = new flatbuffers.ByteBuffer(buffer);
    return new EngineEvent().__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }

  /** Register a node and every node nested in its graph or functions. */
  _storeNodeTree(node) {
    const info = extractNodeInfo(node);
    if (!info) return null;
    this._nodes.set(info.id, info);
    if (node.contentsType() === NodeContents.Graph) {
      const graph = node.contents(new Graph());
      for (let i = 0; graph && i < graph.nodesLength(); i++) this._storeNodeTree(graph.nodes(i, new Node()));
    }
    for (let i = 0; i < node.functionsLength(); i++) this._storeNodeTree(node.functions(i, new Node()));
    return info;
  }

  _handleEngineEvent(engineEvent) {
    const type = engineEvent.eventType();
    switch (type) {
      case EngineEventUnion.AppConnectedEvent: {
        const event = engineEvent.event(new AppConnectedEvent());
        if (!event) break;
        this.connected = true;
        this.lastError = null;
        this.engineProcessId = event.engineProcessId();
        this.emit('connected', { engineProcessId: this.engineProcessId });
        break;
      }
      case EngineEventUnion.AppPinValueChanged: {
        const event = engineEvent.event(new AppPinValueChanged());
        if (event) this.emit('pinValueChanged', { pinId: uuidToHex(event.pinId()), value: event.valueArray() });
        break;
      }
      case EngineEventUnion.StateChanged: {
        const event = engineEvent.event(new StateChanged());
        if (event) this.emit('stateChanged', { state: event.state() });
        break;
      }
      case EngineEventUnion.nos_PartialNodeUpdate: {
        const event = engineEvent.event(new PartialNodeUpdate());
        if (!event) break;
        for (let i = 0; i < event.nodesToAddLength(); i++) this._storeNodeTree(event.nodesToAdd(i, new Node()));
        for (let i = 0; i < event.functionsToAddLength(); i++) this._storeNodeTree(event.functionsToAdd(i, new Node()));
        for (let i = 0; i < event.nodesToDeleteLength(); i++) this._nodes.delete(uuidToHex(event.nodesToDelete(i, new UUID())));
        for (let i = 0; i < event.functionsToDeleteLength(); i++) this._nodes.delete(uuidToHex(event.functionsToDelete(i, new UUID())));
        this.emit('nodesUpdated', { count: this._nodes.size });
        break;
      }
      case EngineEventUnion.BatchEngineEvent: {
        const event = engineEvent.event(new BatchEngineEvent());
        for (let i = 0; event && i < event.eventsLength(); i++) {
          const nested = event.events(i, new EngineEvent());
          if (nested) this._handleEngineEvent(nested);
        }
        break;
      }
      case EngineEventUnion.NodeImported: {
        const node = engineEvent.event(new NodeImported())?.node();
        if (node && this._storeNodeTree(node)) this.emit('nodesUpdated', { count: this._nodes.size });
        break;
      }
      default:
        log.debug(`Unhandled EngineEvent type ${type}`);
    }
  }

  /** Open the bidirectional stream; resolves once the engine acknowledges. */
  connect() {
    this._closeStream();
    return new Promise((resolve, reject) => {
      const address = `${this.host}:${this.port}`;
      let settled = false;
      let call = null;
      let channel = null;
      const timeout = setTimeout(() => {
        fail(new Error(`AppService did not confirm connection at ${address}`));
      }, CONNECT_TIMEOUT_MS);

      const fail = (error) => {
        if (call && this.call !== call) return; // Event from a replaced stream.
        clearTimeout(timeout);
        this.off('connected', onConnected);
        const wasConnected = settled;
        this.connected = false;
        this.lastError = error.message;
        this.call = null;
        this.channel = null;
        call?.cancel?.();
        channel?.close?.();
        if (!settled) {
          settled = true;
          reject(error);
        } else if (wasConnected) {
          this.emit('disconnected', { error: error.message });
        }
      };

      const onConnected = () => {
        this.off('connected', onConnected);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(this);
      };
      this.on('connected', onConnected);

      try {
        const AppService = grpc.makeGenericClientConstructor({
          Connect: {
            path: '/nos.app.AppService/Connect',
            requestStream: true,
            responseStream: true,
            requestSerialize: (bytes) => Buffer.from(bytes),
            responseDeserialize: (buffer) => this._deserializeEngineEvent(buffer),
          },
        });
        channel = this.channel = new AppService(address, grpc.credentials.createInsecure());
        call = this.call = channel.Connect();
        call.on('data', (event) => {
          if (this.call !== call) return;
          try {
            this._handleEngineEvent(event);
          } catch (error) {
            fail(error);
          }
        });
        call.on('error', (error) => fail(error));
        call.on('end', () => fail(new Error('AppService stream ended')));
        call.write(this._createConnectionRequest());
      } catch (error) {
        fail(error);
      }
    });
  }

  /** Mark a pin as dirty (needs recomputation). */
  pinDirtied(pinIdHex) {
    if (!this.isConnected()) return Promise.reject(new Error('Not connected to Nodos AppService'));
    return new Promise((resolve, reject) => {
      this.call.write(this._createPinDirtiedMessage(pinIdHex), (error) => {
        if (error) reject(error);
        else resolve({ success: true, pinId: pinIdHex });
      });
    });
  }

  isConnected() {
    return this.connected && this.call !== null;
  }

  getNodes() {
    return Array.from(this._nodes.values());
  }

  getNodeById(nodeId) {
    return this._nodes.get(normalizeUUID(nodeId) || nodeId) || null;
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
}

export { NodosClient, UUID };
