/** Minimal EditorService codec, following sdk/types/EditorEvents.fbs.
 * The bundled generated SDK contains AppService bindings only. Keep field
 * indexes and union tags aligned with that schema when upgrading the SDK.
 */
import * as flatbuffers from 'flatbuffers';

export const EditorEvent = Object.freeze({
  ClientConnected: 1,
  NodeCreated: 2,
  NodeDeleted: 3,
  ServerStatus: 6,
  EditorPinValueChanged: 7,
  PinsWithChangedValues: 17,
  PinCreated: 28,
  PinDeleted: 30,
  BatchEvent: 15,
  FunctionCreated: 29,
  EditorPartialItemUpdate: 33,
});

export class EditorTable {
  __init(position, bb) {
    this.position = position;
    this.bb = bb;
    return this;
  }

  field(index) {
    const offset = this.bb.__offset(this.position, 4 + index * 2);
    return offset ? this.position + offset : 0;
  }

  table(index, target = new EditorTable()) {
    const field = this.field(index);
    return field ? target.__init(this.bb.__indirect(field), this.bb) : null;
  }

  string(index) {
    const field = this.field(index);
    return field ? this.bb.__string(field) : null;
  }

  uint8(index) {
    const field = this.field(index);
    return field ? this.bb.readUint8(field) : 0;
  }

  bytes(index) {
    const field = this.field(index);
    if (!field) return null;
    const start = this.bb.__vector(field);
    return this.bb.bytes().subarray(start, start + this.bb.__vector_len(field));
  }

  strings(index) {
    const field = this.field(index);
    if (!field) return [];
    const start = this.bb.__vector(field);
    return Array.from({ length: this.bb.__vector_len(field) }, (_, i) => this.bb.__string(start + i * 4));
  }

  tables(index) {
    const field = this.field(index);
    if (!field) return [];
    const start = this.bb.__vector(field);
    return Array.from({ length: this.bb.__vector_len(field) }, (_, i) =>
      new EditorTable().__init(this.bb.__indirect(start + i * 4), this.bb));
  }
}

export function decodeEditorEvent(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  return new EditorTable().__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

export function createEditorConnectionRequest(clientName, frequency = 30) {
  const builder = new flatbuffers.Builder(256);
  const name = builder.createString(clientName);
  // ConnectionRequest { client_name:string; pin_value_update_frequency:float; }
  builder.startObject(2);
  builder.addFieldOffset(0, name, 0);
  builder.addFieldFloat32(1, frequency, 0);
  const request = builder.endObject();
  // FromEditor { event:FromEditorUnion; request_id:UUID; }
  builder.startObject(3);
  builder.addFieldInt8(0, 3, 0); // FromEditorUnion.ConnectionRequest
  builder.addFieldOffset(1, request, 0);
  builder.finish(builder.endObject());
  return builder.asUint8Array();
}

/** EditorPinValueChanged (FromEditorUnion tag 2), optionally batched. */
export function createEditorPinUpdates(updates) {
  return createEditorRequests(updates.map(update => ({ ...update, type: 2 })));
}

export function createEditorWatchRequests(watch, unwatch = []) {
  return createEditorRequests([
    ...unwatch.map(path => ({ path, type: 32 })),
    ...watch.map(path => ({ path, type: 31 })),
  ]);
}

function createEditorRequests(updates) {
  const b = new flatbuffers.Builder(512);
  const events = updates.map(({ path, bytes, type }) => {
    const pinPath = b.createString(path);
    let value = 0;
    if (bytes) {
      b.startVector(1, bytes.length, 1);
      for (let i = bytes.length - 1; i >= 0; i--) b.addInt8(bytes[i]);
      value = b.endVector();
    }
    b.startObject(bytes ? 2 : 1);
    b.addFieldOffset(0, pinPath, 0);
    if (bytes) b.addFieldOffset(1, value, 0);
    const event = b.endObject();
    b.startObject(3);
    b.addFieldInt8(0, type, 0);
    b.addFieldOffset(1, event, 0);
    return b.endObject();
  });
  let root = events[0];
  if (events.length > 1) {
    b.startVector(4, events.length, 4);
    for (let i = events.length - 1; i >= 0; i--) b.addOffset(events[i]);
    const requests = b.endVector();
    b.startObject(1);
    b.addFieldOffset(0, requests, 0);
    const batch = b.endObject();
    b.startObject(3);
    b.addFieldInt8(0, 26, 0); // FromEditorUnion.BatchRequest
    b.addFieldOffset(1, batch, 0);
    root = b.endObject();
  }
  b.finish(root);
  return b.asUint8Array();
}
