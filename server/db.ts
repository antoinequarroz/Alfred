import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SPACE_ID, ensureSpaceColumns, migrateUp } from './migrations.js';
import { PostgresDriver } from './pg.js';
import { ALL_SPACES, Sql, SqliteDriver, type Driver } from './sql.js';

const SCHEMA = `
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

-- Notifications sur les appareils (Web Push).
CREATE TABLE IF NOT EXISTS push_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_success_at TEXT,
  last_error      TEXT,
  last_error_at   TEXT
);
-- Notifications déjà traitées (envoyées, ou volontairement tues) : une clé par événement signalé.
CREATE TABLE IF NOT EXISTS push_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
`;

/** Horaires proposés à la première ouverture : lundi à vendredi, 09:00-12:00 et 13:30-17:30. */
const DEFAULT_HOURS: [number, number][] = [[9 * 60, 12 * 60], [13 * 60 + 30, 17 * 60 + 30]];

/**
 * Schéma de départ : colonnes ajoutées après coup et valeurs initiales, rejouables. Les
 * changements suivants sont des migrations numérotées (server/migrations.ts).
 */
function migrate(db: Sql): void {
  const addColumn = (table: string, column: string, definition: string) => {
    if (!db.columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  // Base créée avant les espaces : ces lignes reçoivent l'espace par défaut avec la colonne.
  const seeded = db.get(`SELECT 1 AS ok FROM booking_settings WHERE key = 'hours_seeded' ${ALL_SPACES}`);
  if (!seeded) {
    db.tx(() => {
      for (let weekday = 1; weekday <= 5; weekday++) {
        for (const [start, end] of DEFAULT_HOURS) db.run(`INSERT INTO booking_hours (weekday, start_min, end_min) VALUES (?, ?, ?) ${ALL_SPACES}`, weekday, start, end);
      }
      db.run(`INSERT INTO booking_settings (key, value) VALUES ('hours_seeded', '1') ${ALL_SPACES}`);
    });
  }
}

export type Db = Sql;

/**
 * Ouvre la base d'Alfred : le fichier alfred.db du dossier, ou une base en mémoire (':memory:').
 *
 * Tests : avec ALFRED_TEST_PG=postgres://… dans l'environnement, une base « en mémoire » est un
 * schéma neuf de ce PostgreSQL, si bien que toute la suite de tests tourne aussi sur PostgreSQL.
 */
export function openDb(dataDir: string): Db {
  let driver: Driver;
  const testPg = process.env.ALFRED_TEST_PG;
  if (dataDir === ':memory:' && testPg) {
    driver = new PostgresDriver(testPg, `t_${randomBytes(6).toString('hex')}`);
  } else {
    let path = ':memory:';
    if (dataDir !== ':memory:') {
      mkdirSync(dataDir, { recursive: true });
      path = join(dataDir, 'alfred.db');
    }
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    driver = new SqliteDriver(raw);
  }
  // La garde d'espace vérifie chaque requête pendant les tests (voir server/sql.ts).
  const guard = Boolean(process.env.VITEST) || process.env.ALFRED_SPACE_GUARD === '1';
  return prepareDb(Sql.open(driver, DEFAULT_SPACE_ID, { guard }));
}

/** Schéma de départ, puis migrations numérotées : la base est prête à servir. */
export function prepareDb(db: Db): Db {
  db.exec(SCHEMA);
  migrate(db);
  // Phase 4 : migrations numérotées (espaces, personnes, liens…), voir server/migrations.ts.
  migrateUp(db);
  ensureSpaceColumns(db);
  return db;
}

/** Exécute fn dans une transaction (imbriquée : point de sauvegarde). */
export function tx<T>(db: Db, fn: () => T): T {
  return db.tx(fn);
}
