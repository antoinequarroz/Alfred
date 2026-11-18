// Fiches Personnes, liens vers Cairn et adresses media:// (phase 4, E4.2).
import { describe, expect, it } from 'vitest';
import type { BookingConfirmation, BookingType, LinkInfo, PersonDetail, PersonSummary, ResolvedAddress } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer } from '../server/booking/mail.js';
import { BookingService } from '../server/booking/service.js';
import { openDb } from '../server/db.js';
import { addressOf } from '../server/ids.js';
import { hashPassword } from '../server/password.js';
import { syncEventAttendees } from '../server/attendees.js';
import { attendeesOf } from '../server/ics.js';
import { PeopleService } from '../server/people.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
/** Dimanche 15 novembre 2026, 12:00 à Zurich. */
const NOW = '2026-11-15T11:00:00Z';
const MONDAY_9 = '2026-11-16T08:00:00.000Z';
const MONDAY_10 = '2026-11-16T09:00:00.000Z';
const TUESDAY_9 = '2026-11-17T08:00:00.000Z';
const CAIRN = 'https://cairn.example.ch';

async function setup() {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const service = new CalendarService(store, null, 'Europe/Zurich');
  const clock = { now: new Date(NOW) };
  const mailer: Mailer = { configured: false, from: 'A <a@example.ch>', notifyTo: 'a@example.ch', async send() {} };
  const booking = new BookingService({
    store, calendar: service, caldav: null, timezone: 'Europe/Zurich', mailer,
    publicUrl: 'https://alfred.example.ch', defaultPublicName: 'Antoine', now: () => clock.now, maxPerEmailPerDay: 100, quietCancelMinutes: 0,
  });
  const people = new PeopleService({ db: store.db, store, booking, cairnUrl: CAIRN, now: () => clock.now });
  const app = createApp({
    store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking, people,
    bookingLimits: { bookOk: [1000, 3_600_000] },
  });
  const json = (path: string, method = 'GET', body?: unknown, cookie?: string) =>
    app.request(path, {
      method,
      headers: {
        'sec-fetch-site': 'same-origin',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const login = await json('/api/login', 'POST', { password: PASSWORD });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) => json(path, method, body, cookie);
  expect((await admin('/api/booking/settings', 'PUT', { enabled: true })).status).toBe(200);
  const type = (await (await admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30 })).json()) as BookingType;
  const book = async (start: string, client: Record<string, string>) => {
    const res = await json('/api/public/booking/book', 'POST', { typeSlug: type.slug, start, message: '', phone: '', ...client });
    expect(res.status).toBe(201);
    return (await res.json()) as BookingConfirmation;
  };
  return { app, store, booking, people, clock, json, admin, book };
}

