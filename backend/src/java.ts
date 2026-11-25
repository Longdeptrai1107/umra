import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { JarAnalysis } from '../../shared-schemas';

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export async function realFile(input: string, extensions: string[]): Promise<string> {
  const file = await fs.realpath(input).catch(() => { throw new ApiError(400, 'FILE_NOT_FOUND', `File does not exist: ${input}`); });
  const stat = await fs.stat(file);
  if (!stat.isFile() || !extensions.includes(path.extname(file).toLowerCase())) throw new ApiError(400, 'INVALID_FILE', `Expected ${extensions.join('/')} file: ${file}`);
  if (path.extname(file).toLowerCase() === '.jar' && stat.size > 128 * 1024 * 1024) throw new ApiError(413, 'JAR_TOO_LARGE', 'JAR exceeds 128 MiB');
  return file;
}
export function execute(file: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false }, (error, stdout, stderr) => {
    if (error) reject(new ApiError(400, 'JAVA_COMMAND_FAILED', `${error.message}\n${stderr.slice(0, 3000)}`));
    else resolve(stdout || stderr);
  }));
}
export async function probeJava(javaPath: string) {
  const file = await realFile(javaPath, process.platform === 'win32' ? ['.exe'] : ['']);
  if (!/^java(w)?(\.exe)?$/i.test(path.basename(file))) throw new ApiError(400, 'INVALID_RUNTIME', 'Choose the java executable from a desktop JRE/JDK');
  const version = await execute(file, ['-version']);
  const match = version.match(/version\s+"([^"]+)"/);
  if (!match) throw new ApiError(400, 'INVALID_RUNTIME', 'Cannot determine Java version');
  const major = Number(match[1].startsWith('1.') ? match[1].split('.')[1] : match[1].split('.')[0]);
  if (major < 8 || major > 27) throw new ApiError(400, 'UNSUPPORTED_JVM', 'This adapter supports desktop Java 8–27; Java 8 is recommended for MicroEmulator 2.0.4');
  return { javaPath: file, version: match[1], major, details: version.slice(0, 2000) };
}
export async function discoverRuntimes() {
  const candidates = new Set<string>();
  if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', '/usr/lib/jvm']) {
    for (const name of await fs.readdir(base).catch(() => [])) candidates.add(path.join(base, name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  }
  const results = await Promise.allSettled([...candidates].map(probeJava));
  return results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []).sort((a, b) => (a.major === 8 ? -1 : b.major === 8 ? 1 : a.major - b.major));
}
export async function resolveGame(input: string): Promise<string> {
  const file = await realFile(input, ['.jar', '.jad']);
  if (path.extname(file).toLowerCase() === '.jar') return file;
  const text = await fs.readFile(file, 'utf8');
  const url = text.match(/^MIDlet-Jar-URL:\s*(.+)$/im)?.[1]?.trim();
  if (!url || /^[a-z]+:/i.test(url)) throw new ApiError(400, 'INVALID_JAD', 'JAD must refer to a local relative JAR');
  return realFile(path.resolve(path.dirname(file), decodeURIComponent(url)), ['.jar']);
}
export async function analyzeJar(java: string, agent: string, gamePath: string): Promise<JarAnalysis> {
  const file = await resolveGame(gamePath);
  const result = JSON.parse(await execute(java, ['-jar', agent, 'inspect', file], 45000));
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  if (!Array.isArray(result.classes) || !result.classes.length) throw new ApiError(400, 'EMPTY_JAR', 'No readable Java classes found');
  return { path: file, sha256, manifest: result.manifest, classes: result.classes, warnings: result.warnings };
}
export function properties(values: Record<string, string>): string {
  return Object.entries(values).map(([key, val]) => `${key}=${val.replace(/[^\x20-\x7e]|[\\=:\n\r]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))}`).join('\n');
}
