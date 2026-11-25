import path from 'node:path';
import fs from 'node:fs/promises';
import { createBackend } from '../backend/src/server';
const root = process.cwd(), dataDir = path.join(root, 'artifacts', 'probe-' + Date.now());
await fs.mkdir(dataDir, { recursive: true });
const backend = await createBackend({ dataDir, agentPath: path.join(root, 'instrumentation/target/umra-agent.jar'), migrations: path.join(root, 'backend/migrations'), dbWorkerPath: path.join(root, 'dist/backend/db-worker.cjs'), frontendDir: path.join(root, 'dist/frontend') });
try {
  const s = await backend.sessions.create({ name: 'Agent diagnostic', javaPath: process.env.UMRA_JAVA!, emulatorPath: process.env.UMRA_MICROEMULATOR!, gamePath: path.join(root, 'tests/midlet/target/umratest.jar'), trace: { mode: 'deep', classFilter: '', methodFilter: '', captureFields: true, redact: true, capturePayload: true } });
  await backend.sessions.launch(s.id);
  await new Promise<void>(resolve => setTimeout(resolve, 1500));
  await backend.sessions.startTrace(s.id, s.trace);
  await new Promise<void>(resolve => setTimeout(resolve, 4000));
  console.log(backend.sessions.live.get(s.id)?.console.join(''));
  console.log('SESSION', backend.sessions.get(s.id));
  const rows = await backend.sessions.db.query('SELECT type,method_name,data FROM events WHERE session_id=? ORDER BY seq LIMIT 30', [s.id]);
  console.log(rows.map(r => ({ type: r.type, method: r.method_name, data: JSON.parse(r.data).data })));
} finally { await backend.close(); }
