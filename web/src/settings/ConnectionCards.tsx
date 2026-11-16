import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaldavConnectionState, ConnectionSecret, ConnectionsState, ConnectionTest, SettingSource, SmtpConnectionState, SmtpSettingsInput } from '../../../shared/types';
import { api, ApiError, connectionsApi } from '../api';
import { AlertIcon, CheckIcon, LockIcon } from '../icons';
import { Card, Fld } from '../rdv/ui';
import './settings.css';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

/** État des connexions, relu régulièrement (et plus vite tant qu'une synchro tourne). */
export function useConnections(): { state: ConnectionsState | null; error: string | null; reload: () => Promise<void>; set: (s: ConnectionsState) => void } {
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await connectionsApi.state());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(message(err));
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  const running = state?.caldav.sync.running ?? false;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const t = setInterval(refresh, running ? 2000 : 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload, running]);
  return { state, error, reload, set: setState };
}

const SOURCE_LABEL: Record<SettingSource, string> = { app: 'app', env: '.env', default: 'par défaut', none: '' };
const SOURCE_TITLE: Record<SettingSource, string> = {
  app: 'Réglé ici, dans l’app',
  env: 'Lu dans le fichier .env du serveur',
  default: 'Valeur par défaut',
  none: '',
};

/** D'où vient un réglage : app, fichier .env ou valeur par défaut. */
function Source({ source }: { source: SettingSource }) {
  if (source === 'none') return null;
  return <span className={`src src-${source}`} title={SOURCE_TITLE[source]}>{SOURCE_LABEL[source]}</span>;
}

function secretLabel(s: ConnectionSecret): string {
  if (s.unreadable) return 'À ressaisir';
  if (!s.configured) return 'Non configuré';
  return s.source === 'app' ? 'Configuré dans l’app' : 'Configuré dans le fichier .env';
}

function SecretState({ secret }: { secret: ConnectionSecret }) {
  const kind = secret.unreadable ? 'bad' : secret.configured ? 'ok' : 'off';
  return (
    <span className={`secret-state ${kind}`}>
      {kind === 'ok' ? <LockIcon /> : <AlertIcon />}
      {secretLabel(secret)}
    </span>
  );
}

