import { ALL_SPACES, type Sql } from './sql.js';

// Instants d'Alfred (phase 4, ALFRED-296).
//
// Un seul format d'instant dans toute la base : le texte ISO 8601 en UTC, toujours avec les
// millisecondes et le Z final, exactement comme Date.prototype.toISOString :
//
//     2026-11-18T21:45:00.000Z
//
// Ce format a la même longueur pour toutes les dates de 0000 à 9999 : l'ordre alphabétique est
// donc l'ordre chronologique, et les comparaisons (<, >, ORDER BY) marchent pareil sous SQLite
// et PostgreSQL. L'heure locale n'est jamais stockée seule : quand elle compte (horaires
// d'ouverture, événements récurrents), le fuseau IANA l'accompagne (booking_hours.tzid,
// events.tzid).
//
// Anciennes colonnes en millisecondes : events.start_ms, end_ms, recur_end_ms, updated_at et
// sessions.expires_ms. Le code ne les lit plus, mais les écrit encore, pour qu'on puisse remettre
// l'image précédente d'Alfred sans restaurer la base. Si cette image a tourné entre-temps,
// syncLegacyInstants recopie ses écritures dans les colonnes ISO au démarrage suivant.

/** Format canonique d'un instant en base. */
export const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Instant canonique depuis des millisecondes, une Date ou un texte ISO quelconque (avec décalage). */
export function toInstant(value: number | Date | string): string {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(ms)) throw new Error(`Instant illisible : ${String(value)}`);
  return new Date(ms).toISOString();
}

export function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT_RE.test(value);
}

/**
 * Toutes les colonnes d'instant de la base, par table. La liste sert à la migration (mise au
 * format), à l'export (docs/EXPORT.md) et au test qui vérifie que la base n'a qu'un format.
 * Une nouvelle colonne d'instant doit y être ajoutée (le test le rappelle).
 */
export const INSTANT_COLUMNS: Record<string, readonly string[]> = {
  spaces: ['created_at'],
  schema_migrations: ['applied_at'],
  events: ['start_at', 'end_at', 'recur_end_at', 'modified_at', 'attendees_at'],
  sessions: ['expires_at'],
  bookings: ['start_utc', 'end_utc', 'created_at', 'cancelled_at', 'notified_start', 'reminder_ref'],
  booking_tokens: ['created_at'],
  connection_settings: ['updated_at'],
  video_rooms: ['starts_at', 'ends_at', 'created_at', 'closed_at'],
  push_subscriptions: ['created_at', 'last_success_at', 'last_error_at'],
  push_sent: ['sent_at'],
  people: ['created_at', 'updated_at'],
  links: ['created_at'],
  payment_holds: ['start_utc', 'end_utc', 'created_at', 'expires_at'],
  outbox: ['occurred_at'],
  outbox_readers: ['updated_at'],
  settings: ['updated_at'],
  video_participations: ['joined_at', 'seen_at', 'left_at'],
  api_tokens: ['created_at', 'last_used_at'],
};

/** Anciennes colonnes en millisecondes → colonne ISO qui les remplace. Écrites, plus lues. */
export const LEGACY_MS_COLUMNS: Record<string, Record<string, string>> = {
  events: { start_ms: 'start_at', end_ms: 'end_at', recur_end_ms: 'recur_end_at', updated_at: 'modified_at' },
  sessions: { expires_ms: 'expires_at' },
};

/** Fuseaux IANA stockés à côté d'une heure locale. */
export const TIMEZONE_COLUMNS: Record<string, readonly string[]> = {
  booking_hours: ['tzid'],
  events: ['tzid'],
};

/**
 * Recopie les anciennes colonnes en millisecondes dans les colonnes ISO quand elles diffèrent :
 * lignes écrites par l'image précédente d'Alfred (retour arrière puis retour en avant).
 * Rejoué à chaque démarrage ; ne fait rien sur une base à jour. Renvoie le nombre de lignes corrigées.
 */
export function syncLegacyInstants(db: Sql): number {
  let fixed = 0;
  for (const [table, map] of Object.entries(LEGACY_MS_COLUMNS)) {
    const cols = db.columns(table);
    const pairs = Object.entries(map).filter(([ms, iso]) => cols.includes(ms) && cols.includes(iso));
    if (pairs.length === 0) continue;
    const select = pairs.flatMap(([ms, iso]) => [ms, iso]).join(', ');
    const rows = db.all<Record<string, unknown>>(`SELECT id, ${select} FROM ${table} ${ALL_SPACES}`);
    for (const row of rows) {
      const sets: string[] = [];
      const values: (string | null)[] = [];
      for (const [ms, iso] of pairs) {
        const raw = row[ms];
        const expected = raw === null || raw === undefined ? null : toInstant(Number(raw));
        if (row[iso] !== expected) {
          sets.push(`${iso} = ?`);
          values.push(expected);
        }
      }
      if (sets.length === 0) continue;
      db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? ${ALL_SPACES}`, ...values, String(row.id));
      fixed++;
    }
  }
  return fixed;
}
