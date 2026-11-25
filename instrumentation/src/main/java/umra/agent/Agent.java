package umra.agent;

import java.io.*;
import java.lang.instrument.Instrumentation;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;

public final class Agent {
    private static JarFile bootstrap;
    public static void premain(String args, Instrumentation inst) {
        try { agentmain(args, inst); }
        catch (Throwable e) { System.err.println("[UMRA] Instrumentation failed: " + e); e.printStackTrace(); }
    }
    public static synchronized void agentmain(String args, Instrumentation inst) throws Exception {
        if (bootstrap != null) return;
        if (args == null || !args.startsWith("config=")) throw new IllegalArgumentException("Expected config=<properties path>");
        Properties p = new Properties();
        try (InputStream in = Files.newInputStream(Paths.get(args.substring(7)))) { p.load(in); }
        File source = new File(Agent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        File tmp = File.createTempFile("umra-runtime-", ".jar", Paths.get(args.substring(7)).toAbsolutePath().getParent().toFile()); tmp.deleteOnExit();
        try (JarFile jar = new JarFile(source); JarOutputStream out = new JarOutputStream(Files.newOutputStream(tmp.toPath()))) {
            Enumeration<JarEntry> entries = jar.entries(); byte[] buffer = new byte[8192];
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                if (!entry.getName().startsWith("umra/runtime/") || !entry.getName().endsWith(".class")) continue;
                out.putNextEntry(new JarEntry(entry.getName()));
                try (InputStream in = jar.getInputStream(entry)) {
                    int n; while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                }
                out.closeEntry();
            }
        }
        bootstrap = new JarFile(tmp); inst.appendToBootstrapClassLoaderSearch(bootstrap);
        Engine.install(p, inst);
    }
}
