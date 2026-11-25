import type { Bootstrap } from '../../shared-schemas';
declare global { interface Window { umra?: { bootstrap: Bootstrap; chooseFile(kind: 'runtime' | 'emulator' | 'game'): Promise<string | null> } } }
export function bootstrap(): Bootstrap {
  if (!window.umra?.bootstrap) throw new Error('Open UMRA using the desktop launcher (npm run dev or Start-UMRA.bat).');
  return window.umra.bootstrap;
}
export async function api<T>(route: string, body?: unknown, method?: string): Promise<T> {
  const b = bootstrap();
  const response = await fetch(b.origin + '/api/v1' + route, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: 'Bearer ' + b.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.error?.message ?? `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json();
}
export async function download(id: string, format: string) {
  const b = bootstrap(), response = await fetch(`${b.origin}/api/v1/sessions/${id}/export?format=${format}`, { headers: { Authorization: 'Bearer ' + b.token } });
  if (!response.ok) throw new Error((await response.json()).error.message);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = `umra-${id}.${format === 'report' ? 'json' : format}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
