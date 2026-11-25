# Compatibility scope

Primary adapter: MicroEmulator 2.x, inspected against the local 2.0.4 JAR. Primary runtime under test: Java 1.8.0_513 (HotSpot 64-bit) on Windows. JDK 27.0.1.1 builds Java-8-compatible agent bytecode. The Java executable validator accepts desktop JVM major versions 8–27; this is not a claim that MicroEmulator 2.0.4 itself works on every one of those JVMs. The GUI recommends Java 8.

The agent does not require Java Agent/JVMTI support inside a physical Java ME device. It runs in the desktop JVM that hosts MicroEmulator. Arbitrary running-process attach is outside the implemented workflow. Launching with a startup agent is the supported path and avoids dynamic-agent restrictions of newer runtimes.

The runtime adapter explicitly integrates the child-first MIDletClassLoader, javax.microedition.io.Connector, MicroEmulator HTTP/socket connection stream factories and Display.setCurrent. Byte Buddy also has a system-classloader resource fallback because MIDletClassLoader may not expose javax.microedition class resources through its own resource lookup. Game scope comes from static JAR inventory; no special game symbols, opcodes or protocols are used by the analyzer.

Runtime test fixtures are three independently packaged Java ME applications:

| JAR | Design | Assertions |
|---|---|---|
| umratest.jar | Canvas A–F actions | Integer argument/return, nested methods, local HTTP bytes, exception, receiver field snapshot, async worker |
| obfuscated.jar | Separate Canvas/MIDlet hierarchy with short symbols | Generic JAR scoping and method names without application-specific analyzer code |
| independent.jar | Form/CommandListener | Command callback and helper invocation |

These are controlled application fixtures, not a certification of arbitrary commercial games. A local NinjaSchool_251-rebuilt.jar is available for a separate compatibility smoke check; report static inspection, launch and observed input results independently. Do not interpret a successful static inventory as runtime compatibility or protocol support. Actual runs and results are recorded in generated artifacts and the final validation report.

Unsupported or adapter-dependent features: native/custom IO, UDP/datagrams, proprietary network factories, constructor/static-initializer tracing, direct field-write events, instruction-exact offsets, asynchronous causal propagation, deobfuscation without mappings, game-specific protocol decode and encryption/compression boundary detection. Signed/restricted games, anti-instrumentation code, malformed bytecode, external JAR dependencies and JVM verification rules can require additional work. Errors are surfaced in Console/TRACE_WARNING rather than hidden by fabricated observations.

HTTP/socket records are application stream chunks. They may be fragments, batches, encoded data or encrypted by the application. The generic adapter does not assign opcodes or packet boundaries. Byte snapshots default to disabled; inspect private data only when authorized.
