import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Disposable } from '@ccbuddy/core';
import type { WebChatAdapter } from './webchat-adapter.js';

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
  webchatAdapter?: WebChatAdapter,
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

          // Register with webchat adapter
          if (webchatAdapter) {
            const channelId = (msg as any).channelId || 'webchat-main';
            (socket as any).__channelId = channelId;
            webchatAdapter.addClient(channelId, socket);
          }

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
        return;
      }

      // Chat message routing
      if (msg.type === 'chat.message' && webchatAdapter) {
        const channelId = (socket as any).__channelId;
        if (channelId) {
          webchatAdapter.handleClientMessage(channelId, msg as any);
        }
        return;
      }

      if (msg.type === 'chat.button_click' && webchatAdapter) {
        webchatAdapter.handleButtonClick((msg as any).messageId, (msg as any).buttonLabel);
        return;
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (webchatAdapter && (socket as any).__channelId) {
        webchatAdapter.removeClient((socket as any).__channelId);
      }
      for (const d of disposables) d.dispose();
    });
  });
}
