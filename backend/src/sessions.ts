import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { runtimeEventSchema, type Session, type SessionConfig, type TraceEvent, type TraceOptions, type JarAnalysis } from '../../shared-schemas';
import { Database } from './database';
import { ApiError, analyzeJar, probeJava, properties, realFile } from './java';

interface Live {
  socket?: net.Socket; child?: ChildProcess; seq: number; persistedSeq: number; runtimeSeq: number;
  ring: TraceEvent[]; console: string[]; delays: number[]; metrics: Record<string, unknown>;
  busy: boolean; jar?: JarAnalysis; timer?: NodeJS.Timeout; deleting?: boolean; stopping?: boolean; backendLost?: number;
}
export interface BackendOptions { dataDir: string; agentPath: string; migrations: string; dbWorkerPath: string; frontendDir: string; port?: number; token?: string; devOrigin?: string }
export class Sessions extends EventEmitter {
  readonly db: Database;
  readonly sessions = new Map<string, Session>();
  readonly live = new Map<string, Live>();
  readonly transport = net.createServer(socket => this.accept(socket));
  private collectorPort = 0;
  private transportToken = crypto.randomBytes(32).toString('hex');
  private queue: TraceEvent[] = [];
  private pumping: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  private sockets = new Set<net.Socket>();
  private shuttingDown = false;
  constructor(readonly options: BackendOptions) {
    super();
    this.db = new Database(path.join(options.dataDir, 'umra.sqlite'), options.migrations, options.dbWorkerPath);
    this.db.on('failure', error => this.emit('warning', String(error)));
  }
  async init() {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    const rows = await this.db.query('SELECT data FROM sessions ORDER BY created_at DESC');
    for (const row of rows) {
      const s: Session = JSON.parse(row.data);
      s.processState = 'stopped'; s.traceState = 'disabled'; s.recording = false; s.agentReady = false; s.pid = null;
      const counts = await this.db.query('SELECT COALESCE(MAX(seq),0) AS seq,COUNT(*) AS count FROM events WHERE session_id=?', [s.id]);
      s.eventCount = counts[0].count;
      this.sessions.set(s.id, s); this.live.set(s.id, this.empty(counts[0].seq));
      await this.db.saveSession(s);
    }
    await new Promise<void>((resolve, reject) => { this.transport.once('error', reject); this.transport.listen(0, '127.0.0.1', resolve); });
    this.collectorPort = (this.transport.address() as net.AddressInfo).port;
    this.timer = setInterval(() => void this.pump(), 40);
  }
  private empty(seq = 0): Live { return { seq, persistedSeq: seq, runtimeSeq: 0, ring: [], console: [], delays: [], metrics: {}, busy: false }; }
  get(id: string) { const s = this.sessions.get(id); if (!s) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found'); return s; }
  async create(config: SessionConfig) {
    if (this.sessions.size >= 1000) throw new ApiError(409, 'SESSION_LIMIT', 'Archive or delete old sessions before creating more (limit: 1000)');
    const s: Session = { ...config, id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), processState: 'stopped',
      traceState: 'disabled', recording: false, completed: false, agentReady: false, pid: null, eventCount: 0, dropped: 0, lastError: null };
    await this.db.saveSession(s); this.sessions.set(s.id, s); this.live.set(s.id, this.empty()); await this.db.flush();
    return s;
  }
  private changed(s: Session) { s.updatedAt = Date.now(); this.emit('state', s); }
  async launch(id: string) {
    const s = this.get(id), live = this.live.get(id)!;
    if (live.busy || live.child || s.completed) throw new ApiError(409, 'INVALID_STATE', s.completed ? 'Create a new session to launch another recording; this session is an archive' : 'Emulator is already starting or running');
    if ([...this.live.values()].filter(l => l.child).length >= 4) throw new ApiError(409, 'PROCESS_LIMIT', 'At most four emulator processes can run at once');
    live.busy = true;
    try {
      const java = await probeJava(s.javaPath);
      const emulator = await realFile(s.emulatorPath, ['.jar']);
      const agent = await realFile(this.options.agentPath, ['.jar']);
      const jar = await analyzeJar(java.javaPath, agent, s.gamePath);
      live.jar = jar;
      const sessionDir = path.join(this.options.dataDir, s.id); await fs.mkdir(sessionDir, { recursive: true });
      const configPath = path.join(sessionDir, 'agent.properties');
      await fs.writeFile(configPath, properties({ sessionId: id, token: this.transportToken, port: String(this.collectorPort), classes: jar.classes.map(c => c.name).join(',') }), { mode: 0o600 });
      const jad = s.gamePath.toLowerCase().endsWith('.jad') ? await fs.readFile(s.gamePath, 'utf8') : jar.manifest;
      if (Buffer.byteLength(jad) > 128 * 1024) throw new ApiError(413, 'JAD_TOO_LARGE', 'MIDlet properties exceed 128 KiB');
      const midletClass = jad.match(/^MIDlet-1:\s*[^,]*,[^,]*,\s*([^\r\n]+)$/im)?.[1]?.trim();
      if (!midletClass || !jar.classes.some(c => c.name === midletClass)) throw new ApiError(400, 'MIDLET_ENTRY_NOT_FOUND', 'MIDlet-1 must name a class in the selected game JAR');
      const jadPath = path.join(sessionDir, 'launch.jad');
      await fs.writeFile(jadPath, jad, 'utf8');
      s.runtimeMetadata = { ...java, adapter: 'microemulator-2', jarSha256: jar.sha256, jarPath: jar.path,
        midletClass, scope: 'Non-native instance/static methods in selected JAR; excludes constructors and class initializers',
        warnings: [...jar.warnings, ...(java.major === 8 ? [] : ['MicroEmulator 2.0.4 is primarily tested with Java 8; newer JVM compatibility depends on emulator APIs'])] };
      await this.db.run('INSERT INTO runtime_metadata VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data', [id, JSON.stringify(s.runtimeMetadata)]);
      s.processState = 'starting'; s.lastError = null; this.changed(s); await this.db.saveSession(s);
      const child = spawn(java.javaPath, ['-javaagent:' + agent + '=config=' + configPath,
        '-Dfile.encoding=UTF-8', '-jar', emulator, '--appclasspath', jar.path, '--propertiesjad', jadPath, midletClass], { cwd: sessionDir, shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      live.child = child; s.pid = child.pid ?? null;
      const log = (data: Buffer) => {
        let text = data.toString('utf8').slice(0, 16000);
        if (s.trace.redact) text = text.replace(/((?:password|passwd|token|secret|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]').replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, '$1[redacted]');
        live.console.push(text);
        if (live.console.length > 300) live.console.splice(0, live.console.length - 300);
        this.emit('console', id, text);
      };
      child.stdout!.on('data', log); child.stderr!.on('data', log);
      child.once('error', error => { s.processState = 'failed'; s.traceState = 'failed'; s.lastError = error.message; live.child = undefined; this.changed(s); void this.db.saveSession(s); });
      child.once('exit', (code, signal) => {
        if (live.timer) clearTimeout(live.timer);
        live.child = undefined; live.socket?.destroy(); live.socket = undefined;
        const unexpectedExit = code && code !== 0 && !live.stopping && !this.shuttingDown;
        s.processState = unexpectedExit ? 'failed' : 'stopped';
        s.traceState = 'disabled'; s.agentReady = false; s.pid = null; s.recording = false; s.completed = true;
        if (unexpectedExit) s.lastError = `Emulator exited (${code}, ${signal ?? 'no signal'}). See Console.`;
        this.changed(s); void this.db.saveSession(s).then(() => this.pump()).then(() => this.db.flush());
      });
      live.timer = setTimeout(() => {
        if (!s.agentReady && live.child) {
          s.traceState = 'failed'; s.lastError = 'Agent did not confirm instrumentation within 30 seconds. Check Java runtime, MicroEmulator adapter and Console.';
          this.changed(s); void this.db.saveSession(s);
        }
      }, 30000);
      return s;
    } catch (error) { s.processState = 'failed'; s.lastError = String(error); this.changed(s); await this.db.saveSession(s); throw error; }
    finally { live.busy = false; }
  }
  async stop(id: string) {
    const s = this.get(id), live = this.live.get(id)!;
    if (!live.child) throw new ApiError(409, 'EMULATOR_STOPPED', 'This session has no running emulator');
    if (live.stopping) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'Emulator is already stopping');
    live.stopping = true;
    try {
      if (s.traceState === 'active' || s.traceState === 'paused') await this.control(id, 'STOP', 'disabled').catch(() => undefined);
      const child = live.child;
      if (child) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new ApiError(504, 'PROCESS_STOP_TIMEOUT', 'Emulator did not stop')), 6000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          if (!child.kill()) { clearTimeout(timer); reject(new ApiError(500, 'PROCESS_STOP_FAILED', 'Unable to stop emulator')); }
        });
      }
      await this.drain(); await this.db.flush(); return s;
    } finally { live.stopping = false; }
  }
  async startTrace(id: string, options: TraceOptions) {
    const s = this.get(id);
    if (s.traceState === 'active') throw new ApiError(409, 'TRACE_ALREADY_ACTIVE', 'Stop or pause tracing before changing its mode');
    for (const value of [options.classFilter, options.methodFilter]) if (/[\t\n\r]/.test(value)) throw new ApiError(400, 'INVALID_FILTER', 'Filters cannot contain tabs or newlines');
    s.trace = options;
    return this.control(id, ['START', options.mode, options.classFilter, options.methodFilter, options.captureFields, options.redact, options.capturePayload].join('\t'), 'active');
  }
  async stopTrace(id: string) { if (this.get(id).traceState === 'disabled') throw new ApiError(409, 'TRACE_DISABLED', 'Trace is already disabled'); return this.control(id, 'STOP', 'disabled'); }
  async pauseTrace(id: string) { if (this.get(id).traceState !== 'active') throw new ApiError(409, 'TRACE_NOT_ACTIVE', 'Trace must be active to pause'); return this.control(id, 'PAUSE', 'paused'); }
  async marker(id: string, message: string) {
    const live = this.live.get(this.get(id).id)!;
    if (!live.socket || !this.get(id).agentReady) throw new ApiError(409, 'AGENT_UNAVAILABLE', 'Launch an instrumented emulator first');
    live.socket.write('MARK\t' + message.replace(/[\t\r\n]/g, ' ').slice(0, 200) + '\n');
    return { accepted: true };
  }
  private async control(id: string, command: string, target: Session['traceState']) {
    const s = this.get(id), live = this.live.get(id)!;
    if (!live.socket || !s.agentReady || !live.child) throw new ApiError(409, 'AGENT_UNAVAILABLE', 'Wait for the runtime to confirm instrumentation readiness');
    if (live.busy) throw new ApiError(409, 'OPERATION_IN_PROGRESS', 'Another runtime operation is pending');
    live.busy = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.off('state', listener); reject(new ApiError(504, 'RUNTIME_ACK_TIMEOUT', 'Runtime did not acknowledge the trace command')); }, 5000);
        const listener = (updated: Session) => {
          if (updated.id === id && updated.traceState === target) { clearTimeout(timer); this.off('state', listener); resolve(); }
        };
        this.on('state', listener); live.socket!.write(command + '\n');
      });
      await this.db.saveSession(s); return s;
    } finally { live.busy = false; }
  }
  async delete(id: string) {
    const s = this.get(id), live = this.live.get(id)!;
    if (live.child || live.busy) throw new ApiError(409, 'EMULATOR_RUNNING', 'Stop the emulator before deleting its session');
    live.deleting = true; await this.drain();
    await this.db.run('DELETE FROM sessions WHERE id=?', [id]); await this.db.flush();
    this.sessions.delete(s.id); this.live.delete(s.id);
    // Only the exact UUID session directory owned by UMRA is removed.
    await fs.rm(path.join(this.options.dataDir, s.id), { recursive: true, force: true });
  }
  private accept(socket: net.Socket) {
    if (this.sockets.size >= 8) { socket.destroy(); return; }
    this.sockets.add(socket); socket.setNoDelay(true); socket.setEncoding('utf8');
    let buffer = '', id: string | undefined, live: Live | undefined;
    const timeout = setTimeout(() => { if (!id) socket.destroy(); }, 5000);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 65536) { socket.destroy(); return; }
        try {
          const value = JSON.parse(line);
          if (!id) {
            const hello = z.object({ hello: z.literal('UMRA/1'), sessionId: z.string().uuid(), token: z.string().length(64), javaVersion: z.string().max(200), vm: z.string().max(300) }).parse(value);
            if (!crypto.timingSafeEqual(Buffer.from(hello.token), Buffer.from(this.transportToken))) throw new Error('Invalid transport token');
            const s = this.get(hello.sessionId); live = this.live.get(s.id)!;
            if (!live.child || live.socket) throw new Error('Session has no owned process or is already connected');
            id = s.id; live.socket = socket; clearTimeout(timeout);
            s.runtimeMetadata = { ...s.runtimeMetadata, observedJavaVersion: hello.javaVersion, observedVM: hello.vm };
          } else {
            const event = runtimeEventSchema.parse(value);
            if (live!.runtimeSeq && event.runtimeSeq > live!.runtimeSeq + 1) this.backendWarning(id, `Runtime sequence gap: ${live!.runtimeSeq + 1}–${event.runtimeSeq - 1}`, 0);
            live!.runtimeSeq = event.runtimeSeq;
            this.ingest(id, event);
          }
        } catch (error) {
          if (!id) { socket.destroy(); return; }
          this.backendWarning(id, 'Rejected invalid runtime payload: ' + String(error).slice(0, 500), 1);
        }
      }
      if (buffer.length > 65536) socket.destroy();
      if (this.queue.length > 12000) socket.pause();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timeout); this.sockets.delete(socket);
      if (id && live?.socket === socket) {
        live.socket = undefined; const s = this.get(id); s.agentReady = false; s.recording = false;
        if (live.child && !live.stopping && !this.shuttingDown) { s.traceState = 'failed'; s.lastError = 'Runtime transport disconnected; waiting for reconnect'; }
        this.changed(s); void this.db.saveSession(s);
      }
    });
  }
  private ingest(id: string, value: z.infer<typeof runtimeEventSchema>, source: TraceEvent['source'] = 'runtime-instrumentation') {
    const s = this.get(id), live = this.live.get(id)!;
    if (live.deleting) return;
    if (this.queue.length >= 16384) { s.dropped++; live.backendLost = (live.backendLost ?? 0) + 1; return; }
    const seq = ++live.seq;
    const e: TraceEvent = { ...value, eventId: `${id}:${seq}`, sessionId: id, seq, receivedAt: Date.now(), source };
    this.queue.push(e); live.ring.push(e); if (live.ring.length > 10000) live.ring.splice(0, live.ring.length - 10000);
    s.eventCount++;
    if (source === 'runtime-instrumentation') { live.delays.push(Math.max(0, e.receivedAt - e.timestamp)); if (live.delays.length > 512) live.delays.shift(); }
    if (e.type === 'METRICS') live.metrics = e.data ?? {};
    if (e.type === 'TRACE_WARNING') s.dropped += Number(e.data?.dropped ?? 0);
    if (e.type === 'RUNTIME_STATUS') {
      const status = e.data?.status;
      if (status === 'INSTRUMENTATION_READY') { s.agentReady = true; s.processState = 'running'; s.lastError = null; }
      if (status === 'AGENT_READY' && s.traceState === 'failed' && s.processState === 'running') { s.agentReady = true; s.traceState = 'disabled'; s.lastError = null; }
      if (status === 'INSTRUMENTATION_FAILED') { s.traceState = 'failed'; s.lastError = String(e.data?.message); }
      if (status === 'TRACE_ACTIVE') { s.traceState = 'active'; s.recording = true; }
      if (status === 'TRACE_DISABLED') { s.traceState = 'disabled'; s.recording = false; }
      if (status === 'TRACE_PAUSED') s.traceState = 'paused';
      this.changed(s);
    }
  }
  backendWarning(id: string, message: string, dropped: number) {
    this.ingest(id, { runtimeSeq: 0, timestamp: Date.now(), type: 'TRACE_WARNING', threadId: 0, threadName: 'backend',
      traceId: null, invocationId: null, parentId: null, className: '', methodName: '', descriptor: '', depth: 0,
      data: { message, dropped } }, 'backend');
  }
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    if (!this.queue.length) return Promise.resolve();
    const batch = this.queue.splice(0, 512);
    this.pumping = (async () => {
      try {
        await this.db.events(batch);
        const ids = new Set(batch.map(e => e.sessionId));
        for (const id of ids) {
          const s = this.sessions.get(id); if (!s) continue;
          const committed = batch.filter(e => e.sessionId === id);
          this.live.get(id)!.persistedSeq = committed.at(-1)!.seq;
          await this.db.saveSession(s); this.emit('batch', id, committed);
        }
      } catch (error) {
        for (const id of new Set(batch.map(e => e.sessionId))) {
          const s = this.sessions.get(id); if (!s) continue;
          s.lastError = `Persistence failed: ${String(error)}`; s.traceState = 'failed'; s.dropped += batch.filter(e => e.sessionId === id).length;
          this.live.get(id)?.socket?.write('STOP\n'); this.changed(s);
        }
        this.emit('warning', String(error));
      } finally {
        this.pumping = null;
        if (this.queue.length < 4000) {
          for (const [id, live] of this.live) if (live.backendLost) { const lost = live.backendLost; live.backendLost = 0; this.backendWarning(id, `Backend ingestion queue overflow: ${lost} records lost (included in session dropped count)`, 0); }
          for (const socket of this.sockets) socket.resume();
        }
      }
    })();
    return this.pumping;
  }
  async drain() {
    // Bound the barrier so a continuously busy game cannot starve history/API queries.
    const batches = Math.ceil(this.queue.length / 512) + (this.pumping ? 1 : 0);
    for (let i = 0; i < batches; i++) await this.pump();
  }
  stats(id: string) {
    const live = this.live.get(this.get(id).id)!;
    const sorted = [...live.delays].sort((a, b) => a - b);
    return { ...live.metrics, receiptDelayP50Ms: sorted[Math.floor(sorted.length * .5)] ?? null,
      receiptDelayP95Ms: sorted[Math.floor(sorted.length * .95)] ?? null, measuredSamples: sorted.length,
      ingestionQueue: this.queue.length, bufferedEvents: live.ring.length };
  }
  async close() {
    this.shuttingDown = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.sessions.values()].filter(s => this.live.get(s.id)?.child).map(s => this.stop(s.id)));
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.transport.close(() => resolve()));
    await this.drain(); await this.db.close();
  }
}
