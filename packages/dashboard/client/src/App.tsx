import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { ThemeToggle } from './components/ui';
import { StatusPage } from './pages/StatusPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { LogsPage } from './pages/LogsPage';
import { ConfigPage } from './pages/ConfigPage';
import { ChatPage } from './pages/ChatPage';

const navGroups = [
  {
    label: 'Operations',
    items: [
      { to: '/', label: 'Status' },
      { to: '/sessions', label: 'Runtime Sessions' },
      { to: '/logs', label: 'Logs' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/chat', label: 'Chat' },
      { to: '/conversations', label: 'History' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/settings', label: 'Settings' },
    ],
  },
];

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const pathname = location.pathname.replace(/\/$/, '') || '/';
  const isMigrated =
    pathname === '/' ||
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/') ||
    pathname === '/logs';

  return (
    <div className="sd-shell">
      <nav className="sd-sidebar">
        <h1 className="mb-5 border border-[color:var(--sd-border)] px-3 py-3 font-mono text-sm font-bold text-[color:var(--sd-accent)]">
          CCBuddy
        </h1>
        {navGroups.map(group => (
          <div key={group.label} className="mb-3">
            <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">
              {group.label}
            </div>
            <div className="flex flex-col gap-1">
              {group.items.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `rounded-[var(--sd-radius)] px-3 py-2 text-sm ${isActive ? 'bg-[color:var(--sd-accent)] text-[color:var(--sd-accent-ink)]' : 'text-[color:var(--sd-muted)] hover:bg-[color:var(--sd-panel-raised)] hover:text-[color:var(--sd-text)]'}`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-2">
          <ThemeToggle />
          <button
            onClick={() => { localStorage.removeItem('dashboard_token'); window.location.reload(); }}
            className="sd-button-secondary px-3 py-2 text-left text-sm hover:text-[color:var(--sd-danger)]"
          >
            Sign Out
          </button>
        </div>
      </nav>
      <main className={`sd-main ${isMigrated ? '' : 'sd-main-legacy'}`}>{children}</main>
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
            <Route path="/settings" element={<ConfigPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/chat" element={<ChatPage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthGuard>
  );
}
