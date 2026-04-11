import { useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './ui';

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
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--sd-bg)] p-6 text-[color:var(--sd-text)]">
      <Panel className="w-80 p-8">
        <form onSubmit={handleLogin}>
          <h1 className="mb-6 text-center font-serif text-xl font-bold">CCBuddy Dashboard</h1>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Enter dashboard token"
            className="sd-input mb-4 w-full text-sm"
            autoFocus
          />
          {error && <p className="mb-4 text-sm text-[color:var(--sd-danger)]">{error}</p>}
          <button type="submit" className="sd-button w-full text-sm">
            Sign In
          </button>
        </form>
      </Panel>
    </div>
  );
}
