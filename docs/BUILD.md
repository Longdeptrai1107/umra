# Build and distribution

Windows is the implemented and tested desktop target. Node 22.12+ and npm are needed to build the app; a JDK 8+ is needed to compile the agent. JAVA_HOME takes priority, followed by PATH and known local JDK directories. No global Maven installation is necessary: scripts/build-agent.ps1 downloads Byte Buddy 1.18.17 from Maven Central, verifies SHA-256, compiles with --release 8 (or JDK 8 source/target flags) and produces a fat agent JAR. A conventional instrumentation/pom.xml is also provided for Maven users.

`npm ci` uses package-lock.json. `npm run build` builds the agent, checks TypeScript, bundles desktop/backend/SQLite worker using esbuild and builds React with Vite. Production uses one Electron process tree and a separate DB worker, not a Vite server. `npm run dev` starts both frontend development server and Electron/backend; the native shell passes a local token via isolated preload. `npm run backend` is an optional API development command, not a requirement for normal users.

`npm run package` builds an unpacked Windows desktop directory. `npm run package:zip` builds an unsigned desktop ZIP. Keep all files in win-unpacked together. Backend assets and database migration are copied as extraResources. SQLite WASM is unpacked from ASAR so the worker can locate it. The release contains Electron/Chromium and open source dependencies with their license files. It does not include MicroEmulator, Oracle/OpenJDK/JRE files, user games or session recordings.

The same end-to-end suite can validate the packaged executable, including its agent, migrations, frontend and SQLite WASM resources. Set `UMRA_MICROEMULATOR` and `UMRA_JAVA` as described in the README, then run:

```powershell
npm run package
$env:UMRA_EXECUTABLE = (Resolve-Path 'release\win-unpacked\UMRA.exe').Path
npm run test:e2e
Remove-Item Env:UMRA_EXECUTABLE
```

Without `UMRA_EXECUTABLE`, the suite launches Electron from source. Both modes use isolated session data under their own `artifacts/e2e-*` directory and reopen the database in a new desktop process. `PASS.json` and `report.json` identify the executable and completed assertions; a failed run records console output, event/session diagnostics, DOM text and layout measurements. See [VALIDATION.md](VALIDATION.md) for recorded results.

Source distribution should include frontend, backend, desktop, instrumentation source, runtime-adapters, schemas, tests, scripts, docs, package manifests and lockfile. Generated binaries may be included separately for convenience. Exclude node_modules, artifacts, .umra and recordings. Test fixture JARs are generated from source; they target this emulator test environment and are not certified CLDC device builds. Their classes are re-emitted with ASM as Java 1.4, omitting modern StackMapTable frames, for the legacy emulator preprocessor; fixture source intentionally avoids Java 5+ bytecode instructions. This conversion is only for controlled test fixtures and never changes a user's game.

Data configuration: UMRA_DATA_DIR overrides the user-data sessions directory; standalone backend supports UMRA_PORT/UMRA_TOKEN. Packaged desktop picks an available port automatically. Java executable, emulator and selected game are configured from the GUI. No executable arguments from a JAR are passed to a shell.

Dependencies used by UMRA include Electron/Chromium (MIT and bundled notices), React (MIT), Byte Buddy (Apache 2.0), SQL.js (MIT), Express (MIT), ws (MIT), Zod (MIT), TanStack Virtual (MIT), Lucide (ISC). Inspect generated distribution notices for transitive dependency terms. Supplying or redistributing a JRE/MicroEmulator is a separate licensing decision.
