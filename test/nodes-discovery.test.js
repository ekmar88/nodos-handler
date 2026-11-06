import test from 'node:test';
import assert from 'node:assert/strict';
import * as flatbuffers from 'flatbuffers';
import { NodosClient, UUID } from '../src/lib/nodos-client.js';
import { Node } from '../sdk/generated/js/nos/fb/node.js';
import { Graph } from '../sdk/generated/js/nos/fb/graph.js';
import { NodeContents } from '../sdk/generated/js/nos/fb/node-contents.js';
import { EngineEvent } from '../sdk/generated/js/nos/app/engine-event.js';
import { EngineEventUnion } from '../sdk/generated/js/nos/app/engine-event-union.js';
import { NodeImported } from '../sdk/generated/js/nos/app/node-imported.js';
import { PartialNodeUpdate } from '../sdk/generated/js/nos/partial-node-update.js';

function node(builder, id, children = [], functions = []) {
  const name = builder.createString(`node-${id}`);
  const functionsOffset = Node.createFunctionsVector(builder, functions);
  const nodes = Graph.createNodesVector(builder, children);
  Graph.startGraph(builder);
  Graph.addNodes(builder, nodes);
  const graph = Graph.endGraph(builder);
  Node.startNode(builder);
  Node.addName(builder, name);
  Node.addFunctions(builder, functionsOffset);
  Node.addContentsType(builder, NodeContents.Graph);
  Node.addContents(builder, graph);
  Node.addId(builder, UUID.createUUID(builder, new Uint8Array(16).fill(id)));
  return Node.endNode(builder);
}

for (const type of ['import', 'partial', 'function']) {
  test(`${type} discovers nested graphs and functions without duplicating IDs`, () => {
    const builder = new flatbuffers.Builder(1024);
    const leaf = node(builder, 3);
    const child = node(builder, 2, [leaf]);
    const fn = node(builder, 4);
    const root = node(builder, 1, [child], [fn]);
    let event, eventType;
    if (type === 'import') {
      event = NodeImported.createNodeImported(builder, root);
      eventType = EngineEventUnion.NodeImported;
    } else {
      const vector = type === 'partial'
        ? PartialNodeUpdate.createNodesToAddVector(builder, [root])
        : PartialNodeUpdate.createFunctionsToAddVector(builder, [root]);
      PartialNodeUpdate.startPartialNodeUpdate(builder);
      if (type === 'partial') PartialNodeUpdate.addNodesToAdd(builder, vector);
      else PartialNodeUpdate.addFunctionsToAdd(builder, vector);
      event = PartialNodeUpdate.endPartialNodeUpdate(builder);
      eventType = EngineEventUnion.nos_PartialNodeUpdate;
    }
    EngineEvent.startEngineEvent(builder);
    EngineEvent.addEventType(builder, eventType);
    EngineEvent.addEvent(builder, event);
    builder.finish(EngineEvent.endEngineEvent(builder));
    const client = new NodosClient();
    const decoded = client._deserializeEngineEvent(builder.asUint8Array());
    client._handleEngineEvent(decoded);
    client._handleEngineEvent(decoded);
    const response = { count: client.getNodes().length, nodes: client.getNodes() };
    assert.equal(response.count, 4);
    assert.deepEqual(response.nodes.map(n => n.name).sort(), ['node-1', 'node-2', 'node-3', 'node-4']);
  });
}
