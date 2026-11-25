package obfuscated;
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.*;

/** A third independent fixture with deliberately short symbols. */
public final class a extends MIDlet {
    protected void startApp() { Display.getDisplay(this).setCurrent(new b()); }
    protected void pauseApp() { }
    protected void destroyApp(boolean value) { }
    public static final class b extends Canvas {
        private int c;
        protected void paint(Graphics g) { g.setColor(0); g.fillRect(0,0,getWidth(),getHeight()); g.setColor(0xffffff); g.drawString("Independent game: " + c, 3, 20, Graphics.TOP | Graphics.LEFT); }
        protected void keyPressed(int code) { c = a(code); repaint(); }
        private int a(int n) { return n + 5; }
    }
}
