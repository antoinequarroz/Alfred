import ICAL from 'ical.js';
import { toInstant } from './instants.js';
import { schemaVersion } from './migrations.js';
import { ALL_SPACES, type Param, type Sql } from './sql.js';

// Export et import complets des données d'un espace (phase 4, ALFRED-304). Format : docs/EXPORT.md.
//
// L'export est un JSON lisible, versionné, qui contient toutes les données d'Alfred de l'espace,
// table par table, sans les secrets. L'import le recharge dans un Alfred vide : un nouvel export
// redonne alors exactement le même fichier (seule la date d'export change). Le calendrier peut
// aussi sortir en .ics, pour n'importe quelle autre app de calendrier.

export const EXPORT_FORMAT = 'alfred-export';
/** Version du format de fichier (pas du schéma) : à augmenter si la forme du fichier change. */
export const EXPORT_VERSION = 1;

interface TableSpec {
  /** Ordre stable des lignes, pour que deux exports des mêmes données soient identiques. */
  order: string;
  /** Colonnes jamais exportées : identifiants internes recréés à l'import, anciennes colonnes. */
  omit?: readonly string[];
  /** Lignes exportées (les autres sont des secrets ou des données d'un appareil). */
  where?: string;
  /** Colonnes vidées à l'export (secrets de passage). */
  blank?: readonly string[];
}

/**
 * Tables exportées, dans l'ordre d'import (une table avant celles qui la référencent).
 * Toute table de la base doit être ici ou dans NOT_EXPORTED : un test le vérifie.
 */
export const EXPORTED_TABLES: Record<string, TableSpec> = {
  calendars: { order: 'sort, id' },
  events: { order: 'id', omit: ['start_ms', 'end_ms', 'recur_end_ms', 'updated_at'] },
  booking_settings: { order: 'key' },
  booking_types: { order: 'sort, id' },
  booking_hours: { order: 'weekday, start_min, end_min', omit: ['id'] },
  people: { order: 'id' },
  bookings: { order: 'id' },
  booking_tokens: { order: 'token_hash' },
  payment_holds: { order: 'id', blank: ['cancel_token'] },
  video_settings: { order: 'key' },
  video_rooms: { order: 'id' },
  links: { order: 'id' },
  connection_settings: { order: 'key', where: 'secret = 0' },
  push_settings: { order: 'key', where: "key NOT IN ('vapid', 'since')" },
  outbox: { order: 'seq', omit: ['seq'] },
};

/** Tables laissées de côté, et pourquoi (repris dans docs/EXPORT.md). */
export const NOT_EXPORTED: Record<string, string> = {
  spaces: 'l’espace est décrit dans l’en-tête du fichier',
  schema_migrations: 'mécanique interne, la version du schéma est dans l’en-tête',
  sessions: 'connexions en cours, propres à cette installation',
  push_subscriptions: 'abonnements des appareils, liés aux clés de cette installation',
  push_sent: 'mémoire interne des notifications déjà envoyées',
  outbox_readers: 'positions de lecture internes du journal',
  sqlite_sequence: 'mécanique interne de SQLite',
};

/** Tables qui doivent être vides pour accepter un import (les réglages, eux, sont remplacés). */
const CONTENT_TABLES = ['events', 'bookings', 'booking_types', 'booking_tokens', 'people', 'links', 'video_rooms', 'payment_holds', 'outbox'];
/** Tables de réglages : remplacées par celles du fichier, en gardant les secrets déjà enregistrés. */
const SETTINGS_TABLES: Record<string, string> = {
  booking_settings: '1 = 1',
  video_settings: '1 = 1',
  connection_settings: 'secret = 0',
  push_settings: "key NOT IN ('vapid', 'since')",
};

/** Lecteurs du journal : placés après les faits importés, pour ne pas les traiter une seconde fois. */
const OUTBOX_READERS = ['push'];

export type Row = Record<string, string | number | null>;

export interface AlfredExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** Version du schéma de la base qui a produit le fichier (server/migrations.ts). */
  schemaVersion: number;
  exportedAt: string;
  space: { id: string; name: string };
  tables: Record<string, Row[]>;
}

export class ImportError extends Error {
  constructor(readonly status: 400 | 409, readonly code: string, message: string) {
    super(message);
  }
}

