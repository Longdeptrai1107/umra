import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { Bootstrap, JarAnalysis, Session, TraceEvent } from '../shared-schemas';

const games = process.argv.slice(2);
const javaPath = process.env.UMRA_JAVA, emulatorPath = process.env.UMRA_MICROEMULATOR;
if (!games.length || !javaPath || !emulatorPath) throw new Error('Set UMRA_JAVA and UMRA_MICROEMULATOR; pass one or more local game JAR paths.');
const root = process.cwd(), execute = promisify(execFile);
const artifacts = path.join(root, 'artifacts', 'game-smoke-' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(artifacts, { recursive: true });
const summaries: Record<string, unknown>[] = [];

async function waitFor<T>(label: string, check: () => Promise<T | false | undefined>, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check(); if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

for (const [index, input] of games.entries()) {
  const gamePath = path.resolve(input), directory = path.join(artifacts, String(index));
  await fs.mkdir(directory, { recursive: true });
  const summary: Record<string, unknown> = { gamePath, executable: process.env.UMRA_EXECUTABLE ?? 'source', staticReadable: false, runtimeObserved: false };
  const pageErrors: string[] = [];
  let desktop: ElectronApplication | undefined, page: Page | undefined, bootstrap: Bootstrap | undefined, id: string | undefined;
  async function call<T>(route: string, body?: unknown): Promise<T> {
    if (!bootstrap) throw new Error('Desktop bootstrap is unavailable');
    const response = await fetch(bootstrap.origin + '/api/v1' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + bootstrap.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  try {
    desktop = await electron.launch({ args: process.env.UMRA_EXECUTABLE ? [] : [root], executablePath: process.env.UMRA_EXECUTABLE,
      env: { ...process.env, UMRA_DATA_DIR: path.join(directory, 'data') }, timeout: 60000 });
    page = await desktop.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.getByText('Backend ready', { exact: true }).waitFor({ timeout: 30000 });
    bootstrap = await page.evaluate(() => window.umra!.bootstrap);
    const inventory = await call<JarAnalysis>('/jars/analyze', { javaPath, gamePath });
    await fs.writeFile(path.join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2));
    Object.assign(summary, { staticReadable: true, sha256: inventory.sha256, classes: inventory.classes.length,
      methods: inventory.classes.reduce((total, cls) => total + cls.methods.length, 0), staticWarnings: inventory.warnings });

    await page.getByTestId('runtime').selectOption(javaPath);
    await page.getByTestId('emulator-path').fill(emulatorPath);
    await page.getByTestId('game-path').fill(gamePath);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId('mode-deep').click();
    await page.getByTestId('launch').click();
    const ready = await waitFor<Session>('owned emulator instrumentation', async () => {
      const sessions = await call<Session[]>('/sessions');
      const session = sessions.find(s => s.gamePath === gamePath); if (!session) return;
      id = session.id;
      if (session.processState === 'failed') throw new Error(session.lastError ?? 'Emulator failed');
      return session.agentReady ? session : undefined;
    });
    id = ready.id;
    await call<Session>(`/sessions/${id}/trace/start`, { mode: 'deep', captureFields: false, redact: true, capturePayload: false });
    await waitFor('observed game method invocation', async () => {
      const data = await call<{ events: TraceEvent[] }>(`/sessions/${id}/events?types=METHOD_ENTER&limit=10`);
      if (data.events.length) return true;
      const state = await call<Session>('/sessions/' + id);
      if (state.processState === 'failed' || state.completed) throw new Error(state.lastError ?? 'Game exited before a method was observed');
    }, 20000);
    try {
      const result = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/win-input.ps1',
        '-ProcessId', String(ready.pid), '-Keys', '2468'], { cwd: root, timeout: 20000 });
      summary.input = result.stdout.trim();
      await waitFor('observed keyboard callback', async () => {
        const data = await call<{ events: TraceEvent[] }>(`/sessions/${id}/events?types=USER_INPUT&limit=20`);
        return data.events.some(event => event.methodName === 'keyPressed');
      }, 5000);
      summary.inputObserved = true;
    } catch (error) { summary.inputError = String(error); }
    await call<Session>(`/sessions/${id}/trace/stop`, {});
    const methods = await call<{ methods: Record<string, unknown>[] }>(`/sessions/${id}/methods`);
    const observations = await call<{ events: TraceEvent[] }>(`/sessions/${id}/events?limit=2000`);
    const inputs = await call<{ events: TraceEvent[] }>(`/sessions/${id}/events?types=USER_INPUT&limit=2000`);
    const report = await call<{ counts: { type: string; count: number }[]; warnings: TraceEvent[]; session: Session }>(`/sessions/${id}/report`);
    await fs.writeFile(path.join(directory, 'methods.json'), JSON.stringify(methods, null, 2));
    await fs.writeFile(path.join(directory, 'events.json'), JSON.stringify(observations, null, 2));
    await fs.writeFile(path.join(directory, 'inputs.json'), JSON.stringify(inputs, null, 2));
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    await page.getByRole('button', { name: 'Live Events', exact: true }).click();
    await page.getByTestId('event-row').first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(directory, 'live-events.png'), fullPage: true });
    const entries = observations.events.filter(event => event.type === 'METHOD_ENTER');
    const instrumented = observations.events.filter(event => event.type === 'RUNTIME_STATUS' && event.data?.status === 'CLASS_INSTRUMENTED');
    Object.assign(summary, { runtimeObserved: entries.length > 0, liveRowsVisible: true, observedMethodGroups: methods.methods.length,
      observedClassCount: new Set(methods.methods.map(method => method.className)).size,
      counts: report.counts, dropped: report.session.dropped,
      instrumentedClasses: instrumented.map(event => event.data?.message),
      sampleMethods: methods.methods.slice(0, 35),
      inputCallbacks: inputs.events.map(event => ({ class: event.className, method: event.methodName, arguments: event.arguments })),
      warnings: report.warnings.map(event => event.data),
      methodExceptions: observations.events.filter(event => event.type === 'METHOD_EXCEPTION').slice(0, 10).map(event => ({ class: event.className, method: event.methodName, exception: event.exception })) });
  } catch (error) {
    summary.error = String(error);
    if (page) {
      await fs.writeFile(path.join(directory, 'failure-dom.txt'), await page.locator('body').innerText()).catch(() => undefined);
      await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => undefined);
    }
  } finally {
    if (id) {
      const logs = await call<string[]>(`/sessions/${id}/console`).catch(() => []);
      await fs.writeFile(path.join(directory, 'console.log'), logs.join(''));
      const session = await call<Session>('/sessions/' + id).catch(() => undefined);
      summary.sessionBeforeStop = session;
      if (session?.pid) await call<Session>(`/sessions/${id}/stop`, {}).catch(error => { summary.stopError = String(error); });
    }
    if (desktop) await desktop.close();
    summary.pageErrors = pageErrors;
    await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    summaries.push(summary);
    console.log(JSON.stringify({ gamePath, staticReadable: summary.staticReadable, classes: summary.classes, methods: summary.methods,
      runtimeObserved: summary.runtimeObserved, observedMethodGroups: summary.observedMethodGroups, inputObserved: summary.inputObserved,
      error: summary.error, directory }, null, 2));
  }
}
await fs.writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summaries, null, 2));
console.log('Artifacts: ' + artifacts);
if (summaries.some(summary => !summary.runtimeObserved)) process.exitCode = 1;
