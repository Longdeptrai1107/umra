# Universal MicroEmulator Realtime Analyzer (UMRA)

Ứng dụng desktop chạy local để quan sát **runtime thật** của game Java ME trong MicroEmulator: input/lifecycle, method enter/exit, arguments, exceptions, observed call tree, object snapshots và HTTP/TCP application streams. Không dùng event mẫu để thay backend hoặc runtime.

UMRA dùng Electron + React/TypeScript, backend Node/TypeScript, SQLite trong worker thread và Java agent Byte Buddy. Backend và frontend được khởi động tự động bởi desktop launcher. Chọn Electron vì dùng chung runtime Node cho backend và shell, tránh phải cài riêng một service hoặc thêm Rust toolchain cho bản Windows đầu tiên.

## Chạy trên Windows

Yêu cầu khi chạy source: Node.js 22.12+ (đã kiểm tra trên Node 26), npm, JDK 8+ để build agent. MicroEmulator và Java runtime chạy game do người dùng tự cung cấp. **Java 8 được khuyến nghị cho MicroEmulator 2.0.4.** JDK mới có thể build agent thành bytecode Java 8.

```powershell
npm ci
npm run build
.\Start-UMRA.bat
```

Hoặc chạy `scripts\setup.bat` lần đầu, sau đó mở `Start-UMRA.bat`. Máy build cần Internet để tải npm packages và Byte Buddy. Lần sử dụng app sau khi build không cần Internet cho UMRA; bản thân game có thể có hành vi mạng riêng.

Development mode, một lệnh:

```powershell
npm run dev
```

Lệnh này build agent khi cần, build backend/worker, bật Vite và khởi chạy Electron. Desktop chờ backend listen thành công; frontend gọi health API trước khi hiển thị sẵn sàng. Token API được truyền qua preload cô lập, không qua một endpoint công khai.

## Quy trình sử dụng

1. Chọn Java runtime, MicroEmulator JAR và game JAR/JAD. JAD phải tham chiếu JAR local.
2. Chọn chế độ trong **Settings**. Mặc định Basic, che String/credential fields và không thu payload byte.
3. **Launch** tạo session mới và chạy emulator với agent. Chờ backend xác nhận instrumentation.
4. **Start Live Trace**, sau đó thao tác trực tiếp trên cửa sổ game.
5. Chọn event → **Follow trace** để lọc trace context thực sự quan sát được. Xem Arguments, Result, Stack, Network hoặc Bytecode trong inspector.
6. **Pause View** đóng băng giao diện; runtime và database vẫn thu dữ liệu. **Stop Trace** dừng ghi runtime, emulator tiếp tục chạy. **Stop** đóng đúng emulator do session đó khởi chạy.
7. Mở lại dữ liệu trong **Sessions/Search**, thêm alias trong **Mapping**, xuất NDJSON/JSON/CSV trong **Reports**. Session đã hoàn tất là archive; Launch tiếp theo tạo session mới.

F6 bật/tắt trace; Ctrl+K focus bộ lọc. Các panel inspector và call tree có thể đổi kích thước bằng resize handle ở góc dưới. Clear View chỉ xóa buffer hiển thị. Xóa session trong Sessions sẽ xóa dữ liệu đã lưu sau xác nhận của người dùng.

## Chế độ và phạm vi

| Chế độ | Thu thập |
|---|---|
| Basic | Callback input/lifecycle đã instrument, bounded stack và method context của callback |
| Selective | Invocation có class/method chứa chuỗi lọc, cùng input/lifecycle |
| Network | Input/lifecycle và HTTP/socket streams được adapter wrap |
| Deep | Method enter/exit, arguments, return/exception và observed call context trong JAR đã chọn |

Bytecode probes được cài ở các method có thân trong **JAR đã chọn**, cả package tên ngắn/obfuscated. Selective lọc việc ghi event tại runtime, không gỡ probe khỏi những method khác. Agent được cài ngay lúc launch; Start/Stop Trace chỉ điều khiển thu thập. Không phụ thuộc attach vào JVM đang chạy, JVMTI trong một máy Java ME vật lý, hoặc sửa source game.

Object inspection không gọi `toString()` hay method tùy ý của game. Field snapshot chỉ đọc tối đa 8 instance fields với giới hạn độ sâu/budget, có thể không truy cập được trên runtime bị giới hạn hoặc không nhất quán khi có thay đổi đồng thời. `FIELD_CHANGE` không được phát vì adapter hiện tại chưa quan sát từng field write.

