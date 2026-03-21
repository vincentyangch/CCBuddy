import { useEffect, useRef, useCallback, useState } from 'react';

type EventHandler = (type: string, data: any) => void;

interface UseWebSocketOptions {
  onEvent: EventHandler;
  channelId?: string;
}

export function useWebSocket(onEventOrOptions: EventHandler | UseWebSocketOptions) {
  const opts = typeof onEventOrOptions === 'function'
    ? { onEvent: onEventOrOptions }
    : onEventOrOptions;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const delayRef = useRef(3000);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const connect = useCallback(() => {
    const token = localStorage.getItem('dashboard_token');
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token, channelId: opts.channelId }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'auth.ok') {
        setConnected(true);
        delayRef.current = 3000;
        return;
      }
      onEventRef.current(msg.type, msg.data ?? msg);
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimerRef.current = setTimeout(connect, delayRef.current);
      delayRef.current = Math.min(delayRef.current * 2, 30000);
    };
  }, [opts.channelId]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, send };
}
