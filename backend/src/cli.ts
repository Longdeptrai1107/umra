import path from 'node:path';
import { createBackend } from './server';
const root = process.cwd();
const backend = await createBackend({ dataDir: process.env.UMRA_DATA_DIR ?? path.join(root, '.umra'),
  agentPath: path.join(root, 'instrumentation/target/umra-agent.jar'), migrations: path.join(root, 'backend/migrations'),
  dbWorkerPath: path.join(root, 'dist/backend/db-worker.cjs'), frontendDir: path.join(root, 'dist/frontend'),
  port: Number(process.env.UMRA_PORT ?? 0), token: process.env.UMRA_TOKEN });
console.log(`UMRA backend: ${backend.origin}\nLocal bearer token: ${backend.token}\nDesktop launcher supplies this token through its isolated preload.`);
const close = async () => { await backend.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
