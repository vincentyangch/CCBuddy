# Dashboard Client Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React frontend for the CCBuddy dashboard — 5 pages (Status, Sessions, Conversations, Logs, Config) served as static files from the existing Fastify server.

**Architecture:** A Vite + React + Tailwind app in `packages/dashboard/client/`. Builds to `packages/dashboard/dist-client/` which Fastify serves via `@fastify/static`. Uses `react-router-dom` for client-side routing, a custom `useWebSocket` hook for real-time updates, and a typed API client for REST calls.

**Tech Stack:** Vite, React 19, Tailwind CSS 4, react-router-dom, prism-react-renderer

---

## Chunk 1: Client Scaffold + Auth + Layout

### Task 1: Create client scaffold with Vite + React + Tailwind

**Files:**
- Create: `packages/dashboard/client/` directory with Vite project
- Modify: `packages/dashboard/package.json` (add client build script)

- [ ] **Step 1: Scaffold Vite project**

Create the client directory and initialize:

```bash
cd packages/dashboard
mkdir -p client/src
```

Create `packages/dashboard/client/package.json`:
```json
{
  "name": "@ccbuddy/dashboard-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "react-router-dom": "^7"
  },
  "devDependencies": {
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4",
    "tailwindcss": "^4",
    "@tailwindcss/vite": "^4",
    "typescript": "^5.7",
    "vite": "^6"
  }
}
```

Create `packages/dashboard/client/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

Create `packages/dashboard/client/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-client',
    emptyDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:18801',
      '/ws': { target: 'ws://localhost:18801', ws: true },
    },
  },
});
```

Create `packages/dashboard/client/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CCBuddy Dashboard</title>
  </head>
  <body class="bg-gray-950 text-gray-100 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `packages/dashboard/client/src/main.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 2: Install client dependencies**

```bash
cd packages/dashboard/client && npm install
```

- [ ] **Step 3: Add client build to dashboard package scripts**

In `packages/dashboard/package.json`, update the `build` script:
```json
"build": "tsc && cd client && npm run build",
"build:client": "cd client && npm run build",
"dev:client": "cd client && npm run dev"
```

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/client/ packages/dashboard/package.json
git commit -m "feat(dashboard): scaffold Vite + React + Tailwind client"
```

---

### Task 2: API client + WebSocket hook + Auth

**Files:**
- Create: `packages/dashboard/client/src/main.tsx`
- Create: `packages/dashboard/client/src/App.tsx`
- Create: `packages/dashboard/client/src/lib/api.ts`
- Create: `packages/dashboard/client/src/hooks/useWebSocket.ts`
- Create: `packages/dashboard/client/src/components/AuthGuard.tsx`

- [ ] **Step 1: Create API client**

Create `packages/dashboard/client/src/lib/api.ts`:

```typescript
const getToken = () => localStorage.getItem('dashboard_token') ?? '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('dashboard_token');
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  auth: (token: string) =>
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => r.ok),

  status: () => request<any>('/api/status'),
  sessions: () => request<{ sessions: any[] }>('/api/sessions'),
  sessionEvents: (key: string) => request<{ events: any[] }>(`/api/sessions/${encodeURIComponent(key)}/events`),
  conversations: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/api/conversations?${qs}`);
  },
  logs: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ lines: string[]; file: string }>(`/api/logs?${qs}`);
  },
  config: () => request<{ config: any }>('/api/config'),
  updateConfig: (config: any) =>
    request<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
};
```

- [ ] **Step 2: Create WebSocket hook**

Create `packages/dashboard/client/src/hooks/useWebSocket.ts`:

```typescript
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
      // Reconnect after 3 seconds
      setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
```

- [ ] **Step 3: Create AuthGuard component**

Create `packages/dashboard/client/src/components/AuthGuard.tsx`:

