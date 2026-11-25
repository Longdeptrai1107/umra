import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
const command = process.platform === 'win32' ? 'powershell.exe' : 'sh';
try { await fs.access('instrumentation/target/umra-agent.jar'); }
catch { if (process.platform !== 'win32') throw new Error('Build the Java agent with Maven first: cd instrumentation && mvn package');
  await new Promise((resolve, reject) => { const p = spawn(command, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-agent.ps1'], { stdio: 'inherit' }); p.on('exit', code => code ? reject(new Error('Agent build failed')) : resolve()); }); }
await import('./build.mjs');
const vite = await createServer({ configFile: 'frontend/vite.config.ts' }); await vite.listen();
const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, UMRA_DEV_URL: 'http://127.0.0.1:5173' } });
child.on('exit', async code => { await vite.close(); process.exit(code ?? 0); });
process.on('SIGINT', () => child.kill());
