import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import type { Session, TraceEvent } from '../../shared-schemas';

export class Database extends EventEmitter {
  private worker: Worker;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(file: string, migrations: string, workerPath: string) {
    super();
    this.worker = new Worker(workerPath, { workerData: { file, migrations } });
    this.worker.on('message', msg => {
      if (msg.fatal) { this.emit('failure', new Error(msg.fatal)); return; }
      const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    });
    this.worker.on('error', error => { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); this.emit('failure', error); });
  }
  private call<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, params }); });
  }
  query<T = Record<string, any>>(sql: string, params: (string | number | null)[] = []): Promise<T[]> { return this.call('query', { sql, params }); }
  run(sql: string, params: (string | number | null)[] = []) { return this.call('run', { sql, params }); }
  saveSession(s: Session) { return this.run('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [s.id, s.createdAt, JSON.stringify(s)]); }
  events(events: TraceEvent[]) { return this.call('events', events); }
  flush() { return this.call('flush', null); }
  async close() { await this.flush(); await this.worker.terminate(); }
}
