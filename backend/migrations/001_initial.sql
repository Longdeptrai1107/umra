PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES(1);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_metadata(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  event_id TEXT NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL,
  class_name TEXT NOT NULL, method_name TEXT NOT NULL, thread_id INTEGER NOT NULL,
  trace_id TEXT, invocation_id TEXT, connection_id TEXT, data TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(session_id,timestamp);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(session_id,trace_id,seq);
CREATE INDEX IF NOT EXISTS idx_events_method ON events(session_id,class_name,method_name);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(session_id,thread_id,seq);
CREATE INDEX IF NOT EXISTS idx_events_connection ON events(session_id,connection_id,seq);
CREATE TABLE IF NOT EXISTS user_events(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, trace_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS method_invocations(
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, invocation_id TEXT NOT NULL,
  class_name TEXT NOT NULL, method_name TEXT NOT NULL, descriptor TEXT NOT NULL,
  thread_id INTEGER NOT NULL, trace_id TEXT, parent_id TEXT, started_at INTEGER NOT NULL,
  duration_ns INTEGER, entry TEXT NOT NULL, exit TEXT, PRIMARY KEY(session_id,invocation_id)
);
CREATE INDEX IF NOT EXISTS idx_invocation_trace ON method_invocations(session_id,trace_id,started_at);
CREATE INDEX IF NOT EXISTS idx_invocation_method ON method_invocations(session_id,class_name,method_name);
CREATE TABLE IF NOT EXISTS argument_snapshots(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, invocation_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exceptions(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, invocation_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS network_events(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, connection_id TEXT, trace_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_network_connection ON network_events(session_id,connection_id);
CREATE TABLE IF NOT EXISTS call_graph_edges(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, parent_id TEXT NOT NULL, child_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'observed-ancestry', PRIMARY KEY(session_id,parent_id,child_id));
CREATE TABLE IF NOT EXISTS mapping_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, original TEXT NOT NULL, alias TEXT NOT NULL, note TEXT NOT NULL, UNIQUE(session_id,kind,original));
CREATE TABLE IF NOT EXISTS instrumentation_warnings(event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, format TEXT NOT NULL, state TEXT NOT NULL);
