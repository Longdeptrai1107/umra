import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { createBackend } from '../backend/src/server';

let backend: Awaited<ReturnType<typeof createBackend>> | undefined;
let closing = false;
app.setName('UMRA');
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!backend || closing) return;
  event.preventDefault(); closing = true;
  void backend.close().finally(() => { backend = undefined; app.quit(); });
});
app.whenReady().then(async () => {
  const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../..');
  backend = await createBackend({
    dataDir: process.env.UMRA_DATA_DIR ?? path.join(app.getPath('userData'), 'sessions'),
    agentPath: path.join(root, app.isPackaged ? 'umra-agent.jar' : 'instrumentation/target/umra-agent.jar'),
    migrations: path.join(root, app.isPackaged ? 'migrations' : 'backend/migrations'),
    dbWorkerPath: path.join(__dirname, '../backend/db-worker.cjs'),
    frontendDir: path.join(__dirname, '../frontend'),
    devOrigin: process.env.UMRA_DEV_URL,
  });
  ipcMain.handle('umra:choose-file', async (event, kind: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !['runtime', 'emulator', 'game'].includes(kind)) throw new Error('Invalid file dialog request');
    const result = await dialog.showOpenDialog(owner, { properties: ['openFile'],
      title: kind === 'runtime' ? 'Select desktop Java executable' : kind === 'emulator' ? 'Select MicroEmulator JAR' : 'Select Java ME game JAR/JAD',
      filters: [{ name: kind, extensions: kind === 'runtime' ? ['exe'] : kind === 'game' ? ['jar', 'jad'] : ['jar'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  const bootstrap = { origin: backend.origin, token: backend.token, version: '1.0.0' };
  const window = new BrowserWindow({ width: 1540, height: 960, minWidth: 1100, minHeight: 720,
    backgroundColor: '#0b101a', title: 'Universal MicroEmulator Realtime Analyzer',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: ['--umra-bootstrap=' + encodeURIComponent(JSON.stringify(bootstrap))] } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend!.origin + '/') && !url.startsWith((process.env.UMRA_DEV_URL ?? backend!.origin) + '/')) event.preventDefault(); });
  await window.loadURL(process.env.UMRA_DEV_URL ?? backend.origin);
}).catch(error => { dialog.showErrorBox('UMRA failed to start', String(error)); app.exit(1); });
