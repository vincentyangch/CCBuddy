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