function exportColumns(db: Sql, table: string, spec: TableSpec): string[] {
  return db.columns(table).filter((c) => c !== 'space_id' && !spec.omit?.includes(c));
}

/** Toutes les données de l'espace de db, sans les secrets. */
export function exportSpace(db: Sql, now = new Date()): AlfredExport {
  const space = db.get<{ id: string; name: string }>(`SELECT id, name FROM spaces WHERE id = ? ${ALL_SPACES}`, db.spaceId);
  const present = new Set(db.tables());
  const tables: Record<string, Row[]> = {};
  for (const [table, spec] of Object.entries(EXPORTED_TABLES)) {
    if (!present.has(table)) continue;
    const cols = exportColumns(db, table, spec);
    const rows = db.all<Row>(
      `SELECT ${cols.join(', ')} FROM ${table} WHERE space_id = ?${spec.where ? ` AND ${spec.where}` : ''} ORDER BY ${spec.order}`, db.spaceId);
    tables[table] = rows.map((r) => {
      const out: Row = {};
      for (const c of cols) out[c] = spec.blank?.includes(c) ? null : normalize(r[c]);
      return out;
    });
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    schemaVersion: schemaVersion(db),
    exportedAt: toInstant(now),
    space: { id: db.spaceId, name: space?.name ?? '' },
    tables,
  };
}

/** Valeurs JSON stables : les entiers BIGINT de PostgreSQL et de SQLite deviennent des nombres. */
function normalize(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

/** Vrai si l'espace ne contient encore aucune donnée (réglages et calendrier vide mis à part). */
export function isEmptySpace(db: Sql): boolean {
  const present = new Set(db.tables());
  return CONTENT_TABLES.every((t) => !present.has(t) || !db.get(`SELECT 1 AS ok FROM ${t} WHERE space_id = ? LIMIT 1`, db.spaceId));
}

/** Lit et vérifie un fichier d'export (forme seulement : le contenu est vérifié par les contraintes de la base). */
export function parseExport(value: unknown, db: Sql): AlfredExport {
  const bad = (msg: string) => new ImportError(400, 'invalid_export', msg);
  if (!value || typeof value !== 'object') throw bad('Fichier illisible : ce n’est pas un export d’Alfred.');
  const v = value as Partial<AlfredExport>;
  if (v.format !== EXPORT_FORMAT) throw bad('Fichier illisible : ce n’est pas un export d’Alfred.');
  if (v.version !== EXPORT_VERSION) throw bad(`Format d’export ${String(v.version)} inconnu de cette version d’Alfred (attendu : ${EXPORT_VERSION}).`);
  if (typeof v.schemaVersion !== 'number' || v.schemaVersion > schemaVersion(db)) {
    throw bad('Cet export vient d’une version plus récente d’Alfred : mettez Alfred à jour avant de l’importer.');
  }
  if (!v.tables || typeof v.tables !== 'object') throw bad('Fichier incomplet : les tables manquent.');
  const present = new Set(db.tables());
  for (const [table, rows] of Object.entries(v.tables)) {
    const spec = EXPORTED_TABLES[table];
    if (!spec || !present.has(table)) throw bad(`Table inconnue dans l’export : ${table}.`);
    if (!Array.isArray(rows)) throw bad(`Table ${table} illisible.`);
    const allowed = new Set(exportColumns(db, table, spec));
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad(`Ligne illisible dans ${table}.`);
      for (const [k, val] of Object.entries(row)) {
        if (!allowed.has(k)) throw bad(`Colonne inconnue dans ${table} : ${k}.`);
        if (val !== null && typeof val !== 'string' && typeof val !== 'number') throw bad(`Valeur illisible dans ${table}.${k}.`);
      }
    }
  }
  return v as AlfredExport;
}

/**
 * Charge un export dans l'espace de db, qui doit être vide. Tout ou rien (une transaction).
 * Les réglages sont remplacés ; les secrets déjà enregistrés ici (mots de passe, clés) restent.
 * Renvoie le nombre de lignes importées par table.
 */
