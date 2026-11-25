package umra.runtime;

import java.util.*;

/** Small bounded-value JSON writer; runtime has no external dependency. */
public final class Json {
    public static Map<String, Object> obj(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }
    public static String encode(Object value) { StringBuilder out = new StringBuilder(); write(out, value); return out.toString(); }
    private static void write(StringBuilder out, Object v) {
        if (v == null) out.append("null");
        else if (v instanceof String) {
            out.append('"');
            String s = (String) v;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': out.append("\\\""); break;
                    case '\\': out.append("\\\\"); break;
                    case '\n': out.append("\\n"); break;
                    case '\r': out.append("\\r"); break;
                    case '\t': out.append("\\t"); break;
                    default: if (c < 32) out.append(String.format("\\u%04x", (int) c)); else out.append(c);
                }
            }
            out.append('"');
        } else if (v instanceof Boolean || v instanceof Number) {
            String s = v.toString();
            out.append("NaN".equals(s) || s.contains("Infinity") ? "null" : s);
        } else if (v instanceof Map) {
            out.append('{'); boolean comma = false;
            for (Object entryObject : ((Map<?, ?>) v).entrySet()) {
                Map.Entry<?, ?> e = (Map.Entry<?, ?>) entryObject;
                if (comma) out.append(','); comma = true;
                write(out, e.getKey()); out.append(':'); write(out, e.getValue());
            }
            out.append('}');
        } else if (v instanceof Iterable) {
            out.append('['); boolean comma = false;
            for (Object item : (Iterable<?>) v) { if (comma) out.append(','); comma = true; write(out, item); }
            out.append(']');
        } else throw new IllegalArgumentException("Unsupported JSON value");
    }
}
