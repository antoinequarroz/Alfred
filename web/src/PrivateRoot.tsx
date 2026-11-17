import { useEffect, useState } from 'react';
import { api } from './api';
import { App } from './App';

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connexion impossible');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit}>
        <span className="logo big">A</span>
        <h1>Alfred</h1>
        <p className="login-sub">Calendrier personnel</p>
        <input type="text" name="username" autoComplete="username" value="alfred" readOnly hidden />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary wide" disabled={busy}>Se connecter</button>
      </form>
    </div>
  );
}

export function PrivateRoot() {
  const [auth, setAuth] = useState<boolean | null>(null);
  useEffect(() => {
    api.me().then((r) => setAuth(r.authenticated), () => setAuth(false));
    const onLogout = () => setAuth(false);
    window.addEventListener('alfred:logout', onLogout);
    // L'app privée s'installe (PWA) ; la page publique de rendez-vous n'enregistre rien.
    if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => window.removeEventListener('alfred:logout', onLogout);
  }, []);
  if (auth === null) return null;
  return auth ? <App onLogout={() => setAuth(false)} /> : <Login onDone={() => setAuth(true)} />;
}
