import { useCallback, useEffect, useState } from 'react';
import type { VideoAdminState, VideoQuality, VideoRoom } from '../../../shared/types';
import { ApiError, videoApi } from '../api';
import { AlertIcon, CheckIcon, CopyIcon, ExternalIcon, MenuIcon, PlusIcon, UsersIcon, VideoIcon } from '../icons';
import { Card } from '../rdv/ui';
import '../rdv/rdv.css';
import '../settings/settings.css';
import './video-admin.css';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

/** État de la visio, relu régulièrement pour suivre qui est connecté. */
export function useVideoState(): { state: VideoAdminState | null; error: string | null; reload: () => Promise<void>; set: (s: VideoAdminState) => void } {
  const [state, setState] = useState<VideoAdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await videoApi.state());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(message(err));
    }
  }, []);
  useEffect(() => {
    void reload();
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const t = setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);
  return { state, error, reload, set: setState };
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function CopyButton({ text, notify, label = 'Copier' }: { text: string; notify: (m: string) => void; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('Copie impossible : sélectionne le lien à la main.');
    }
  };
  return <button type="button" className="btn" onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? 'Copié' : label}</button>;
}

function whenLabel(room: VideoRoom): string {
  if (!room.startsAt) return '';
  const start = new Date(room.startsAt);
  const day = new Intl.DateTimeFormat('fr-CH', { weekday: 'short', day: 'numeric', month: 'short' }).format(start);
  const time = new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (room.kind === 'instant') return `Créée ${day} à ${time.format(start)}`;
  return `${day}, ${time.format(start)}${room.endsAt ? ` – ${time.format(new Date(room.endsAt))}` : ''}`;
}

const KIND_LABEL: Record<VideoRoom['kind'], string> = { instant: 'Réunion instantanée', event: 'Événement', booking: 'Rendez-vous', permanent: 'Salle permanente' };

function Live({ n }: { n: number | null }) {
  if (!n) return null;
  return <span className="vd-live"><UsersIcon />{n} en ligne</span>;
}

/** Carte des réglages de la visio (écran Réglages, et rappel dans la rubrique Visio). */
export function VideoSettingsCard({ state, onState, notify }: { state: VideoAdminState; onState: (s: VideoAdminState) => void; notify: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const save = async (patch: Parameters<typeof videoApi.saveSettings>[0]) => {
    setBusy(true);
    try {
      onState(await videoApi.saveSettings(patch));
    } catch (err) {
      notify(message(err));
    } finally {
      setBusy(false);
    }
  };
  const { settings, server } = state;
  const status = !server.configured ? 'Serveur de visio non installé' : server.reachable ? 'Serveur de visio en ligne' : 'Serveur de visio injoignable';
  return (
    <Card title="Visioconférence" sub="Tes visios passent par ton propre serveur, sans Zoom ni Teams. Tes invités rejoignent depuis leur navigateur, sans compte." id="visio">
      <div className={`bk-status${server.configured && server.reachable ? '' : ' bad'}`}>
        <span className="sync-dot" />
        <div>
          <p className="bk-status-title">{status}</p>
          {server.problem && <p className="bk-meta">{server.problem}</p>}
        </div>
      </div>
      <div className="vd-setting">
        <Switch checked={settings.enabled} disabled={busy} onChange={(v) => void save({ enabled: v })} label="Activer la visio" />
        <div>
          <p className="vd-setting-title">Activer la visio</p>
          <p className="bk-hint">Désactivée, aucun lien ne s’ouvre et les rendez-vous « En visio » ne reçoivent plus de lien Alfred.</p>
        </div>
      </div>
      <div className="vd-grid">
        <div className="fld">
          <label htmlFor="vd-max">Participants au plus par visio</label>
          <select id="vd-max" value={settings.maxParticipants} disabled={busy} onChange={(e) => void save({ maxParticipants: Number(e.target.value) })}>
            {[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} personnes{n === 4 ? ' (conseillé)' : ''}</option>)}
          </select>
          <p className="fld-hint">Toi compris. Une place t’est toujours réservée.</p>
        </div>
        <div className="fld">
          <label htmlFor="vd-quality">Qualité de la vidéo</label>
          <select id="vd-quality" value={settings.quality} disabled={busy} onChange={(e) => void save({ quality: e.target.value as VideoQuality })}>
            <option value="standard">Standard (HD 720p)</option>
            <option value="eco">Économe (360p)</option>
          </select>
          <p className="fld-hint">« Économe » soulage le serveur et les petites connexions.</p>
        </div>
      </div>
      <ul className="bk-warnings vd-limits">
        <li>
          <AlertIcon />
          <span>
            Sur le VPS actuel (2 cœurs, 4 Go partagés avec tes autres sites), la visio est prévue pour des appels à 2, et jusqu’à 4 personnes.
            Au-delà, l’image peut saccader. Après l’agrandissement du VPS, tu pourras monter à 8.
          </span>
        </li>
      </ul>
    </Card>
  );
}