```tsx
import { useState } from 'react';
import { api } from '../lib/api';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('dashboard_token'));
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  if (authed) return <>{children}</>;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const ok = await api.auth(token);
    if (ok) {
      localStorage.setItem('dashboard_token', token);
      setAuthed(true);
    } else {
      setError('Invalid token');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={handleLogin} className="bg-gray-900 p-8 rounded-xl border border-gray-800 w-80">
        <h1 className="text-xl font-bold mb-6 text-center">CCBuddy Dashboard</h1>
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Enter dashboard token"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg mb-4 text-sm"
          autoFocus
        />
        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
        <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium">
          Sign In
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Create App with router and layout**

Create `packages/dashboard/client/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { StatusPage } from './pages/StatusPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { LogsPage } from './pages/LogsPage';
import { ConfigPage } from './pages/ConfigPage';

const navItems = [
  { to: '/', label: 'Status' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/logs', label: 'Logs' },
  { to: '/config', label: 'Config' },
];

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex">
      <nav className="w-48 bg-gray-900 border-r border-gray-800 p-4 flex flex-col gap-1">
        <h1 className="text-lg font-bold mb-4 px-2">CCBuddy</h1>
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `px-3 py-2 rounded-lg text-sm ${isActive ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`
            }
          >
            {item.label}
          </NavLink>
        ))}
        <button
          onClick={() => { localStorage.removeItem('dashboard_token'); window.location.reload(); }}
          className="mt-auto px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-red-400 hover:bg-gray-800"
        >
          Sign Out
        </button>
      </nav>
      <main className="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <AuthGuard>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<StatusPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:key" element={<SessionDetailPage />} />
            <Route path="/conversations" element={<ConversationsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/config" element={<ConfigPage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthGuard>
  );
}
```

- [ ] **Step 5: Create main.tsx entry**

Create `packages/dashboard/client/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './main.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 6: Create stub pages**

Create stubs for all pages so the app compiles. Each page should be a simple placeholder:

`packages/dashboard/client/src/pages/StatusPage.tsx`:
```tsx
export function StatusPage() { return <h2 className="text-2xl font-bold">Status</h2>; }
```

Create similar stubs for: `SessionsPage.tsx`, `SessionDetailPage.tsx`, `ConversationsPage.tsx`, `LogsPage.tsx`, `ConfigPage.tsx`.

- [ ] **Step 7: Build and verify**

```bash
cd packages/dashboard/client && npm run build
```
Expected: Builds to `packages/dashboard/dist-client/`

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/client/ packages/dashboard/package.json
git commit -m "feat(dashboard): auth, routing, layout, API client, WebSocket hook"
```

---

### Task 3: Serve static client from Fastify

**Files:**
- Modify: `packages/dashboard/src/server/index.ts`

- [ ] **Step 1: Register @fastify/static in DashboardServer**

In `packages/dashboard/src/server/index.ts`, add import:

```typescript
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
```

In the `start()` method, before `this.app.listen(...)`, add:

```typescript
    // Serve built React client
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const clientDir = join(__dirname, '..', '..', 'dist-client');
    try {
      await this.app.register(fastifyStatic, {
        root: clientDir,
        wildcard: false, // Let API routes take precedence
      });
      // SPA fallback — serve index.html for all non-API, non-file routes
      this.app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        return reply.sendFile('index.html');
      });
    } catch {
      console.warn('[Dashboard] Client build not found — API-only mode');
    }
```

- [ ] **Step 2: Build everything**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/server/index.ts
git commit -m "feat(dashboard): serve React client via @fastify/static"
```

---

## Chunk 2: Pages

### Task 4: Status page

**Files:**
- Modify: `packages/dashboard/client/src/pages/StatusPage.tsx`

- [ ] **Step 1: Implement StatusPage**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

