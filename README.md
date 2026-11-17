# Nodos Backend API

Express backend to browse and control a running [Nodos](https://nodos.dev/)
instance: list nodes, read pin/property values, change them, and receive
changes in real time. It talks to Nodos over gRPC with FlatBuffers messages.

## Architecture

```
config/default.js                 Configuration (env vars / .env)
public/index.html                 Web control panel (served at /panel/)
scripts/probe-ports.js            Diagnostic: probe Nodos service ports
src/
├── app.js                        Entry point: clients, reconnection, HTTP server
├── create-app.js                 Express app factory (used by tests too)
├── controllers/
│   ├── nodes.controller.js       Node/pin reads and writes
│   └── events.controller.js      Server-Sent Events stream
├── lib/
│   ├── nodos-graph-client.js     EditorService client (graph, values, writes)
│   ├── nodos-client.js           AppService client (PinDirtied)
│   ├── editor-protocol.js        EditorService FlatBuffers codec
│   ├── pin-values.js             Pin value encoding/decoding/merging
│   ├── fb-extract.js             FlatBuffers Node/Pin -> plain objects
│   ├── reconnect.js              Automatic reconnection with backoff
│   └── logger.js                 Leveled logger (LOG_LEVEL)
├── middlewares/index.js          Logging, JSON, CORS, API key, errors
└── routes/index.js               Route table
sdk/                              Nodos SDK schemas (.fbs) and generated JS
test/                             node:test suites (no running Nodos needed)
```

### How it talks to Nodos

| Service | Port | Used for |
|---------|------|----------|
| EditorService (`/nos.editor.EditorService/Connect`) | 50052 | Graph snapshot, structural events, `WatchPin` values, pin writes |
| AppService (`/nos.app.AppService/Connect`) | 50053 | `PinDirtied` only (optional) |

The backend keeps **one persistent EditorService stream** open:

1. On connect, Nodos sends a `ServerStatus` snapshot with the whole graph
   (`mother_graph`), including nested graphs and functions.
2. Node created/deleted/renamed and pin created/deleted/changed events keep
   that graph current.
3. Every pin is subscribed with `WatchPin`, so value changes arrive as events.

Reads (`GET`) are served from that live state, so they are fast and do not
open new connections. A new snapshot (a short-lived second stream) is fetched
only when:

- Nodos reported that a value changed but the new value has not arrived yet;
- the request asks for it with `?fresh=true` (or `NODOS_READ_MODE=fresh`);
- the background resync runs (`NODOS_RESYNC_MS`, default 10 s), which
  covers any missed events;
- a write needs confirmation and the watched value event did not arrive.

If Nodos stops or restarts, both connections **reconnect automatically**
with exponential backoff. Meanwhile, graph endpoints answer `503`.

## Prerequisites

- **Node.js** 20.12 or later
- **Nodos** running, with its EditorService reachable on `NODOS_HOST:50052`

## Installation and running

```bash
npm install
cp .env.example .env   # optional; adjust NODOS_HOST etc.
npm start              # or: npm run dev (auto-reload)
```

Open the control panel at <http://localhost:3000/panel/>.

## Configuration

Variables already set in the environment take precedence over `.env`.
`.env` is git-ignored; do not commit real host addresses or keys.

| Variable | Default | Description |
|----------|---------|-------------|
| `NODOS_HOST` | `127.0.0.1` | Machine running Nodos (for WSL, the Windows host address) |
| `NODOS_EDITOR_PORT` | `50052` | EditorService port |
| `NODOS_PORT` | `50053` | AppService port |
| `NODOS_APP_SERVICE` | `true` | Set `false` to skip the AppService connection |
| `NODOS_APP_KEY` / `NODOS_APP_NAME` | | Identity shown in Nodos |
| `NODOS_READ_MODE` | `cache` | `cache` (live stream) or `fresh` (snapshot per read) |
| `NODOS_RESYNC_MS` | `10000` | Background resync interval; `0` disables |
| `NODOS_RECONNECT_MIN_MS` / `_MAX_MS` | `1000` / `30000` | Reconnection backoff |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | HTTP bind address |
| `API_KEY` | *(empty)* | When set, `/api/*` requires `X-API-Key` (or `?api_key=`) |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` value |
| `LOG_LEVEL` | `info` | `debug` shows engine pin paths and unhandled events |

If Nodos uses a different address, override it at launch:

```bash
nosLauncher --override-settings connection_settings/node_graph_service_address="0.0.0.0:50052"
```

**Security:** the API binds to loopback by default. If you set
`HOST=0.0.0.0`, also set `API_KEY`, because anyone who can reach the API can
change pins.

## API

Nodes and pins can be referenced by UUID (any case, hyphens optional), by
unique name/display name, or nodes by their path (URL-encoded, e.g.
`%2FGroup.Transform`). Ambiguous names return `409`.

### Reading

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness; includes `graph_ready` |
| `GET /api/status` | Connection state and path diagnostics (also `/api/nodes/status`) |
| `GET /api/nodes` | All nodes with pins. Filters: `name` (substring), `class`, `path` (prefix), `pins=false` (summary only), `fresh=true` |
| `GET /api/graph` | Nodes as a nested tree (no pins) |
| `GET /api/nodes/:nodeId` | One node with its pins |
| `GET /api/nodes/class/:className` | Nodes of one class |
| `GET /api/nodes/:nodeId/pins/:pinId` | One pin: metadata and value |
| `GET /api/nodes/:nodeId/pin/:pinId/current-value` | Just the value (`404` if not decodable) |

Each node includes `id`, `name`, `displayName`, `className`, `path` and
`parentId`. Each pin includes `id`, `name`, `typeName`, `readOnly`,
`editable`, `valueKind` (how to send its value) and `value` when known.

```bash
curl "http://localhost:3000/api/nodes?name=transform&pins=false"
curl http://localhost:3000/api/nodes/YOUR_NODE_UUID
```

### Writing

| Endpoint | Body | Semantics |
|----------|------|-----------|
| `POST /api/nodes/:nodeId/pin/:pinId` | `{"value": …}` | Replace the value |
| `PATCH /api/nodes/:nodeId/pin/:pinId` | `{"value": …}` | Like POST, but vectors may be partial: `{"value":{"x":5}}` |
| `POST /api/nodes/:nodeId/pins` | `{"pins": {"<pin>": value, …}}` | Several pins in one batch |
| `PATCH /api/nodes/:nodeId/pins` | `{"pins": {…}}` | Batch with partial vectors |
| `POST /api/nodes/:nodeId/dirty` | `{"pin": "<pin>"}` | Mark a pin dirty (needs AppService) |

```bash
curl -X POST http://localhost:3000/api/nodes/YOUR_NODE/pin/Gain \
  -H 'Content-Type: application/json' -d '{"value": 0.5}'

curl -X PATCH http://localhost:3000/api/nodes/YOUR_NODE/pin/Position \
  -H 'Content-Type: application/json' -d '{"value": {"y": 2}}'
```

Value formats follow the pin's declared `typeName`:

- `bool`: `true`/`false`. `string`: a JSON string.
- Numbers: `float`, `double`, `byte`… `ulong`, range-checked for their width.
  Send 64-bit integers beyond JavaScript's safe range as decimal strings.
- Vectors (`vec2`, `vec3`, `vec4`, and the `d`/`i`/`u`/`u8` variants):
  an object with `x`, `y`, `z`, `w` as applicable.
- Complex/resource types (textures, etc.) return `422`.

Every write is validated before anything is sent. The response is `200` only
once **Nodos reports the requested value back**:

```json
{ "success": true, "message": "Pin update confirmed by Nodos",
  "node_id": "…", "pin_id": "…", "pin": "Gain", "value": 0.5,
  "type": "double", "status": "confirmed" }
```

If Nodos does not confirm, the response is `502` with the engine's actual
value. Batches are sent as one Editor `BatchRequest` but are not
transactional: no rollback happens if one pin is not confirmed.

Errors: `400` invalid value, `404` node/pin not found, `409` ambiguous name,
read-only pin, or partial vector without a known current value, `422`
unsupported type, `503` Nodos unavailable or pin path not yet reported.

### Real-time events

`GET /api/events` is a [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
stream. Use `?node=<uuid|name|path>` to receive pin events for one node only.

| Event | Data |
|-------|------|
| `status` | `{graph_ready, app_connected, graph_error}` on open and on (dis)connection |
| `graph` | `{reason}` when the graph structure changes (reload your node list) |
| `pin` | `{node_id, node_name, node_path, pin_id, pin, value, type}` when a value changes |

```js
const events = new EventSource('http://localhost:3000/api/events');
events.addEventListener('pin', e => console.log(JSON.parse(e.data)));
```

## Pin paths (diagnostics)

Nodos addresses pins by path for watches and writes. The backend infers
`/Node.Pin` (or `/Parent.Child.Pin`) from the snapshot and, before the
first write to a pin, waits up to 2 s for Nodos to confirm a valid path in
response to read-only `WatchPin` requests. No mutation is sent to an
unconfirmed path.

If writes return `503 … has not reported a valid path`, run with
`LOG_LEVEL=debug`, change the pin once in the Nodos editor, and check
`graph_paths.observed_paths` in `GET /api/status` to see the path format your
Nodos version uses.

## Development

```bash
npm test        # node:test suites with simulated gRPC streams; no Nodos needed
npm run dev     # auto-reload
npm run probe   # check which Nodos service ports respond
```

## License

No project license has been specified. Verify redistribution rights for the
bundled Nodos SDK schemas and generated files before publishing.
