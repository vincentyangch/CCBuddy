import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { StatusPage } from './pages/StatusPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { LogsPage } from './pages/LogsPage';
import { ConfigPage } from './pages/ConfigPage';
import { ChatPage } from './pages/ChatPage';

const navItems = [
  { to: '/', label: 'Status' },
  { to: '/chat', label: 'Chat' },
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
            <Route path="/chat" element={<ChatPage />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthGuard>
  );
}
