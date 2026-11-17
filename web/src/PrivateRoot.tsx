import { useEffect, useState } from 'react';
import { api } from './api';
import { App } from './App';

/** Message laissé dans l'adresse par un retour raté du Compte Postmelo (/?connexion=…), lu une fois puis effacé. */
function takeSignInError(): string | null {
  const params = new URLSearchParams(location.search);
  const message = params.get('connexion');
  if (message === null) return null;
  params.delete('connexion');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  return message.slice(0, 200) || null;
}

function Login({ onDone, compte }: { onDone: () => void; compte: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(takeSignInError);
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
        {compte && (
          <>
            <a className="btn primary wide" href="/api/auth/compte/start">Continuer avec mon Compte Postmelo</a>
            <p className="login-or"><span>ou avec le mot de passe d’Alfred</span></p>
          </>
        )}
        <input type="text" name="username" autoComplete="username" value="alfred" readOnly hidden />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus={!compte}
          required
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className={compte ? 'btn wide' : 'btn primary wide'} disabled={busy}>Se connecter</button>
      </form>
    </div>
  );
}

export function PrivateRoot() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [compte, setCompte] = useState(false);
  useEffect(() => {
    api.me().then((r) => { setCompte(r.compte === true); setAuth(r.authenticated); }, () => setAuth(false));
    const onLogout = () => setAuth(false);
    window.addEventListener('alfred:logout', onLogout);
    // L'app privée s'installe (PWA) ; la page publique de rendez-vous n'enregistre rien.
    if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => window.removeEventListener('alfred:logout', onLogout);
  }, []);
  if (auth === null) return null;
  return auth ? <App onLogout={() => setAuth(false)} /> : <Login onDone={() => setAuth(true)} compte={compte} />;
}