interface StatusData {
  heartbeat: {
    modules?: Record<string, string>;
    system?: { cpuPercent: number; memoryPercent: number; diskPercent: number };
  };
  sessions: any[];
  queueSize: number;
  uptime: number;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-green-500',
    degraded: 'bg-yellow-500',
    down: 'bg-red-500',
  };
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full ${colors[status] ?? 'bg-gray-500'} mr-2`} />
  );
}

function Gauge({ label, value }: { label: string; value: number }) {
  const color = value > 80 ? 'bg-red-500' : value > 60 ? 'bg-yellow-500' : 'bg-blue-500';
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="text-sm text-gray-400 mb-2">{label}</div>
      <div className="text-2xl font-bold mb-2">{value}%</div>
      <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function StatusPage() {
  const [data, setData] = useState<StatusData | null>(null);

  const load = useCallback(async () => {
    setData(await api.status());
  }, []);

  useEffect(() => { load(); }, [load]);

  useWebSocket(useCallback((type, payload) => {
    if (type === 'heartbeat.status') {
      setData(prev => prev ? { ...prev, heartbeat: payload } : prev);
    }
  }, []));

  if (!data) return <p className="text-gray-400">Loading...</p>;

  const sys = data.heartbeat.system;
  const mods = data.heartbeat.modules ?? {};
  const upHours = Math.floor(data.uptime / 3600);
  const upMins = Math.floor((data.uptime % 3600) / 60);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">System Status</h2>

      {sys && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Gauge label="CPU" value={sys.cpuPercent} />
          <Gauge label="Memory" value={Math.round(sys.memoryPercent * 100) / 100} />
          <Gauge label="Disk" value={sys.diskPercent} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="text-sm text-gray-400 mb-3">Modules</div>
          {Object.entries(mods).map(([name, status]) => (
            <div key={name} className="flex items-center mb-1 text-sm">
              <StatusBadge status={status} />
              <span className="capitalize">{name}</span>
              <span className="ml-auto text-gray-500">{status}</span>
            </div>
          ))}
        </div>
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="text-sm text-gray-400 mb-3">Overview</div>
          <div className="text-sm mb-1">Active Sessions: <span className="text-white font-medium">{data.sessions.length}</span></div>
          <div className="text-sm mb-1">Queue Depth: <span className="text-white font-medium">{data.queueSize}</span></div>
          <div className="text-sm">Uptime: <span className="text-white font-medium">{upHours}h {upMins}m</span></div>
        </div>
      </div>

      {data.sessions.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div className="text-sm text-gray-400 mb-3">Active Sessions</div>
          {data.sessions.map((s: any) => (
            <div key={s.sessionKey} className="text-sm mb-1 flex justify-between">
              <span className="font-mono">{s.sessionKey}</span>
              <span className="text-gray-500">{new Date(s.lastActivity).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build client, commit**

```bash
cd packages/dashboard/client && npm run build
git add packages/dashboard/client/src/pages/StatusPage.tsx
git commit -m "feat(dashboard): implement StatusPage with health gauges and session list"
```

---

### Task 5: Sessions + SessionDetail pages

**Files:**
- Modify: `packages/dashboard/client/src/pages/SessionsPage.tsx`
- Modify: `packages/dashboard/client/src/pages/SessionDetailPage.tsx`
- Create: `packages/dashboard/client/src/components/ChatMessage.tsx`
- Create: `packages/dashboard/client/src/components/ThinkingBlock.tsx`
- Create: `packages/dashboard/client/src/components/ToolUseBlock.tsx`

- [ ] **Step 1: Implement SessionsPage**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

export function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([]);

  useEffect(() => {
    api.sessions().then(d => setSessions(d.sessions));
  }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-gray-400">No active sessions</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Session Key</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Type</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s.sessionKey} className="border-t border-gray-800 hover:bg-gray-800/30">
                  <td className="px-4 py-3">
                    <Link to={`/sessions/${encodeURIComponent(s.sessionKey)}`} className="text-blue-400 hover:underline font-mono">
                      {s.sessionKey}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{s.isGroupChannel ? 'Group' : 'DM'}</td>
                  <td className="px-4 py-3 text-gray-400">{new Date(s.lastActivity).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create chat rendering components**

Create `packages/dashboard/client/src/components/ThinkingBlock.tsx`:

```tsx
import { useState } from 'react';

