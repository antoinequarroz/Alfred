// Export et import complets des données (ALFRED-304) : JSON versionné sans secrets, .ics, import dans un Alfred vide.
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import type { BookingConfirmation } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer } from '../server/booking/mail.js';
import { BookingService } from '../server/booking/service.js';
import { openDb } from '../server/db.js';
import { EXPORT_FORMAT, EXPORT_VERSION, EXPORTED_TABLES, NOT_EXPORTED, type AlfredExport } from '../server/export.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
const NOW = '2026-11-15T11:00:00Z';

async function setup() {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const service = new CalendarService(store, null, 'Europe/Zurich');
  const clock = { now: new Date(NOW) };
  const mailer: Mailer = { configured: true, from: 'Alfred <a@example.ch>', notifyTo: 'a@example.ch', async send() {} };
  const booking = new BookingService({
    store, calendar: service, caldav: null, timezone: 'Europe/Zurich', mailer, publicUrl: 'https://alfred.example.ch',
    defaultPublicName: 'Antoine', now: () => clock.now, maxPerEmailPerDay: 100, quietCancelMinutes: 0,
  });
  const app = createApp({ store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking, bookingLimits: { bookOk: [1000, 3_600_000] } });
  const json = (path: string, method = 'GET', body?: unknown, cookie?: string) =>
    app.request(path, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
  const login = await json('/api/login', 'POST', { password: PASSWORD });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) => json(path, method, body, cookie);
  return { store, booking, clock, json, admin, calendar: store.listCalendars()[0] };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Un Alfred bien rempli : réglages, types, horaires, réservations (une annulée), événements, personnes, liens, visio, acompte, journal. */
async function fill(ctx: Ctx) {
  expect((await ctx.admin('/api/booking/settings', 'PUT', { enabled: true, publicName: 'Antoine Q.', reminderHours: [24] })).status).toBe(200);
  expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, location: 'Rue du Lac 1, Sion' })).status).toBe(201);
  expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Appel', durationMin: 15, mode: 'telephone' })).status).toBe(201);
  expect((await ctx.admin('/api/booking/hours', 'PUT', [
    { weekday: 1, startMin: 540, endMin: 720 }, { weekday: 3, startMin: 600, endMin: 960 },
  ])).status).toBe(200);
  const book = async (start: string, email: string) => {
    const res = await ctx.json('/api/public/booking/book', 'POST', { typeSlug: 'consultation', start, name: 'Élodie Müller', email, phone: '+41 79 123 45 67', message: 'Bonjour' });
    expect(res.status).toBe(201);
    return (await res.json()) as BookingConfirmation;
  };
  await book('2026-11-16T08:00:00.000Z', 'elodie@example.org');
  const second = await book('2026-11-16T09:00:00.000Z', 'marc@example.org');
  expect((await ctx.json(`/api/public/booking/cancel/${second.cancelUrl.split('/').pop()}`, 'POST')).status).toBe(200);
  expect((await ctx.admin('/api/events', 'POST', {
    calendarId: ctx.calendar.id, title: 'Cours de yoga', start: '2026-11-18T18:00:00+01:00', end: '2026-11-18T19:00:00+01:00', allDay: false, repeat: 'weekly', location: 'Sion',
  })).status).toBe(201);
  expect((await ctx.admin('/api/events', 'POST', { calendarId: ctx.calendar.id, title: 'Vacances', start: '2026-12-24', end: '2026-12-27', allDay: true })).status).toBe(201);
  const people = (await (await ctx.admin('/api/people')).json()) as { id: string }[];
  expect((await ctx.admin('/api/links', 'POST', { from: `media://alfred/person/${people[0].id}`, target: 'https://cairn.example.ch/notes/abc', title: 'Note' })).status).toBe(201);
  const db = ctx.store.db;
  db.prepare(`INSERT INTO video_rooms (id, slug, title, kind, starts_at, ends_at, created_at) VALUES ('r1', 'abc-def-ghi', 'Réunion', 'event', '2026-11-20T10:00:00.000Z', '2026-11-20T11:00:00.000Z', '2026-11-15T11:00:00.000Z')`).run();
  db.prepare(`INSERT INTO video_settings (key, value) VALUES ('quality', '"eco"')`).run();
  db.prepare(`INSERT INTO payment_holds (id, ref_hash, status, type_name, mode, start_utc, end_utc, name, email, token_hash, cancel_token, amount_cents, currency, created_at, expires_at)
    VALUES ('h1', 'ref', 'expired', 'Consultation', 'cabinet', '2026-11-17T08:00:00.000Z', '2026-11-17T08:30:00.000Z', 'Paul', 'paul@example.org', 'th', 'JETON-EN-CLAIR', 5000, 'chf', '2026-11-15T11:00:00.000Z', '2026-11-15T11:30:00.000Z')`).run();
  // Secrets et données propres à cette installation : jamais exportés.
  const now = '2026-11-15T11:00:00.000Z';
  db.prepare(`INSERT INTO connection_settings (key, value, secret, updated_at) VALUES ('smtp.host', 'mail.example.ch', 0, ?), ('smtp.password', 'chiffré:MOT-DE-PASSE', 1, ?)`).run(now, now);
  db.prepare(`INSERT INTO push_settings (key, value) VALUES ('vapid', '{"privateKey":"CLE-PRIVEE"}'), ('since', '"2026-11-01T00:00:00.000Z"'), ('prefs', '{"cancellation":true}')`).run();
  db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES ('p1', 'https://push.example/1', 'P256', 'AUTH-SECRET', 'iPhone', ?)`).run(now);
}

/** Export sans sa date : deux exports des mêmes données doivent être identiques. */
async function exportOf(ctx: Ctx): Promise<Omit<AlfredExport, 'exportedAt'>> {
  const res = await ctx.admin('/api/export');
  expect(res.status).toBe(200);
  const { exportedAt, ...rest } = (await res.json()) as AlfredExport;
  expect(exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return rest;
}

describe('export et import des données (ALFRED-304)', () => {
  it('exporte toutes les données, sans les secrets, dans un fichier versionné', async () => {
    const ctx = await setup();
    await fill(ctx);
    const res = await ctx.admin('/api/export');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="alfred-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    const data = JSON.parse(text) as AlfredExport;
    expect(data.format).toBe(EXPORT_FORMAT);
    expect(data.version).toBe(EXPORT_VERSION);
    expect(data.space.name).toBe('Personnel');
    expect(data.tables.bookings).toHaveLength(2);
    expect(data.tables.events).toHaveLength(3); // le rendez-vous confirmé, le cours, les vacances
    expect(data.tables.booking_types.map((t) => t.name)).toEqual(['Consultation', 'Appel']);
    expect(data.tables.booking_hours).toEqual([
      { weekday: 1, start_min: 540, end_min: 720, tzid: 'Europe/Zurich' },
      { weekday: 3, start_min: 600, end_min: 960, tzid: 'Europe/Zurich' },
    ]);
    expect(data.tables.people.map((p) => p.email)).toEqual(expect.arrayContaining(['elodie@example.org', 'marc@example.org']));
    expect(data.tables.outbox.length).toBeGreaterThanOrEqual(3);
    expect(data.tables.connection_settings.map((r) => r.key)).toEqual(['smtp.host']);
    expect(data.tables.push_settings.map((r) => r.key)).toEqual(['prefs']);
    expect(data.tables.payment_holds[0].cancel_token).toBeNull();
    for (const secret of ['MOT-DE-PASSE', 'CLE-PRIVEE', 'AUTH-SECRET', 'JETON-EN-CLAIR', 'push.example']) expect(text).not.toContain(secret);
    expect(data.tables).not.toHaveProperty('sessions');
    expect(data.tables).not.toHaveProperty('push_subscriptions');
    // Aucune colonne d'espace ni ancienne colonne en millisecondes.
    expect(Object.keys(data.tables.events[0])).not.toContain('space_id');
    expect(Object.keys(data.tables.events[0])).not.toContain('start_ms');
  });

  it('importe dans un Alfred vide et redonne exactement les mêmes données', async () => {
    const source = await setup();
    await fill(source);
    const before = await exportOf(source);
    const file = await (await source.admin('/api/export')).text();

    const target = await setup();
    const res = await target.admin('/api/import', 'POST', file);
    expect(res.status).toBe(200);
    const { counts } = (await res.json()) as { counts: Record<string, number> };
    expect(counts.bookings).toBe(2);
    expect(await exportOf(target)).toEqual(before);

    // Et ça marche : la réservation garde son lien d'annulation, l'agenda ses événements, la page publique ses créneaux.
    const bookings = target.booking.listBookings('upcoming');
    expect(bookings.map((b) => b.start)).toEqual(['2026-11-16T08:00:00.000Z']);
    const events = (await (await target.admin('/api/events?start=2026-11-16T00:00:00Z&end=2026-11-30T00:00:00Z')).json()) as { title: string }[];
    expect(events.filter((e) => e.title === 'Cours de yoga')).toHaveLength(2);
    const slots = await target.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-16');
    expect(((await slots.json()) as { days: { slots: string[] }[] }).days[0].slots).not.toContain('2026-11-16T08:00:00.000Z');
    // Les faits importés ne repartent pas en notifications : le lecteur du journal est placé après eux.
    const maxSeq = (target.store.db.prepare('SELECT MAX(seq) AS s FROM outbox').get() as { s: number }).s;
    expect(target.store.db.prepare("SELECT seq FROM outbox_readers WHERE reader = 'push'").get()).toEqual({ seq: maxSeq });
    // Les secrets de la cible restent les siens.
    expect(target.store.db.prepare("SELECT COUNT(*) AS n FROM connection_settings WHERE secret = 1").get()).toEqual({ n: 0 });
  });

  it('refuse un Alfred qui contient déjà des données, sans rien changer', async () => {
    const source = await setup();
    await fill(source);
    const file = await (await source.admin('/api/export')).text();
    const target = await setup();
    expect((await target.admin('/api/events', 'POST', { calendarId: target.calendar.id, title: 'Déjà là', start: '2026-11-20T10:00:00Z', end: '2026-11-20T11:00:00Z', allDay: false })).status).toBe(201);
    const before = await exportOf(target);
    const res = await target.admin('/api/import', 'POST', file);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('not_empty');
    expect(await exportOf(target)).toEqual(before);
  });

  it('refuse un fichier qui n’est pas un export, d’un format inconnu ou d’une version plus récente', async () => {
    const ctx = await setup();
    const good = (await (await ctx.admin('/api/export')).json()) as AlfredExport;
    const cases: unknown[] = [
      'pas du json',
      { format: 'autre' },
      { ...good, version: 2 },
      { ...good, schemaVersion: good.schemaVersion + 1 },
      { ...good, tables: { sessions: [] } },
      { ...good, tables: { bookings: [{ id: 'b1', mot_de_passe: 'x' }] } },
      { ...good, tables: { bookings: [{ id: { objet: true } }] } },
    ];
    for (const body of cases) {
      const res = await ctx.admin('/api/import', 'POST', typeof body === 'string' ? body : JSON.stringify(body));
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    // Un import qui échoue en route (contrainte de la base) ne laisse rien à moitié fait.
    const broken = { ...good, tables: { booking_types: [{ id: 't1', slug: 'x', name: 'X', duration_min: 30 }, { id: 't2', slug: 'x', name: 'Y', duration_min: 30 }] } };
    expect((await ctx.admin('/api/import', 'POST', broken)).status).toBe(400);
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM booking_types').get()).toEqual({ n: 0 });
  });

  it('garde l’export et l’import derrière la connexion', async () => {
    const ctx = await setup();
    for (const [path, method] of [['/api/export', 'GET'], ['/api/export/calendar.ics', 'GET'], ['/api/import', 'POST']] as const) {
      expect((await ctx.json(path, method, method === 'POST' ? {} : undefined)).status).toBe(401);
    }
  });

  it('exporte le calendrier en un fichier .ics lisible par les autres apps', async () => {
    const ctx = await setup();
    await fill(ctx);
    const res = await ctx.admin('/api/export/calendar.ics');
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const text = await res.text();
    const vcal = new ICAL.Component(ICAL.parse(text) as unknown[]);
    const titles = vcal.getAllSubcomponents('vevent').map((e) => String(e.getFirstPropertyValue('summary')));
    expect(titles).toEqual(expect.arrayContaining(['Cours de yoga', 'Vacances']));
    expect(titles).toHaveLength(3);
    // Un seul VTIMEZONE par fuseau, avant les événements.
    expect(vcal.getAllSubcomponents('vtimezone').map((t) => t.getFirstPropertyValue('tzid'))).toEqual(['Europe/Zurich']);
    expect(text.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(text.indexOf('BEGIN:VEVENT'));
    expect((await ctx.admin('/api/export/calendar.ics?calendar=inconnu')).status).toBe(404);
  });

  it('répertorie chaque table de la base : exportée, ou laissée de côté pour une raison écrite', async () => {
    const ctx = await setup();
    for (const table of ctx.store.db.tables()) {
      expect(table in EXPORTED_TABLES || table in NOT_EXPORTED, table).toBe(true);
    }
  });
});
