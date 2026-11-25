import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createBackend } from '../backend/src/server';
import { runtimeEventSchema, sessionConfigSchema } from '../shared-schemas';

const root = process.cwd();
test('local authorization, validation, persistence, mapping and session lifecycle', async () => {
  const tempRoot = path.join(os.tmpdir(), 'opencode'); await fs.mkdir(tempRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(tempRoot, 'umra-api-'));
  const options = { dataDir, agentPath: path.join(root, 'instrumentation/target/umra-agent.jar'), migrations: path.join(root, 'backend/migrations'), dbWorkerPath: path.join(root, 'dist/backend/db-worker.cjs'), frontendDir: path.join(root, 'dist/frontend') };
  let backend = await createBackend(options);
  const request = (route: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(backend.origin + '/api/v1' + route,
    { method, headers: { Authorization: 'Bearer ' + backend.token, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await fetch(backend.origin + '/api/v1/health')).status, 401);
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/health', 'GET', undefined, { Origin: 'http://untrusted.invalid' })).status, 403);
    const wrongHost = await new Promise<number>(resolve => { const req = http.get(backend.origin + '/api/v1/health', { headers: { Host: 'untrusted.invalid', Authorization: 'Bearer ' + backend.token } }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', () => resolve(0)); });
    assert.equal(wrongHost, 403);
    assert.equal((await request('/sessions', 'POST', { name: '' })).status, 400);
    const config = sessionConfigSchema.parse({ name: 'Persistence test', javaPath: 'missing-java.exe', emulatorPath: 'missing.jar', gamePath: 'missing-game.jar' });
    const created = await request('/sessions', 'POST', config); assert.equal(created.status, 201);
    const session = await created.json();
    assert.equal((await request(`/sessions/${session.id}/trace/start`, 'POST', {})).status, 409);
  } finally { await backend.close(); }
  backend = await createBackend(options);
  try {
    const sessions = await (await request('/sessions')).json(); assert.equal(sessions.length, 1);
    const id = sessions[0].id;
    assert.equal((await request(`/sessions/${id}/trace/start`, 'POST', { mode: 'deep' })).status, 409);
    assert.equal((await request(`/sessions/${id}/stop`, 'POST', {})).status, 409);
    const alias = { kind: 'class', original: 'a', alias: 'Player', note: 'User annotation' };
    assert.equal((await request(`/sessions/${id}/mappings`, 'POST', alias)).status, 201);
    assert.equal((await (await request(`/sessions/${id}/mappings`)).json())[0].alias, 'Player');
    await request(`/sessions/${id}/mappings`, 'POST', { ...alias, alias: 'Avatar' });
    assert.equal((await (await request(`/sessions/${id}/mappings`)).json()).length, 1);
    const emptyEvents = await (await request(`/sessions/${id}/events`)).json(); assert.deepEqual(emptyEvents.events, []);
    assert.equal((await request(`/sessions/${id}/events?limit=99999`)).status, 400);
    assert.equal((await request(`/sessions/${id}/launch`, 'POST', {})).status, 400);
    assert.equal((await (await request(`/sessions/${id}`)).json()).processState, 'failed');
    const exportText = await (await request(`/sessions/${id}/export?format=json`)).text(); assert.deepEqual(JSON.parse(exportText).events, []);
    assert.equal((await request(`/sessions/${id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/sessions/${id}`)).status, 404);
    const tables = await backend.sessions.db.query("SELECT name FROM sqlite_master WHERE type='table'");
    for (const table of ['sessions','runtime_metadata','user_events','method_invocations','argument_snapshots','exceptions','network_events','call_graph_edges','mapping_entries','instrumentation_warnings','export_jobs']) assert.ok(tables.some(t => t.name === table));
    assert.equal((await backend.sessions.db.query('SELECT COUNT(*) AS n FROM mapping_entries'))[0].n, 0);
  } finally { await backend.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('runtime schema rejects unbounded stack and array snapshots', () => {
  const minimal = { runtimeSeq: 1, timestamp: Date.now(), type: 'METHOD_ENTER', threadId: 1, threadName: 'main', traceId: 't', invocationId: 'i', parentId: null, className: 'a', methodName: 'b', descriptor: '()V', depth: 0 };
  assert.equal(runtimeEventSchema.safeParse(minimal).success, true);
  assert.equal(runtimeEventSchema.safeParse({ ...minimal, stack: Array(100).fill('frame') }).success, false);
  assert.equal(runtimeEventSchema.safeParse({ ...minimal, arguments: Array(13).fill({ type: 'int', status: 'observed', value: 1 }) }).success, false);
});
