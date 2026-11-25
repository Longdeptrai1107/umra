package umra.runtime;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import static umra.runtime.Json.obj;

/** Non-blocking producer queue; all network IO is performed on daemon transport threads. */
public final class TraceRuntime {
    private static final ArrayBlockingQueue<String> QUEUE = new ArrayBlockingQueue<String>(8192);
    private static final AtomicLong IDS = new AtomicLong(), DROPPED = new AtomicLong();
    private static long seq;
    private static volatile boolean active, configured;
    private static volatile long generation;
    private static volatile String mode = "basic", classFilter = "", methodFilter = "";
    private static String session, token;
    private static int port;
    private static final ThreadLocal<State> LOCAL = new ThreadLocal<State>() {
        @Override protected State initialValue() { return new State(); }
    };

    public static synchronized void configure(Properties p) {
        if (configured) return;
        session = p.getProperty("sessionId"); token = p.getProperty("token");
        port = Integer.parseInt(p.getProperty("port"));
        if (port < 1 || port > 65535 || session == null || token == null) throw new IllegalArgumentException("Invalid transport config");
        configured = true;
        Thread transport = new Thread(new Runnable() { @Override public void run() { transport(); } }, "umra-transport");
        transport.setDaemon(true); transport.start();
    }

    public static long enter(String cls, String method, String descriptor, Object receiver, Object[] args) {
        if (!active) return 0;
        State state = LOCAL.get();
        if (state.busy) return 0;
        state.busy = true;
        try {
            if (state.generation != generation) { state.frames.clear(); state.generation = generation; }
            if (state.frames.size() >= 64) { if (!state.warned) { warning("Call depth capped at 64", 0); state.warned = true; } return 0; }
            Frame parent = state.frames.peek();
            boolean input = callback(method), lifecycle = lifecycle(method);
            boolean selected = "deep".equals(mode) || ("selective".equals(mode)
                    && cls.contains(classFilter) && method.contains(methodFilter)) || input || lifecycle;
            String id = Long.toString(IDS.incrementAndGet());
            String trace = input || parent == null ? "trace-" + id : parent.trace;
            Frame frame = new Frame(id, parent == null ? null : parent.observed ? parent.id : parent.visibleParent,
                    trace, cls, method, descriptor, state.frames.size(), selected);
            state.frames.push(frame);
            if (selected) {
                Map<String, Object> event = event("METHOD_ENTER", frame);
                if ("deep".equals(mode) || "selective".equals(mode) || input) event.put("arguments", arguments(args));
                if (receiver != null && Snapshots.captureFields) event.put("receiver", Snapshots.take(receiver));
                emit(event);
            }
            if (input || lifecycle) {
                Map<String, Object> e = event(input ? "USER_INPUT" : "LIFECYCLE", frame);
                e.put("arguments", arguments(args)); e.put("stack", stack());
                if (receiver != null) e.put("receiver", Snapshots.take(receiver));
                emit(e);
            }
            return Long.parseLong(id);
        } finally { state.busy = false; }
    }

    public static void exit(long id, Object value, Throwable thrown, boolean isVoid, Object receiver) {
        if (id == 0) return;
        State state = LOCAL.get();
        if (state.busy || state.generation != generation) return;
        state.busy = true;
        try {
            Frame frame = state.frames.peek();
            if (frame == null || !frame.id.equals(Long.toString(id))) return;
            state.frames.pop();
            if (!active || !frame.observed) return;
            Map<String, Object> e = event(thrown == null ? "METHOD_EXIT" : "METHOD_EXCEPTION", frame);
            e.put("durationNs", System.nanoTime() - frame.start);
            if (thrown != null) e.put("exception", Snapshots.take(thrown));
            else if ("deep".equals(mode) || "selective".equals(mode)) e.put("returnValue", isVoid
                    ? obj("type", "void", "status", "observed") : Snapshots.take(value));
            if (receiver != null && Snapshots.captureFields) e.put("receiver", Snapshots.take(receiver));
            emit(e);
        } finally { state.busy = false; }
    }

    public static void network(String type, String connection, String endpoint, byte[] bytes, int offset, int length) {
        if (!active) return;
        State state = LOCAL.get();
        if (state.busy) return;
        state.busy = true;
        try {
            Frame frame = state.generation == generation ? state.frames.peek() : null;
            Map<String, Object> e = event(type, frame);
            e.put("data", obj("connectionId", connection, "endpoint", endpoint, "length", length,
                    "layer", "Java ME application stream (before TLS, after application encoding)",
                    "unit", "stream chunk", "opcode", null,
                    "payload", bytes == null ? null : Snapshots.bytes(bytes, offset, length)));
            emit(e);
        } catch (Throwable ignored) { DROPPED.incrementAndGet(); }
        finally { state.busy = false; }
    }

    public static void screen(Object displayable) {
        if (!active) return;
        Map<String, Object> e = event("SCREEN_CHANGE", current());
        e.put("data", obj("displayable", Snapshots.take(displayable))); emit(e);
    }

