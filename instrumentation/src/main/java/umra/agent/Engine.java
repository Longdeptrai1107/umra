package umra.agent;

import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.description.method.MethodDescription;
import net.bytebuddy.matcher.ElementMatcher.Junction;
import net.bytebuddy.utility.JavaModule;
import net.bytebuddy.dynamic.ClassFileLocator;
import net.bytebuddy.dynamic.DynamicType;
import umra.runtime.TraceRuntime;
import java.lang.instrument.Instrumentation;
import java.util.Properties;
import static net.bytebuddy.matcher.ElementMatchers.*;

final class Engine {
    static void install(Properties p, Instrumentation inst) {
        TraceRuntime.configure(p);
        if (!inst.isRetransformClassesSupported()) {
            TraceRuntime.status("INSTRUMENTATION_FAILED", "Desktop JVM must support class retransformation"); return;
        }
        final String loader = "org.microemu.app.classloader.MIDletClassLoader";
        final String connector = "javax.microedition.io.Connector";
        final String display = "javax.microedition.lcdui.Display";
        final String[] streams = {"org.microemu.cldc.http.Connection", "org.microemu.cldc.socket.SocketConnection"};
        String[] classes = p.getProperty("classes", "").split(",");
        Junction<TypeDescription> game = namedOneOf(classes);
        Junction<TypeDescription> adapter = named(loader).or(named(connector)).or(named(display)).or(namedOneOf(streams));
        new AgentBuilder.Default().disableClassFormatChanges()
                .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
                .with(new AgentBuilder.LocationStrategy.Compound(AgentBuilder.LocationStrategy.ForClassLoader.STRONG,
                        new AgentBuilder.LocationStrategy.Simple(ClassFileLocator.ForClassLoader.ofSystemLoader())))
                .ignore(nameStartsWith("umra.").or(nameStartsWith("net.bytebuddy.")))
                .type(game.or(adapter))
                .transform((builder, type, cl, module, domain) -> {
                    String name = type.getName();
                    if (name.equals(loader)) return builder.visit(Advice.to(Hooks.ClassLoaderAdapter.class).on(named("classLoadByParent")));
                    if (name.equals(connector)) return builder.visit(Advice.to(Hooks.OpenConnection.class).on(named("open").and(returns(named("javax.microedition.io.Connection")))));
                    if (name.equals(display)) return builder.visit(Advice.to(Hooks.Screen.class).on(named("setCurrent").and(takesArguments(1))));
                    if (name.equals(streams[0]) || name.equals(streams[1])) return builder.visit(Advice.to(Hooks.OpenStream.class).on(named("openInputStream").or(named("openOutputStream"))));
                    Junction<MethodDescription> methods = isMethod().and(not(isAbstract())).and(not(isNative())).and(not(isSynthetic()));
                    return builder.visit(Advice.to(Hooks.Method.class).on(methods));
                })
                .with(new AgentBuilder.Listener.Adapter() {
                    @Override public void onTransformation(TypeDescription type, ClassLoader cl, JavaModule module, boolean loaded, DynamicType dynamicType) {
                        TraceRuntime.status("CLASS_INSTRUMENTED", type.getName());
                    }
                    @Override public void onError(String name, ClassLoader cl, JavaModule module, boolean loaded, Throwable error) {
                        TraceRuntime.warning("Cannot instrument " + name + ": " + error, 0);
                        System.err.println("[UMRA] " + name + ": " + error);
                        error.printStackTrace(System.err);
                    }
                }).installOn(inst);
        TraceRuntime.status("INSTRUMENTATION_READY", "Game methods + MicroEmulator 2.x loader, input, display and HTTP/socket adapters installed");
    }
}
