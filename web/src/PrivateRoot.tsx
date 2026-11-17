import { useEffect, useState } from 'react';
import { api } from './api';
import { App } from './App';

/** Message renvoyé par la connexion PostMelo (?compte_erreur=…), lu une fois puis retiré de l'adresse. */
function takeCompteError(): string | null {
  const url = new URL(location.href);
  const message = url.searchParams.get('compte_erreur');
  if (message === null) return null;
  url.searchParams.delete('compte_erreur');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return message.slice(0, 200);
}

function Login({ onDone, compte, initialError }: { onDone: () => void; compte: boolean; initialError: string | null }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  // Avec le compte PostMelo, le mot de passe devient l'accès de secours : replié par défaut.
  const [showPassword, setShowPassword] = useState(!compte);
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
            <a className="btn primary wide" href="/api/auth/compte/start">Se connecter avec PostMelo</a>
            {!showPassword && (
              <button type="button" className="btn ghost small login-fallback" onClick={() => setShowPassword(true)}>
                Utiliser le mot de passe de secours
              </button>
            )}
          </>
        )}
        {showPassword && (
          <>
            <input type="text" name="username" autoComplete="username" value="alfred" readOnly hidden />
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder={compte ? 'Mot de passe de secours' : 'Mot de passe'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {showPassword && (
          <button className={compte ? 'btn wide' : 'btn primary wide'} disabled={busy}>
            {compte ? 'Entrer avec le mot de passe' : 'Se connecter'}
          </button>
        )}
      </form>
    </div>
  );
}

export function PrivateRoot() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [compte, setCompte] = useState(false);
  const [compteError] = useState(takeCompteError);
  useEffect(() => {
    api.me().then((r) => { setCompte(Boolean(r.compte)); setAuth(r.authenticated); }, () => setAuth(false));
    const onLogout = () => setAuth(false);
    window.addEventListener('alfred:logout', onLogout);
    // L'app privée s'installe (PWA) ; la page publique de rendez-vous n'enregistre rien.
    if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => window.removeEventListener('alfred:logout', onLogout);
  }, []);
  if (auth === null) return null;
  return auth ? <App onLogout={() => setAuth(false)} /> : <Login onDone={() => setAuth(true)} compte={compte} initialError={compteError} />;
}