    public static void status(String status, String message) {
        Map<String, Object> e = event("RUNTIME_STATUS", null);
        e.put("data", obj("status", status, "message", message, "mode", mode)); emit(e);
    }
    public static void warning(String message, long dropped) {
        Map<String, Object> e = event("TRACE_WARNING", null);
        e.put("data", obj("message", message, "dropped", dropped)); emit(e);
    }
    private static Frame current() {
        State s = LOCAL.get(); return s.generation == generation ? s.frames.peek() : null;
    }
    private static Map<String, Object> event(String type, Frame f) {
        Thread t = Thread.currentThread();
        return obj("runtimeSeq", 0, "timestamp", System.currentTimeMillis(), "type", type,
                "threadId", t.getId(), "threadName", t.getName(),
                "traceId", f == null ? null : f.trace, "invocationId", f == null || !f.observed ? null : f.id,
                "parentId", f == null ? null : f.visibleParent,
                "className", f == null ? "" : f.cls, "methodName", f == null ? "" : f.method,
                "descriptor", f == null ? "" : f.descriptor, "depth", f == null ? 0 : f.depth,
                "bytecodeOffset", null);
    }
    private static synchronized void emit(Map<String, Object> e) {
        e.put("runtimeSeq", ++seq);
        String text = Json.encode(e);
        if (text.length() > 24000 || !QUEUE.offer(text)) DROPPED.incrementAndGet();
    }
    private static List<Object> arguments(Object[] args) {
        List<Object> out = new ArrayList<Object>();
        for (int i = 0; i < args.length && i < 12; i++) {
            Map<String, Object> v = Snapshots.take(args[i]); v.put("index", i); out.add(v);
        }
        return out;
    }
    private static List<String> stack() {
        List<String> out = new ArrayList<String>();
        for (StackTraceElement e : Thread.currentThread().getStackTrace()) {
            if (e.getClassName().startsWith("umra.") || e.getClassName().equals("java.lang.Thread")) continue;
            out.add(e.toString()); if (out.size() == 24) break;
        }
        return out;
    }
    private static boolean callback(String name) {
        return Arrays.asList("keyPressed", "keyReleased", "keyRepeated", "pointerPressed", "pointerReleased",
                "pointerDragged", "commandAction").contains(name);
    }
    private static boolean lifecycle(String name) {
        return Arrays.asList("startApp", "pauseApp", "destroyApp", "showNotify", "hideNotify").contains(name);
    }

    private static void command(String line) {
        String[] p = line.split("\t", -1);
        if ("START".equals(p[0]) && p.length == 7) {
            active = false; generation++;
            mode = p[1]; classFilter = p[2]; methodFilter = p[3];
            Snapshots.captureFields = Boolean.parseBoolean(p[4]);
            Snapshots.redact = Boolean.parseBoolean(p[5]); Snapshots.capturePayload = Boolean.parseBoolean(p[6]);
            active = true; status("TRACE_ACTIVE", "Runtime recording enabled");
        } else if ("STOP".equals(p[0])) { active = false; generation++; status("TRACE_DISABLED", "Runtime recording disabled"); }
        else if ("PAUSE".equals(p[0])) { active = false; generation++; status("TRACE_PAUSED", "Runtime recording paused"); }
        else if ("MARK".equals(p[0])) { Map<String, Object> e = event("MARKER", current()); e.put("data", obj("message", p.length > 1 ? p[1] : "Marker")); emit(e); }
    }

    private static void transport() {
        for (;;) {
            try (final Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), 3000);
                socket.setTcpNoDelay(true);
                final BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                BufferedWriter out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
                out.write(Json.encode(obj("hello", "UMRA/1", "sessionId", session, "token", token,
                        "javaVersion", System.getProperty("java.version"), "vm", System.getProperty("java.vm.name"))));
                out.newLine(); out.flush();
                Thread control = new Thread(new Runnable() {
                    @Override public void run() {
                        try { String line; while ((line = in.readLine()) != null && line.length() <= 4096) command(line); }
                        catch (IOException ignored) { }
                        finally { try { socket.close(); } catch (IOException ignored) { } }
                    }
                }, "umra-control");
                control.setDaemon(true); control.start();
                status("AGENT_READY", "Transport connected; instrumentation scope is the selected JAR");
                long metricsAt = 0;
                while (!socket.isClosed()) {
                    String record = QUEUE.poll(50, TimeUnit.MILLISECONDS);
                    if (record != null) { out.write(record); out.newLine(); }
                    for (int i = 0; i < 127 && (record = QUEUE.poll()) != null; i++) { out.write(record); out.newLine(); }
                    out.flush();
                    long lost = DROPPED.getAndSet(0);
                    if (lost > 0) warning("Runtime queue or snapshot limit exceeded", lost);
                    if (System.currentTimeMillis() - metricsAt > 1000) {
                        metricsAt = System.currentTimeMillis(); Runtime r = Runtime.getRuntime();
                        Map<String, Object> e = event("METRICS", null);
                        e.put("data", obj("heapUsed", r.totalMemory() - r.freeMemory(), "heapMax", r.maxMemory(),
                                "queueSize", QUEUE.size(), "cpuPercent", null)); emit(e);
                    }
                }
            } catch (Throwable error) {
                try { Thread.sleep(500); } catch (InterruptedException e) { return; }
            }
        }
    }
    private static final class State {
        boolean busy, warned; long generation = -1;
        final ArrayDeque<Frame> frames = new ArrayDeque<Frame>();
    }
    private static final class Frame {
        final String id, visibleParent, trace, cls, method, descriptor;
        final int depth; final boolean observed; final long start = System.nanoTime();
        Frame(String id, String parent, String trace, String cls, String method, String descriptor, int depth, boolean observed) {
            this.id = id; this.visibleParent = parent; this.trace = trace; this.cls = cls;
            this.method = method; this.descriptor = descriptor; this.depth = depth; this.observed = observed;
        }
    }
}
