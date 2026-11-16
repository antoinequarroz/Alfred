import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { App } from './App';
import '@fontsource-variable/plus-jakarta-sans';
import './styles.css';

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

function Root() {
  const [auth, setAuth] = useState<boolean | null>(null);
  useEffect(() => {
    api.me().then((r) => setAuth(r.authenticated), () => setAuth(false));
    const onLogout = () => setAuth(false);
    window.addEventListener('alfred:logout', onLogout);
    return () => window.removeEventListener('alfred:logout', onLogout);
  }, []);
  if (auth === null) return null;
  return auth ? <App onLogout={() => setAuth(false)} /> : <Login onDone={() => setAuth(true)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
