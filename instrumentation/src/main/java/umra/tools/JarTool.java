package umra.tools;

import net.bytebuddy.jar.asm.*;
import umra.runtime.Json;
import java.io.*;
import java.util.*;
import java.util.jar.*;
import java.nio.file.*;
import static umra.runtime.Json.obj;

/** Static analysis only. Never loads or initializes classes from the inspected game. */
public final class JarTool {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) throw new IllegalArgumentException("inspect <jar> | bytecode <jar> <class>");
        if ("legacy-fixture".equals(args[0])) {
            // Test fixture conversion, never used to rewrite a user's game.
            try (java.util.stream.Stream<Path> files = Files.walk(Paths.get(args[1]))) {
                Iterator<Path> iterator = files.filter(p -> p.toString().endsWith(".class")).iterator();
                while (iterator.hasNext()) {
                    Path file = iterator.next(); ClassReader reader = new ClassReader(Files.readAllBytes(file));
                    final ClassWriter writer = new ClassWriter(0);
                    reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                        @Override public void visit(int version, int access, String name, String signature, String superName, String[] interfaces) {
                            super.visit(Opcodes.V1_4, access, name, signature, superName, interfaces);
                        }
                    }, ClassReader.SKIP_FRAMES);
                    Files.write(file, writer.toByteArray());
                }
            }
            return;
        }
        try (JarFile jar = new JarFile(args[1])) {
            if ("bytecode".equals(args[0])) {
                final List<String> lines = new ArrayList<String>();
                JarEntry entry = jar.getJarEntry(args[2].replace('.', '/') + ".class");
                if (entry == null) throw new IOException("Class not found");
                new ClassReader(read(jar, entry)).accept(new ClassVisitor(Opcodes.ASM9) {
                    @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                        lines.add("\n" + name + descriptor + "  // instruction indices, NOT bytecode offsets");
                        return new MethodVisitor(Opcodes.ASM9) {
                            int index;
                            void line(String s) { if (lines.size() < 20000) lines.add(String.format("  %04d  %s", index++, s)); }
                            @Override public void visitInsn(int opcode) { line("opcode " + opcode); }
                            @Override public void visitIntInsn(int opcode, int operand) { line("opcode " + opcode + " " + operand); }
                            @Override public void visitVarInsn(int opcode, int var) { line("opcode " + opcode + " local=" + var); }
                            @Override public void visitTypeInsn(int opcode, String type) { line("opcode " + opcode + " " + type); }
                            @Override public void visitFieldInsn(int opcode, String owner, String name, String descriptor) { line("opcode " + opcode + " " + owner + "." + name + " " + descriptor); }
                            @Override public void visitMethodInsn(int opcode, String owner, String name, String descriptor, boolean itf) { line("invoke " + owner + "." + name + descriptor); }
                            @Override public void visitLdcInsn(Object value) { String s = String.valueOf(value); line("ldc " + s.substring(0, Math.min(s.length(), 200))); }
                            @Override public void visitJumpInsn(int opcode, Label label) { line("jump opcode " + opcode); }
                            @Override public void visitIincInsn(int var, int increment) { line("iinc local=" + var + " by=" + increment); }
                            @Override public void visitTableSwitchInsn(int min, int max, Label dflt, Label... labels) { line("tableswitch " + min + ".." + max); }
                            @Override public void visitLookupSwitchInsn(Label dflt, int[] keys, Label[] labels) { line("lookupswitch " + Arrays.toString(keys)); }
                            @Override public void visitMultiANewArrayInsn(String desc, int dimensions) { line("multianewarray " + desc + " dimensions=" + dimensions); }
                            @Override public void visitInvokeDynamicInsn(String name, String desc, Handle handle, Object... args) { line("invokedynamic " + name + desc); }
                        };
                    }
                }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                System.out.println(Json.encode(obj("className", args[2], "lines", lines))); return;
            }
            List<Object> classes = new ArrayList<Object>(); List<String> warnings = new ArrayList<String>();
            Enumeration<JarEntry> entries = jar.entries(); long total = 0;
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                if (!entry.getName().endsWith(".class") || entry.getName().startsWith("META-INF/versions/")) continue;
                if (classes.size() >= 20000) throw new IOException("JAR has more than 20,000 classes");
                byte[] bytes = read(jar, entry); total += bytes.length;
                if (total > 128 * 1024 * 1024) throw new IOException("Uncompressed classes exceed 128 MiB");
                final Map<String, Object> c = obj("name", "", "superName", "");
                final List<Object> methods = new ArrayList<Object>(), fields = new ArrayList<Object>();
                c.put("methods", methods); c.put("fields", fields);
                try {
                    new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
                        @Override public void visit(int version, int access, String name, String sig, String sup, String[] interfaces) {
                            c.put("name", name.replace('/', '.')); c.put("superName", sup == null ? "" : sup.replace('/', '.'));
                        }
                        @Override public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] exceptions) {
                            methods.add(obj("name", name, "descriptor", desc, "access", access)); return null;
                        }
                        @Override public FieldVisitor visitField(int access, String name, String desc, String sig, Object value) {
                            fields.add(obj("name", name, "descriptor", desc)); return null;
                        }
                    }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                    classes.add(c);
                } catch (Throwable e) { if (warnings.size() < 100) warnings.add(entry.getName() + ": " + e); }
            }
            Manifest manifest = jar.getManifest(); StringBuilder text = new StringBuilder();
            if (manifest != null) for (Map.Entry<Object, Object> e : manifest.getMainAttributes().entrySet()) text.append(e.getKey()).append(": ").append(e.getValue()).append('\n');
            System.out.println(Json.encode(obj("classes", classes, "manifest", text.toString(), "warnings", warnings)));
        }
    }
    private static byte[] read(JarFile jar, JarEntry entry) throws IOException {
        if (entry.getSize() > 8 * 1024 * 1024) throw new IOException("Class exceeds 8 MiB");
        try (InputStream in = jar.getInputStream(entry); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) != -1) { if (out.size() + n > 8 * 1024 * 1024) throw new IOException("Class exceeds 8 MiB"); out.write(buffer, 0, n); }
            return out.toByteArray();
        }
    }
}
