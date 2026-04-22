import { useSearchParams } from 'react-router-dom';

export function Login() {
  const [params] = useSearchParams();
  const error = params.get('error');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const href = `/auth/google/start?tz=${encodeURIComponent(tz)}`;

  return (
    <div className="empty">
      <h2>Sign in with Google</h2>
      <p>Connect your Gmail to import filters and set up AI rules.</p>
      {error && <p style={{ color: '#b00' }}>Sign-in failed: {error}</p>}
      <a className="primary" href={href} style={{ textDecoration: 'none' }}>
        Continue with Google
      </a>
    </div>
  );
}
