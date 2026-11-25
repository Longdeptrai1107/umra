# Desktop validation — November 25, 2026

The source desktop and unpacked Windows executable both passed the real-runtime end-to-end suite on Windows with Java 1.8.0_513 and MicroEmulator 2.0.4. These results cover the project's three controlled MIDlet fixtures; they do not certify arbitrary commercial games.

| Check | Result | Evidence |
|---|---|---|
| TypeScript | PASS | `npm run typecheck` |
| Backend authorization, validation, persistence and schemas | PASS, 2 tests | `npm test` |
| Agent, frontend, backend and Windows packaging | PASS | `npm run package` |
| Source desktop end-to-end | PASS | `artifacts/e2e-2026-11-25T08-17-06-664Z/PASS.json` |
| Packaged `release/win-unpacked/UMRA.exe` end-to-end | PASS | `artifacts/e2e-2026-11-25T08-17-46-523Z/PASS.json` |

The end-to-end suite checks real Windows keyboard input, argument 7 and return 14, nested method ancestry, an application exception, bounded field snapshots and credential redaction, a separate async trace root, and HTTP send/receive bytes matching the local echo endpoint. It also checks WebSocket delivery, SQLite queries and export, Pause View versus runtime collection, Stop Trace versus emulator lifetime, an independent obfuscated Canvas game, and a Form/CommandListener game activated with the right soft key (F2).

Desktop checks cover visible virtual event rows at the minimum 1100 × 720 window size. After restarting Electron and its backend, the suite verifies persisted invocation values and mappings, then opens the saved session and mapped call tree through the UI. Screenshots are captured as artifacts; viewport geometry and row visibility are asserted automatically.

The packaged sample run exported 94 records, reported zero dropped records and no renderer page errors. Its measured runtime-to-backend receipt delay was p50 11 ms and p95 64 ms across 94 recent samples. These are measurements of this short local fixture run, not performance guarantees.

Fixes made during validation: native input waits for the owned emulator window; every fixture waits for the runtime trace acknowledgement; the command fixture uses the correct soft key; intentional process shutdown no longer records a spurious transport-disconnected error or treats Windows termination as an unexpected crash. Actual unexpected disconnections still surface as failures.

Run instructions are in [BUILD.md](BUILD.md). The executable is unsigned and requires the rest of the `win-unpacked` directory. Java and MicroEmulator must be supplied separately. Existing limits in [COMPATIBILITY.md](COMPATIBILITY.md) still apply, including no automatic protocol decoding or direct field-write events.
