import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS calendars (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,            -- 'local' | 'caldav'
  url        TEXT,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  ctag       TEXT,
  visible    INTEGER NOT NULL DEFAULT 1,
  read_only  INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  calendar_id  TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  href         TEXT,                   -- URL CalDAV de la ressource
  etag         TEXT,
  uid          TEXT NOT NULL,
  ics          TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  recurring    INTEGER NOT NULL DEFAULT 0,
  recur_end_ms INTEGER,                -- NULL = répétition sans fin
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_id);
CREATE INDEX IF NOT EXISTS events_range ON events(start_ms, end_ms);
CREATE UNIQUE INDEX IF NOT EXISTS events_href ON events(href) WHERE href IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_uid ON events(uid);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  expires_ms INTEGER NOT NULL
);

-- Prise de rendez-vous (v1.1)
CREATE TABLE IF NOT EXISTS booking_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_types (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  duration_min      INTEGER NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  mode              TEXT NOT NULL DEFAULT 'cabinet',  -- 'cabinet' | 'telephone' | 'visio' | 'autre'
  location          TEXT NOT NULL DEFAULT '',         -- précision libre : adresse, lien, consigne
  buffer_before_min INTEGER NOT NULL DEFAULT 0,
  buffer_after_min  INTEGER NOT NULL DEFAULT 0,
  min_notice_hours  INTEGER NOT NULL DEFAULT 12,
  horizon_days      INTEGER NOT NULL DEFAULT 60,
  active            INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS booking_hours (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday   INTEGER NOT NULL,          -- 1 = lundi … 7 = dimanche
  start_min INTEGER NOT NULL,          -- minutes depuis minuit, heure locale
  end_min   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id            TEXT PRIMARY KEY,
  type_id       TEXT REFERENCES booking_types(id) ON DELETE SET NULL,
  type_name     TEXT NOT NULL,         -- copie : le type peut être renommé ou supprimé ensuite
  location      TEXT NOT NULL DEFAULT '',
  buffer_before_min INTEGER NOT NULL DEFAULT 0,
  buffer_after_min  INTEGER NOT NULL DEFAULT 0,
  event_id      TEXT,                  -- événement créé dans le calendrier
  calendar_id   TEXT,
  start_utc     TEXT NOT NULL,         -- instant ISO UTC
  end_utc       TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'confirmed',   -- 'confirmed' | 'cancelled'
  token_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 du jeton d'annulation, jamais le jeton
  created_at    TEXT NOT NULL,
  cancelled_at  TEXT,
  cancelled_by  TEXT,                  -- 'client' | 'admin'
  mail_error    TEXT                   -- dernier échec d'envoi d'e-mail, NULL si tout est parti
);
CREATE INDEX IF NOT EXISTS bookings_start ON bookings(start_utc);
CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status, end_utc);

-- Liens supplémentaires vers une réservation (rappels, déplacement) : le jeton n'est jamais
-- conservé en clair, chaque e-mail qui porte un lien en reçoit donc un nouveau.
CREATE TABLE IF NOT EXISTS booking_tokens (
  token_hash  TEXT PRIMARY KEY,        -- SHA-256 du jeton
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_tokens_booking ON booking_tokens(booking_id);

-- Connexions réglées depuis l'app (SMTP, CalDAV). Une ligne par réglage : « smtp.host »,
-- « caldav.password »… Les secrets (secret = 1) sont chiffrés, voir server/secrets.ts.
CREATE TABLE IF NOT EXISTS connection_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  secret     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Visioconférence (v2) : réglages (clé, valeur JSON) et salles. Le lien d'une salle est
-- /v/<slug> ; le slug, aléatoire, sert de clé d'entrée aux invités.
CREATE TABLE IF NOT EXISTS video_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_rooms (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- 'instant' | 'event' | 'booking' | 'permanent'
  booking_id  TEXT,                      -- réservation liée (kind = 'booking')
  starts_at   TEXT,                      -- instants ISO UTC, NULL pour la salle permanente
  ends_at     TEXT,
  created_at  TEXT NOT NULL,
  closed_at   TEXT                       -- fermée (annulation, suppression, lien renouvelé)
);
CREATE INDEX IF NOT EXISTS video_rooms_booking ON video_rooms(booking_id) WHERE booking_id IS NOT NULL;
`;

/** Horaires proposés à la première ouverture : lundi à vendredi, 09:00-12:00 et 13:30-17:30. */
const DEFAULT_HOURS: [number, number][] = [[9 * 60, 12 * 60], [13 * 60 + 30, 17 * 60 + 30]];

/** Migrations idempotentes : colonnes ajoutées après coup et valeurs initiales. */
function migrate(db: DatabaseSync): void {
  const addColumn = (table: string, column: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  // Par défaut, tout calendrier occupe l'agenda pour la prise de rendez-vous.
  addColumn('calendars', 'blocks_booking', 'INTEGER NOT NULL DEFAULT 1');
  // Occupation d'un événement non récurrent, calculée à l'enregistrement (JSON compact).
  // NULL : série à développer, ou ligne antérieure à la colonne (complétée à la première lecture).
  addColumn('events', 'busy', 'TEXT');
  // UID iCalendar de l'événement créé : il survit à un changement de calendrier, pas l'identifiant local.
  addColumn('bookings', 'event_uid', 'TEXT');
  // Horaire annoncé au client quand il diffère de l'horaire actuel (événement déplacé dans l'agenda).
  addColumn('bookings', 'notified_start', 'TEXT');
  // Rappels déjà partis pour l'horaire actuel (« 24,1 »), et instant à partir duquel le client
  // connaît cet horaire (NULL : created_at). Un rappel dont le moment précède cet instant n'est pas envoyé.
  addColumn('bookings', 'reminders_sent', "TEXT NOT NULL DEFAULT ''");
  addColumn('bookings', 'reminder_ref', 'TEXT');
  // Déplacements faits par le client lui-même, depuis le lien de ses e-mails.
  addColumn('bookings', 'client_reschedules', 'INTEGER NOT NULL DEFAULT 0');
  // Les horaires ne sont posés qu'une fois : si Antoine les vide ensuite, ils restent vides.
  const seeded = db.prepare("SELECT 1 FROM booking_settings WHERE key = 'hours_seeded'").get();
  if (!seeded) {
    db.exec('BEGIN');
    try {
      const insert = db.prepare('INSERT INTO booking_hours (weekday, start_min, end_min) VALUES (?, ?, ?)');
      for (let weekday = 1; weekday <= 5; weekday++) {
        for (const [start, end] of DEFAULT_HOURS) insert.run(weekday, start, end);
      }
      db.prepare("INSERT INTO booking_settings (key, value) VALUES ('hours_seeded', '1')").run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  let path = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, 'alfred.db');
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Exécute fn dans une transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