export function importSpace(db: Sql, value: unknown): Record<string, number> {
  const data = parseExport(value, db);
  if (!isEmptySpace(db)) {
    throw new ImportError(409, 'not_empty', 'Alfred contient déjà des données : l’import se fait seulement dans un Alfred vide.');
  }
  const counts: Record<string, number> = {};
  db.tx(() => {
    // Ce qui existe d'office dans un Alfred neuf : le calendrier vide « Personnel », les horaires
    // proposés et les réglages. Remplacés par ceux du fichier.
    if ((data.tables.calendars ?? []).length > 0) db.run('DELETE FROM calendars WHERE space_id = ?', db.spaceId);
    if (data.tables.booking_hours) db.run('DELETE FROM booking_hours WHERE space_id = ?', db.spaceId);
    for (const [table, where] of Object.entries(SETTINGS_TABLES)) {
      if (data.tables[table]) db.run(`DELETE FROM ${table} WHERE space_id = ? AND ${where}`, db.spaceId);
    }
    for (const table of Object.keys(EXPORTED_TABLES)) {
      const rows = data.tables[table];
      if (!rows) continue;
      for (const row of rows) insertRow(db, table, row);
      counts[table] = rows.length;
    }
    // Les faits importés sont de l'histoire : aucune notification ne doit repartir pour eux.
    const last = db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM outbox WHERE space_id = ?', db.spaceId)?.seq;
    if (last !== null && last !== undefined) {
      const names = new Set([...OUTBOX_READERS, ...db.all<{ reader: string }>('SELECT reader FROM outbox_readers WHERE space_id = ?', db.spaceId).map((r) => r.reader)]);
      for (const reader of names) {
        db.run(`INSERT INTO outbox_readers (space_id, reader, seq, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (space_id, reader) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`, db.spaceId, reader, Number(last), toInstant(Date.now()));
      }
    }
  });
  return counts;
}

function insertRow(db: Sql, table: string, row: Row): void {
  const values: Row = { ...row };
  if (table === 'events') {
    // Anciennes colonnes en millisecondes : déduites des instants (voir server/instants.ts).
    const ms = (v: string | number | null) => (v === null ? null : Date.parse(String(v)));
    values.start_ms = ms(row.start_at);
    values.end_ms = ms(row.end_at);
    values.recur_end_ms = ms(row.recur_end_at ?? null);
    values.updated_at = ms(row.modified_at ?? null) ?? Date.now();
  }
  const cols = Object.keys(values);
  const params: Param[] = cols.map((c) => values[c]);
  // Une clé de réglage déjà prise (secret gardé ici, ou réglage d'un autre espace) n'est pas écrasée.
  const settings = table in SETTINGS_TABLES ? ' ON CONFLICT (key) DO NOTHING' : '';
  db.run(`INSERT INTO ${table} (${[...cols, 'space_id'].join(', ')}) VALUES (${[...cols, 'space_id'].map(() => '?').join(', ')})${settings}`,
    ...params, db.spaceId);
}

/**
 * Tout le calendrier de l'espace en un seul fichier .ics (iCalendar), lisible par Apple
 * Calendrier, Google Agenda, Outlook… calendarId : un seul calendrier.
 */
export function exportIcs(db: Sql, calendarId?: string): string {
  const rows = db.all<{ ics: string; calendar_id: string }>(
    `SELECT ics, calendar_id FROM events WHERE space_id = ?${calendarId ? ' AND calendar_id = ?' : ''} ORDER BY start_at, id`,
    ...(calendarId ? [db.spaceId, calendarId] : [db.spaceId]));
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.addPropertyWithValue('version', '2.0');
  out.addPropertyWithValue('prodid', '-//Alfred//Calendrier//FR');
  out.addPropertyWithValue('calscale', 'GREGORIAN');
  const zones = new Map<string, ICAL.Component>();
  const events: ICAL.Component[] = [];
  for (const row of rows) {
    let vcal: ICAL.Component;
    try {
      vcal = new ICAL.Component(ICAL.parse(row.ics) as unknown[]);
    } catch {
      continue; // iCalendar illisible : il reste dans l'export JSON, tel quel
    }
    for (const tz of vcal.getAllSubcomponents('vtimezone')) {
      const id = String(tz.getFirstPropertyValue('tzid') ?? '');
      if (!zones.has(id)) zones.set(id, tz);
    }
    events.push(...vcal.getAllSubcomponents('vevent'));
  }
  // Fuseaux d'abord (une fois chacun), puis les événements.
  for (const tz of zones.values()) out.addSubcomponent(tz);
  for (const ev of events) out.addSubcomponent(ev);
  return out.toString() + '\r\n';
}
