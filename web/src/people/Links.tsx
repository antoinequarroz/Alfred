import { useCallback, useEffect, useState } from 'react';
import type { LinkInfo } from '../../../shared/types';
import { ApiError, peopleApi, type LinkSource } from '../api';
import { CloseIcon, ExternalIcon, PlusIcon } from '../icons';
import './people.css';

const MODULE_LABELS: Record<string, string> = { cairn: 'Note Cairn', alfred: 'Alfred', web: 'Page web' };

/** Texte affiché pour un lien : son titre, sinon ce qu'on sait de la cible. */
function linkLabel(l: LinkInfo): string {
  if (l.title) return l.title;
  if (l.module === 'web') {
    try {
      const u = new URL(l.to);
      return u.host + (u.pathname !== '/' ? u.pathname : '');
    } catch {
      return l.to;
    }
  }
  return MODULE_LABELS[l.module] ?? l.to;
}

/**
 * Liens d'un objet (fiche Personne, événement) vers une note Cairn ou une page web : on colle
 * le lien de la note ouverte dans Cairn, il s'enregistre comme adresse media://cairn/note/<id>.
 */
export function LinksPanel({ source, initial, compact }: { source: LinkSource; initial?: LinkInfo[]; compact?: boolean }) {
  const [links, setLinks] = useState<LinkInfo[] | null>(initial ?? null);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = 'from' in source ? source.from : `event:${source.eventId}`;

  const load = useCallback(async () => {
    try {
      setLinks(await peopleApi.links(source));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Liens indisponibles');
    }
  }, [key]);

  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const link = await peopleApi.addLink(source, target, title);
      setLinks((prev) => [...(prev ?? []).filter((l) => l.id !== link.id), link]);
      setTarget('');
      setTitle('');
      setAdding(false);
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields?.target ?? err.message) : 'Le lien n’a pas pu être ajouté');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (l: LinkInfo) => {
    setError(null);
    try {
      await peopleApi.removeLink(l.id);
      setLinks((prev) => (prev ?? []).filter((x) => x.id !== l.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Le lien n’a pas pu être retiré');
    }
  };

  return (
    <div className={`pp-links${compact ? ' compact' : ''}`}>
      {links && links.length > 0 && (
        <ul className="pp-link-list">
          {links.map((l) => (
            <li key={l.id}>
              <span className={`pp-link-kind ${l.module}`}>{MODULE_LABELS[l.module] ?? l.module}</span>
              {l.url ? (
                <a href={l.url} target="_blank" rel="noopener" className="pp-link-title">{linkLabel(l)}<ExternalIcon /></a>
              ) : <span className="pp-link-title">{linkLabel(l)}</span>}
              <button type="button" className="icon-btn small" onClick={() => void remove(l)} aria-label={`Retirer le lien « ${linkLabel(l)} »`} title="Retirer le lien">
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      {links && links.length === 0 && !adding && !compact && <p className="bk-empty">Aucun lien. Colle le lien d’une note Cairn pour la retrouver ici.</p>}
      {adding ? (
        <div className="pp-link-form">
          <input type="url" inputMode="url" autoFocus value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder="Lien de la note Cairn (https://cairn…/notes/…) ou d’une page" aria-label="Lien" maxLength={2000}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(e); }} />
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre (facultatif)" aria-label="Titre du lien" maxLength={200}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(e); }} />
          <div className="pp-link-actions">
            <button type="button" className="btn ghost small" onClick={() => { setAdding(false); setError(null); }}>Annuler</button>
            <button type="button" className="btn primary small" disabled={busy || !target.trim()} onClick={(e) => void add(e)}>{busy ? 'Ajout…' : 'Ajouter'}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn small" onClick={() => setAdding(true)}><PlusIcon />Lier une note Cairn</button>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
