import { useRef, useState } from 'react';
import { ApiError, requestJson } from '../http';
import { Card } from '../rdv/ui';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Une erreur est survenue');

/**
 * Carte « Données » des Réglages : export complet (JSON, sans les secrets) et calendrier en .ics,
 * import d'un export dans un Alfred vide. Format : docs/EXPORT.md.
 */
export function DataCard({ notify }: { notify: (msg: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    setError(null);
    if (!f) return;
    try {
      setFile({ name: f.name, data: JSON.parse(await f.text()) });
    } catch {
      setError('Ce fichier n’est pas un export d’Alfred (JSON illisible).');
    }
    if (input.current) input.current.value = '';
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson<{ counts: Record<string, number> }>('POST', '/api/import', file.data);
      const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
      notify(`Import terminé : ${total} éléments chargés. Alfred se recharge.`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 413 ? 'Fichier trop gros (50 Mo au plus).' : message(err));
      setBusy(false);
      setFile(null);
    }
  };

  return (
    <Card id="donnees" title="Données" sub="Toutes les données d’Alfred dans un fichier ouvert, pour les garder ou les déplacer.">
      <p className="cx-help muted">
        L’export contient le calendrier, les rendez-vous, les personnes, les liens, la visio et les réglages. Les mots de passe et les clés n’y sont jamais.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {file ? (
        <div className="bk-savebar static">
          <span>Importer « {file.name} » ? L’import se fait seulement dans un Alfred vide ; les réglages sont remplacés.</span>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setFile(null)}>Annuler</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? 'Import…' : 'Importer'}</button>
        </div>
      ) : (
        <div className="bk-savebar static cx-data">
          <span />
          <button type="button" className="btn ghost" onClick={() => input.current?.click()}>Importer un export…</button>
          <a className="btn" href="/api/export/calendar.ics" download>Calendrier (.ics)</a>
          <a className="btn primary" href="/api/export" download>Exporter tout</a>
        </div>
      )}
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.target.files?.[0])} />
    </Card>
  );
}
