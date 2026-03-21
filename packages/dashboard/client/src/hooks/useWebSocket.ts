import { useEffect, useRef, useCallback, useState } from 'react';

type EventHandler = (type: string, data: any) => void;

export function useWebSocket(onEvent: EventHandler) {
  const wsRef = useRef<WebSocket | null>(null);
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
        return;
      }
      onEventRef.current(msg.type, msg.data);
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  return { connected };
}
