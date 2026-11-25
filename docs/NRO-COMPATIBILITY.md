# NRO rebuilt JAR compatibility — November 25, 2026

Tested with UMRA's packaged Windows executable, Java 1.8.0_513 and MicroEmulator 2.0.4. The tested game JARs were read and launched in place; no game source or bytecode was rewritten.

## Static inspection

All three local variants expose 157 readable classes and 1,690 method declarations, with no static-inspection warnings:

- `D:\NRO\source\dist\DragonBoy252-source-rebuilt.jar`
- `D:\NRO\source\debug-dist\DragonBoy252-source-rebuilt.jar`
- `D:\NRO\source\debug-dist\DragonBoy252-source-rebuilt-edited.jar`

The declaration count includes constructors, static initializers and abstract methods; runtime instrumentation excludes those categories as documented in COMPATIBILITY.md. Readable names include `main.GameMidlet`, `main.GameCanvas`, `nro.Controller`, `nro.Service`, `nro.Session_ME`, `nro.Message` and `nro.GameScr`. Static bytecode inspection also succeeded for `main.GameCanvas` and `nro.Session_ME`.

Static inventories, SHA-256 fingerprints and bytecode are stored in `artifacts/nro-static-2026-11-25T09-27-45-657Z/`.

## Observed runtime sample

For `source/dist/DragonBoy252-source-rebuilt.jar` (SHA-256 `e108150898e95618b35f9b3dd935b7f2328a99a86752e28ff4813ecee8f9846d`), UMRA captured 105 distinct method signatures across 37 classes, including 12,874 `METHOD_ENTER` and 12,871 `METHOD_EXIT` records. The sample reported zero dropped records and the Live Events rows were visible in the desktop UI.

Examples actually observed at runtime:

| Class | Method | Calls in sample |
|---|---|---:|
| `main.GameMidlet` | `startApp()V` | 1 |
| `main.GameCanvas` | `update()V` | 140 |
| `main.GameCanvas` | `paint(Ljavax/microedition/lcdui/Graphics;)V` | 138 |
| `main.GameCanvas` | `connect()V` | 1 |
| `nro.Session_ME` | `connect(Ljava/lang/String;I)V` | 1 |
| `nro.Controller` | `gI()Lnro/Controller;` | 2 |
| `nro.Service` | `gI()Lnro/Service;` | 1 |

The first sample's evidence is under `artifacts/game-smoke-2026-11-25T09-29-29-577Z/0/`: `summary.json`, `methods.json`, `events.json`, `report.json`, `console.log` and a Live Events screenshot. `events.json` contains the first 2,000 records; aggregate counts and methods describe the whole recorded sample, with the API's documented 1,000 method-group limit.

All three runtime runs finished with the following results. Counts reflect short samples with different recording durations and are not a comparison of total coverage or performance.

| Variant | Runtime classes | Distinct methods | Method entries | Input callbacks |
|---|---:|---:|---:|---|
| `source/dist/...rebuilt.jar` | 37 | 105 | 12,874 | Not observed before timeout |
| `source/debug-dist/...rebuilt.jar` | 37 | 102 | 9,338 | 4 key presses + 4 releases |
| `source/debug-dist/...rebuilt-edited.jar` | 33 | 78 | 1,455 | 4 key presses + 4 releases |

The debug and edited variants both recorded `main.GameCanvas.keyPressed(I)V` and `keyReleased(I)V` from the native `2468` input sequence. Their respective evidence directories are `1/` and `2/` beneath the same game-smoke artifact directory. Input events are exported separately to `inputs.json` because startup/rendering events can fill the first 2,000-record general event page before the input occurs. All three samples reported zero dropped records, no instrumentation warnings and no renderer page errors.

For the dist variant, the automatic `2468` key sequence was posted to the emulator window, but a keyboard callback was not observed before its timeout. That particular sample confirms method tracing during startup/rendering, not input-to-handler correlation. Console output also reports several missing image resources. Login, successful server connection, gameplay, protocol decoding and all 1,690 declarations executing are not established by these smoke tests. Strings remain redacted; field and payload capture are disabled.

## Reproduce

Set `UMRA_JAVA` to a Java 8 executable and `UMRA_MICROEMULATOR` to the local emulator JAR. To test the packaged app:

```powershell
$env:UMRA_EXECUTABLE = (Resolve-Path 'release\win-unpacked\UMRA.exe').Path
npm run test:game -- 'D:\NRO\source\dist\DragonBoy252-source-rebuilt.jar'
```

Pass multiple JAR paths to inspect and launch them sequentially. Each run uses separate session data under `artifacts/game-smoke-*`. Its summary reports static readability, observed runtime methods, input status and any warnings/errors independently. A missing runtime observation fails the command; input limitations are recorded separately.
