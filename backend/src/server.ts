import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { sessionConfigSchema, traceOptionsSchema, eventTypes, type TraceEvent, type ServerMessage, type Session } from '../../shared-schemas';
import { Sessions, type BackendOptions } from './sessions';
import { ApiError, discoverRuntimes, analyzeJar, execute } from './java';

const filterSchema = z.object({
  q: z.string().max(300).default(''), traceId: z.string().max(120).default(''),
  threadId: z.coerce.number().int().nonnegative().optional(), connectionId: z.string().max(120).default(''),
  types: z.array(z.enum(eventTypes)).max(eventTypes.length).default([]),
});
type Filter = z.infer<typeof filterSchema>;
function matches(e: TraceEvent, f: Filter) {
  return (!f.traceId || e.traceId === f.traceId) && (f.threadId === undefined || e.threadId === f.threadId)
    && (!f.connectionId || e.data?.connectionId === f.connectionId) && (!f.types.length || f.types.includes(e.type))
    && (!f.q || (e.className + '.' + e.methodName + ' ' + JSON.stringify(e.data ?? {})).toLowerCase().includes(f.q.toLowerCase()));
}
function sqlFilter(id: string, filter: Filter, after: number) {
  const conditions = ['session_id=?', 'seq>?']; const params: (string | number)[] = [id, after];
  if (filter.traceId) { conditions.push('trace_id=?'); params.push(filter.traceId); }
  if (filter.threadId !== undefined) { conditions.push('thread_id=?'); params.push(filter.threadId); }
  if (filter.connectionId) { conditions.push('connection_id=?'); params.push(filter.connectionId); }
  if (filter.types.length) { conditions.push(`type IN (${filter.types.map(() => '?').join(',')})`); params.push(...filter.types); }
  if (filter.q) { conditions.push("(class_name LIKE ? ESCAPE '\\' OR method_name LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')"); const q = '%' + filter.q.replace(/[\\%_]/g, '\\$&') + '%'; params.push(q, q, q); }
  return { where: conditions.join(' AND '), params };
}

