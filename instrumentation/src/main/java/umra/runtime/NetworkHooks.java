package umra.runtime;

import java.io.*;
import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;

/** MicroEmulator HTTP/socket adapter; records successful application stream reads/writes. */
public final class NetworkHooks {
    private static final List<Connection> CONNECTIONS = new ArrayList<Connection>();
    private static final AtomicLong IDS = new AtomicLong();
    public static synchronized void opened(Object object, String endpoint) {
        if (object == null || find(object) != null) return;
        if (CONNECTIONS.size() >= 4096) CONNECTIONS.remove(0);
        Connection c = new Connection(object, Snapshots.endpoint(endpoint)); CONNECTIONS.add(c);
        TraceRuntime.network("NETWORK_OPEN", c.id, c.endpoint, null, 0, 0);
    }
    private static Connection find(Object object) {
        for (Iterator<Connection> i = CONNECTIONS.iterator(); i.hasNext();) {
            Connection c = i.next(); Object v = c.object.get();
            if (v == null) i.remove(); else if (v == object) return c;
        }
        return null;
    }
    public static synchronized Object wrap(Object connection, Object stream) {
        Connection c = find(connection);
        if (c == null) { opened(connection, "unknown (connection opened before trace)"); c = find(connection); }
        if (stream instanceof CaptureIn || stream instanceof CaptureOut) return stream;
        if (stream instanceof InputStream) return new CaptureIn((InputStream) stream, c);
        if (stream instanceof OutputStream) return new CaptureOut((OutputStream) stream, c);
        return stream;
    }
    private static final class Connection {
        final WeakReference<Object> object;
        final String id = "connection-" + IDS.incrementAndGet(), endpoint;
        Connection(Object object, String endpoint) { this.object = new WeakReference<Object>(object); this.endpoint = endpoint; }
    }
    private static final class CaptureIn extends FilterInputStream {
        final Connection c;
        CaptureIn(InputStream in, Connection c) { super(in); this.c = c; }
        @Override public int read() throws IOException {
            int value = in.read();
            if (value >= 0) capture(new byte[] {(byte) value}, 0, 1);
            return value;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            int n = in.read(b, off, len); if (n > 0) capture(b, off, n); return n;
        }
        @Override public int read(byte[] b) throws IOException { return read(b, 0, b.length); }
        private void capture(byte[] b, int off, int len) {
            try { TraceRuntime.network("NETWORK_RECEIVE", c.id, c.endpoint, b, off, len); } catch (Throwable ignored) { }
        }
    }
    private static final class CaptureOut extends FilterOutputStream {
        final Connection c;
        CaptureOut(OutputStream out, Connection c) { super(out); this.c = c; }
        @Override public void write(int b) throws IOException { out.write(b); capture(new byte[] {(byte) b}, 0, 1); }
        @Override public void write(byte[] b, int off, int len) throws IOException { out.write(b, off, len); if (len > 0) capture(b, off, len); }
        @Override public void write(byte[] b) throws IOException { write(b, 0, b.length); }
        private void capture(byte[] b, int off, int len) {
            try { TraceRuntime.network("NETWORK_SEND", c.id, c.endpoint, b, off, len); } catch (Throwable ignored) { }
        }
    }
}
