import { Routes, Route, Navigate, useLocation, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from './lib/api.js';
import { Login } from './pages/Login.js';
import { Home } from './pages/Home.js';
import { Settings } from './pages/Settings.js';

type Me = { id: string; email: string; timezone: string; status: string };

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const onLogin = location.pathname === '/login';

  const { data: me, isLoading } = useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await apiGet<Me>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
  });

  async function logout() {
    await apiSend('POST', '/auth/logout');
    qc.clear();
    navigate('/login');
  }

  if (isLoading && !onLogin) return <div className="empty">Loading…</div>;
  if (me === null && !onLogin) return <Navigate to="/login" replace />;
  if (me && onLogin) return <Navigate to="/" replace />;

  return (
    <div className="app">
      {!onLogin && (
        <header className="topbar">
          <Link to="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>
            Gmail AI Filters
          </Link>
          <div className="spacer" />
          {me && (
            <div className="who">
              <span>{me.email}</span>
              <Link to="/settings" className="topbar-icon" title="Settings">
                ⚙
              </Link>
              <button onClick={logout}>Sign out</button>
            </div>
          )}
        </header>
      )}
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
