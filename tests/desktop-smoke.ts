import { _electron as electron } from '@playwright/test';
import path from 'node:path';
const desktop = await electron.launch({ args: [process.cwd()], env: { ...process.env, UMRA_DATA_DIR: process.env.UMRA_SMOKE_DATA ?? path.join(process.cwd(), 'artifacts/smoke-data') } });
try {
  const page = await desktop.firstWindow();
  page.on('console', message => { if (message.type() === 'error') console.error('Renderer:', message.text()); });
  page.on('pageerror', error => console.error('Renderer exception:', error.message));
  await page.locator('#root > *').waitFor({ timeout: 12000 }).catch(() => undefined);
  if (process.env.UMRA_SMOKE_DATA) {
    await page.getByText('Backend ready', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes('in view'), undefined, { timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.workspace-toolbar small')].some(e => /^[1-9].*in view$/.test(e.textContent ?? '')), undefined, { timeout: 5000 }).catch(() => undefined);
    console.log('LAYOUT', await page.evaluate(() => [...document.querySelectorAll('.analysis-workspace,.monitor-column,.monitor-panel,.event-list,.virtual-scroll,.mini-tree,.page-content')].map(e => ({ class: e.className, height: e.getBoundingClientRect().height, width: e.getBoundingClientRect().width, scroll: e.scrollHeight, children: e.children.length }))));
  }
  console.log(await page.evaluate(async () => ({ href: location.href, bridge: !!window.umra, text: document.body.innerText.slice(0, 10000),
    health: window.umra ? await fetch(window.umra.bootstrap.origin + '/api/v1/health', { headers: { Authorization: 'Bearer ' + window.umra.bootstrap.token } }).then(async r => ({ status: r.status, text: await r.text() })).catch(e => String(e)) : null })));
} finally { await desktop.close(); }
