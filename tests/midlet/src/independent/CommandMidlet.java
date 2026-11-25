package independent;
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.*;

/** Independent Form/CommandListener fixture, not the Canvas fixture's class hierarchy. */
public final class CommandMidlet extends MIDlet implements CommandListener {
    private final Form form = new Form("Independent command game");
    private final Command increase = new Command("Increase", Command.OK, 1);
    private int points;
    protected void startApp() {
        form.append("Use the Increase command to score."); form.addCommand(increase); form.setCommandListener(this);
        Display.getDisplay(this).setCurrent(form);
    }
    protected void pauseApp() { }
    protected void destroyApp(boolean value) { }
    public void commandAction(Command command, Displayable displayable) {
        points = score(points, 9); form.append("Points: " + points);
    }
    private int score(int old, int addition) { return old + addition; }
}
