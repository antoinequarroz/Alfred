import { useEffect, useState } from 'react';
import type { ApiToken, ApiTokenCreated, ApiTokenKind, CalendarInfo } from '../../../shared/types';
import { api, ApiError, tokensApi } from '../api';
import { CheckIcon, CopyIcon } from '../icons';
import { Card, Fld } from '../rdv/ui';
import { dateTimeShortIn } from '../rdv/tz';
import '../people/people.css';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Zurich';
const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* presse-papiers refusé : la valeur reste sélectionnable */
    }
  };
  return (
    <div className="pp-address">
      <code aria-label={label}>{value}</code>
      <button type="button" className="btn ghost small" onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? 'Copié' : 'Copier'}</button>
    </div>
  );
}

/**
 * Carte « Accès à l'agenda » des Réglages (ALFRED-303) : jetons de l'API v1 en lecture (pour la
 * suite PostMelo) et flux iCalendar d'un calendrier (abonnement dans Apple Calendrier). Le jeton
 * n'est montré qu'une fois. Documentation : docs/API.md.
 */
export function AccessCard({ notify }: { notify: (msg: string) => void }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ApiTokenKind>('feed');
  const [calendarId, setCalendarId] = useState('');
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [t, c] = await Promise.all([tokensApi.list(), api.calendars()]);
        setTokens(t);
        setCalendars(c);
        setCalendarId((id) => id || c[0]?.id || '');
      } catch (err) {
        setError(message(err));
      }
    })();
  }, []);

  const calendarName = (id: string | null) => calendars.find((c) => c.id === id)?.name ?? 'calendrier supprimé';

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await tokensApi.create(name.trim(), kind, kind === 'feed' ? calendarId : undefined);
      setCreated(t);
      setTokens((list) => [...(list ?? []), t]);
      setName('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: ApiToken) => {
    if (!window.confirm(`Retirer « ${t.name} » ? ${t.kind === 'feed' ? 'Les abonnements à ce flux s’arrêteront.' : 'Ce qui l’utilise n’aura plus accès.'}`)) return;
    try {
      await tokensApi.remove(t.id);
      setTokens((list) => (list ?? []).filter((x) => x.id !== t.id));
      if (created?.id === t.id) setCreated(null);
      notify('Accès retiré');
    } catch (err) {
      setError(message(err));
    }
  };

  const feedUrl = created?.feedPath ? `${location.origin}${created.feedPath}` : null;

  return (
    <Card id="acces" title="Accès à l’agenda" sub="Abonne Apple Calendrier à un calendrier d’Alfred, ou donne à la suite PostMelo un accès en lecture.">
      {error && <p className="form-error" role="alert">{error}</p>}

      {created && (
        <div className="cx-help cx-created">
          {feedUrl ? (
            <>
              <p><strong>Flux prêt.</strong> Dans Apple Calendrier : Fichier › Nouvel abonnement à un calendrier, puis colle cette adresse. Elle ne sera plus affichée.</p>
              <CopyField value={feedUrl.replace(/^https?:/, 'webcal:')} label="Adresse d’abonnement" />
            </>
          ) : (
            <>
              <p><strong>Jeton prêt.</strong> À envoyer dans l’en-tête « Authorization: Bearer … » des appels à /api/v1. Il ne sera plus affiché.</p>
              <CopyField value={created.token} label="Jeton d’API" />
            </>
          )}
        </div>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="bk-list cx-tokens">
          {tokens.map((t) => (
            <li key={t.id} className="cx-token">
              <span className="pp-what">
                <span>{t.name} <span className="tag">{t.kind === 'feed' ? `Flux · ${calendarName(t.calendarId)}` : 'API en lecture'}</span></span>
                <span className="bk-meta">
                  Créé le {dateTimeShortIn(TZ, t.createdAt)} · {t.lastUsedAt ? `utilisé le ${dateTimeShortIn(TZ, t.lastUsedAt)}` : 'jamais utilisé'}
                </span>
              </span>
              <button type="button" className="btn ghost small" onClick={() => void remove(t)}>Retirer</button>
            </li>
          ))}
        </ul>
      )}

      <form className="bk-form cx-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="bk-grid cx-grid">
          <Fld label="Sorte d’accès">
            {(fid) => (
              <select id={fid} value={kind} onChange={(e) => setKind(e.target.value as ApiTokenKind)}>
                <option value="feed">Flux d’un calendrier (.ics)</option>
                <option value="api">API en lecture (suite PostMelo)</option>
              </select>
            )}
          </Fld>
          {kind === 'feed' && (
            <Fld label="Calendrier">
              {(fid) => (
                <select id={fid} value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
                  {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </Fld>
          )}
          <Fld label="Nom" hint="Pour le reconnaître plus tard : « iPhone », « Lamio »…">
            {(fid) => <input id={fid} type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="iPhone" />}
          </Fld>
        </div>
        <div className="bk-savebar static">
          <span />
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || (kind === 'feed' && !calendarId)}>{busy ? 'Création…' : 'Créer l’accès'}</button>
        </div>
      </form>
    </Card>
  );
}
