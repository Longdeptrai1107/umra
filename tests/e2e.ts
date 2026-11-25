import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';
import type { Bootstrap, Session, TraceEvent } from '../shared-schemas';

const root = process.cwd(), artifacts = path.join(root, 'artifacts', 'e2e-' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(artifacts, { recursive: true });
const dataDir = path.join(artifacts, 'data');
const executablePath = process.env.UMRA_EXECUTABLE;
const desktopOptions = { args: executablePath ? [] : [root], ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
  env: { ...process.env, UMRA_DATA_DIR: dataDir }, timeout: 60000 };
const emulatorPath = process.env.UMRA_MICROEMULATOR;
const javaPath = process.env.UMRA_JAVA;
if (!emulatorPath || !javaPath) throw new Error('Set UMRA_MICROEMULATOR and UMRA_JAVA to real MicroEmulator JAR and Java executable paths.');
async function command(file: string, args: string[]) {
  return new Promise<string>((resolve, reject) => execFile(file, args, { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}
await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-test-midlets.ps1', '-MicroEmulator', emulatorPath]);
const receivedPayloads: Buffer[] = [];
const echo = http.createServer((req, res) => {
  const chunks: Buffer[] = []; let length = 0;
  req.on('data', data => { length += data.length; if (length > 65536) req.destroy(); else chunks.push(data); });
  req.on('end', () => { const data = Buffer.concat(chunks); receivedPayloads.push(data); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(data); });
});
await new Promise<void>((resolve, reject) => { echo.once('error', reject); echo.listen(50123, '127.0.0.1', resolve); });
let desktop: ElectronApplication | undefined, page: Page, bootstrap: Bootstrap, stream: WebSocket | undefined;
const streamed: TraceEvent[] = [], pageErrors: string[] = [];
async function call<T = any>(route: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(bootstrap.origin + '/api/v1' + route, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined as T : response.json();
}
async function waitFor<T>(label: string, fn: () => Promise<T | undefined | false>, timeout = 25000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const result = await fn(); if (result) return result; if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 120)); }
}
async function input(pid: number, keys: string) { await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/win-input.ps1', '-ProcessId', String(pid), '-Keys', keys]); }
async function startTrace(id: string) {
  await page.getByTestId('start-trace').click();
  await waitFor('runtime acknowledges active recording', async () => (await call<Session>('/sessions/' + id)).traceState === 'active');
}
async function launch(game: string) {
  await page.getByTestId('runtime').selectOption(javaPath!);
  await page.getByTestId('emulator-path').fill(emulatorPath!);
  await page.getByTestId('game-path').fill(path.join(root, 'tests/midlet/target', game + '.jar'));
  await page.getByTestId('launch').click();
  const s = await waitFor<Session>('owned emulator instrumentation ready', async () => { const all = await call<Session[]>('/sessions'); return all.find(s => s.gamePath.endsWith(game + '.jar') && s.agentReady && s.processState === 'running'); });
  return s;
}
const checks: string[] = [];
try {
  desktop = await electron.launch(desktopOptions);
  page = await desktop.firstWindow(); page.on('pageerror', e => pageErrors.push(e.message));
  await page.getByText('Backend ready', { exact: true }).waitFor({ timeout: 30000 });
  bootstrap = await page.evaluate(() => window.umra!.bootstrap);
  const sample = await launch('umratest');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('mode-deep').click(); await page.getByTestId('capture-fields').check(); await page.getByTestId('capture-payload').check();
  await startTrace(sample.id);
  stream = new WebSocket(`${bootstrap.origin.replace('http:', 'ws:')}/ws/v1/sessions/${sample.id}/live`, ['umra-v1', 'auth.' + bootstrap.token]);
  stream.on('message', data => { const m = JSON.parse(data.toString()); if (m.type === 'batch') streamed.push(...m.events); });
  await new Promise<void>((resolve, reject) => { stream!.once('open', () => { stream!.send(JSON.stringify({ type: 'subscribe', after: 0 })); resolve(); }); stream!.once('error', reject); });
  await input(sample.pid!, '123456');
  const events = await waitFor<TraceEvent[]>('A-F callback, nested methods, arguments, network, exception and async records', async () => {
    const data = await call<{ events: TraceEvent[] }>(`/sessions/${sample.id}/events?limit=2000`);
    return data.events.some(e => e.methodName === 'asyncWork' && e.type === 'METHOD_EXIT') && data.events.some(e => e.type === 'NETWORK_RECEIVE') ? data.events : undefined;
  });
  const intEntry = events.find(e => e.methodName === 'intAction' && e.type === 'METHOD_ENTER'); assert.ok(intEntry);
  assert.equal(intEntry.arguments?.[0].value, 7); assert.equal(intEntry.arguments?.[0].status, 'observed');
  const intExit = events.find(e => e.methodName === 'intAction' && e.type === 'METHOD_EXIT'); assert.equal(intExit?.returnValue?.value, 14);
  const inputEvent = events.find(e => e.type === 'USER_INPUT' && e.methodName === 'keyPressed'); assert.ok(inputEvent?.stack?.length);
  for (const method of ['outer', 'middle', 'leaf']) assert.ok(events.some(e => e.methodName === method && e.parentId), method + ' has observed ancestry');
  assert.ok(events.some(e => e.methodName === 'expectedFailure' && e.type === 'METHOD_EXCEPTION'));
  const fieldExit = events.find(e => e.className.endsWith('PlayerState') && e.methodName === 'update' && e.type === 'METHOD_EXIT');
  assert.equal(fieldExit?.receiver?.fields?.hp.value, 95); assert.equal(fieldExit?.receiver?.fields?.secretToken.status, 'redacted');
  assert.ok(!events.some(e => e.methodName === 'toString'), 'snapshot code must not execute app toString');
  const asynchronous = events.find(e => e.methodName === 'asyncWork' && e.type === 'METHOD_ENTER')!;
  assert.notEqual(asynchronous.threadId, inputEvent.threadId); assert.notEqual(asynchronous.traceId, inputEvent.traceId);
  assert.ok(receivedPayloads.some(b => b.toString('hex') === '554d5241037f'), 'echo endpoint saw real transmitted bytes');
  assert.ok(events.some(e => e.type === 'NETWORK_SEND' && (e.data?.payload as any)?.hex === '554d5241037f'));
  assert.ok(events.some(e => e.type === 'NETWORK_RECEIVE' && (e.data?.payload as any)?.hex === '554d5241037f'));
  assert.ok(events.filter(e => e.type === 'METHOD_ENTER').every(e => e.source === 'runtime-instrumentation'));
  checks.push('Real keyboard input → callback → argument(7) → return(14)', 'Nested observed ancestry and bounded callback stacks',
    'Controlled runtime exception', 'Receiver field snapshots and credential redaction; no app toString()',
    'Async task recorded on an independent thread/trace root', 'Real HTTP send/receive bytes match local echo endpoint');
  await waitFor('WebSocket delivered method and network observations', async () => streamed.some(e => e.eventId === intEntry.eventId) && streamed.some(e => e.type === 'NETWORK_RECEIVE'));
  await page.getByRole('button', { name: 'Live Events', exact: true }).click();
  await page.getByTestId('event-row').first().waitFor();
  await page.screenshot({ path: path.join(artifacts, 'live-events.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
  await page.waitForFunction(() => window.innerWidth <= 1100);
  const viewport = await page.locator('.monitor-panel .event-list > .virtual-scroll').evaluate(element => ({ height: element.clientHeight, rows: element.querySelectorAll('[data-testid="event-row"]').length }));
  assert.ok(viewport.height >= 65 && viewport.rows > 0, 'minimum-size desktop keeps a visible virtual event viewport');
  await page.screenshot({ path: path.join(artifacts, 'live-events-minimum-size.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1540, 960));
  checks.push('Live event viewport remains usable at the minimum 1100 × 720 desktop window size');
  await page.getByRole('button', { name: 'Call Tree', exact: true }).click(); await page.screenshot({ path: path.join(artifacts, 'call-tree.png'), fullPage: true });
  await page.getByRole('button', { name: 'Network', exact: true }).click(); await page.getByText('NETWORK_OPEN', { exact: true }).count();
  await page.screenshot({ path: path.join(artifacts, 'network.png'), fullPage: true });
  const graph = await call(`/sessions/${sample.id}/callgraph`); assert.ok(graph.nodes.some((n: any) => n.entry.methodName === 'middle' && n.parentId));
  const details = await call(`/sessions/${sample.id}/invocations/${intEntry.invocationId}`); assert.equal(details.entry.arguments[0].value, 7); assert.equal(details.exit.returnValue.value, 14);
  await call(`/sessions/${sample.id}/mappings`, { kind: 'method', original: `${intEntry.className}.${intEntry.methodName}${intEntry.descriptor}`, alias: 'DoubleInteger', note: 'Verified by observed input 7 / result 14' });
  assert.equal((await call(`/sessions/${sample.id}/mappings`))[0].alias, 'DoubleInteger');
  await page.getByRole('button', { name: 'Pause View', exact: true }).click();
  const before = (await call<Session>('/sessions/' + sample.id)).eventCount;
  await input(sample.pid!, '1');
  await waitFor('capture continues while UI is paused', async () => (await call<Session>('/sessions/' + sample.id)).eventCount > before + 4);
  await page.getByRole('button', { name: 'Resume View', exact: true }).click();
  await page.getByTestId('start-trace').click();
  assert.equal((await call<Session>('/sessions/' + sample.id)).processState, 'running');
  assert.equal((await call<Session>('/sessions/' + sample.id)).traceState, 'disabled');
  await page.getByTestId('stop-emulator').click();
  const stopped = await waitFor<Session>('session completed after owned emulator stop', async () => { const s = await call<Session>('/sessions/' + sample.id); return s.completed ? s : undefined; });
  assert.equal(stopped.processState, 'stopped'); assert.equal(stopped.lastError, null); assert.equal(stopped.recording, false);
  checks.push('API, WebSocket, live React monitor, call tree and SQLite invocation query agree', 'Pause View preserves runtime capture; Stop Trace leaves emulator running', 'Session mapping persists and emulator process is stopped explicitly');
  stream.close(); stream = undefined;
  // Independent short-symbol Canvas MIDlet tests exact JAR scoping without any source changes to UMRA.
  const independent = await launch('obfuscated'); await startTrace(independent.id); await input(independent.pid!, '1');
  await waitFor('independent obfuscated JAR method trace', async () => (await call(`/sessions/${independent.id}/events?limit=1000`)).events.some((e: TraceEvent) => e.className === 'obfuscated.a$b' && e.methodName === 'a' && e.type === 'METHOD_EXIT'));
  await page.getByTestId('stop-emulator').click(); await waitFor('independent session stopped', async () => (await call<Session>('/sessions/' + independent.id)).completed);
  checks.push('Independent short-symbol game JAR runs and emits observed calls without game-specific analyzer code');
  const commandGame = await launch('independent'); await startTrace(commandGame.id); await input(commandGame.pid!, '{F2}');
  const commandEvents = await waitFor<TraceEvent[]>('independent CommandListener callback', async () => { const data = await call(`/sessions/${commandGame.id}/events?limit=1000`); return data.events.some((e: TraceEvent) => e.methodName === 'commandAction') ? data.events : undefined; }, 10000);
  assert.ok(commandEvents.some(e => e.type === 'USER_INPUT' && e.methodName === 'commandAction'));
  await page.getByTestId('stop-emulator').click(); await waitFor('command game stopped', async () => (await call<Session>('/sessions/' + commandGame.id)).completed);
  checks.push('Independent Form/CommandListener MIDlet produces observed command callbacks');
  const report = await call(`/sessions/${sample.id}/report`);
  const exported = await fetch(`${bootstrap.origin}/api/v1/sessions/${sample.id}/export?format=ndjson`, { headers: { Authorization: 'Bearer ' + bootstrap.token } });
  const exportText = await exported.text(); await fs.writeFile(path.join(artifacts, 'runtime-events.ndjson'), exportText);
  const savedEvents = exportText.trim().split('\n').map(line => JSON.parse(line) as TraceEvent);
  assert.ok(savedEvents.some(e => e.eventId === intEntry.eventId));
  assert.ok(savedEvents.every((e, i) => i === 0 || e.seq > savedEvents[i - 1].seq));
  await desktop.close(); desktop = undefined;
  // A new Electron/backend process must read the database rather than the old live store.
  desktop = await electron.launch(desktopOptions); page = await desktop.firstWindow(); page.on('pageerror', e => pageErrors.push(e.message));
  await page.getByText('Backend ready', { exact: true }).waitFor({ timeout: 30000 }); bootstrap = await page.evaluate(() => window.umra!.bootstrap);
  const reloaded = await call(`/sessions/${sample.id}/invocations/${intEntry.invocationId}`); assert.equal(reloaded.exit.returnValue.value, 14);
  assert.equal((await call(`/sessions/${sample.id}/mappings`))[0].alias, 'DoubleInteger');
  const stored = await call<Session>('/sessions/' + sample.id); assert.equal(stored.processState, 'stopped'); assert.equal(stored.lastError, null); assert.ok(stored.eventCount > 20);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('.session-card').filter({ hasText: stored.name }).getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByTestId('event-row').first().waitFor();
  await page.getByRole('button', { name: 'Call Tree', exact: true }).click();
  await page.locator('.monitor-panel .tree-label').filter({ hasText: 'DoubleInteger' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'reopened-session.png'), fullPage: true });
  checks.push('Fresh Electron/backend process reopens SQLite session, invocation snapshots, mapping and archived call tree through the UI');
  assert.deepEqual(pageErrors, []);
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ checks, executable: executablePath ?? 'source', runtime: report.session.runtimeMetadata, measured: report.stats, eventCounts: report.counts, lost: report.session.dropped, uiErrors: pageErrors }, null, 2));
  await fs.writeFile(path.join(artifacts, 'PASS.json'), JSON.stringify({ passed: true, executable: executablePath ?? 'source', checks, savedEvents: savedEvents.length, artifacts }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, artifacts }, null, 2));
} catch (error) {
  if (desktop) {
    try { const failedPage = await desktop.firstWindow(); await failedPage.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
      await fs.writeFile(path.join(artifacts, 'failure-dom.txt'), await failedPage.locator('body').innerText());
      await fs.writeFile(path.join(artifacts, 'failure-layout.json'), JSON.stringify(await failedPage.evaluate(() => [...document.querySelectorAll('.analysis-workspace,.monitor-column,.monitor-panel,.event-list,.virtual-scroll,.mini-tree,.page-content')].map(e => ({ class: e.className, height: e.getBoundingClientRect().height, width: e.getBoundingClientRect().width, scroll: e.scrollHeight, children: e.children.length }))), null, 2));
      const saved = await call<Session[]>('/sessions'); for (const s of saved) {
        const logs = await call(`/sessions/${s.id}/console`); await fs.writeFile(path.join(artifacts, `${s.id}-console.log`), logs.join(''));
        const observations = await call(`/sessions/${s.id}/events?limit=2000`); await fs.writeFile(path.join(artifacts, `${s.id}-events.json`), JSON.stringify({ session: s, ...observations }, null, 2));
      } } catch { }
  }
  await fs.writeFile(path.join(artifacts, 'FAIL.txt'), String(error) + '\n' + pageErrors.join('\n'));
  throw error;
} finally { stream?.close(); if (desktop) await desktop.close(); await new Promise<void>(resolve => echo.close(() => resolve())); }
