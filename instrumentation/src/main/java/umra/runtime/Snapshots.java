package umra.runtime;

import java.lang.reflect.*;
import java.util.*;
import static umra.runtime.Json.obj;

public final class Snapshots {
    public static volatile boolean redact = true, captureFields = false, capturePayload = false;
    public static Map<String, Object> take(Object v) { return take(v, 0, new int[] {48}); }
    private static Map<String, Object> take(Object v, int depth, int[] budget) {
        if (v == null) return obj("type", "null", "status", "observed", "value", null);
        Class<?> c = v.getClass();
        if (--budget[0] < 0) return obj("type", c.getName(), "status", "unavailable", "value", "Snapshot budget reached");
        Map<String, Object> result = obj("type", c.getName(), "status", "observed");
        if (c == String.class) {
            String text = (String) v;
            result.put("length", text.length());
            result.put("status", redact ? "redacted" : "observed");
            result.put("value", redact ? "[string redacted]" : text.substring(0, Math.min(512, text.length())));
            result.put("truncated", text.length() > 512);
        } else if (c == Integer.class || c == Long.class || c == Short.class || c == Byte.class
                || c == Float.class || c == Double.class || c == Boolean.class) result.put("value", v);
        else if (c == Character.class) result.put("value", String.valueOf(v));
        else if (c == byte[].class) {
            byte[] bytes = (byte[]) v;
            result.putAll(bytes(bytes, 0, bytes.length));
        } else if (c.isArray() && depth < 2) {
            int length = Array.getLength(v);
            result.put("length", length); result.put("truncated", length > 8);
            List<Object> items = new ArrayList<Object>();
            for (int i = 0; i < length && i < 8; i++) items.add(take(Array.get(v, i), depth + 1, budget));
            result.put("items", items);
        } else {
            result.put("identity", c.getName() + "@" + Integer.toHexString(System.identityHashCode(v)));
            if (captureFields && depth < 1 && !c.getName().startsWith("java.")) {
                Map<String, Object> fields = new LinkedHashMap<String, Object>();
                for (Field f : c.getDeclaredFields()) {
                    if (fields.size() >= 8 || Modifier.isStatic(f.getModifiers()) || f.isSynthetic()) continue;
                    if (redact && f.getName().toLowerCase(Locale.ROOT).matches(".*(pass|token|secret|auth|credential).*")) {
                        fields.put(f.getName(), obj("type", f.getType().getName(), "status", "redacted")); continue;
                    }
                    try { f.setAccessible(true); fields.put(f.getName(), take(f.get(v), depth + 1, budget)); }
                    catch (Throwable e) { fields.put(f.getName(), obj("type", f.getType().getName(), "status", "unavailable")); }
                }
                result.put("fields", fields);
            }
        }
        return result;
    }

    public static Map<String, Object> bytes(byte[] data, int offset, int length) {
        Map<String, Object> result = obj("type", "byte[]", "status", capturePayload ? "observed" : "redacted", "length", length);
        if (!capturePayload) return result;
        int n = Math.min(length, 512);
        StringBuilder hex = new StringBuilder(), ascii = new StringBuilder();
        final char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < n; i++) {
            int b = data[offset + i] & 255;
            hex.append(digits[b >> 4]).append(digits[b & 15]);
            ascii.append(b >= 32 && b < 127 ? (char) b : '.');
        }
        result.put("hex", hex.toString()); result.put("ascii", ascii.toString()); result.put("truncated", length > n);
        return result;
    }

    public static String endpoint(String value) {
        if (value == null) return "unknown";
        String s = value.substring(0, Math.min(value.length(), 1000));
        // User info and URL query/fragment may contain credentials.
        return s.replaceAll("(//)[^/@]+@", "$1[redacted]@").replaceAll("[?#].*", "?[redacted]");
    }
}
