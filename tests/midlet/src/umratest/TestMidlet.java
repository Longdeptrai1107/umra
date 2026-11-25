package umratest;

import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.*;
import javax.microedition.io.*;
import java.io.*;

/** Interactive fixture: every observation must be produced by a real callback. */
public final class TestMidlet extends MIDlet {
    private TestCanvas canvas;
    protected void startApp() {
        if (canvas == null) canvas = new TestCanvas();
        Display.getDisplay(this).setCurrent(canvas);
    }
    protected void pauseApp() { }
    protected void destroyApp(boolean unconditional) { }

    public static final class PlayerState {
        public int x = 10, hp = 100;
        public String secretToken = "fixture-secret-must-be-redacted";
        public void update(int amount) { x += amount; hp -= amount; }
        public String toString() { throw new IllegalStateException("Snapshots must not call application toString()"); }
    }
    public static final class TestCanvas extends Canvas {
        private final PlayerState player = new PlayerState();
        private String status = "Keys 1-6 or click A-F";
        protected void paint(Graphics g) {
            g.setColor(0x101b2d); g.fillRect(0, 0, getWidth(), getHeight());
            g.setColor(0x88baff); g.setFont(Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_SMALL));
            g.drawString("UMRA runtime test", 4, 1, Graphics.TOP | Graphics.LEFT);
            String[] labels = {"1  A: integer argument", "2  B: nested calls", "3  C: HTTP bytes", "4  D: exception", "5  E: object fields", "6  F: async worker"};
            for (int i = 0; i < labels.length; i++) {
                int y = 20 + i * 20; g.setColor(0x243b58); g.fillRect(3, y, getWidth() - 6, 18);
                g.setColor(0xc9dfff); g.drawString(labels[i], 6, y + 2, Graphics.TOP | Graphics.LEFT);
            }
            g.setColor(0x77d9ba); g.drawString(status, 4, 143, Graphics.TOP | Graphics.LEFT);
        }
        protected void keyPressed(int code) { if (code >= '1' && code <= '6') action(code - '1'); }
        protected void pointerPressed(int x, int y) { int button = (y - 20) / 20; if (y >= 20 && button < 6) action(button); }
        private void action(int button) {
            try {
                switch (button) {
                    case 0: status = "A=" + intAction(7); break;
                    case 1: status = "B=" + outer(3); break;
                    case 2: status = "C=" + network(); break;
                    case 3: expectedFailure(); break;
                    case 4: player.update(5); status = "E hp=" + player.hp; break;
                    case 5: asynchronous(); status = "F queued"; break;
                }
            } catch (Throwable e) { status = "Controlled exception"; }
            repaint();
        }
        private int intAction(int value) { return value * 2; }
        private int outer(int value) { return middle(value + 1); }
        private int middle(int value) { return leaf(value) + 10; }
        private int leaf(int value) { return value * 3; }
        private void expectedFailure() { throw new IllegalArgumentException("Controlled fixture exception"); }
        private void asynchronous() {
            Thread worker = new Thread(new Runnable() {
                public void run() { asyncWork(42); }
            }); worker.start();
        }
        private int asyncWork(int value) { return leaf(value) + 1; }
        private byte[] serialize() { return new byte[] {0x55, 0x4d, 0x52, 0x41, 3, 0x7f}; }
        private int network() throws IOException {
            HttpConnection connection = (HttpConnection) Connector.open("http://127.0.0.1:50123/echo");
            connection.setRequestMethod(HttpConnection.POST);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            OutputStream out = connection.openOutputStream();
            byte[] payload = serialize(); out.write(payload); out.flush(); out.close();
            InputStream in = connection.openInputStream(); byte[] response = new byte[64];
            int length = in.read(response); in.close(); connection.close();
            return parseResponse(response, length);
        }
        private int parseResponse(byte[] response, int length) { return length; }
    }
}
