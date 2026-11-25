import { z } from 'zod';

export const modes = ['basic', 'selective', 'network', 'deep'] as const;
export const traceOptionsSchema = z.object({
  mode: z.enum(modes).default('basic'),
  classFilter: z.string().max(200).default(''),
  methodFilter: z.string().max(200).default(''),
  captureFields: z.boolean().default(false),
  redact: z.boolean().default(true),
  capturePayload: z.boolean().default(false),
});
export type TraceOptions = z.infer<typeof traceOptionsSchema>;
export const sessionConfigSchema = z.object({
  name: z.string().trim().min(1).max(120),
  javaPath: z.string().min(1).max(2000),
  emulatorPath: z.string().min(1).max(2000),
  gamePath: z.string().min(1).max(2000),
  trace: traceOptionsSchema.default({}),
});
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export const snapshotSchema: z.ZodType<Snapshot> = z.lazy(() => z.object({
  type: z.string().max(400),
  status: z.enum(['observed', 'inferred', 'unavailable', 'redacted']),
  value: z.union([z.string().max(8192), z.number(), z.boolean(), z.null()]).optional(),
  identity: z.string().max(500).optional(),
  length: z.number().nonnegative().optional(),
  hex: z.string().max(8192).optional(),
  ascii: z.string().max(4096).optional(),
  truncated: z.boolean().optional(),
  items: z.array(snapshotSchema).max(12).optional(),
  fields: z.record(snapshotSchema).optional(),
  index: z.number().int().optional(),
}));
export interface Snapshot {
  type: string; status: 'observed' | 'inferred' | 'unavailable' | 'redacted';
  value?: string | number | boolean | null; identity?: string; length?: number;
  hex?: string; ascii?: string; truncated?: boolean; items?: Snapshot[];
  fields?: Record<string, Snapshot>; index?: number;
}
export const eventTypes = ['METHOD_ENTER', 'METHOD_EXIT', 'METHOD_EXCEPTION', 'USER_INPUT',
  'LIFECYCLE', 'SCREEN_CHANGE', 'NETWORK_OPEN', 'NETWORK_SEND', 'NETWORK_RECEIVE',
  'TRACE_WARNING', 'RUNTIME_STATUS', 'MARKER', 'METRICS'] as const;
export const runtimeEventSchema = z.object({
  runtimeSeq: z.number().int().nonnegative(),
  timestamp: z.number().nonnegative(),
  type: z.enum(eventTypes),
  threadId: z.number().int().nonnegative(),
  threadName: z.string().max(200),
  traceId: z.string().max(120).nullable(),
  invocationId: z.string().max(120).nullable(),
  parentId: z.string().max(120).nullable(),
  className: z.string().max(500),
  methodName: z.string().max(300),
  descriptor: z.string().max(2000),
  depth: z.number().int().min(0).max(256),
  arguments: z.array(snapshotSchema).max(12).optional(),
  returnValue: snapshotSchema.optional(),
  exception: snapshotSchema.optional(),
  receiver: snapshotSchema.optional(),
  durationNs: z.number().nonnegative().optional(),
  stack: z.array(z.string().max(600)).max(32).optional(),
  bytecodeOffset: z.number().int().nonnegative().nullable().optional(),
  data: z.record(z.unknown()).optional(),
});
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export interface TraceEvent extends RuntimeEvent {
  eventId: string; sessionId: string; seq: number; receivedAt: number;
  source: 'runtime-instrumentation' | 'backend';
}
export interface Session extends SessionConfig {
  id: string; createdAt: number; updatedAt: number;
  processState: 'stopped' | 'starting' | 'running' | 'failed';
  traceState: 'disabled' | 'active' | 'paused' | 'failed';
  recording: boolean; completed: boolean; agentReady: boolean;
  pid: number | null; eventCount: number; dropped: number;
  lastError: string | null; runtimeMetadata?: Record<string, unknown>;
}
export interface JarMethod { name: string; descriptor: string; access: number }
export interface JarClass { name: string; superName: string; methods: JarMethod[]; fields: { name: string; descriptor: string }[] }
export interface JarAnalysis { path: string; sha256: string; manifest: string; classes: JarClass[]; warnings: string[] }
export interface Mapping { id: number; sessionId: string; kind: 'class' | 'method'; original: string; alias: string; note: string }
export interface Bootstrap { origin: string; token: string; version: string }
export interface ServerMessage {
  type: 'batch' | 'state' | 'hello' | 'gap' | 'heartbeat' | 'warning';
  events?: TraceEvent[]; session?: Session; latestSeq?: number; message?: string;
  from?: number; to?: number; dropped?: number;
}