export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-2 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 text-left text-sm text-gray-400 bg-gray-800/50 hover:bg-gray-800 flex justify-between items-center"
      >
        <span>Thinking...</span>
        <span>{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <pre className="px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap max-h-96 overflow-auto">{content}</pre>
      )}
    </div>
  );
}
```

Create `packages/dashboard/client/src/components/ToolUseBlock.tsx`:

```tsx
export function ToolUseBlock({ tool, input, output }: { tool: string; input?: string; output?: string }) {
  return (
    <div className="my-2 border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 text-sm bg-gray-800/50 font-mono">
        <span className="text-yellow-400">Tool:</span> {tool}
      </div>
      {input && (
        <pre className="px-3 py-2 text-xs text-gray-300 border-t border-gray-700 whitespace-pre-wrap max-h-48 overflow-auto">{input}</pre>
      )}
      {output && (
        <pre className="px-3 py-2 text-xs text-gray-400 border-t border-gray-700 whitespace-pre-wrap max-h-48 overflow-auto">{output}</pre>
      )}
    </div>
  );
}
```

Create `packages/dashboard/client/src/components/ChatMessage.tsx`:

```tsx
export function ChatMessage({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user';
  return (
    <div className={`my-3 p-3 rounded-lg ${isUser ? 'bg-blue-900/30 border border-blue-800/50' : 'bg-gray-800/50 border border-gray-700/50'}`}>
      <div className="text-xs font-medium mb-1 text-gray-400">{isUser ? 'User' : 'Assistant'}</div>
      <div className="text-sm whitespace-pre-wrap">{content}</div>
    </div>
  );
}
```

- [ ] **Step 3: Implement SessionDetailPage**

```tsx
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ChatMessage } from '../components/ChatMessage';
import { ThinkingBlock } from '../components/ThinkingBlock';
import { ToolUseBlock } from '../components/ToolUseBlock';

