# Implemented stages and acceptance checks

Every stage shares one schema and one repository; no mocked backend/event adapter is used in the production app. Stage completion is assessed by the listed command or runtime assertion, not by a UI label alone.

| Stage | Implementation | Acceptance |
|---|---|---|
| 1. Compatibility | Probe desktop JVM version; inspect MIDletClassLoader; exact-JAR inventory | Java 8 and MicroEmulator 2.0.4 metadata in E2E report |
| 2. Architecture | Electron/React, Node controller, Java agent, worker SQLite | docs/ARCHITECTURE.md and shared-schemas |
| 3. Frontend/backend skeleton | Buildable TS entrypoints and isolated preload | npm run typecheck + npm run build:app |
| 4. Health/process lifecycle | Authenticated health, validated spawn, owned stop | API tests + launch/stop through Electron |
| 5. Instrumentation PoC | Startup agent, bootstrap hooks, loader/resource fallback | Callback/method invocation from real fixture JVM |
| 6. Event transport | Authenticated loopback TCP, producer queue and command ACK | Runtime source tag + RUNTIME_STATUS transition |
| 7. WebSocket | Auth protocols, subscribe/filter, bounded replay, heartbeat/gap | Independent WS client receives actual JVM invocation and network bytes |
| 8. Live Events | Bounded store and virtual event rows | Rows appear after real native keyboard event |
| 9. Inspector/call tree | Snapshots, observed parent IDs, duration/exception | Input 7 → return 14; nested calls have observed context |
| 10. Network | Connector + HTTP/socket stream adapters | Sent/received bytes equal local HTTP echo endpoint bytes |
| 11. SQLite | Async worker, batched transaction, atomic snapshot, table indexes | Invocation/arguments/mapping survive fresh desktop process |
| 12. JAR/Mapping | Static ASM inventory and bounded instructions; persistent aliases | No class initialization during inspection; mapping CRUD tested |
| 13. Integration | One desktop launches all services/processes | npm run test:e2e on interactive Windows |
| 14. Tests/measurement | Backend security/state tests; three runtime fixtures; measured receipt delay | PASS.json/report.json; no fixed latency promise |
| 15. Packaging | Source manifests, build scripts, unsigned desktop ZIP/unpacked build | npm run package and desktop smoke on packaged executable |

Partial or intentionally out-of-scope capabilities are documented rather than shown as supported: runtime field-write events, datagram payloads, automatic protocol decoding, inferred opcode/plaintext, causal propagation across async boundaries, executable bytecode offsets and attach to an arbitrary pre-existing JVM. UMRA's supported launch path is MicroEmulator on a desktop JVM with its startup agent. A different emulator/runtime needs a new adapter or compatible launch configuration.

Retention and persistence limits: live view 10,000 records; visible call tree 3,000 nodes; graph API 5,000 nodes; methods API 1,000 groups; network history page 2,000 records; WS reconnect replay 4,000 records. Full record export is streamed using cursors. SQLite WASM persists snapshots, so the last periodic-flush window can be lost on abrupt system/process failure. No unlimited object traversal or unlimited stack transport is performed.
