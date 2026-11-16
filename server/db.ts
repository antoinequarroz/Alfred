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

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  expires_ms INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  let path = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, 'alfred.db');
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
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