export function SessionDetailPage() {
  const { key } = useParams<{ key: string }>();
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!key) return;
    api.sessionEvents(key).then(d => {
      setEvents(d.events);
      setLoading(false);
    });
  }, [key]);

  if (loading) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <Link to="/sessions" className="text-blue-400 hover:underline text-sm mb-4 inline-block">&larr; Back to Sessions</Link>
      <h2 className="text-2xl font-bold mb-6 font-mono">{key}</h2>
      <div className="max-w-3xl">
        {events.length === 0 ? (
          <p className="text-gray-400">No events recorded for this session</p>
        ) : (
          events.map((e: any, i: number) => {
            if (e.eventType === 'thinking') return <ThinkingBlock key={i} content={e.content} />;
            if (e.eventType === 'tool_use' || e.eventType === 'tool_result')
              return <ToolUseBlock key={i} tool={e.content} input={e.toolInput} output={e.toolOutput} />;
            if (e.eventType === 'text') return <ChatMessage key={i} role="assistant" content={e.content} />;
            return null;
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build client, commit**

```bash
cd packages/dashboard/client && npm run build
git add packages/dashboard/client/src/
git commit -m "feat(dashboard): Sessions, SessionDetail pages with chat replay components"
```

---

### Task 6: Conversations page

**Files:**
- Modify: `packages/dashboard/client/src/pages/ConversationsPage.tsx`

- [ ] **Step 1: Implement ConversationsPage**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

export function ConversationsPage() {
  const [messages, setMessages] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ user: '', platform: '', search: '' });
  const pageSize = 50;

  const load = useCallback(async () => {
    const params: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
    if (filters.user) params.user = filters.user;
    if (filters.platform) params.platform = filters.platform;
    if (filters.search) params.search = filters.search;
    const data = await api.conversations(params);
    setMessages(data.messages);
    setTotal(data.total);
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Conversations</h2>

      <div className="flex gap-3 mb-4">
        <input placeholder="Filter user" value={filters.user}
          onChange={e => { setFilters(f => ({ ...f, user: e.target.value })); setPage(1); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40" />
        <input placeholder="Filter platform" value={filters.platform}
          onChange={e => { setFilters(f => ({ ...f, platform: e.target.value })); setPage(1); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40" />
        <input placeholder="Search..." value={filters.search}
          onChange={e => { setFilters(f => ({ ...f, search: e.target.value })); setPage(1); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm flex-1" />
      </div>

      <div className="text-sm text-gray-400 mb-3">{total} messages</div>

      <div className="space-y-2">
        {messages.map((m: any) => (
          <div key={m.id} className="bg-gray-900 rounded-lg border border-gray-800 p-3">
            <div className="flex gap-4 text-xs text-gray-500 mb-2">
              <span>{m.role === 'user' ? '👤' : '🤖'} {m.userId}</span>
              <span>{m.platform}</span>
              <span>{new Date(m.timestamp).toLocaleString()}</span>
              <span className="font-mono">{m.sessionId}</span>
            </div>
            <div className="text-sm whitespace-pre-wrap line-clamp-3">{m.content}</div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex gap-2 mt-4 justify-center">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-50">Prev</button>
          <span className="px-3 py-1 text-sm text-gray-400">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-50">Next</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build client, commit**

```bash
cd packages/dashboard/client && npm run build
git add packages/dashboard/client/src/pages/ConversationsPage.tsx
git commit -m "feat(dashboard): Conversations page with pagination and filters"
```

---

### Task 7: Logs page

**Files:**
- Modify: `packages/dashboard/client/src/pages/LogsPage.tsx`

- [ ] **Step 1: Implement LogsPage**

```tsx
import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

const LOG_FILES = ['stdout', 'stderr', 'app'] as const;

export function LogsPage() {
  const [file, setFile] = useState<string>('stdout');
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.logs({ file, lines: '500' }).then(d => setLines(d.lines));
  }, [file]);

  useWebSocket(useCallback((type, data) => {
    if (type === 'log.line' && data.file === file) {
      setLines(prev => [...prev.slice(-999), data.line]);
    }
  }, [file]));

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, autoScroll]);

  const filtered = filter
    ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-2xl font-bold">Logs</h2>
        <div className="flex gap-1 ml-4">
          {LOG_FILES.map(f => (
            <button key={f} onClick={() => setFile(f)}
              className={`px-3 py-1 rounded text-sm ${file === f ? 'bg-blue-600' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
              {f}
            </button>
          ))}
        </div>
        <input placeholder="Filter..." value={filter} onChange={e => setFilter(e.target.value)}
          className="px-3 py-1 bg-gray-800 border border-gray-700 rounded text-sm ml-auto w-48" />
        <button onClick={() => setAutoScroll(!autoScroll)}
          className={`px-3 py-1 rounded text-sm ${autoScroll ? 'bg-green-700' : 'bg-gray-800 text-gray-400'}`}>
          {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
        </button>
      </div>
      <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 overflow-auto font-mono text-xs p-3">
        {filtered.map((line, i) => (
          <div key={i} className="py-0.5 hover:bg-gray-800/50 whitespace-pre-wrap">
            {line}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build client, commit**

```bash
cd packages/dashboard/client && npm run build
git add packages/dashboard/client/src/pages/LogsPage.tsx
git commit -m "feat(dashboard): Logs page with real-time streaming and filters"
```

---

### Task 8: Config page

**Files:**
- Modify: `packages/dashboard/client/src/pages/ConfigPage.tsx`

- [ ] **Step 1: Implement ConfigPage with tabs**

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const TABS = ['General', 'Agent', 'Users', 'Platforms', 'Scheduler', 'Memory', 'Media', 'Skills', 'Webhooks', 'Apple', 'Dashboard'] as const;
const TAB_KEYS: Record<string, string> = {
  General: '_root', Agent: 'agent', Users: 'users', Platforms: 'platforms',
  Scheduler: 'scheduler', Memory: 'memory', Media: 'media', Skills: 'skills',
  Webhooks: 'webhooks', Apple: 'apple', Dashboard: 'dashboard',
};

function ConfigField({ label, value, onChange, type = 'text' }: {
  label: string; value: any; onChange: (v: any) => void; type?: string;
}) {
  if (typeof value === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm py-1">
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)}
          className="rounded bg-gray-800 border-gray-600" />
        {label}
      </label>
    );
  }
  return (
    <div className="flex items-center gap-3 py-1">
      <label className="text-sm text-gray-400 w-48 shrink-0">{label}</label>
      <input type={type} value={String(value ?? '')} onChange={e => {
        const v = type === 'number' ? Number(e.target.value) : e.target.value;
        onChange(v);
      }} className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm" />
    </div>
  );
}

function renderFields(obj: Record<string, any>, path: string[], onChange: (path: string[], value: any) => void) {
  return Object.entries(obj).map(([key, value]) => {
    const fullPath = [...path, key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return (
        <div key={key} className="ml-4 mb-3">
          <div className="text-sm font-medium text-gray-300 mb-1">{key}</div>
          {renderFields(value, fullPath, onChange)}
        </div>
      );
    }
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'checkbox' : 'text';
    return <ConfigField key={key} label={key} value={value} type={type}
      onChange={v => onChange(fullPath, v)} />;
  });
}

export function ConfigPage() {
  const [config, setConfig] = useState<any>(null);
  const [tab, setTab] = useState<string>('General');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    api.config().then(d => setConfig(d.config));
  }, []);

  const handleChange = (path: string[], value: any) => {
    setConfig((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await api.updateConfig(config);
      setStatus('Saved successfully');
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    setSaving(false);
  };

  if (!config) return <p className="text-gray-400">Loading...</p>;

  const tabKey = TAB_KEYS[tab];
  const section = tabKey === '_root'
    ? { data_dir: config.data_dir, log_level: config.log_level }
    : config[tabKey] ?? {};

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Config</h2>
        <div className="flex items-center gap-3">
          {status && <span className={`text-sm ${status.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>{status}</span>}
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-6 flex-wrap">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab === t ? 'bg-blue-600' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            {t}
          </button>
        ))}
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        {renderFields(section, tabKey === '_root' ? [] : [tabKey], handleChange)}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build client, commit**

```bash
cd packages/dashboard/client && npm run build
git add packages/dashboard/client/src/pages/ConfigPage.tsx
git commit -m "feat(dashboard): Config page with tabbed editor"
```

---

## Chunk 3: Final Build + Verification

### Task 9: Full build + restart + smoke test

- [ ] **Step 1: Build everything**

```bash
npm run build
```

- [ ] **Step 2: Enable dashboard in local config**

Add to `config/local.yaml`:
```yaml
  dashboard:
    enabled: true
    host: "0.0.0.0"
```

Ensure `CCBUDDY_DASHBOARD_TOKEN` is set in the environment (add to the launchd plist if needed).

- [ ] **Step 3: Restart CCBuddy**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccbuddy.agent.plist
```

- [ ] **Step 4: Verify dashboard loads**

Open `http://localhost:18801` in a browser. Verify:
1. Login page appears → enter token → dashboard loads
2. Status page shows health gauges, module statuses
3. Sessions page lists active sessions (if any)
4. Conversations page shows message history with pagination
5. Logs page shows log output
6. Config page shows tabbed config editor

- [ ] **Step 5: Update CLAUDE.md and memory**

Add to CLAUDE.md under Key Files:
```
- `packages/dashboard/` — Fastify server + React client for GUI dashboard (port 18801)
```

Commit:
```bash
git add CLAUDE.md
git commit -m "docs: add dashboard to CLAUDE.md"
```
