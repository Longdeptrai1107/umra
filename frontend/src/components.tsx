import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, AlertTriangle, GitBranch, Search } from 'lucide-react';
import type { Mapping, Snapshot, TraceEvent } from '../../shared-schemas';

export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><GitBranch size={30}/><h3>{title}</h3><p>{children}</p></div>; }
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={'badge ' + tone}>{children}</span>; }
export const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
export const duration = (n?: number) => n === undefined ? 'open' : n < 1000000 ? (n / 1000).toFixed(1) + ' µs' : (n / 1000000).toFixed(2) + ' ms';
export function name(e: TraceEvent, mappings: Mapping[]) {
  const method = mappings.find(m => m.kind === 'method' && m.original === `${e.className}.${e.methodName}${e.descriptor}`);
  const cls = mappings.find(m => m.kind === 'class' && m.original === e.className);
  return method?.alias ?? `${cls?.alias ?? e.className}.${e.methodName}${e.descriptor}`;
}
export function value(v?: Snapshot): string {
  if (!v) return 'not collected'; if (v.status === 'redacted') return '[redacted]';
  if (v.identity) return v.identity; if (v.hex) return v.hex.slice(0, 40) + (v.truncated ? '…' : '');
  if (v.items) return '[' + v.items.map(value).join(', ') + ']'; return String(v.value ?? v.type);
}
export function EventList({ events, selected, onSelect, mappings }: { events: TraceEvent[]; selected?: string; onSelect(e: TraceEvent): void; mappings: Mapping[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: events.length, getScrollElement: () => ref.current, estimateSize: () => 42, overscan: 12 });
  return <div className="event-list"><div className="event-grid table-head"><span>TIME / ID</span><span>EVENT</span><span>HANDLER / METHOD</span><span>VALUES / DETAIL</span><span>THREAD</span></div>
    <div className="virtual-scroll" ref={ref}>{!events.length && <Empty title="Waiting for observed events">Launch a MIDlet, enable live tracing and interact with the emulator. Saved records are available in Search.</Empty>}<div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
      {virtual.getVirtualItems().map(row => { const e = events[row.index]; return <button key={e.eventId} data-testid="event-row" className={'event-grid table-row ' + (selected === e.eventId ? 'selected ' : '') + (e.type === 'METHOD_EXCEPTION' || e.type === 'TRACE_WARNING' ? 'warn' : '')}
        style={{ position: 'absolute', transform: `translateY(${row.start}px)`, height: row.size, width: '100%' }} onClick={() => onSelect(e)}>
        <span className="mono small">{time(e.timestamp)}<small>#{e.seq}</small></span>
        <span><Badge tone={e.type.includes('NETWORK') ? 'purple' : e.type === 'USER_INPUT' ? 'green' : ''}>{e.type.replace('METHOD_', '').replace('NETWORK_', 'NET ')}</Badge></span>
        <span className="mono truncate" title={name(e, mappings)}>{e.className ? name(e, mappings) : String(e.data?.status ?? e.type)}<small>{e.traceId ?? 'No observed trace context'}</small></span>
        <span className="truncate mono small">{e.arguments?.map(value).join(', ') ?? (e.returnValue ? value(e.returnValue) : e.exception ? value(e.exception) : String(e.data?.message ?? e.data?.endpoint ?? ''))}</span>
        <span className="truncate small">{e.threadName}<small>#{e.threadId}</small></span>
      </button>; })}
    </div></div></div>;
}
export function SnapshotView({ snapshot, label }: { snapshot?: Snapshot; label: string }) {
  if (!snapshot) return <div className="snapshot"><span>{label}</span><Badge>unavailable</Badge><p>Not collected in this trace mode.</p></div>;
  const hex = snapshot.hex?.match(/.{1,32}/g)?.map((line, i) => `${(i * 16).toString(16).padStart(6, '0')}  ${line.match(/../g)?.join(' ').padEnd(47, ' ')}  ${snapshot.ascii?.slice(i * 16, i * 16 + 16) ?? ''}`).join('\n');
  return <div className="snapshot"><div className="row between"><b>{label}</b><Badge tone={snapshot.status === 'redacted' ? 'orange' : ''}>{snapshot.status}</Badge></div>
    <div className="mono muted small">{snapshot.type}{snapshot.length !== undefined ? ` · length ${snapshot.length}` : ''}</div>
    <pre className="value">{value(snapshot)}</pre>{hex && <pre className="hex">{hex}</pre>}
    {snapshot.truncated && <small className="warning-text">Snapshot truncated at the configured safety limit.</small>}
    {snapshot.items?.map((s, i) => <details key={i}><summary>index {i} · {value(s)}</summary><SnapshotView snapshot={s} label={String(i)}/></details>)}
    {snapshot.fields && Object.entries(snapshot.fields).map(([key, s]) => <details key={key}><summary>{key} · {value(s)}</summary><SnapshotView snapshot={s} label={key}/></details>)}
  </div>;
}
export function CallTree({ events, traceId, mappings, onSelect }: { events: TraceEvent[]; traceId: string; mappings: Mapping[]; onSelect(e: TraceEvent): void }) {
  const [collapsed, setCollapsed] = useState(new Set<string>()), [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const { flat, total } = useMemo(() => {
    const entries = events.filter(e => e.type === 'METHOD_ENTER' && (!traceId || e.traceId === traceId));
    const ids = new Set(entries.map(e => e.invocationId)); const children = new Map<string, TraceEvent[]>();
    const exits = new Map(events.filter(e => e.type === 'METHOD_EXIT' || e.type === 'METHOD_EXCEPTION').map(e => [e.invocationId, e]));
    for (const e of entries) { const key = e.parentId && ids.has(e.parentId) ? e.parentId : 'root'; const list = children.get(key) ?? []; list.push(e); children.set(key, list); }
    const list: { event: TraceEvent; depth: number; expandable: boolean; exit?: TraceEvent }[] = [];
    const add = (key: string, depth: number) => {
      if (depth > 64 || list.length >= 3000) return;
      for (const e of children.get(key) ?? []) {
        if (list.length >= 3000) break;
        const match = !query || name(e, mappings).toLowerCase().includes(query.toLowerCase());
        if (match) list.push({ event: e, depth, expandable: !!children.get(e.invocationId!), exit: exits.get(e.invocationId) });
        if (!collapsed.has(e.invocationId!)) add(e.invocationId!, depth + 1);
      }
    };
    add('root', 0); return { flat: list, total: entries.length };
  }, [events, traceId, mappings, query, collapsed]);
  const virtual = useVirtualizer({ count: flat.length, getScrollElement: () => ref.current, estimateSize: () => 36, overscan: 12 });
  return <div className="tree"><div className="sub-toolbar"><Search size={14}/><input placeholder="Filter class or method…" value={query} onChange={e => setQuery(e.target.value)}/><small>{total.toLocaleString()} calls</small>
    <button onClick={() => setCollapsed(new Set())}>Expand</button><button onClick={() => setCollapsed(new Set(events.filter(e => e.type === 'METHOD_ENTER').map(e => e.invocationId!)))}>Collapse</button></div>
    <div className="note">Observed ancestry · independent threads remain separate · at most 3,000 visible nodes</div>
    {!flat.length ? <Empty title="No method tree yet">Deep mode records method invocations in the selected JAR. Basic mode records instrumented callbacks.</Empty> : <div className="virtual-scroll" ref={ref}><div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
      {virtual.getVirtualItems().map(row => { const n = flat[row.index], e = n.event; return <div className={'tree-node ' + (n.exit?.exception ? 'warn' : '')} key={e.eventId} style={{ position: 'absolute', width: '100%', height: row.size, transform: `translateY(${row.start}px)`, paddingLeft: 10 + Math.min(n.depth, 14) * 17 }}>
        <button className="icon-button" aria-label="Toggle node" onClick={() => setCollapsed(old => { const next = new Set(old); next.has(e.invocationId!) ? next.delete(e.invocationId!) : next.add(e.invocationId!); return next; })} disabled={!n.expandable}>
          {collapsed.has(e.invocationId!) ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}</button>
        <button className="tree-label mono truncate" onClick={() => onSelect(e)} title={name(e, mappings)}>{n.exit?.exception && <AlertTriangle size={12}/>} {name(e, mappings)}</button>
        <small className="mono muted">{duration(n.exit?.durationNs)} · 1 call</small>
      </div>; })}
    </div></div>}
  </div>;
}
