# Nodos Backend API

Express.js backend that communicates with [Nodos](https://nodos.dev/) via gRPC to control node properties in a running Nodos instance.

## Architecture

```
nodos-backend/
├── config/
│   └── default.js          # Configuration (Nodos address, server port)
├── proto/
│   └── nodos_app.proto     # gRPC service definitions for Nodos App Service
├── src/
│   ├── app.js              # Express application entry point
│   ├── controllers/
│   │   └── nodes.controller.js   # Business logic for node operations
│   ├── lib/
│   │   └── nodos-client.js       # gRPC client for Nodos communication
│   ├── middlewares/
│   │   └── index.js                # Request logging, error handling
│   ├── models/
│   │   └── nodos-nodes.js          # Node type models (Location, Double, String, Bool)
│   └── routes/
│       └── index.js                # API route definitions
├── .gitignore
├── package.json
└── README.md
```

## Supported Node Types

| Type | Display Name | Description | Pins |
|------|-------------|-------------|------|
| `location` | Location | 3D vector (vec3) | `x`, `y`, `z` (double) |
| `double` | Double | Floating point value | `value` (double) |
| `string` | String | Text value | `value` (string) |
| `bool` | Bool | Boolean value | `value` (bool) |

## Prerequisites

- **Node.js** 20.12 or later 
- **Nodos** running (nodos.exe on Windows)

## Installation

```bash
# Install dependencies
npm install

# (Optional) Generate gRPC stubs from proto file
# Requires: grpc-tools
# npm install -g grpc-tools
# npm run proto:generate
```

## Configuration

The `.env` file is optional when using the default values or environment variables.
To keep machine-specific settings local, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set `NODOS_HOST` in `.env` to the address of the machine running Nodos. For
WSL connecting to a Windows-hosted engine, use the host address reachable from
your WSL instance. `.env` is ignored by Git; do not commit actual host addresses
or credentials. The app loads the file at startup, and variables already set in
the environment take precedence. Restart the backend after editing it.

Available settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODOS_HOST` | `127.0.0.1` | Nodos engine host |
| `NODOS_PORT` | `50053` | Nodos App service port |
| `NODOS_EDITOR_PORT` | `50052` | Nodos Editor service port (graph discovery) |
| `NODOS_APP_KEY` | `nodos-backend-app` | Application identifier |
| `NODOS_APP_NAME` | `Nodos Backend Controller` | Display name in Nodos |
| `PORT` | `3000` | Express server port |
| `HOST` | `127.0.0.1` | Express server bind address |

Graph discovery uses `/nos.editor.EditorService/Connect` on port `50052`.
The App service on `50053` integrates a process as its own node; it does not
provide the complete graph. Changing `NODOS_PORT` to `50052` is insufficient,
because the two services use different protocols.

`GET /api/nodes` requests a fresh `ServerStatus.mother_graph` snapshot from
EditorService for each read. Concurrent reads share an in-flight snapshot. It includes nested graph nodes and functions, excluding the
mother graph container and the registered node class catalogue. Until a graph
snapshot arrives, or after disconnection, graph reads return HTTP `503`.
`GET /api/nodes/status` exposes `graph_connected`, `graph_ready`,
`editor_address`, and `graph_error` for diagnosis. `graph_paths` additionally
shows observed engine paths and whether each pin path comes from an engine
event or is inferred from snapshot names. Unambiguous engine-supplied paths
are preserved verbatim for watches and writes across snapshot refreshes.
For unresolved paths, read-only watches test relative, root-qualified, and UUID
addresses. A write waits up to two seconds for the engine to report a matching,
unambiguous pin path; otherwise it returns `503` without sending a mutation.
`graph_paths.engine_version` and `root_name` aid SDK/path diagnosis.
If a write is not confirmed, change that pin manually once and inspect
`GET /api/nodes/status` to verify the path reported by the engine.

For a remote engine or WSL, `NODOS_HOST` must point to the machine running
Nodos, and its Editor service must be reachable on `NODOS_EDITOR_PORT`.
After changing these settings, restart the backend. This client does not
reconnect automatically after a stream failure.

The API binds to loopback by default. Set `HOST=0.0.0.0` only when it must be
reachable from other machines and access is restricted appropriately: the API
does not currently authenticate callers and permits cross-origin requests.

## Running

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## API Endpoints

### Health Check
```
GET /health
```

### Nodos Connection Status
```
GET /api/nodes/status
```

### List and inspect nodes

```text
GET /api/nodes
GET /api/nodes/:nodeId
GET /api/nodes/class/:className
```

Copy a node's `id` from the list response. `GET /api/nodes/:nodeId` returns
its metadata and actual pins, including `id`, `name`, `typeName`, `readOnly`,
and `value` when Nodos has supplied a supported value. UUID matching accepts
uppercase letters and omitted hyphens. Unique node names are also accepted;
ambiguous names return `409` and require a UUID.

### Update a pin or property

```text
POST /api/nodes/:nodeId/pin/:pinId
```

Use the actual pin UUID from the node response, or its unique name. Properties
are pins too. The declared `typeName` determines the wire format; there is no
`:type` URL segment and the backend never generates a pin UUID.

```bash
curl http://localhost:3000/api/nodes/YOUR_NODE_UUID

curl -X POST http://localhost:3000/api/nodes/YOUR_NODE_UUID/pin/YOUR_PIN_UUID \
  -H 'Content-Type: application/json' \
  -d '{"value": 42.0}'
```

For `bool`, use JSON `true` or `false`; for `string`, use a JSON string.
Vectors require every component, e.g. `{"value":{"x":1,"y":2,"z":3}}`
for `nos.fb.vec3`. An individual pin named `x` is encoded using its declared
scalar type, rather than being treated as an entire vector. The backend supports
FlatBuffers scalars and the `vec2`, `vec3`, `vec4` families declared in
`Builtins.fbs`. Complex/resource types return `422`. Send 64-bit integers as
decimal strings when they exceed JavaScript's safe integer range.

Writes use EditorService, read the values back from Nodos, and return HTTP
`200` only when the engine reports the requested values, for example:

```json
{
  "success": true,
  "message": "Pin update confirmed by Nodos",
  "node_id": "actual-node-uuid",
  "pin_id": "actual-pin-uuid",
  "pin": "value",
  "value": 42,
  "type": "double",
  "status": "confirmed"
}
```

`confirmed` means an engine readback matched the requested value. If the
engine does not report the change, the API returns `502` with the actual value
rather than reporting a successful stream submission. Multi-pin writes are not
transactional: a failed confirmation does not roll back pins already changed.

Read the current engine value with:

```text
GET /api/nodes/:nodeId/pin/:pinId/current-value
```

List, node, class, and current-value reads request a new engine snapshot and
return `Cache-Control: no-store`. If the snapshot cannot be obtained, they
return `503` rather than serving old cached values. A missing/unsupported pin
value returns `404` from the current-value endpoint.

The persistent connection also subscribes with `WatchPin` to each pin at a
nonzero update frequency. Watches follow additions, deletions, and renames.
Only snapshots and value events received from Nodos change the stored values;
a write request never substitutes its desired value for the engine's value.
A new gRPC connection per fresh read has a latency/connection cost; this is
intentional so HTTP reads do not depend solely on asynchronous notifications.

### Update multiple pins

```text
POST /api/nodes/:nodeId/pins
```

Body: `{"pins":{"YOUR_PIN_UUID":42,"enabled":true}}`.
The backend validates every pin before sending one Editor `BatchRequest`.
The engine processes that batch; the API does not promise transactional rollback.

Invalid values return `400`, absent nodes/pins return `404`, ambiguous names
or read-only pins return `409`, unsupported types return `422`, and unavailable
graph connections return `503`.

### Mark an application pin dirty

```text
POST /api/nodes/:nodeId/dirty
```

Body: `{"pin":"YOUR_PIN_UUID"}`. This separate operation uses AppService
and requires its connection; it is not needed for ordinary Editor pin writes.

## Nodos setup

Start Nodos and make its Editor service reachable at `NODOS_HOST:50052`.
If needed, override the address at launch:

```bash
nosLauncher --override-settings connection_settings/node_graph_service_address="0.0.0.0:50052"
```

AppService uses port `50053` separately. Graph reads and ordinary pin writes
use EditorService and can work without an AppService connection.

## Development

```bash
# Install dev dependencies
npm install

# Run with nodemon (auto-reload)
npm run dev

# Lint (add your linter)
# npm run lint
```

## License

No project license has been specified. Verify redistribution rights for the bundled Nodos SDK schemas and generated files before publishing.

## Tests

```bash
npm test
```

Tests use FlatBuffers snapshots and simulated gRPC streams; a running Nodos engine is not required.