/** Résultat d'un essai : vert ou rouge, avec le diagnostic en clair. */
function TestResult({ test, warning }: { test: Pick<ConnectionTest, 'ok' | 'message'> | null; warning?: string | null }) {
  if (!test && !warning) return null;
  return (
    <div className="cx-results" role="status" aria-live="polite">
      {test && (
        <p className={`cx-result ${test.ok ? 'ok' : 'err'}`}>
          {test.ok ? <CheckIcon /> : <AlertIcon />}
          <span>{test.message}</span>
        </p>
      )}
      {warning && (
        <p className="cx-result warn">
          <AlertIcon />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
}

function when(iso: string | null): string {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `il y a ${h} h` : `le ${new Date(iso).toLocaleDateString('fr-CH', { day: 'numeric', month: 'long' })}`;
}

// --- e-mails (SMTP) --------------------------------------------------------------

interface SmtpDraft {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
  notifyTo: string;
}

const smtpDraft = (s: SmtpConnectionState): SmtpDraft => ({
  host: s.host.value, port: s.port.value, user: s.user.value, password: '', from: s.from.value,
  // L'adresse des avis par défaut est celle de l'expéditeur : le champ reste vide pour la suivre.
  notifyTo: s.notifyTo.source === 'default' ? '' : s.notifyTo.value,
});

/**
 * Envoi des e-mails : état, formulaire SMTP, essai. Le mot de passe n'est jamais relu du
 * serveur : le champ est vide à chaque ouverture, et vide = « garder l'actuel ».
 */
export function SmtpCard({ state, onState, notify, children, id, autoFocus }: {
  state: ConnectionsState; onState: (s: ConnectionsState) => void; notify: (msg: string) => void;
  /** Lignes d'information supplémentaires (envois sur 24 h, dernière erreur). */
  children?: React.ReactNode; id?: string;
  /** Change de valeur pour amener le focus sur le premier champ à compléter. */
  autoFocus?: number;
}) {
  const s = state.smtp;
  const [draft, setDraft] = useState<SmtpDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [result, setResult] = useState<Pick<ConnectionTest, 'ok' | 'message'> | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const base = smtpDraft(s);
  const d = draft ?? base;
  const set = (patch: Partial<SmtpDraft>) => setDraft({ ...d, ...patch });
  const changed = (Object.keys(base) as (keyof SmtpDraft)[]).filter((k) => d[k].trim() !== base[k]);
  const dirty = changed.length > 0;

  useEffect(() => {
    if (!autoFocus) return;
    const target = s.user.value ? passwordRef.current : userRef.current;
    target?.focus({ preventScroll: true });
    target?.closest('.bk-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [autoFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (test: boolean) => {
    setBusy(test ? 'test' : 'save');
    setErrors({});
    setResult(null);
    try {
      // Seuls les champs modifiés partent : les autres gardent leur origine (.env ou défaut).
      const input: SmtpSettingsInput = { test };
      for (const k of changed) input[k] = d[k].trim();
      const res = await connectionsApi.saveSmtp(input);
      onState(res.state);
      setDraft(null);
      if (res.test) setResult(res.test);
      if (!res.test) notify('Réglages d’envoi enregistrés');
      else if (dirty) notify(res.test.ok ? 'Réglages enregistrés, e-mail d’essai envoyé' : 'Réglages enregistrés, mais l’essai d’envoi a échoué');
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      else setResult({ ok: false, message: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    setResult(null);
    try {
      onState((await connectionsApi.clearSmtp()).state);
      setDraft(null);
      setErrors({});
      setConfirmClear(false);
      notify('Réglages d’envoi retirés de l’app');
    } catch (err) {
      setResult({ ok: false, message: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? (dirty ? null : s.lastTest);
  const statusKind = s.password.unreadable ? 'bad' : s.configured ? (s.lastTest && !s.lastTest.ok ? 'bad' : 'ok') : 'off';
  const statusTitle = s.password.unreadable ? 'Mot de passe à ressaisir' : s.configured ? (s.lastTest && !s.lastTest.ok ? 'Envoi configuré, mais le dernier essai a échoué' : 'Envoi configuré') : 'Envoi non configuré';
  const statusText = s.password.unreadable
    ? 'Le mot de passe enregistré ne peut plus être déchiffré. Ressaisis-le ci-dessous : en attendant, aucun e-mail ne part.'
    : s.configured
      ? `Les e-mails partent par ${s.host.value}, au nom de ${s.from.value}.`
      : 'Les réservations fonctionnent, mais aucun e-mail ne part. Renseigne l’identifiant et le mot de passe de ta boîte ci-dessous.';

  return (
    <Card id={id} title="E-mails" sub="Confirmations et annulations envoyées aux clients, avis envoyés à toi.">
      <div className={`bk-status ${statusKind}`}>
        <span className="sync-dot" />
        <div>
          <p className="bk-status-title">{statusTitle}</p>
          <p className="bk-meta">{statusText}</p>
        </div>
      </div>

      <form className="bk-form cx-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void submit(true); }}>
        <div className="bk-grid cx-grid">
          <Fld label="Identifiant" badge={<Source source={s.user.source} />} error={errors.user} hint="L’adresse complète de la boîte, par exemple info@antoinequarroz.ch.">
            {(fid) => (
              <input ref={userRef} id={fid} type="text" name="smtp-identifiant" inputMode="email" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={254} placeholder="info@antoinequarroz.ch" value={d.user} onChange={(e) => set({ user: e.target.value })} />
            )}
          </Fld>
          <Fld
            label="Mot de passe" badge={<SecretState secret={s.password} />} error={errors.password}
            hint="Celui de la boîte. Si la double authentification est active chez Infomaniak, crée un mot de passe d’application et colle-le ici."
          >
            {(fid) => (
              <input ref={passwordRef} id={fid} type="password" name="smtp-mot-de-passe" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={1024} placeholder={s.password.configured ? 'Inchangé : laisse vide pour le garder' : ''} value={d.password} onChange={(e) => set({ password: e.target.value })} />
            )}
          </Fld>
          <Fld label="Serveur d’envoi (SMTP)" badge={<Source source={s.host.source} />} error={errors.host} hint="Infomaniak : mail.infomaniak.com.">
            {(fid) => (
              <input id={fid} type="text" name="smtp-serveur" inputMode="url" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={253} placeholder="mail.infomaniak.com" value={d.host} onChange={(e) => set({ host: e.target.value })} />
            )}
          </Fld>
          <Fld label="Port" badge={<Source source={s.port.source} />} error={errors.port} hint="587 (STARTTLS) en général, ou 465 (TLS).">
            {(fid) => (
              <input id={fid} type="text" name="smtp-port" inputMode="numeric" autoComplete="off" maxLength={5} placeholder="587"
                value={d.port} onChange={(e) => set({ port: e.target.value.replace(/[^\d]/g, '') })} />
            )}
          </Fld>
          <Fld label="Expéditeur" badge={<Source source={s.from.source} />} error={errors.from} hint="Le nom et l’adresse que voient tes clients : Nom <adresse>.">
            {(fid) => (
              <input id={fid} type="text" name="smtp-expediteur" autoComplete="off" autoCapitalize="none" spellCheck={false}
                maxLength={360} placeholder="Antoine Quarroz <info@antoinequarroz.ch>" value={d.from} onChange={(e) => set({ from: e.target.value })} />
            )}
          </Fld>
          <Fld label="Adresse des avis" badge={<Source source={s.notifyTo.source === 'default' ? 'none' : s.notifyTo.source} />} error={errors.notifyTo} hint="Reçoit les avis de nouveau rendez-vous et d’annulation, et l’e-mail d’essai.">
            {(fid) => (
              <input id={fid} type="text" name="smtp-avis" inputMode="email" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={254} placeholder={s.notifyTo.source === 'default' ? `${s.notifyTo.value} (celle de l’expéditeur)` : ''} value={d.notifyTo} onChange={(e) => set({ notifyTo: e.target.value })} />
            )}
          </Fld>
        </div>

        <TestResult test={shown} />

        {children && <dl className="bk-dl">{children}</dl>}

        {confirmClear ? (
          <div className="bk-savebar static">
            <span>Retirer les réglages enregistrés dans l’app ? Ceux du fichier .env, s’il y en a, reprennent la main.</span>
            <button type="button" className="btn ghost" onClick={() => setConfirmClear(false)}>Garder</button>
            <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void clear()}>Retirer</button>
          </div>
        ) : dirty ? (
          <div className="bk-savebar static">
            <span>Modifications non enregistrées</span>
            <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => { setDraft(null); setErrors({}); }}>Annuler</button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void submit(false)}>{busy === 'save' ? 'Enregistrement…' : 'Enregistrer'}</button>
            <button type="submit" className="btn primary" disabled={busy !== null}>{busy === 'test' ? 'Envoi de l’essai…' : 'Enregistrer et tester'}</button>
          </div>
        ) : (
          <div className="bk-savebar static">
            <span />
            {s.hasAppValues && <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setConfirmClear(true)}>Revenir au fichier .env</button>}
            <button type="submit" className="btn" disabled={busy !== null || !s.configured}>{busy === 'test' ? 'Envoi…' : 'Envoyer un e-mail d’essai'}</button>
          </div>
        )}
      </form>
    </Card>
  );
}

// --- iCloud (CalDAV) -------------------------------------------------------------

const APPLE_PASSWORD_RE = /^[a-z]{4}(-?)[a-z]{4}\1[a-z]{4}\1[a-z]{4}$/;
const DEFAULT_URL = 'https://caldav.icloud.com';

function isIcloud(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'icloud.com' || host.endsWith('.icloud.com');
  } catch {
    return false;
  }
}

function syncSummary(c: CaldavConnectionState): { kind: 'ok' | 'off' | 'bad'; title: string; text: string } {
  const counts = `${c.calendars} calendrier${c.calendars > 1 ? 's' : ''}, ${c.events} événement${c.events > 1 ? 's' : ''} en copie locale`;
  if (c.password.unreadable) return { kind: 'bad', title: 'Mot de passe à ressaisir', text: 'Le mot de passe d’application enregistré ne peut plus être déchiffré. Ressaisis-le ci-dessous : en attendant, la synchro est arrêtée.' };
  if (!c.configured) return { kind: 'off', title: 'iCloud n’est pas relié', text: 'Alfred fonctionne avec un calendrier local. Relie ton compte pour retrouver tes calendriers Apple.' };
  if (c.sync.running) return { kind: 'ok', title: 'Synchronisation en cours…', text: counts };
  if (c.sync.lastError) return { kind: 'bad', title: 'Synchro en échec', text: `${c.sync.lastError}${c.sync.lastSuccessAt ? ` Dernière synchro réussie ${when(c.sync.lastSuccessAt)}.` : ''}` };
  if (!c.sync.lastSuccessAt) return { kind: 'ok', title: 'En attente de la première synchro', text: counts };
  return { kind: 'ok', title: `Synchronisé ${when(c.sync.lastSuccessAt)}`, text: `${counts}. Alfred interroge le serveur toutes les deux minutes.` };
}

/**
 * Compte de calendrier : état de la synchro, changement du mot de passe d'application
 * (même identifiant), première configuration. Le serveur teste la connexion avant d'enregistrer.
 */
export function CaldavCard({ state, onState, notify, onSynced }: {
  state: ConnectionsState; onState: (s: ConnectionsState) => void; notify: (msg: string) => void;
  /** Après un changement d'identifiants ou une synchro : les calendriers de l'app sont à relire. */
  onSynced: () => void;
}) {
  const c = state.caldav;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [otherServer, setOtherServer] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | 'sync' | null>(null);
  const [result, setResult] = useState<Pick<ConnectionTest, 'ok' | 'message'> | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const summary = syncSummary(c);
  const locked = c.accountLocked;
  const effectiveUrl = !locked && otherServer && url.trim() ? url.trim() : c.url.value;
  const oddShape = password.trim() !== '' && isIcloud(effectiveUrl) && !APPLE_PASSWORD_RE.test(password.trim());
  const host = (() => {
    try {
      return new URL(c.url.value).host;
    } catch {
      return c.url.value;
    }
  })();

  const input = () => ({
    username: locked ? c.username.value : username.trim(),
    password: password.trim(),
    ...(!locked && otherServer && url.trim() ? { url: url.trim() } : {}),
  });

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.fields) setErrors(err.fields);
    else setResult({ ok: false, message: message(err) });
  };

  const save = async () => {
    setBusy('save');
    setErrors({});
    setResult(null);
    setWarning(null);
    try {
      const res = await connectionsApi.saveCaldav(input());
      onState(res.state);
      setPassword('');
      setUsername('');
      setUrl('');
      setResult({ ok: true, message: `${res.test.message} Identifiants enregistrés : la synchro repart.` });
      setWarning(res.warning);
      notify('Identifiants iCloud enregistrés');
      // La synchro est lancée par le serveur : on relit les calendriers une fois qu'elle a eu le temps d'avancer.
      setTimeout(onSynced, 2500);
      setTimeout(onSynced, 8000);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setErrors({});
    setResult(null);
    setWarning(null);
    try {
      const body = input();
      const res = await connectionsApi.testCaldav(body.password || !locked ? body : {});
      onState(res.state);
      setResult(res.test);
      setWarning(res.warning);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    setResult(null);
    setWarning(null);
    try {
      const res = await connectionsApi.clearCaldav();
      onState(res.state);
      setConfirmClear(false);
      notify('Retour aux identifiants du fichier .env');
      setTimeout(onSynced, 2500);
    } catch (err) {
      setConfirmClear(false);
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    try {
      await api.sync();
      onState(await connectionsApi.state());
      onSynced();
    } catch (err) {
      notify(message(err));
    } finally {
      setBusy(null);
    }
  };

  const canSubmit = password.trim() !== '' && (locked || username.trim() !== '');

  return (
    <Card
      title="Calendrier iCloud"
      sub="Tes calendriers Apple, synchronisés dans les deux sens."
      action={c.configured ? <button type="button" className="btn" disabled={busy !== null || c.sync.running} onClick={() => void syncNow()}>{busy === 'sync' || c.sync.running ? 'Synchronisation…' : 'Synchroniser'}</button> : undefined}
    >
      <div className={`bk-status ${summary.kind}`}>
        <span className="sync-dot" />
        <div>
          <p className="bk-status-title">{summary.title}</p>
          <p className="bk-meta">{summary.text}</p>
        </div>
      </div>

      {locked && (
        <dl className="bk-dl cx-dl">
          <div><dt>Identifiant Apple</dt><dd>{c.username.value} <Source source={c.username.source} /></dd></div>
          <div><dt>Serveur</dt><dd>{host} <Source source={c.url.source} /></dd></div>
          <div><dt>Mot de passe d’application</dt><dd><SecretState secret={c.password} /></dd></div>
        </dl>
      )}

      <form className="bk-form cx-form cx-sub" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void save(); }}>
        <div>
          <h3 className="cx-h3">{locked ? (c.password.unreadable ? 'Ressaisir le mot de passe d’application' : 'Changer le mot de passe d’application') : 'Relier ton compte iCloud'}</h3>
          <p className="bk-hint cx-help">
            Sur <a href="https://account.apple.com" target="_blank" rel="noopener noreferrer">account.apple.com</a>, ouvre <strong>Connexion et sécurité</strong> puis <strong>Mots de passe pour les apps</strong>, crée-en un nommé « Alfred » et colle-le ici.
            Il a la forme <span className="nb">abcd-efgh-ijkl-mnop</span> : ce n’est jamais le mot de passe de ton compte Apple.
          </p>
        </div>
        <div className="bk-grid cx-grid">
          {!locked && (
            <Fld label="Identifiant Apple" error={errors.username} hint="L’adresse e-mail de ton compte Apple.">
              {(fid) => (
                <input id={fid} type="text" name="icloud-identifiant" inputMode="email" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  maxLength={254} placeholder="prenom@icloud.com" value={username} onChange={(e) => setUsername(e.target.value)} />
              )}
            </Fld>
          )}
          <Fld
            label={locked ? 'Nouveau mot de passe d’application' : 'Mot de passe d’application'} error={errors.password}
            hint={oddShape
              ? <span className="cx-warn-text">Un mot de passe d’application Apple fait 16 lettres minuscules, avec ou sans tirets. Vérifie ce que tu as collé.</span>
              : 'Alfred teste la connexion avant d’enregistrer : si l’essai échoue, rien ne change.'}
          >
            {(fid) => (
              <input id={fid} type="password" name="icloud-mot-de-passe-app" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={1024} placeholder="abcd-efgh-ijkl-mnop" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Fld>
          {!locked && otherServer && (
            <Fld label="Adresse du serveur CalDAV" error={errors.url} hint={`Laisse vide pour iCloud (${DEFAULT_URL}).`} className="span-2">
              {(fid) => (
                <input id={fid} type="text" name="caldav-adresse" inputMode="url" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  maxLength={500} placeholder={c.url.value} value={url} onChange={(e) => setUrl(e.target.value)} />
              )}
            </Fld>
          )}
        </div>
        {!locked && !otherServer && (
          <button type="button" className="cx-link" onClick={() => setOtherServer(true)}>Utiliser un autre serveur CalDAV qu’iCloud</button>
        )}
        {locked && (
          <p className="bk-hint">Changer de compte (un autre identifiant Apple) n’est pas encore possible depuis l’app : les calendriers du compte actuel et les réservations qui y sont liées sont enregistrés ici.</p>
        )}

        <TestResult test={result ?? (password ? null : c.lastTest)} warning={warning} />

        {confirmClear ? (
          <div className="bk-savebar static">
            <span>Retirer le mot de passe enregistré dans l’app et revenir à celui du fichier .env ? Alfred vérifie d’abord qu’il fonctionne encore.</span>
            <button type="button" className="btn ghost" onClick={() => setConfirmClear(false)}>Garder</button>
            <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void clear()}>{busy === 'clear' ? 'Vérification…' : 'Revenir au .env'}</button>
          </div>
        ) : (
          <div className="bk-savebar static">
            <span />
            {c.canRevertToEnv && !password && <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setConfirmClear(true)}>Revenir au fichier .env</button>}
            <button type="button" className="btn" disabled={busy !== null || (!canSubmit && !c.configured)} onClick={() => void test()}>
              {busy === 'test' ? 'Essai en cours…' : canSubmit || !c.configured ? 'Tester la connexion' : 'Tester la connexion actuelle'}
            </button>
            <button type="submit" className="btn primary" disabled={busy !== null || !canSubmit}>{busy === 'save' ? 'Essai puis enregistrement…' : locked ? 'Tester et enregistrer' : 'Relier iCloud'}</button>
          </div>
        )}
      </form>
    </Card>
  );
}
