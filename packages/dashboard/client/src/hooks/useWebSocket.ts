import { useEffect, useRef, useCallback, useState } from 'react';

type EventHandler = (type: string, data: any) => void;

export function useWebSocket(onEvent: EventHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const delayRef = useRef(3000);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    const token = localStorage.getItem('dashboard_token');
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'auth.ok') {
        setConnected(true);
        delayRef.current = 3000; // Reset backoff on successful auth
        return;
      }
      onEventRef.current(msg.type, msg.data);
    };

    ws.onclose = () => {
      setConnected(false);
      // Exponential backoff: 3s, 6s, 12s, capped at 30s
      reconnectTimerRef.current = setTimeout(connect, delayRef.current);
      delayRef.current = Math.min(delayRef.current * 2, 30000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
