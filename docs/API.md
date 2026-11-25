# UMRA API v1

The desktop launches one server on an ephemeral port, bound only to 127.0.0.1. All /api routes require `Authorization: Bearer <bootstrap token>`. Electron preload supplies the token. Host and Origin are validated; production does not enable arbitrary CORS. Development accepts only its configured Vite origin. Responses use JSON; errors have `{ "error": { "code": "...", "message": "..." } }` with meaningful HTTP 400/401/403/404/409/413/500/504 codes.

| Method | Route | Behavior |
|---|---|---|
| GET | /api/v1/health | Service/DB/transport description |
| GET | /api/v1/runtimes | Probe local desktop Java candidates (8–27) |
| GET | /api/v1/jars | JAR paths referenced by saved sessions |
| POST | /api/v1/jars/analyze | `{javaPath,gamePath}` → static class/method/field/manifest inventory and SHA-256 |
| GET/POST | /api/v1/sessions | List / create using SessionConfig |
| GET/DELETE | /api/v1/sessions/:id | Read / delete a stopped session |
| POST | /api/v1/sessions/:id/launch | Validate files and Java; spawn an owned JVM (202 starting) |
| POST | /api/v1/sessions/:id/stop | Stop capture, then owned JVM; flush data |
| POST | /api/v1/sessions/:id/trace/start | TraceOptions, wait for runtime ACK |
| POST | /api/v1/sessions/:id/trace/stop | Disable capture without closing JVM |
| POST | /api/v1/sessions/:id/trace/pause | Runtime capture pause; distinct from frontend Pause View |
| POST | /api/v1/sessions/:id/markers | `{message}` enqueue a real runtime marker |
| GET | /api/v1/sessions/:id/events | History query, cursor paging |
| GET | /api/v1/sessions/:id/methods | Aggregate observed calls/durations/exceptions |
| GET | /api/v1/sessions/:id/invocations/:invocation | Entry/exit plus collected argument/receiver/result snapshots |
| GET | /api/v1/sessions/:id/network | Last 2,000 network observations, optional traceId |
| GET | /api/v1/sessions/:id/callgraph | At most 5,000 observed invocation nodes; truncated flag |
| GET | /api/v1/sessions/:id/jar | Static inventory for selected JAR |
| GET | /api/v1/sessions/:id/bytecode?className=... | Read-only instruction listing; indices are not offsets |
| GET/POST | /api/v1/sessions/:id/mappings | Read/upsert `{kind,original,alias,note}` |
| DELETE | /api/v1/sessions/:id/mappings/:mapping | Remove one alias |
| GET | /api/v1/sessions/:id/stats | Actual memory/queue/receipt-delay statistics |
| GET | /api/v1/sessions/:id/console | Bounded emulator stdout/stderr chunks |
| GET | /api/v1/sessions/:id/report | Counts, metadata, warnings, measured stats and limitations |
| GET | /api/v1/sessions/:id/export?format=ndjson | Stream NDJSON/JSON/CSV/report; create export_job |

SessionConfig:

```json
{"name":"My game","javaPath":"C:\\Java\\bin\\java.exe","emulatorPath":"C:\\Tools\\microemulator.jar","gamePath":"C:\\Games\\game.jar","trace":{"mode":"basic","classFilter":"","methodFilter":"","captureFields":false,"redact":true,"capturePayload":false}}
```

TraceOptions supports basic/selective/network/deep, substring filters and three booleans. JAD may refer to a local relative JAR. Extra process arguments are not accepted. A completed session cannot be relaunched; create a new one to keep invocation IDs and recording boundaries unambiguous.

Event query: after>=0, limit=1..2000 (default 500), q (literal substring), traceId, threadId, connectionId, types (comma separated), tail=true for the last matching page. Returned fields: events, latestSeq, nextAfter, limit. Callgraph edges are observed ancestry in instrumented scope. Unobserved/filtered calls and asynchronous relationships are not fabricated.

WebSocket URL `/ws/v1/sessions/:id/live`, protocols `umra-v1` and `auth.<token>`. The server selects only umra-v1, never echoes the token. Inbound maximum 4 KiB, maximum 8 connections:

```json
{"type":"subscribe","after":0,"filter":{"q":"","traceId":"","types":["USER_INPUT"]}}
{"type":"filter","filter":{"threadId":12}}
{"type":"unsubscribe"}
{"type":"ping"}
```

Server messages: hello, state, batch(events/latestSeq), heartbeat, gap, warning. Normal live batches contain at most 64 events. After reconnect, subscribe with the last received saved seq. Replay is bounded; gap reports overflow/replay limits and history/export can recover persisted data. Filter changes affect future streaming; use events API for older matching data. Do not interpret a gap in filtered event sequence as proof of loss: latestSeq also counts records omitted by the chosen filter. Native WebSocket ping/pong plus a 15-second heartbeat detects stale connections.

Type definitions and runtime validation are in shared-schemas/index.ts. Events include source, eventId, sessionId, seq/runtimeSeq, capture/receipt timestamps, type, thread, invocation/parent/trace context, descriptor, bounded snapshots, duration and data. `bytecodeOffset` is null in this implementation.