export async function createBackend(options: BackendOptions) {
  const token = options.token ?? crypto.randomBytes(32).toString('hex');
  const sessions = new Sessions(options); await sessions.init();
  const app = express(); app.disable('x-powered-by');
  const server = http.createServer(app);
  let origin = '';
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== new URL(origin || 'http://127.0.0.1').host) { res.status(403).json({ error: { code: 'INVALID_HOST', message: 'Loopback host required' } }); return; }
    if (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== options.devOrigin) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Origin is not allowed' } }); return; }
    if (options.devOrigin && req.headers.origin === options.devOrigin) {
      res.setHeader('Access-Control-Allow-Origin', options.devOrigin!);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.get('authorization') !== `Bearer ${token}`) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'A valid local UMRA token is required' } }); return; }
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use(express.json({ limit: '128kb', strict: true }));
  const api = express.Router();
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
  const sid = (req: express.Request) => z.string().uuid().parse(req.params.id);
  api.get('/health', (_req, res) => res.json({ ok: true, version: '1.0.0', transport: 'UMRA/1', database: 'SQLite (WASM in worker thread)', runtimePortBoundTo: '127.0.0.1' }));
  api.get('/runtimes', wrap(async (_req, res) => res.json(await discoverRuntimes())));
  api.get('/jars', (_req, res) => res.json([...new Set([...sessions.sessions.values()].map(s => s.gamePath))]));
  api.post('/jars/analyze', wrap(async (req, res) => {
    const p = z.object({ javaPath: z.string().min(1).max(2000), gamePath: z.string().min(1).max(2000) }).parse(req.body);
    res.json(await analyzeJar(p.javaPath, options.agentPath, p.gamePath));
  }));
  api.get('/sessions', (_req, res) => res.json([...sessions.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)));
  api.post('/sessions', wrap(async (req, res) => res.status(201).json(await sessions.create(sessionConfigSchema.parse(req.body)))));
  api.get('/sessions/:id', (req, res) => res.json(sessions.get(sid(req))));
  api.delete('/sessions/:id', wrap(async (req, res) => { await sessions.delete(sid(req)); res.status(204).end(); }));
  api.post('/sessions/:id/launch', wrap(async (req, res) => res.status(202).json(await sessions.launch(sid(req)))));
  api.post('/sessions/:id/stop', wrap(async (req, res) => res.json(await sessions.stop(sid(req)))));
  api.post('/sessions/:id/trace/start', wrap(async (req, res) => res.json(await sessions.startTrace(sid(req), traceOptionsSchema.parse(req.body)))));
  api.post('/sessions/:id/trace/stop', wrap(async (req, res) => res.json(await sessions.stopTrace(sid(req)))));
  api.post('/sessions/:id/trace/pause', wrap(async (req, res) => res.json(await sessions.pauseTrace(sid(req)))));
  api.post('/sessions/:id/markers', wrap(async (req, res) => { const p = z.object({ message: z.string().min(1).max(200) }).parse(req.body); res.status(202).json(await sessions.marker(sid(req), p.message)); }));
  api.get('/sessions/:id/stats', (req, res) => res.json(sessions.stats(sid(req))));
  api.get('/sessions/:id/console', (req, res) => res.json(sessions.live.get(sessions.get(sid(req)).id)!.console));
  api.get('/sessions/:id/events', wrap(async (req, res) => {
    const id = sid(req); sessions.get(id); await sessions.drain();
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    const limit = z.coerce.number().int().min(1).max(2000).default(500).parse(req.query.limit);
    const filter = filterSchema.parse({ ...req.query, types: typeof req.query.types === 'string' && req.query.types ? req.query.types.split(',') : [] });
    const f = sqlFilter(id, filter, after);
    const rows = await sessions.db.query(`SELECT data FROM events WHERE ${f.where} ORDER BY seq ${req.query.tail === 'true' ? 'DESC' : 'ASC'} LIMIT ?`, [...f.params, limit]);
    const events = rows.map(r => JSON.parse(r.data) as TraceEvent); if (req.query.tail === 'true') events.reverse();
    res.json({ events, latestSeq: sessions.live.get(id)!.seq, nextAfter: events.at(-1)?.seq ?? after, limit });
  }));
  api.get('/sessions/:id/methods', wrap(async (req, res) => {
    const id = sid(req); sessions.get(id); await sessions.drain();
    const filter = z.string().max(300).default('').parse(req.query.q);
    const rows = await sessions.db.query(`SELECT class_name AS className,method_name AS methodName,descriptor,COUNT(*) AS calls,
      SUM(CASE WHEN exit LIKE '%METHOD_EXCEPTION%' THEN 1 ELSE 0 END) AS exceptions,AVG(duration_ns) AS averageNs,MAX(duration_ns) AS maxNs
      FROM method_invocations WHERE session_id=? AND (instr(class_name,?)>0 OR instr(method_name,?)>0)
      GROUP BY class_name,method_name,descriptor ORDER BY calls DESC LIMIT 1000`, [id, filter, filter]);
    res.json({ methods: rows, limit: 1000 });
  }));
  api.get('/sessions/:id/invocations/:invocation', wrap(async (req, res) => {
    const id = sid(req); sessions.get(id); await sessions.drain();
    const invocation = z.string().max(120).parse(req.params.invocation);
    const rows = await sessions.db.query('SELECT entry,exit FROM method_invocations WHERE session_id=? AND invocation_id=?', [id, invocation]);
    if (!rows.length) throw new ApiError(404, 'INVOCATION_NOT_FOUND', 'Invocation is outside the observed method scope or has not arrived');
    res.json({ entry: JSON.parse(rows[0].entry), exit: rows[0].exit ? JSON.parse(rows[0].exit) : null });
  }));
  api.get('/sessions/:id/callgraph', wrap(async (req, res) => {
    const id = sid(req); sessions.get(id); await sessions.drain();
    const trace = z.string().max(120).default('').parse(req.query.traceId);
    const nodes = await sessions.db.query('SELECT invocation_id AS id,parent_id AS parentId,entry,exit,duration_ns AS durationNs FROM method_invocations WHERE session_id=? AND (?=\'\' OR trace_id=?) ORDER BY started_at,CAST(invocation_id AS INTEGER) LIMIT 5001', [id, trace, trace]);
    const clipped = nodes.length > 5000;
    res.json({ nodes: nodes.slice(0, 5000).map(n => ({ ...n, entry: JSON.parse(n.entry), exit: n.exit ? JSON.parse(n.exit) : null })),
      relation: 'observed-ancestry', truncated: clipped, limit: 5000, note: 'Parents are known only within observed runtime frames; asynchronous threads have independent roots.' });
  }));
  api.get('/sessions/:id/network', wrap(async (req, res) => {
    const id = sid(req); sessions.get(id); await sessions.drain();
    const trace = z.string().max(120).default('').parse(req.query.traceId);
    const rows = await sessions.db.query('SELECT data FROM network_events WHERE session_id=? AND (?=\'\' OR trace_id=?) ORDER BY rowid DESC LIMIT 2000', [id, trace, trace]);
    res.json({ events: rows.reverse().map(r => JSON.parse(r.data)), limit: 2000 });
  }));
  api.get('/sessions/:id/jar', wrap(async (req, res) => {
    const id = sid(req), s = sessions.get(id), live = sessions.live.get(id)!;
    live.jar ??= await analyzeJar(s.javaPath, options.agentPath, s.gamePath); res.json(live.jar);
  }));
  api.get('/sessions/:id/bytecode', wrap(async (req, res) => {
    const s = sessions.get(sid(req)); const name = z.string().min(1).max(500).parse(req.query.className);
    const jar = sessions.live.get(s.id)!.jar ?? await analyzeJar(s.javaPath, options.agentPath, s.gamePath);
    if (!jar.classes.some(c => c.name === name)) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class is not in the selected game JAR');
    res.json(JSON.parse(await execute(s.javaPath, ['-jar', options.agentPath, 'bytecode', jar.path, name])));
  }));
  api.get('/sessions/:id/mappings', wrap(async (req, res) => { const id = sid(req); sessions.get(id); res.json(await sessions.db.query('SELECT id,session_id AS sessionId,kind,original,alias,note FROM mapping_entries WHERE session_id=? ORDER BY kind,original', [id])); }));
  api.post('/sessions/:id/mappings', wrap(async (req, res) => {
    const id = sid(req); sessions.get(id);
    const p = z.object({ kind: z.enum(['class', 'method']), original: z.string().min(1).max(1000), alias: z.string().trim().min(1).max(200), note: z.string().max(2000).default('') }).parse(req.body);
    await sessions.db.run('INSERT INTO mapping_entries(session_id,kind,original,alias,note) VALUES(?,?,?,?,?) ON CONFLICT(session_id,kind,original) DO UPDATE SET alias=excluded.alias,note=excluded.note', [id, p.kind, p.original, p.alias, p.note]); await sessions.db.flush(); res.status(201).json(p);
  }));
  api.delete('/sessions/:id/mappings/:mapping', wrap(async (req, res) => { const id = sid(req); sessions.get(id); const mapping = z.coerce.number().int().positive().parse(req.params.mapping); await sessions.db.run('DELETE FROM mapping_entries WHERE session_id=? AND id=?', [id, mapping]); await sessions.db.flush(); res.status(204).end(); }));
  api.get('/sessions/:id/report', wrap(async (req, res) => {
    const id = sid(req), s = sessions.get(id); await sessions.drain();
    const counts = await sessions.db.query('SELECT type,COUNT(*) AS count FROM events WHERE session_id=? GROUP BY type', [id]);
    const warnings = await sessions.db.query('SELECT data FROM instrumentation_warnings WHERE session_id=? ORDER BY rowid DESC LIMIT 100', [id]);
    res.json({ session: s, counts, stats: sessions.stats(id), warnings: warnings.map(w => JSON.parse(w.data)), limitations: [
      'Application stream chunks are not protocol packets. Opcodes, encryption and serialization boundaries require a protocol adapter.',
      'No automatic causal propagation across asynchronous threads. Constructor, native, static initializer and direct field write tracing are excluded.',
      'Bytecode offsets are unavailable. Field snapshots may differ because game state can change concurrently.',
      'Snapshots are bounded. Strings and payloads are redacted by default. Java CPU percentage is unavailable in this adapter.',
    ] });
  }));
  api.get('/sessions/:id/export', wrap(async (req, res) => {
    const id = sid(req), s = sessions.get(id); await sessions.drain();
    const format = z.enum(['ndjson', 'json', 'csv', 'report']).default('ndjson').parse(req.query.format);
    const job = crypto.randomUUID(); await sessions.db.run('INSERT INTO export_jobs VALUES(?,?,?,?,?)', [job, id, Date.now(), format, 'running']);
    res.setHeader('Content-Disposition', `attachment; filename="umra-${id}.${format === 'report' ? 'json' : format}"`);
    res.type(format === 'ndjson' ? 'application/x-ndjson' : format === 'csv' ? 'text/csv' : 'application/json');
    try {
      const write = async (text: string) => { if (!res.write(text)) await once(res, 'drain'); };
      if (format === 'report') { await write(JSON.stringify({ session: s, stats: sessions.stats(id), note: 'Detailed events are available in JSON/NDJSON/CSV exports.' }, null, 2)); }
      else {
        if (format === 'json') await write('{"version":1,"session":' + JSON.stringify(s) + ',"events":[');
        if (format === 'csv') await write('seq,timestamp,type,className,methodName,threadId,traceId,invocationId,detail\r\n');
        let after = 0, first = true;
        for (;;) {
          const rows = await sessions.db.query('SELECT seq,data FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 1000', [id, after]);
          if (!rows.length || res.destroyed) break;
          for (const row of rows) {
            const e: TraceEvent = JSON.parse(row.data);
            if (format === 'ndjson') await write(row.data + '\n');
            if (format === 'json') { await write((first ? '' : ',') + row.data); first = false; }
            if (format === 'csv') {
              const cell = (v: unknown) => '"' + String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
              await write([e.seq, e.timestamp, e.type, e.className, e.methodName, e.threadId, e.traceId, e.invocationId, JSON.stringify(e.data ?? e.arguments ?? {})].map(cell).join(',') + '\r\n');
            }
            after = row.seq;
          }
        }
        if (format === 'json') await write(']}');
      }
      await sessions.db.run('UPDATE export_jobs SET state=? WHERE id=?', [res.destroyed ? 'cancelled' : 'completed', job]); res.end();
    } catch (e) { await sessions.db.run('UPDATE export_jobs SET state=? WHERE id=?', ['failed', job]); throw e; }
  }));
  app.use('/api/v1', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'ENDPOINT_NOT_FOUND', message: 'API endpoint does not exist' } }));
  app.use(express.static(options.frontendDir, { index: 'index.html' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = error instanceof ZodError ? 400 : error.status ?? 500;
    res.status(status).json({ error: { code: error instanceof ZodError ? 'VALIDATION_ERROR' : error.code ?? 'INTERNAL_ERROR', message: error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message ?? 'Unexpected backend error' } });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false, handleProtocols: () => 'umra-v1' });
  const clients = new Map<WebSocket, { id: string; filter: Filter; subscribed: boolean; dropped: number; alive: boolean; cursor: number; version: number; rateStart: number; messages: number }>();
  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/ws\/v1\/sessions\/([\da-f-]{36})\/live$/);
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim());
    if (!match || !sessions.sessions.has(match[1]) || !protocols.includes('auth.' + token) || clients.size >= 8
      || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== options.devOrigin)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, match[1]));
  });
  function send(ws: WebSocket, message: ServerMessage) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, id: string) => {
    const client = { id, filter: filterSchema.parse({}), subscribed: false, dropped: 0, alive: true, cursor: 0, version: 0, rateStart: Date.now(), messages: 0 }; clients.set(ws, client);
    send(ws, { type: 'hello', session: sessions.get(id), latestSeq: sessions.live.get(id)!.seq });
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', async data => {
      try {
        if (Date.now() - client.rateStart > 1000) { client.rateStart = Date.now(); client.messages = 0; }
        if (++client.messages > 20) { ws.close(1008, 'Control message rate exceeded'); return; }
        const command = z.object({ type: z.enum(['subscribe', 'unsubscribe', 'filter', 'ping']), after: z.number().int().min(0).default(0), filter: filterSchema.default({}) }).parse(JSON.parse(data.toString()));
        if (command.type === 'ping') { send(ws, { type: 'heartbeat', latestSeq: sessions.live.get(id)!.seq }); return; }
        if (command.type === 'unsubscribe') { client.subscribed = false; client.version++; return; }
        client.filter = command.filter;
        if (command.type === 'subscribe') {
          const version = ++client.version;
          client.subscribed = false; await sessions.drain();
          const checkpoint = sessions.live.get(id)!.persistedSeq;
          const f = sqlFilter(id, client.filter, command.after);
          const rows = await sessions.db.query(`SELECT data FROM events WHERE ${f.where} AND seq<=? ORDER BY seq LIMIT 4001`, [...f.params, checkpoint]);
          if (client.version !== version || ws.readyState !== WebSocket.OPEN) return;
          for (let i = 0; i < Math.min(rows.length, 4000); i += 32) {
            if (ws.bufferedAmount > 1024 * 1024) { send(ws, { type: 'gap', to: checkpoint, message: 'Replay exceeded the socket output budget. Use history search/export for remaining records.' }); break; }
            send(ws, { type: 'batch', events: rows.slice(i, Math.min(i + 32, 4000)).map(r => JSON.parse(r.data)), latestSeq: checkpoint });
          }
          if (rows.length > 4000) send(ws, { type: 'gap', from: JSON.parse(rows[3999].data).seq + 1, to: checkpoint, message: 'Replay limit is 4000 events; use history search/export for the remaining records' });
          client.subscribed = true;
          client.cursor = checkpoint;
          const persisted = sessions.live.get(id)!.persistedSeq;
          const catchup = sessions.live.get(id)!.ring.filter(e => e.seq > checkpoint && e.seq <= persisted && matches(e, client.filter));
          for (let i = 0; i < catchup.length; i += 64) send(ws, { type: 'batch', events: catchup.slice(i, i + 64), latestSeq: catchup.at(-1)!.seq });
          client.cursor = persisted;
          send(ws, { type: 'heartbeat', latestSeq: checkpoint });
        }
      } catch (e) { send(ws, { type: 'warning', message: 'Invalid subscription: ' + String(e).slice(0, 300) }); }
    });
    ws.on('close', () => clients.delete(ws)); ws.on('error', () => clients.delete(ws));
  });
  const onBatch = (id: string, events: TraceEvent[]) => {
    for (const [ws, client] of clients) {
      if (client.id !== id || !client.subscribed) continue;
      const selected = events.filter(e => e.seq > client.cursor && matches(e, client.filter));
      client.cursor = Math.max(client.cursor, events.at(-1)?.seq ?? 0);
      if (ws.bufferedAmount > 1024 * 1024) { client.dropped += selected.length; continue; }
      if (client.dropped) { send(ws, { type: 'gap', dropped: client.dropped, message: 'WebSocket client could not keep up. Records remain queryable in SQLite.' }); client.dropped = 0; }
      for (let i = 0; i < selected.length; i += 64) send(ws, { type: 'batch', events: selected.slice(i, i + 64), latestSeq: events.at(-1)!.seq });
    }
  };
  const onState = (s: Session) => { for (const [ws, client] of clients) if (client.id === s.id) send(ws, { type: 'state', session: s }); };
  sessions.on('batch', onBatch); sessions.on('state', onState);
  const heartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) { ws.terminate(); continue; }
      client.alive = false; ws.ping(); send(ws, { type: 'heartbeat', latestSeq: sessions.live.get(client.id)?.seq ?? 0 });
    }
  }, 15000);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return { origin, token, sessions, server,
    async close() {
      clearInterval(heartbeat); for (const ws of clients.keys()) ws.terminate(); wss.close();
      await sessions.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
