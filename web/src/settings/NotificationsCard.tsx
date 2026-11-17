import { useCallback, useEffect, useState } from 'react';
import type { PushPrefs, PushReminderMode, PushState } from '../../../shared/types';
import { ApiError, pushApi } from '../api';
import { AlertIcon, CheckIcon } from '../icons';
import { Card } from '../rdv/ui';
import './notifications.css';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
/** iPadOS se présente comme un Mac : on le reconnaît à l'écran tactile. */
const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
const isMac = !isIos && /Macintosh/.test(ua);
const isStandalone = () =>
  (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Nom proposé pour l'appareil courant, affiché dans la liste. */
function deviceLabel(): string {
  const app = isStandalone();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (isIos) return 'iPad';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'navigateur';
  if (isMac) return app ? 'Mac (app Alfred)' : `Mac (${browser})`;
  if (/Android/.test(ua)) return `Android (${browser})`;
  if (/Windows/.test(ua)) return `Windows (${browser})`;
  return `Ordinateur (${browser})`;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
};

async function endpointRef(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

const when = (iso: string) => new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** État des notifications, partagé par la carte. */
export function usePushState(): { state: PushState | null; error: string | null; set: (s: PushState) => void; reload: () => Promise<void> } {
  const [state, setState] = useState<PushState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await pushApi.state());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(message(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { state, error, set: setState, reload };
}

/** Carte « Notifications » : abonner cet appareil, choisir quoi recevoir, voir les appareils. */
export function NotificationsCard({ state, onState, notify }: { state: PushState; onState: (s: PushState) => void; notify: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  /** Empreinte de l'abonnement de cet appareil, s'il en a un. */
  const [hereRef, setHereRef] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => (pushSupported() ? Notification.permission : 'unsupported'));

  const readHere = useCallback(async () => {
    if (!pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      setHereRef(sub ? await endpointRef(sub.endpoint) : null);
    } catch {
      setHereRef(null);
    }
  }, []);
  useEffect(() => {
    void readHere();
  }, [readHere]);

  const here = hereRef ? state.devices.find((d) => d.ref === hereRef) ?? null : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      notify(message(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = () => run(async () => {
    // La demande d'autorisation part en premier, encore dans le geste de l'utilisateur (exigé par Safari).
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== 'granted') {
      notify('Notifications refusées : tu peux les autoriser plus tard dans les réglages de l’appareil.');
      return;
    }
    const reg = await registration();
    const key = keyBytes(state.publicKey);
    let sub = await reg.pushManager.getSubscription();
    // Abonnement fait pour une autre clé (serveur réinstallé) : il est refait.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const next = await pushApi.addDevice(sub.toJSON(), deviceLabel());
    const ref = await endpointRef(sub.endpoint);
    onState(next);
    setHereRef(ref);
    // Une première notification confirme tout de suite que la chaîne complète fonctionne.
    const added = next.devices.find((d) => d.ref === ref);
    const sent = added ? await pushApi.test(added.id).then((r) => (onState(r.state), r.results[0]?.ok === true), () => false) : false;
    notify(sent ? 'Notifications activées : une notification d’essai arrive sur cet appareil.' : 'Notifications activées sur cet appareil.');
  });

  const disableHere = () => run(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
    if (here) onState(await pushApi.removeDevice(here.id));
    setHereRef(null);
    notify('Notifications désactivées sur cet appareil.');
  });

  const remove = (id: string) => run(async () => {
    onState(await pushApi.removeDevice(id));
    if (here?.id === id) {
      // C'était cet appareil : son abonnement local est retiré aussi.
      const reg = await navigator.serviceWorker.getRegistration('/');
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      setHereRef(null);
    }
  });

  const test = (id?: string) => run(async () => {
    const r = await pushApi.test(id);
    onState(r.state);
    const failed = r.results.filter((x) => !x.ok);
    if (failed.length === 0) notify(r.results.length > 1 ? `Notification d’essai envoyée à ${r.results.length} appareils.` : 'Notification d’essai envoyée.');
    else notify(failed.map((f) => `${f.label} : ${f.removed ? 'désabonné, retiré de la liste' : f.error}`).join(' · '));
  });

  const save = (patch: Partial<PushPrefs>) => run(async () => onState(await pushApi.savePrefs(patch)));
  const { prefs } = state;

  let hereBlock: React.ReactNode;
  if (isIos && !isStandalone()) {
    hereBlock = (
      <div>
        <p className="nt-setting-title">Sur iPhone, Alfred doit d’abord être installé</p>
        <ol className="nt-steps">
          <li>Ouvre Alfred dans <strong>Safari</strong>, touche <strong>Partager</strong>, puis <strong>Sur l’écran d’accueil</strong>.</li>
          <li>Ouvre Alfred depuis sa nouvelle icône, reviens ici et touche <strong>Activer sur cet appareil</strong>.</li>
        </ol>
        <p className="bk-hint">Il faut iOS 16.4 ou plus récent. C’est une règle d’Apple : une simple page web ne peut pas envoyer de notifications.</p>
      </div>
    );
  } else if (!pushSupported()) {
    hereBlock = (
      <p className="bk-meta">
        Ce navigateur ne gère pas les notifications. {isMac ? 'Sur Mac, ouvre Alfred dans Safari puis Fichier > Ajouter au Dock, ou utilise Chrome.' : 'Essaie Safari, Chrome, Edge ou Firefox à jour.'}
      </p>
    );
  } else if (permission === 'denied') {
    hereBlock = (
      <p className="bk-meta nt-err">
        Les notifications d’Alfred sont bloquées sur cet appareil. {isIos ? 'Autorise-les dans Réglages > Notifications > Alfred.' : isMac ? 'Autorise-les dans Réglages Système > Notifications, ou dans les réglages du site de ton navigateur.' : 'Autorise-les dans les réglages du site de ton navigateur.'}
      </p>
    );
  } else if (here) {
    hereBlock = (
      <div className="nt-here">
        <p className="bk-meta"><CheckIcon /> Cet appareil reçoit les notifications ({here.label}).</p>
        <button className="btn" disabled={busy} onClick={() => void test(here.id)}>Envoyer un essai</button>
        <button className="btn danger" disabled={busy} onClick={() => void disableHere()}>Désactiver ici</button>
      </div>
    );
  } else {
    hereBlock = (
      <div className="nt-here">
        <p className="bk-meta">Cet appareil ne reçoit pas encore les notifications.{isMac && !isStandalone() ? ' Astuce : dans Safari, Fichier > Ajouter au Dock fait d’Alfred une vraie app sur ton Mac.' : ''}</p>
        <button className="btn primary" disabled={busy} onClick={() => void enable()}>Activer sur cet appareil</button>
      </div>
    );
  }

  return (
    <Card title="Notifications" sub="Alfred te prévient sur ton iPhone et ton Mac : nouveau rendez-vous, annulation, rappel avant un rendez-vous, invité arrivé en visio." id="notifications">
      {hereBlock}

      <div className="cx-sub">
        <div className="nt-setting">
          <Switch checked={prefs.newBooking} disabled={busy} onChange={(v) => void save({ newBooking: v })} label="Nouveau rendez-vous" />
          <div><p className="nt-setting-title">Nouveau rendez-vous</p><p className="bk-hint">Dès qu’un client réserve sur ta page.</p></div>
        </div>
        <div className="nt-setting">
          <Switch checked={prefs.cancellation} disabled={busy} onChange={(v) => void save({ cancellation: v })} label="Annulation par un client" />
          <div><p className="nt-setting-title">Annulation par un client</p><p className="bk-hint">Quand un client annule depuis le lien de son e-mail.</p></div>
        </div>
        <div className="nt-setting">
          <Switch checked={prefs.guestArrived} disabled={busy} onChange={(v) => void save({ guestArrived: v })} label="Invité arrivé en visio" />
          <div><p className="nt-setting-title">Invité arrivé en visio</p><p className="bk-hint">Quand quelqu’un entre dans une de tes salles. Toucher la notification t’y emmène.</p></div>
        </div>
        <div className="nt-setting">
          <Switch checked={!prefs.details} disabled={busy} onChange={(v) => void save({ details: !v })} label="Masquer les détails" />
          <div><p className="nt-setting-title">Masquer les détails</p><p className="bk-hint">Ni nom ni titre dans les notifications, par exemple sur l’écran verrouillé.</p></div>
        </div>
      </div>

      <div className="nt-grid">
        <div className="fld">
          <label htmlFor="nt-rem">Rappels</label>
          <select id="nt-rem" value={prefs.reminders} disabled={busy} onChange={(e) => void save({ reminders: e.target.value as PushReminderMode })}>
            <option value="bookings">Avant les rendez-vous pris en ligne</option>
            <option value="all">Avant tous mes événements</option>
            <option value="off">Aucun rappel</option>
          </select>
          <p className="fld-hint">Tes événements iCloud ont déjà leurs alertes Apple : « tous » peut faire doublon.</p>
        </div>
        <div className="fld">
          <label htmlFor="nt-min">Délai</label>
          <select id="nt-min" value={prefs.reminderMinutes} disabled={busy || prefs.reminders === 'off'} onChange={(e) => void save({ reminderMinutes: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n === 60 ? '1 heure avant' : `${n} minutes avant`}</option>)}
          </select>
        </div>
      </div>

      <div className="cx-sub">
        <p className="cx-h3">Appareils abonnés</p>
        {state.devices.length === 0 ? (
          <p className="bk-empty">Aucun appareil pour l’instant.</p>
        ) : (
          <ul className="bk-list">
            {state.devices.map((d) => (
              <li key={d.id} className="nt-device">
                <div>
                  <p className="nt-device-name">{d.label}{d.ref === hereRef && <span className="nt-tag">cet appareil</span>}</p>
                  <p className={`bk-meta${d.lastError ? ' nt-err' : ''}`}>
                    {d.lastError
                      ? <><AlertIcon /> {d.lastError}</>
                      : d.lastSuccessAt ? `Dernière notification reçue par ${d.service} le ${when(d.lastSuccessAt)}` : `Abonné le ${when(d.createdAt)} · service ${d.service}`}
                  </p>
                </div>
                <div className="bk-row-actions">
                  <button className="btn" disabled={busy} onClick={() => void test(d.id)}>Essai</button>
                  <button className="btn danger" disabled={busy} onClick={() => void remove(d.id)}>Retirer</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
