import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs/promises';
await fs.mkdir('dist/backend', { recursive: true });
await Promise.all([
  build({ entryPoints: ['desktop/main.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/desktop/main.cjs', external: ['electron', 'sql.js'] }),
  build({ entryPoints: ['desktop/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/desktop/preload.cjs', external: ['electron'] }),
  build({ entryPoints: ['backend/src/db-worker.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/backend/db-worker.cjs', external: ['sql.js'] }),
  build({ entryPoints: ['backend/src/server.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/backend/server.cjs', external: ['sql.js'] }),
  viteBuild({ configFile: 'frontend/vite.config.ts' }),
]);
console.log('UMRA frontend, desktop shell, backend and database worker built.');
