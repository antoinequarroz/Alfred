// Phase 4 : identifiants, adresses, migrations numérotées, espaces et annuaire des personnes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../server/db.js';
import { addressOf, isUuidv7, parseAddress, uuidv7 } from '../server/ids.js';
import { DEFAULT_SPACE_ID, MIGRATIONS, migrateDown, migrateUp, normalizeEmail, schemaVersion } from '../server/migrations.js';

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

function columns(db: Db, table: string): string[] {
  return db.columns(table);
}

function userTables(db: Db): string[] {
  return db.tables().filter((t) => t !== 'sqlite_sequence');
}

/** Réservation insérée comme le faisait le code d'avant la phase 4 (sans person_id ni space_id). */
function oldBooking(db: Db, id: string, email: string, name: string, createdAt: string, phone = '') {
  db.prepare(
    `INSERT INTO bookings (id, type_id, type_name, location, start_utc, end_utc, name, email, phone, message, status, token_hash, created_at)
     VALUES (?, NULL, 'Consultation', '', ?, ?, ?, ?, ?, '', 'confirmed', ?, ?)`,
  ).run(id, '2026-12-01T09:00:00.000Z', '2026-12-01T10:00:00.000Z', name, email, phone, `hash-${id}`, createdAt);
}

describe('identifiants UUID v7 et adresses media://', () => {
  it('produit des UUID v7 valides, triés dans l’ordre de création, même dans la même milliseconde', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7(1_763_000_000_000));
    for (const id of ids) expect(isUuidv7(id)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(uuidv7(1_763_000_000_001) > ids[ids.length - 1]).toBe(true);
    // L'horodatage se relit dans les 48 premiers bits.
    const id = uuidv7(Date.UTC(2026, 10, 17, 10, 0, 0) + 5000);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 17, 10, 0, 5));
  });

  it('donne une adresse stable et la relit, identifiants CalDAV compris', () => {
    const id = uuidv7();
    expect(addressOf('booking', id)).toBe(`media://alfred/booking/${id}`);
    expect(parseAddress(`media://alfred/booking/${id}`)).toEqual({ module: 'alfred', type: 'booking', id });
    const uid = 'ABC-123@icloud.com/x y';
    const addr = addressOf('event', uid);
    expect(addr).toBe('media://alfred/event/ABC-123%40icloud.com%2Fx%20y');
    expect(parseAddress(addr)).toEqual({ module: 'alfred', type: 'event', id: uid });
    expect(parseAddress(addressOf('note', 'n1', 'cairn'))).toEqual({ module: 'cairn', type: 'note', id: 'n1' });
  });

  it('refuse les adresses mal formées', () => {
    for (const bad of ['', 'https://x', 'media://alfred/booking', 'media://alfred/booking/a/b', 'media://Alfred/booking/a', 'media://alfred/booking/%E0', 'media://alfred/booking/a%00']) {
      expect(parseAddress(bad), bad).toBeNull();
    }
    expect(() => addressOf('Booking', 'x')).toThrow();
    expect(() => addressOf('booking', '')).toThrow();
  });
});

