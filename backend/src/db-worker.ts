import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { TraceEvent } from '../../shared-schemas';

let db: Database;
let dirty = false;
let saving: Promise<void> = Promise.resolve();
const file: string = workerData.file;
const ready = (async () => {
  const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = await fs.readFile(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined; });
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run(await fs.readFile(path.join(workerData.migrations, '001_initial.sql'), 'utf8'));
  db.run('PRAGMA foreign_keys = ON');
  dirty = true;
})();
function rows(sql: string, params: (string | number | null)[] = []): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  try { statement.bind(params); const out = []; while (statement.step()) out.push(statement.getAsObject()); return out; }
  finally { statement.free(); }
}
function save(): Promise<void> {
  saving = saving.then(async () => {
    if (!dirty) return;
    dirty = false;
    const bytes = db.export();
    db.run('PRAGMA foreign_keys = ON');
    await fs.writeFile(file + '.tmp', bytes);
    await fs.rename(file + '.tmp', file);
  });
  return saving;
}
function insertEvents(events: TraceEvent[]) {
  db.run('BEGIN');
  try {
    for (const e of events) {
      const json = JSON.stringify(e), sid = e.sessionId;
      db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [sid, e.seq, e.eventId, e.timestamp, e.type,
        e.className, e.methodName, e.threadId, e.traceId, e.invocationId, String(e.data?.connectionId ?? '') || null, json]);
      if (['USER_INPUT', 'LIFECYCLE', 'SCREEN_CHANGE'].includes(e.type)) db.run('INSERT INTO user_events VALUES(?,?,?,?)', [e.eventId, sid, e.traceId, json]);
      if (e.type === 'METHOD_ENTER' && e.invocationId) {
        db.run('INSERT INTO method_invocations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [sid, e.invocationId, e.className,
          e.methodName, e.descriptor, e.threadId, e.traceId, e.parentId, e.timestamp, null, json, null]);
        if (e.parentId) db.run("INSERT OR IGNORE INTO call_graph_edges SELECT ?,?,?,'observed-ancestry' WHERE EXISTS(SELECT 1 FROM method_invocations WHERE session_id=? AND invocation_id=?)",
          [sid, e.parentId, e.invocationId, sid, e.parentId]);
      }
      if (['METHOD_EXIT', 'METHOD_EXCEPTION'].includes(e.type) && e.invocationId) db.run('UPDATE method_invocations SET exit=?,duration_ns=? WHERE session_id=? AND invocation_id=?', [json, e.durationNs ?? null, sid, e.invocationId]);
      if (e.arguments) db.run('INSERT INTO argument_snapshots VALUES(?,?,?,?)', [e.eventId, sid, e.invocationId, JSON.stringify(e.arguments)]);
      if (e.exception) db.run('INSERT INTO exceptions VALUES(?,?,?,?)', [e.eventId, sid, e.invocationId, JSON.stringify(e.exception)]);
      if (e.type.startsWith('NETWORK_')) db.run('INSERT INTO network_events VALUES(?,?,?,?,?)', [e.eventId, sid, String(e.data?.connectionId ?? ''), e.traceId, json]);
      if (e.type === 'TRACE_WARNING') db.run('INSERT INTO instrumentation_warnings VALUES(?,?,?)', [e.eventId, sid, json]);
    }
    db.run('COMMIT'); dirty = true;
  } catch (e) { db.run('ROLLBACK'); throw e; }
}

async function handle(method: string, p: any): Promise<unknown> {
  await ready;
  if (method === 'query') return rows(p.sql, p.params);
  if (method === 'run') { db.run(p.sql, p.params); dirty = true; return true; }
  if (method === 'events') { insertEvents(p); return true; }
  if (method === 'flush') { await save(); return true; }
  throw new Error('Unknown database operation');
}
let chain = Promise.resolve();
parentPort!.on('message', ({ id, method, params }) => {
  chain = chain.then(async () => {
    try { parentPort!.postMessage({ id, result: await handle(method, params) }); }
    catch (e) { parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) }); }
  });
});
const timer = setInterval(() => { chain = chain.then(() => ready).then(() => save()).catch(e => parentPort!.postMessage({ fatal: String(e) })); }, 1500);
timer.unref();