/** Rubrique « Visio » : réunion instantanée, salle permanente, visios à venir. */
export function VideoScreen({ onMenu, onSettings }: { onMenu: () => void; onSettings: () => void }) {
  const { state, error, reload } = useVideoState();
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = useCallback((m: string) => setToast(m), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) notify(done);
    } catch (err) {
      notify(message(err));
    } finally {
      setBusy(false);
      void reload();
    }
  };

  const startNow = () => act(async () => {
    // La fenêtre est ouverte tout de suite (dans le geste), puis dirigée vers la salle : pas de blocage de fenêtre.
    const win = window.open('', '_blank');
    try {
      const room = await videoApi.createRoom({});
      if (win) win.location.href = room.url;
      else location.href = room.url;
    } catch (err) {
      win?.close();
      throw err;
    }
  });

  const personal = state?.personalRoom ?? null;

  return (
    <main className="main bk-main">
      <header className="toolbar">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu"><MenuIcon /></button>
        <h1>Visio</h1>
      </header>
      <div className="bk-scroll">
        <div className="bk">
          {error && !state && (
            <div className="bk-card"><p className="form-error" role="alert">{error}</p><button className="btn" onClick={() => void reload()}>Réessayer</button></div>
          )}
          {state && (
            <>
              {!state.available && (
                <ul className="bk-warnings">
                  <li>
                    <AlertIcon />
                    <span>
                      {!state.server.configured ? state.server.problem : 'La visio est désactivée.'}
                      <button type="button" className="cx-link" onClick={onSettings}> Ouvrir les réglages</button>
                    </span>
                  </li>
                </ul>
              )}
              {state.available && state.server.reachable === false && (
                <ul className="bk-warnings"><li><AlertIcon /><span>{state.server.problem}</span></li></ul>
              )}

              <section className="bk-card bk-hero on vd-hero">
                <div className="vd-hero-main">
                  <span className="vd-hero-icon"><VideoIcon /></span>
                  <div>
                    <h2>Démarrer une visio maintenant</h2>
                    <p>Une salle s’ouvre dans un nouvel onglet. Copie ensuite son lien pour inviter quelqu’un.</p>
                  </div>
                  <button className="btn primary" disabled={busy || !state.available} onClick={() => void startNow()}><PlusIcon />Nouvelle visio</button>
                </div>
              </section>

              <Card
                title="Ma salle permanente"
                sub="Un lien fixe, toujours le même, à donner à tes contacts ou à mettre dans ta signature."
                action={personal ? <Live n={personal.live} /> : undefined}
              >
                {personal ? (
                  <>
                    <div className="bk-link">
                      <code className="bk-url">{personal.url}</code>
                      <CopyButton text={personal.url} notify={notify} />
                      <a className="btn primary" href={personal.url} target="_blank" rel="noopener"><ExternalIcon />Entrer</a>
                    </div>
                    <p className="bk-hint">
                      Toute personne qui a ce lien peut entrer dans la salle.{' '}
                      <button type="button" className="cx-link" disabled={busy} onClick={() => {
                        if (window.confirm('Créer un nouveau lien ? L’ancien ne fonctionnera plus.')) void act(() => videoApi.personalRoom(true), 'Nouveau lien créé : l’ancien ne fonctionne plus.');
                      }}>Changer de lien</button>
                    </p>
                  </>
                ) : (
                  <div><button className="btn" disabled={busy || !state.available} onClick={() => void act(() => videoApi.personalRoom())}>Créer ma salle permanente</button></div>
                )}
              </Card>

              <Card title="Visios ouvertes et à venir" sub="Rendez-vous « En visio », événements avec une visio, réunions instantanées récentes.">
                {state.rooms.length === 0 ? (
                  <p className="bk-empty">Aucune visio prévue. Les rendez-vous « En visio » pris en ligne apparaîtront ici avec leur lien.</p>
                ) : (
                  <ul className="bk-list">
                    {state.rooms.map((r) => (
                      <li key={r.id} className="vd-room">
                        <div className="vd-room-main">
                          <p className="vd-room-title">{r.title} <Live n={r.live} /></p>
                          <p className="bk-meta">{KIND_LABEL[r.kind]}{whenLabel(r) ? ` · ${whenLabel(r)}` : ''}</p>
                        </div>
                        <div className="bk-row-actions">
                          <CopyButton text={r.url} notify={notify} label="Lien" />
                          <a className="btn" href={r.url} target="_blank" rel="noopener"><ExternalIcon />Entrer</a>
                          {r.live ? (
                            <button className="btn danger ghost" disabled={busy} onClick={() => void act(() => videoApi.endMeeting(r.id), 'Visio terminée pour tout le monde.')}>Terminer</button>
                          ) : r.kind !== 'booking' ? (
                            <button className="btn danger ghost" disabled={busy} onClick={() => {
                              if (window.confirm('Supprimer cette visio ? Son lien ne fonctionnera plus.')) void act(() => videoApi.deleteRoom(r.id));
                            }}>Supprimer</button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <p className="cx-foot">
                <VideoIcon />
                <span>
                  {state.settings.maxParticipants} participants au plus, qualité {state.settings.quality === 'eco' ? 'économe' : 'standard'}.{' '}
                  <button type="button" className="cx-link" onClick={onSettings}>Modifier dans les réglages</button>
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
