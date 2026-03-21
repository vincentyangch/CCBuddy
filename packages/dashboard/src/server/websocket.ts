import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Disposable } from '@ccbuddy/core';

// EventBus interface (minimal, avoids full import chain)
interface EventBusLike {
  subscribe(event: string, handler: (payload: any) => void): Disposable;
}

const FORWARDED_EVENTS = [
  'heartbeat.status',
  'message.incoming',
  'message.outgoing',
  'agent.progress',
  'alert.health',
  'session.conflict',
  'scheduler.job.complete',
] as const;

export function setupWebSocket(
  app: FastifyInstance,
  eventBus: EventBusLike,
  token: string,
): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    let authenticated = false;
    const disposables: Disposable[] = [];

    // Require auth within 5 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(4001, 'Auth timeout');
      }
    }, 5000);

    socket.on('message', (data) => {
      let msg: { type: string; token?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'auth') {
        if (msg.token === token) {
          authenticated = true;
          clearTimeout(authTimeout);
          socket.send(JSON.stringify({ type: 'auth.ok' }));

          // Subscribe to event bus and forward to client
          for (const eventType of FORWARDED_EVENTS) {
            const d = eventBus.subscribe(eventType, (payload: any) => {
              if (socket.readyState === 1) { // WebSocket.OPEN
                socket.send(JSON.stringify({ type: eventType, data: payload }));
              }
            });
            disposables.push(d);
          }
        } else {
          socket.close(4001, 'Invalid token');
        }
        return;
      }

      if (!authenticated) {
        socket.close(4001, 'Not authenticated');
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      for (const d of disposables) d.dispose();
    });
  });
}
