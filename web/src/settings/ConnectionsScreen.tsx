import { useCallback, useEffect, useState } from 'react';
import { AlertIcon, LockIcon, MenuIcon } from '../icons';
import { CaldavCard, SmtpCard, useConnections } from './ConnectionCards';
import { useVideoState, VideoSettingsCard } from '../video/VideoScreen';
import { NotificationsCard, usePushState } from './NotificationsCard';
import { PaymentCard, usePayments } from '../rdv/PaymentCard';
import { DataCard } from './DataCard';

const KEY_TEXT = {
  env: 'La clé de chiffrement vient de la variable ALFRED_SECRET_KEY du serveur.',
  file: 'La clé de chiffrement est le fichier secret.key du dossier de données, à sauvegarder avec la base.',
  memory: 'La clé de chiffrement n’existe qu’en mémoire (mode de test).',
  none: 'La clé de chiffrement sera créée au premier mot de passe enregistré (fichier secret.key du dossier de données).',
} as const;

/** Écran « Réglages » : les connexions d'Alfred (calendrier iCloud, envoi des e-mails, paiement en ligne), les notifications, la visio et les données (export, import). */
export function ConnectionsScreen({ onMenu, onCalendarChanged }: { onMenu: () => void; onCalendarChanged: () => void }) {
  const { state, error, reload, set } = useConnections();
  const video = useVideoState();
  const push = usePushState();
  const payments = usePayments();
  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const synced = useCallback(() => {
    onCalendarChanged();
    void reload();
  }, [onCalendarChanged, reload]);

  return (
    <main className="main bk-main">
      <header className="toolbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu"><MenuIcon /></button>
        <h1>Réglages</h1>
      </header>
      <div className="bk-scroll">
        <div className="bk">
          {error && !state && (
            <div className="bk-card"><p className="form-error" role="alert">{error}</p><button className="btn" onClick={() => void reload()}>Réessayer</button></div>
          )}
          {state && (
            <>
              <p className="cx-intro">Les connexions d’Alfred se règlent ici, sans passer par le serveur. Chaque réglage indique d’où il vient : de l’app, ou du fichier .env posé à l’installation.</p>
              {state.notices.length > 0 && (
                <ul className="bk-warnings cx-notices" role="alert">
                  {state.notices.map((n) => <li key={n}><AlertIcon /><span>{n}</span></li>)}
                </ul>
              )}
              <div className="bk-pair">
                <CaldavCard state={state} onState={set} notify={notify} onSynced={synced} />
                <SmtpCard state={state} onState={set} notify={notify} />
                {payments.state && <PaymentCard state={payments.state} onState={payments.set} notify={notify} />}
                {push.state && <NotificationsCard state={push.state} onState={push.set} notify={notify} />}
                {video.state && <VideoSettingsCard state={video.state} onState={video.set} notify={notify} />}
                <DataCard notify={notify} />
              </div>
              <p className="cx-foot">
                <LockIcon />
                <span>
                  Les mots de passe enregistrés ici sont chiffrés dans la base et ne sont plus jamais affichés, ni renvoyés à ton navigateur. {KEY_TEXT[state.secretKey.source]}
                </span>
              </p>
            </>
          )}
        </div>
      </div>
      {toast && <div className="toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </main>
  );
}