describe('fiches Personnes', () => {
  it('crée une fiche à la première réservation et reconnaît le client qui revient, quelle que soit la casse', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie', email: 'Elodie@Example.org', phone: '+41 79 111 11 11' });
    await ctx.book(TUESDAY_9, { name: 'Élodie Müller', email: ' elodie@example.ORG' });
    await ctx.book(MONDAY_10, { name: 'Marc', email: 'marc@example.org' });
    const list = (await (await ctx.admin('/api/people')).json()) as PersonSummary[];
    expect(list.map((p) => [p.email, p.name, p.bookingCount])).toEqual([
      ['elodie@example.org', 'Élodie Müller', 2], // prochain RDV le plus proche en tête
      ['marc@example.org', 'Marc', 1],
    ]);
    expect(list[0].phone).toBe('+41 79 111 11 11'); // un téléphone vide n'efface pas celui connu
    expect(list[0].nextAt).toBe(MONDAY_9);
    expect(list[0].address).toBe(addressOf('person', list[0].id));

    const res = await ctx.admin(`/api/people/${list[0].id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as PersonDetail;
    expect(detail.upcoming.map((b) => b.start)).toEqual([MONDAY_9, TUESDAY_9]);
    // Chaque réservation garde le nom donné ce jour-là.
    expect(detail.upcoming.map((b) => b.name)).toEqual(['Élodie', 'Élodie Müller']);
    expect(detail.upcoming.every((b) => b.personId === list[0].id)).toBe(true);
    expect(detail.past).toEqual([]);

    // Le temps passe : le premier RDV devient « passé ».
    ctx.clock.now = new Date('2026-11-16T12:00:00Z');
    const later = (await (await ctx.admin(`/api/people/${list[0].id}`)).json()) as PersonDetail;
    expect(later.upcoming.map((b) => b.start)).toEqual([TUESDAY_9]);
    expect(later.past.map((b) => b.start)).toEqual([MONDAY_9]);
    expect(later.lastAt).toBe(MONDAY_9);
  });

  it('cherche par nom, e-mail ou téléphone', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie Müller', email: 'elodie@example.org', phone: '079 111' });
    await ctx.book(MONDAY_10, { name: 'Marc', email: 'marc@example.org' });
    const find = async (q: string) => ((await (await ctx.admin(`/api/people?q=${encodeURIComponent(q)}`)).json()) as PersonSummary[]).map((p) => p.name);
    expect(await find('müll')).toEqual(['Élodie Müller']);
    expect(await find('MARC@')).toEqual(['Marc']);
    expect(await find('079')).toEqual(['Élodie Müller']);
    expect(await find('%')).toEqual([]);
  });

  it('ne montre jamais une fiche ni un lien d’un autre espace', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Moi', email: 'moi@example.org' });
    ctx.store.db.prepare("INSERT INTO people (id, space_id, email, name, phone, created_at, updated_at) VALUES ('autre', 'espace-2', 'x@example.org', 'Autre', '', ?, ?)").run(NOW, NOW);
    ctx.store.db.prepare("INSERT INTO links (id, space_id, from_ref, to_ref, title, created_at) VALUES ('l2', 'espace-2', ?, 'https://x', '', ?)").run(addressOf('person', 'autre'), NOW);
    const list = (await (await ctx.admin('/api/people')).json()) as PersonSummary[];
    expect(list.map((p) => p.name)).toEqual(['Moi']);
    expect((await ctx.admin('/api/people/autre')).status).toBe(404);
    expect((await ctx.admin(`/api/v1/resolve?address=${encodeURIComponent(addressOf('person', 'autre'))}`)).status).toBe(404);
    expect((await ctx.admin('/api/links/l2', 'DELETE')).status).toBe(404);
  });

  it('reste privé sans session', async () => {
    const ctx = await setup();
    for (const [path, method] of [['/api/people', 'GET'], ['/api/people/x', 'GET'], ['/api/links?from=x', 'GET'], ['/api/links', 'POST'], ['/api/links/x', 'DELETE'], ['/api/v1/resolve?address=x', 'GET']]) {
      expect((await ctx.json(path, method, method === 'POST' ? {} : undefined)).status, path).toBe(401);
    }
  });
});

describe('liens vers Cairn et adresses', () => {
  it('relie une fiche à une note Cairn collée depuis le navigateur, et la retire', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie', email: 'elodie@example.org' });
    const [person] = (await (await ctx.admin('/api/people')).json()) as PersonSummary[];
    const res = await ctx.admin('/api/links', 'POST', { from: person.address, target: `${CAIRN}/notes/abc123`, title: 'Bilan initial' });
    expect(res.status).toBe(201);
    const link = (await res.json()) as LinkInfo;
    expect(link).toMatchObject({ from: person.address, to: 'media://cairn/note/abc123', module: 'cairn', title: 'Bilan initial', url: `${CAIRN}/notes/abc123` });
    // Le même lien deux fois : un seul.
    const again = (await (await ctx.admin('/api/links', 'POST', { from: person.address, target: 'media://cairn/note/abc123' })).json()) as LinkInfo;
    expect(again.id).toBe(link.id);
    // Une page web quelconque.
    const web = (await (await ctx.admin('/api/links', 'POST', { from: person.address, target: 'https://exemple.ch/dossier' })).json()) as LinkInfo;
    expect(web).toMatchObject({ module: 'web', to: 'https://exemple.ch/dossier', url: 'https://exemple.ch/dossier' });
    const detail = (await (await ctx.admin(`/api/people/${person.id}`)).json()) as PersonDetail;
    expect(detail.links.map((l) => l.to)).toEqual(['media://cairn/note/abc123', 'https://exemple.ch/dossier']);
    expect((await ctx.admin(`/api/links/${link.id}`, 'DELETE')).status).toBe(200);
    expect(((await (await ctx.admin(`/api/links?from=${encodeURIComponent(person.address)}`)).json()) as LinkInfo[]).map((l) => l.module)).toEqual(['web']);
  });

  it('relie un événement par son UID : le lien survit au changement d’identifiant', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie', email: 'elodie@example.org' });
    const row = ctx.store.db.prepare('SELECT id, event_id, event_uid FROM bookings').get() as { id: string; event_id: string; event_uid: string };
    const bookingId = row.id;
    const res = await ctx.admin('/api/links', 'POST', { eventId: row.event_id, target: `${CAIRN}/notes/n-42` });
    expect(res.status).toBe(201);
    expect(((await res.json()) as LinkInfo).from).toBe(addressOf('event', row.event_uid));
    const list = (await (await ctx.admin(`/api/links?eventId=${encodeURIComponent(row.event_id)}`)).json()) as LinkInfo[];
    expect(list.map((l) => l.to)).toEqual(['media://cairn/note/n-42']);
    const resolved = (await (await ctx.admin(`/api/v1/resolve?address=${encodeURIComponent(addressOf('event', row.event_uid))}`)).json()) as ResolvedAddress;
    expect(resolved).toMatchObject({ type: 'event', title: 'Consultation : Élodie' });
    const b = (await (await ctx.admin(`/api/v1/resolve?address=${encodeURIComponent(addressOf('booking', bookingId))}`)).json()) as ResolvedAddress;
    expect(b.title).toBe('Consultation : Élodie');
    expect(b.url).toMatch(/^\/#personnes\//);
  });

  it('refuse les cibles invalides et les objets d’origine inconnus', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie', email: 'elodie@example.org' });
    const [person] = (await (await ctx.admin('/api/people')).json()) as PersonSummary[];
    for (const target of ['', 'pas un lien', 'javascript:alert(1)', 'ftp://x/y', 'https://moi:secret@exemple.ch', 'media://cairn', person.address]) {
      expect((await ctx.admin('/api/links', 'POST', { from: person.address, target })).status, target).toBe(400);
    }
    expect((await ctx.admin('/api/links', 'POST', { from: addressOf('person', 'inconnu'), target: 'https://exemple.ch' })).status).toBe(404);
    expect((await ctx.admin('/api/links', 'POST', { from: 'media://cairn/note/x', target: 'https://exemple.ch' })).status).toBe(404);
    expect((await ctx.admin('/api/links', 'POST', { eventId: 'inconnu', target: 'https://exemple.ch' })).status).toBe(404);
  });
});

describe('invités des événements', () => {
  const ics = (uid: string, attendees: string[]) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//FR', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z',
    'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', 'SUMMARY:Atelier', 'ORGANIZER:mailto:antoine@example.ch',
    ...attendees, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');

  it('lit les lignes ATTENDEE, une fois par e-mail, sans l’organisateur', () => {
    expect(attendeesOf(ics('u1', [
      'ATTENDEE;CN="Élodie Müller";PARTSTAT=ACCEPTED:mailto:Elodie@Example.org',
      'ATTENDEE;PARTSTAT=declined:MAILTO:elodie@example.org',
      'ATTENDEE;CN=Marc:mailto:marc@example.org',
      'ATTENDEE:urn:uuid:sans-email',
    ]))).toEqual([
      { email: 'elodie@example.org', name: 'Élodie Müller', partstat: 'ACCEPTED' },
      { email: 'marc@example.org', name: 'Marc', partstat: '' },
    ]);
  });

  it('reconnaît un invité comme Personne quand son e-mail est connu, et suit les changements', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie', email: 'elodie@example.org' });
    const cal = ctx.store.listCalendars()[0].id;
    const id = ctx.store.saveEvent({ calendarId: cal, href: null, etag: null, ics: ics('atelier-1', [
      'ATTENDEE;CN=Élodie;PARTSTAT=TENTATIVE:mailto:ELODIE@example.org', 'ATTENDEE:mailto:inconnu@example.org']) });
    const person = ctx.people.list().find((p) => p.email === 'elodie@example.org')!;
    expect(ctx.people.get(person.id).events).toEqual([expect.objectContaining({ eventId: id, title: 'Atelier', partstat: 'TENTATIVE', recurring: false })]);
    // Aucune fiche n'est créée pour l'invité inconnu.
    expect(ctx.people.list().map((p) => p.email)).not.toContain('inconnu@example.org');

    // Retirée des invités, puis événement supprimé : elle n'y figure plus.
    ctx.store.saveEvent({ id, calendarId: cal, href: null, etag: null, ics: ics('atelier-1', []) });
    expect(ctx.people.get(person.id).events).toEqual([]);
    ctx.store.saveEvent({ id, calendarId: cal, href: null, etag: null, ics: ics('atelier-1', ['ATTENDEE:mailto:elodie@example.org']) });
    ctx.store.deleteEvent(id);
    expect(ctx.people.get(person.id).events).toEqual([]);
  });

  it('reprend au démarrage les événements écrits sans leurs invités (image précédente)', async () => {
    const ctx = await setup();
    await ctx.book(MONDAY_9, { name: 'Élodie', email: 'elodie@example.org' });
    const cal = ctx.store.listCalendars()[0].id;
    const id = ctx.store.saveEvent({ calendarId: cal, href: null, etag: null, ics: ics('atelier-2', []) });
    // L'image précédente réécrit l'événement : nouvel iCalendar, nouvelle date, invités non copiés.
    ctx.store.db.run('UPDATE events SET ics = ?, modified_at = ? WHERE id = ? AND space_id = ?',
      ics('atelier-2', ['ATTENDEE:mailto:elodie@example.org']), '2026-11-15T12:00:00.000Z', id, ctx.store.db.spaceId);
    expect(syncEventAttendees(ctx.store.db)).toBe(1);
    expect(syncEventAttendees(ctx.store.db)).toBe(0);
    const person = ctx.people.list()[0];
    expect(ctx.people.get(person.id).events.map((e) => e.eventId)).toEqual([id]);
  });
});
