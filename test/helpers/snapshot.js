import * as flatbuffers from 'flatbuffers';
import { Node } from '../../sdk/generated/js/nos/fb/node.js';
import { Graph } from '../../sdk/generated/js/nos/fb/graph.js';
import { UUID } from '../../sdk/generated/js/nos/fb/uuid.js';
import { NodeContents } from '../../sdk/generated/js/nos/fb/node-contents.js';

function table(b, fields, offsets, type) {
  b.startObject(fields);
  for (const [i, value] of Object.entries(offsets)) b.addFieldOffset(Number(i), value, 0);
  if (type !== undefined) b.addFieldInt8(0, type, 0);
  return b.endObject();
}

/** EditorService ClientConnected message whose mother graph holds one node "Make". */
export function snapshotBytes() {
  const b = new flatbuffers.Builder(256);
  const name = b.createString('Make');
  Node.startNode(b);
  Node.addName(b, name);
  Node.addId(b, UUID.createUUID(b, new Uint8Array(16).fill(0x11)));
  const nodes = Graph.createNodesVector(b, [Node.endNode(b)]);
  const graph = table(b, 4, { 0: nodes });
  Node.startNode(b);
  Node.addContentsType(b, NodeContents.Graph);
  Node.addContents(b, graph);
  const root = Node.endNode(b);
  const status = table(b, 11, { 4: root });
  const connected = table(b, 5, { 1: status });
  b.finish(table(b, 3, { 1: connected }, 1));
  return b.asUint8Array();
}