Network inspector hiển thị **stream chunks**, không khẳng định đó là packet/message hoàn chỉnh. Payload được quan sát ở application stream Java ME, trước TLS của HTTP(S) nhưng sau mã hóa/nén riêng của ứng dụng nếu có. Không tự suy đoán opcode, protocol, plaintext, serializer, encryptor hay response handler. Dùng method trace, bytes thật và mapping để nghiên cứu; protocol riêng cần adapter bổ sung.

Ngoài phạm vi: constructors, static initializers, native methods, class ngoài JAR game (trừ adapter chuẩn), datagram payload, instruction-level bytecode offsets, ghi nhận từng field write, tự nối nhân quả qua thread/queue bất đồng bộ. Quan hệ cây là **observed ancestry trong phạm vi instrument**. Thread bất đồng bộ có root độc lập. Tên nút Canvas không được suy luận tự động; dùng callback/tọa độ/stack/instructions.

## Cấu trúc

```text
frontend/          React, virtualized event list, call tree, inspectors
desktop/           Electron main + isolated preload
backend/           HTTP/WS API, process lifecycle, collector, SQLite worker
instrumentation/   Java agent, bounded snapshots, local socket transport, JAR tool
runtime-adapters/  MicroEmulator adapter capabilities
shared-schemas/    Zod validation + TypeScript models
tests/             API tests, real MIDlet/Electron end-to-end tests
scripts/           Build, dev launcher, fixture build
docs/              Architecture, API, compatibility, troubleshooting, acceptance
```

## Build và kiểm thử

```powershell
npm run typecheck
npm run build
npm test

$env:UMRA_MICROEMULATOR = 'C:\path\microemulator-2.0.4.jar'
$env:UMRA_JAVA = 'C:\path\jre8\bin\java.exe'
npm run test:e2e
```

Test end-to-end cần desktop Windows tương tác được. Nó tạo ba fixture JAR riêng, mở app Electron, launch MIDlet thật qua UI, gửi phím thật vào emulator, kiểm tra argument/return/nesting/exception/fields/async, so sánh HTTP bytes với local echo server, kiểm tra WebSocket/React/SQLite, rồi mở lại database trong process mới. Không thay nguồn runtime bằng mock. Cổng `127.0.0.1:50123` phải còn trống. Artifacts/screenshots/report nằm dưới `artifacts/e2e-*`.

Fixture A–F dùng Canvas; fixture thứ hai dùng Form/CommandListener; fixture thứ ba dùng symbol ngắn. Đây là game kiểm thử của dự án, không đại diện cho mọi game J2ME. Xem [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) và report thực tế đi kèm trước khi đánh giá hỗ trợ một game cụ thể.

Để chạy cùng bộ kiểm thử trên bản desktop đã đóng gói, đặt `UMRA_EXECUTABLE` thành đường dẫn `release\win-unpacked\UMRA.exe` trước khi chạy `npm run test:e2e`. Bài kiểm thử còn kiểm tra viewport event ở cửa sổ 1100×720, Stop không tạo lỗi mất kết nối giả, và mở lại phiên/call tree/alias qua UI sau khi khởi động lại. Kết quả xác thực ngày 25/11/2026 được ghi trong [docs/VALIDATION.md](docs/VALIDATION.md).

## Đóng gói

```powershell
npm run package          # release/win-unpacked/UMRA.exe
npm run package:zip      # bản ZIP desktop
```

Electron package chứa frontend/backend/agent/SQLite WASM; không yêu cầu người dùng chạy từng service. Nó **không chứa JRE hay MicroEmulator**. Bản Windows chưa ký số. Cần kiểm tra license trước khi bổ sung runtime/emulator của bên thứ ba. Byte Buddy theo Apache 2.0, SQL.js/Electron/React theo license đi kèm dependency; Electron distribution giữ các file license Chromium. Xem [docs/BUILD.md](docs/BUILD.md).

SQLite mặc định ở `%APPDATA%\UMRA\sessions\umra.sqlite`; biến `UMRA_DATA_DIR` đổi thư mục dữ liệu. Token và collector chỉ dùng local loopback. Không có telemetry, upload game hoặc dịch vụ đám mây trong UMRA. Chỉ dùng với ứng dụng bạn được quyền kiểm tra.
