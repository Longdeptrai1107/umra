import { useEffect, useRef, useState } from 'react';
import type { Session, TraceEvent, ServerMessage } from '../../shared-schemas';
import { bootstrap } from './api';

export function useLive(sessionId: string | undefined, onState: (s: Session) => void) {
  const [events, setEvents] = useState<TraceEvent[]>([]), [connection, setConnection] = useState('disconnected');
  const [paused, setPaused] = useState(false), [notice, setNotice] = useState(''), [retained, setRetained] = useState(0);
  const buffer = useRef<TraceEvent[]>([]), pausedRef = useRef(paused), cursor = useRef(0), ws = useRef<WebSocket | null>(null);
  const stateHandler = useRef(onState); stateHandler.current = onState; pausedRef.current = paused;
  const filterRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    let disposed = false, reconnect: ReturnType<typeof setTimeout>, attempt = 0;
    buffer.current = []; cursor.current = 0; setEvents([]); setRetained(0); setNotice('');
    if (!sessionId) { setConnection('disconnected'); return; }
    const connect = () => {
      if (disposed) return;
      const b = bootstrap(), socket = new WebSocket(`${b.origin.replace('http:', 'ws:')}/ws/v1/sessions/${sessionId}/live`, ['umra-v1', 'auth.' + b.token]); ws.current = socket;
      setConnection('connecting');
      socket.onopen = () => { attempt = 0; setConnection('connected'); socket.send(JSON.stringify({ type: 'subscribe', after: cursor.current, filter: filterRef.current })); };
      socket.onmessage = ({ data }) => {
        const message: ServerMessage = JSON.parse(data);
        if (message.session) stateHandler.current(message.session);
        if (message.type === 'batch' && message.events) {
          const added = message.events.filter(e => e.seq > cursor.current);
          if (added.length) {
            cursor.current = Math.max(cursor.current, ...added.map(e => e.seq));
            buffer.current.push(...added);
            if (buffer.current.length > 10000) { buffer.current.splice(0, buffer.current.length - 10000); setRetained(n => n + added.length); }
          }
        }
        if (message.type === 'gap' || message.type === 'warning') setNotice(message.message ?? 'A stream gap was detected. Use session history to recover saved records.');
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => { if (disposed) return; setConnection('disconnected'); reconnect = setTimeout(connect, Math.min(500 * 2 ** attempt++, 8000)); };
    };
    connect();
    const refresh = setInterval(() => { if (!pausedRef.current) setEvents([...buffer.current]); }, 150);
    return () => { disposed = true; clearTimeout(reconnect); clearInterval(refresh); ws.current?.close(); ws.current = null; };
  }, [sessionId]);
  return { events, connection, paused, setPaused, notice, retained,
    clear() { buffer.current = []; setEvents([]); setRetained(0); setNotice('View cleared. All recorded events remain in the session database.'); },
    filter(value: Record<string, unknown>) { filterRef.current = value; if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'filter', filter: value })); },
  };
}
