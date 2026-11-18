import type { Hono } from 'hono';
import { exportIcs, exportSpace, importSpace, ImportError } from './export.js';
import type { Store } from './store.js';

// Export et import des données (Réglages > Données). Session requise : enregistrées après la garde.

/** Taille maximale d'un fichier d'import (les autres routes de l'API restent à 128 Ko). */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export function registerExportRoutes(app: Hono, store: Store): void {
  app.get('/api/export', (c) => {
    const data = exportSpace(store.db);
    c.header('content-disposition', `attachment; filename="alfred-export-${data.exportedAt.slice(0, 10)}.json"`);
    c.header('cache-control', 'no-store');
    return c.body(JSON.stringify(data, null, 2) + '\n', 200, { 'content-type': 'application/json; charset=utf-8' });
  });

  app.get('/api/export/calendar.ics', (c) => {
    const calendar = c.req.query('calendar') || undefined;
    if (calendar && !store.getCalendar(calendar)) return c.json({ error: 'Calendrier introuvable' }, 404);
    const day = new Date().toISOString().slice(0, 10);
    c.header('content-disposition', `attachment; filename="alfred-calendrier-${day}.ics"`);
    c.header('cache-control', 'no-store');
    return c.body(exportIcs(store.db, calendar), 200, { 'content-type': 'text/calendar; charset=utf-8' });
  });

  app.post('/api/import', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Fichier illisible : ce n’est pas un export d’Alfred.', code: 'invalid_export' }, 400);
    }
    try {
      const counts = importSpace(store.db, body);
      store.markChanged();
      return c.json({ ok: true, counts });
    } catch (err) {
      if (err instanceof ImportError) return c.json({ error: err.message, code: err.code }, err.status);
      // Refus de la base (doublon, valeur impossible) : rien n'a été écrit, la transaction est annulée.
      console.warn('[alfred] import refusé :', (err as Error).message);
      return c.json({ error: 'Import impossible : le fichier contient des données incohérentes. Rien n’a été modifié.', code: 'import_failed' }, 400);
    }
  });
}