describe('migrations numérotées', () => {
  it('amène une base neuve à la dernière version, et se rejoue sans effet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    openDb(dir).close();
    const db = openDb(dir);
    expect(schemaVersion(db)).toBe(LATEST);
    expect(migrateUp(db)).toEqual([]);
    const versions = (db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as unknown as { version: number; name: string }[]);
    expect(versions.map((v) => v.name)).toEqual(['espaces', 'personnes', 'liens', 'acomptes', 'journal', 'instants', 'reglages']);
    db.close();
  });

  it('met space_id sur toutes les tables, y compris une table créée plus tard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    const db = openDb(dir);
    for (const table of userTables(db)) {
      if (['schema_migrations', 'spaces'].includes(table)) continue;
      expect(columns(db, table), table).toContain('space_id');
    }
    expect(db.prepare('SELECT id, name FROM spaces').all()).toEqual([{ id: DEFAULT_SPACE_ID, name: 'Personnel' }]);
    // Une autre branche du code crée sa table : elle reçoit sa colonne au démarrage suivant.
    db.exec("CREATE TABLE futurs_reglages (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO futurs_reglages VALUES ('vapid', 'x')");
    db.close();
    const again = openDb(dir);
    expect(again.prepare('SELECT space_id FROM futurs_reglages').get()).toEqual({ space_id: DEFAULT_SPACE_ID });
    again.close();
  });

  it('rattache les réservations existantes à une fiche par e-mail normalisé, sans perte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    // Base « d'avant la phase 4 » : schéma de départ seulement.
    const before = openDb(dir);
    migrateDown(before, 0);
    expect(columns(before, 'bookings')).not.toContain('person_id');
    expect(columns(before, 'bookings')).not.toContain('space_id');
    oldBooking(before, 'b1', 'Elodie@Example.org ', 'Élodie', '2026-11-01T10:00:00.000Z', '+41 79 000 00 00');
    oldBooking(before, 'b2', 'elodie@example.org', 'Élodie Müller', '2026-11-05T10:00:00.000Z');
    oldBooking(before, 'b3', 'marc@example.org', 'Marc', '2026-11-03T10:00:00.000Z');
    const snapshot = before.prepare('SELECT id, name, email, phone, start_utc, status FROM bookings ORDER BY id').all();
    before.close();

    const db = openDb(dir);
    expect(schemaVersion(db)).toBe(LATEST);
    const people = db.prepare('SELECT id, email, name, phone, created_at FROM people ORDER BY email').all() as unknown as
      { id: string; email: string; name: string; phone: string; created_at: string }[];
    expect(people.map((p) => [p.email, p.name, p.phone])).toEqual([
      ['elodie@example.org', 'Élodie Müller', '+41 79 000 00 00'], // nom de la dernière réservation, téléphone gardé
      ['marc@example.org', 'Marc', ''],
    ]);
    expect(people[0].created_at).toBe('2026-11-01T10:00:00.000Z');
    for (const p of people) expect(isUuidv7(p.id)).toBe(true);
    const links = db.prepare('SELECT id, person_id FROM bookings ORDER BY id').all() as unknown as { id: string; person_id: string }[];
    expect(links.map((l) => l.person_id)).toEqual([people[0].id, people[0].id, people[1].id]);
    // Les copies figées des réservations n'ont pas bougé.
    expect(db.prepare('SELECT id, name, email, phone, start_utc, status FROM bookings ORDER BY id').all()).toEqual(snapshot);
    db.close();
  });

  it('se défait entièrement (retour au schéma de départ) puis se réapplique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    const db = openDb(dir);
    oldBooking(db, 'b1', 'a@example.org', 'A', '2026-11-01T10:00:00.000Z');
    expect(migrateDown(db, 0)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(schemaVersion(db)).toBe(0);
    for (const t of ['people', 'links', 'spaces', 'payment_holds']) expect(userTables(db)).not.toContain(t);
    for (const table of userTables(db)) expect(columns(db, table), table).not.toContain('space_id');
    expect(columns(db, 'bookings')).not.toContain('person_id');
    expect(columns(db, 'bookings')).not.toContain('payment_status');
    expect(columns(db, 'booking_types')).not.toContain('deposit_cents');
    expect(db.prepare('SELECT id, email FROM bookings').all()).toEqual([{ id: 'b1', email: 'a@example.org' }]);
    expect(migrateUp(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(columns(db, 'payment_holds')).toContain('space_id');
    expect((db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('une migration en échec ne laisse rien à moitié fait', () => {
    const db = openDb(':memory:');
    const broken = [{ version: 99, name: 'cassée', up: (d: Db) => { d.exec('CREATE TABLE moitie (x TEXT)'); throw new Error('boum'); }, down: () => undefined }];
    expect(() => migrateUp(db, Infinity, broken)).toThrow('boum');
    expect(userTables(db)).not.toContain('moitie');
    expect(schemaVersion(db)).toBe(LATEST);
  });

  it('le code d’avant la phase 4 écrit toujours dans une base migrée (retour à l’image précédente sans restaurer)', () => {
    const db = openDb(':memory:');
    oldBooking(db, 'old', 'x@example.org', 'X', '2026-11-01T10:00:00.000Z');
    expect(db.prepare('SELECT space_id, person_id FROM bookings').get()).toEqual({ space_id: DEFAULT_SPACE_ID, person_id: null });
  });

  it('normalise les e-mails : espaces et casse', () => {
    expect(normalizeEmail('  Élodie@Example.ORG ')).toBe('élodie@example.org');
  });
});

describe('instants : un seul format en base (migration 6, ALFRED-296)', () => {
  const ics = (dtstart: string, rrule = '') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x', 'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z',
    dtstart, 'DURATION:PT1H', ...(rrule ? [rrule] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

  it('recopie les millisecondes en ISO, note le fuseau et met les textes au format exact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    const before = openDb(dir);
    migrateDown(before, 5);
    before.prepare("INSERT INTO calendars (id, source, name, color) VALUES ('c1', 'local', 'Perso', '#000')").run();
    const start = Date.UTC(2026, 10, 16, 8, 0, 0);
    before.prepare(`INSERT INTO events (id, calendar_id, uid, ics, summary, start_ms, end_ms, recurring, recur_end_ms, updated_at)
      VALUES ('e1', 'c1', 'u1', ?, 'Cours', ?, ?, 1, NULL, ?)`).run(ics('DTSTART;TZID=Europe/Zurich:20261116T090000', 'RRULE:FREQ=WEEKLY'), start, start + 3_600_000, start - 5000);
    before.prepare(`INSERT INTO events (id, calendar_id, uid, ics, summary, start_ms, end_ms, recurring, updated_at)
      VALUES ('e2', 'c1', 'u2', 'illisible', '', ?, ?, 0, ?)`).run(start, start + 1, start);
    before.prepare('INSERT INTO sessions (id, expires_ms) VALUES (?, ?)').run('s1', start);
    oldBooking(before, 'b1', 'a@example.org', 'A', '2026-11-01T10:00:00Z');
    before.prepare("UPDATE bookings SET cancelled_at = '2026-11-02T11:00:00+01:00' WHERE id = 'b1'").run();
    before.close();

    const db = openDb(dir);
    expect(db.prepare("SELECT start_at, end_at, recur_end_at, modified_at, tzid FROM events WHERE id = 'e1'").get()).toEqual({
      start_at: '2026-11-16T08:00:00.000Z', end_at: '2026-11-16T09:00:00.000Z', recur_end_at: null, modified_at: '2026-11-16T07:59:55.000Z', tzid: 'Europe/Zurich',
    });
    expect(db.prepare("SELECT tzid FROM events WHERE id = 'e2'").get()).toEqual({ tzid: null });
    expect(db.prepare('SELECT expires_at FROM sessions').get()).toEqual({ expires_at: '2026-11-16T08:00:00.000Z' });
    expect(db.prepare('SELECT created_at, cancelled_at FROM bookings').get()).toEqual({ created_at: '2026-11-01T10:00:00.000Z', cancelled_at: '2026-11-02T10:00:00.000Z' });
    expect(new Set((db.prepare('SELECT tzid FROM booking_hours').all() as { tzid: string }[]).map((r) => r.tzid))).toEqual(new Set(['Europe/Zurich']));
    db.close();
  });

  it('rattrape au démarrage ce qu’a écrit l’image précédente après un retour arrière', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    const db = openDb(dir);
    db.prepare("INSERT INTO calendars (id, source, name, color) VALUES ('c1', 'local', 'Perso', '#000')").run();
    const start = Date.UTC(2026, 11, 1, 9, 0, 0);
    // Ce que fait l'image précédente : elle ne connaît que les colonnes en millisecondes.
    db.prepare(`INSERT INTO events (id, calendar_id, uid, ics, summary, start_ms, end_ms, recurring, updated_at)
      VALUES ('e1', 'c1', 'u1', ?, 'Nouveau', ?, ?, 0, ?)`).run(ics('DTSTART:20261201T090000Z'), start, start + 3_600_000, start);
    db.prepare('INSERT INTO sessions (id, expires_ms) VALUES (?, ?)').run('s1', start);
    db.close();
    const again = openDb(dir);
    expect(again.prepare("SELECT start_at, end_at FROM events WHERE id = 'e1'").get()).toEqual({ start_at: '2026-12-01T09:00:00.000Z', end_at: '2026-12-01T10:00:00.000Z' });
    // Puis elle déplace l'événement : la colonne ISO suit au démarrage suivant.
    again.prepare("UPDATE events SET start_ms = ?, end_ms = ? WHERE id = 'e1'").run(start + 86_400_000, start + 90_000_000);
    again.close();
    const third = openDb(dir);
    expect(third.prepare("SELECT start_at FROM events WHERE id = 'e1'").get()).toEqual({ start_at: '2026-12-02T09:00:00.000Z' });
    expect(third.prepare('SELECT expires_at FROM sessions').get()).toEqual({ expires_at: '2026-12-01T09:00:00.000Z' });
    third.close();
  });
});

describe('réglages : une seule table (migration 7, ALFRED-298)', () => {
  it('reprend les quatre anciennes tables sans perte, secrets compris', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    const before = openDb(dir);
    migrateDown(before, 6);
    before.prepare("INSERT INTO booking_settings (key, value) VALUES ('public_name', 'Antoine Q.')").run();
    before.prepare(`INSERT INTO video_settings (key, value) VALUES ('quality', '"eco"')`).run();
    before.prepare("INSERT INTO connection_settings (key, value, secret, updated_at) VALUES ('smtp.host', 'mail.example.ch', 0, '2026-11-01T10:00:00.000Z'), ('smtp.password', 'v1:scellé', 1, '')").run();
    before.prepare(`INSERT INTO push_settings (key, value) VALUES ('prefs', '{"cancellation":true}')`).run();
    before.close();

    const db = openDb(dir);
    const rows = db.prepare("SELECT module, key, value, secret FROM settings WHERE key <> 'hours_seeded' ORDER BY module, key").all();
    expect(rows).toEqual([
      { module: 'booking', key: 'public_name', value: 'Antoine Q.', secret: 0 },
      { module: 'connections', key: 'smtp.host', value: 'mail.example.ch', secret: 0 },
      { module: 'connections', key: 'smtp.password', value: 'v1:scellé', secret: 1 },
      { module: 'push', key: 'prefs', value: '{"cancellation":true}', secret: 0 },
      { module: 'video', key: 'quality', value: '"eco"', secret: 0 },
    ]);
    expect(db.prepare("SELECT updated_at FROM settings WHERE key = 'smtp.host'").get()).toEqual({ updated_at: '2026-11-01T10:00:00.000Z' });
    expect(db.prepare("SELECT updated_at FROM settings WHERE key = 'smtp.password'").get()).toEqual({ updated_at: expect.stringMatching(/Z$/) });
    db.close();
  });

  it('reprend au démarrage ce que l’image précédente a changé ou retiré', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mig-'));
    const db = openDb(dir);
    db.prepare("INSERT INTO booking_settings (key, value) VALUES ('public_name', 'Avant')").run();
    db.prepare(`INSERT INTO video_settings (key, value) VALUES ('quality', '"eco"')`).run();
    db.close();
    const again = openDb(dir);
    expect(again.prepare("SELECT value FROM settings WHERE module = 'booking' AND key = 'public_name'").get()).toEqual({ value: 'Avant' });
    // L'image précédente change un réglage et en retire un autre.
    again.prepare("UPDATE booking_settings SET value = 'Après' WHERE key = 'public_name'").run();
    again.prepare("DELETE FROM video_settings WHERE key = 'quality'").run();
    again.close();
    const third = openDb(dir);
    expect(third.prepare("SELECT value FROM settings WHERE module = 'booking' AND key = 'public_name'").get()).toEqual({ value: 'Après' });
    expect(third.prepare("SELECT COUNT(*) AS n FROM settings WHERE module = 'video'").get()).toEqual({ n: 0 });
    third.close();
  });
});
