package umra.agent;

import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;
import umra.runtime.*;

public final class Hooks {
    public static class Method {
        @Advice.OnMethodEnter(suppress = Throwable.class)
        public static long enter(@Advice.Origin("#t") String cls, @Advice.Origin("#m") String method,
                @Advice.Origin("#d") String descriptor, @Advice.This(optional = true) Object self,
                @Advice.AllArguments Object[] args) {
            try { return TraceRuntime.enter(cls, method, descriptor, self, args); }
            catch (Throwable error) { System.err.println("[UMRA] Method entry hook failed: " + error); return 0; }
        }
        @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
        public static void exit(@Advice.Enter long id, @Advice.Origin("#r") String returnType,
                @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object value,
                @Advice.Thrown Throwable thrown, @Advice.This(optional = true) Object self) {
            TraceRuntime.exit(id, value, thrown, "void".equals(returnType), self);
        }
    }
    public static class ClassLoaderAdapter {
        @Advice.OnMethodExit(suppress = Throwable.class)
        public static void exit(@Advice.Argument(0) String name, @Advice.Return(readOnly = false) boolean result) {
            if (name.startsWith("umra.runtime.")) result = true;
        }
    }
    public static class OpenConnection {
        @Advice.OnMethodExit(suppress = Throwable.class)
        public static void exit(@Advice.Argument(0) String endpoint, @Advice.Return Object connection) {
            NetworkHooks.opened(connection, endpoint);
        }
    }
    public static class OpenStream {
        @Advice.OnMethodExit(suppress = Throwable.class)
        public static void exit(@Advice.This Object self,
                @Advice.Return(readOnly = false, typing = Assigner.Typing.DYNAMIC) Object stream) {
            stream = NetworkHooks.wrap(self, stream);
        }
    }
    public static class Screen {
        @Advice.OnMethodExit(suppress = Throwable.class)
        public static void exit(@Advice.Argument(0) Object displayable) { TraceRuntime.screen(displayable); }
    }
}
