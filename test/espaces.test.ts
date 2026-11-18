// Espaces (ALFRED-295) et journal d'événements (ALFRED-302) : une donnée d'un autre espace n'est
// jamais visible, toutes les requêtes passent par le filtre d'espace, et les faits sont écrits
// dans la même transaction que le changement qu'ils décrivent.
import { createECDH, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookingStore, type BookingRow } from '../server/booking/store.js';
import { BookingService } from '../server/booking/service.js';
import { openDb, type Db } from '../server/db.js';
import { addressOf } from '../server/ids.js';
import { DEFAULT_SPACE_ID } from '../server/migrations.js';
import { FACT_TYPES, factsAfter, onFacts, OutboxReader, recordFact } from '../server/outbox.js';
import { PeopleService } from '../server/people.js';
import { PushService } from '../server/push/service.js';
import { CalendarService } from '../server/service.js';
import { ALL_SPACES } from '../server/sql.js';
import { Store } from '../server/store.js';
import { VideoService, type VideoBackend } from '../server/video/service.js';

const OTHER_SPACE = '01930000-0000-7000-8000-0000000000ff';
const NOW = new Date('2026-11-15T11:00:00Z');

const ics = (uid: string, title: string, start: string, end: string) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Alfred//test//FR', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z',
    `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${title}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

function bookingRow(id: string, name: string, email: string, start: string): BookingRow {
  return {
    id, type_id: null, type_name: 'Consultation', location: '', buffer_before_min: 0, buffer_after_min: 0,
    event_id: null, event_uid: null, calendar_id: null, start_utc: start, end_utc: new Date(Date.parse(start) + 3_600_000).toISOString(),
    name, email, phone: '', message: '', status: 'confirmed', token_hash: randomBytes(8).toString('hex'),
    created_at: NOW.toISOString(), cancelled_at: null, cancelled_by: null, mail_error: null, notified_start: null,
  };
}

const backend: VideoBackend = {
  health: async () => true, createRoom: async () => undefined, listRooms: async () => [], listParticipants: async () => [], deleteRoom: async () => undefined,
};

/** Tout Alfred, vu depuis un espace de la base. */
function stack(db: Db, who: string) {
  const store = new Store(db);
  store.ensureLocalCalendar();
  const calendar = new CalendarService(store, null, 'Europe/Zurich');
  const booking = new BookingService({ store, calendar, caldav: null, timezone: 'Europe/Zurich', now: () => NOW, maxPerEmailPerDay: 100 });
  const people = new PeopleService({ db, store, booking, cairnUrl: 'https://cairn.example.ch', now: () => NOW });
  const video = new VideoService({
    db, publicUrl: 'https://alfred.example.ch', timezone: 'Europe/Zurich', backend, now: () => NOW,
    server: { apiKey: 'k', apiSecret: 'x'.repeat(40), internalUrl: 'http://livekit:7880', publicUrl: 'wss://alfred.example.ch' },
    hostName: () => 'Antoine',
  });
  const push = new PushService({ db, store, publicUrl: 'https://alfred.example.ch', timezone: 'Europe/Zurich', now: () => NOW, fetch: async () => new Response(null, { status: 201 }) });

  // Un peu de tout : événement, type et réservation (donc une fiche), lien, salle de visio, appareil.
  const cal = store.listCalendars()[0];
  const eventId = store.saveEvent({ calendarId: cal.id, href: null, etag: null, ics: ics(`uid-${who}`, `Réunion ${who}`, '20261116T090000Z', '20261116T100000Z') });
  const type = booking.createType({ name: `Type ${who}`, durationMin: 60 });
  booking.data.insertBooking(bookingRow(`rdv-${who}`, `Client ${who}`, `${who}@example.org`, '2026-11-17T09:00:00.000Z'));
  const person = people.list()[0];
  const link = people.addLink(addressOf('person', person.id), `https://example.org/${who}`, `Lien ${who}`);
  video.updateSettings({ enabled: true });
  const room = video.createRoom({ title: `Salle ${who}` });
  push.subscribe({
    endpoint: `https://fcm.googleapis.com/fcm/send/${who}`,
    // Clés d'appareil générées pour le test (aucune valeur figée dans le code).
    keys: { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    label: `Appareil ${who}`,
  });
  return { db, store, booking, people, video, push, ids: { calendar: cal.id, eventId, type: type.id, booking: `rdv-${who}`, person: person.id, link: link.id, room: room.id } };
}

describe('espaces : une donnée d’un autre espace n’est jamais visible', () => {
  it('chaque espace ne voit que ses calendriers, réservations, fiches, liens, salles et appareils', async () => {
    const db = openDb(':memory:');
    const mine = stack(db, 'moi');
    const other = stack(db.inSpace(OTHER_SPACE), 'autre');

    for (const [me, them, who, theirs] of [[mine, other, 'moi', 'autre'], [other, mine, 'autre', 'moi']] as const) {
      // Calendrier et agenda
      expect(me.store.listCalendars().map((c) => c.id)).toEqual([me.ids.calendar]);
      expect(me.store.getCalendar(them.ids.calendar)).toBeUndefined();
      expect(me.store.getEvent(them.ids.eventId)).toBeUndefined();
      const titles = me.store.occurrences(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z')).map((o) => o.title);
      expect(titles).toEqual([`Réunion ${who}`]);
      expect(me.store.busyOccurrences(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))).toHaveLength(1);
      expect(me.store.findEvent(them.ids.eventId, `uid-${theirs}`)).toBeUndefined();

      // Prise de rendez-vous
      expect(me.booking.data.listTypes().map((t) => t.name)).toEqual([`Type ${who}`]);
      expect(me.booking.data.getType(them.ids.type)).toBeUndefined();
      expect(me.booking.data.getBooking(them.ids.booking)).toBeUndefined();
      expect(me.booking.data.listUpcoming(NOW.toISOString(), 50).map((b) => b.id)).toEqual([me.ids.booking]);
      expect(me.booking.data.countCreatedForEmailSince(`${theirs}@example.org`, '2000-01-01T00:00:00Z')).toBe(0);

      // Personnes, liens, adresses
      expect(me.people.list().map((p) => p.email)).toEqual([`${who}@example.org`]);
      expect(() => me.people.get(them.ids.person)).toThrow('introuvable');
      expect(me.people.resolve(addressOf('booking', them.ids.booking))).toBeNull();
      expect(me.people.resolve(addressOf('person', them.ids.person))).toBeNull();
      expect(me.people.resolve(addressOf('event', `uid-${theirs}`))).toBeNull();
      expect(() => me.people.removeLink(them.ids.link)).toThrow('introuvable');

      // Visio et notifications
      const state = await me.video.adminState();
      expect(state.rooms.map((r) => r.title)).toEqual([`Salle ${who}`]);
      expect(() => me.video.deleteRoom(them.ids.room)).toThrow();
      expect(me.push.state().devices.map((d) => d.label)).toEqual([`Appareil ${who}`]);
      expect(() => me.push.remove(them.push.state().devices[0].id)).toThrow('introuvable');

      // Journal : chaque espace a ses faits
      expect(factsAfter(me.db, 0).map((f) => f.data.bookingId)).toEqual([me.ids.booking]);
    }
    // Rien n'a été effacé chez l'autre par les tentatives ci-dessus.
    expect(other.people.listLinks(addressOf('person', other.ids.person))).toHaveLength(1);
    expect(mine.push.state().devices).toHaveLength(1);
  });

  it('un réglage écrit depuis un autre espace ne touche jamais celui de cet espace', () => {
    const db = openDb(':memory:');
    const mine = new BookingStore(db);
    const other = new BookingStore(db.inSpace(OTHER_SPACE));
    const settings = mine.getSettings({ publicName: 'Antoine' });
    mine.saveSettings({ ...settings, publicName: 'Antoine Quarroz', enabled: true });
    other.saveSettings({ ...settings, publicName: 'Quelqu’un d’autre', enabled: false });
    expect(mine.getSettings({ publicName: '' })).toMatchObject({ publicName: 'Antoine Quarroz', enabled: true });
    // Les tables de réglages gardent pour l'instant une clé unique dans toute la base (docs/DONNEES.md) :
    // l'autre espace ne peut pas encore y écrire les siens, mais ne lit et n'écrase jamais ceux d'Antoine.
    expect(other.getSettings({ publicName: 'défaut' }).publicName).toBe('défaut');
  });

  it('la garde refuse une requête sans filtre d’espace', () => {
    const db = openDb(':memory:');
    expect(() => db.all('SELECT * FROM bookings')).toThrow('filtre d');
    expect(() => db.all('SELECT b.* FROM bookings b JOIN people p ON p.id = b.person_id WHERE b.space_id = ?', DEFAULT_SPACE_ID)).toThrow('filtre d');
    expect(() => db.run("UPDATE events SET summary = 'x'")).toThrow('filtre d');
    expect(() => db.run('INSERT INTO links (id, from_ref, to_ref, created_at) VALUES (?, ?, ?, ?)', 'l', 'a', 'b', 'c')).toThrow('filtre d');
    expect(db.all('SELECT * FROM bookings WHERE space_id = ?', DEFAULT_SPACE_ID)).toEqual([]);
    expect(db.all(`SELECT * FROM sessions ${ALL_SPACES}`)).toEqual([]);
    expect(db.all('SELECT version FROM schema_migrations')).not.toHaveLength(0);
  });

  it('le code métier n’utilise jamais l’accès brut (prepare) ni de SQL propre à SQLite', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk('server');
    const allowed = new Set([join('server', 'sql.ts'), join('server', 'pg.ts'), join('server', 'db.ts'), join('server', 'scripts', 'essai-migration.ts')]);
    const problems: string[] = [];
    for (const file of files) {
      if (allowed.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (/\.prepare\(/.test(text)) problems.push(`${file} : prepare`);
      if (/\b(INSERT OR (IGNORE|REPLACE)|COLLATE NOCASE|sqlite_master|PRAGMA|datetime\(|strftime\(|julianday\()/.test(text)) problems.push(`${file} : SQL propre à SQLite`);
    }
    expect(problems).toEqual([]);
  });
});

describe('journal d’événements', () => {
  it('écrit le fait dans la même transaction que le changement : annulé avec lui', () => {
    const db = openDb(':memory:');
    const data = new BookingStore(db);
    const failing = bookingRow('b-echec', 'Échec', 'echec@example.org', '2026-11-17T09:00:00.000Z');
    expect(() => db.tx(() => {
      data.insertBooking(failing);
      throw new Error('envoi impossible');
    })).toThrow('envoi impossible');
    expect(data.getBooking('b-echec')).toBeUndefined();
    expect(factsAfter(db, 0)).toEqual([]);

    data.insertBooking(bookingRow('b1', 'Marie', 'marie@example.org', '2026-11-17T09:00:00.000Z'));
    data.rescheduleByClient('b1', '2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z', NOW.toISOString());
    data.reschedule('b1', '2026-11-18T10:00:00.000Z', '2026-11-18T11:00:00.000Z', '2026-11-18T09:00:00.000Z');
    data.markCancelled('b1', 'client', NOW.toISOString());
    data.markCancelled('b1', 'admin', NOW.toISOString()); // déjà annulée : pas de second fait
    const facts = factsAfter(db, 0);
    expect(facts.map((f) => [f.type, f.data.by ?? null])).toEqual([
      ['booking.created', null], ['booking.rescheduled', 'client'], ['booking.rescheduled', 'agenda'], ['booking.cancelled', 'client'],
    ]);
    for (const f of facts) {
      expect(f.source).toBe('alfred');
      expect(f.subject).toBe(addressOf('booking', 'b1'));
      expect(f.spaceId).toBe(DEFAULT_SPACE_ID);
      // Le journal circulera entre modules : ni e-mail ni téléphone.
      expect(JSON.stringify(f.data)).not.toContain('marie@example.org');
    }
    expect(facts[1].data).toMatchObject({ start: '2026-11-18T09:00:00.000Z', previousStart: '2026-11-17T09:00:00.000Z' });
    expect([...facts].sort((a, b) => a.seq - b.seq)).toEqual(facts);
  });

  it('signale un acompte payé et remboursé', () => {
    const db = openDb(':memory:');
    const data = new BookingStore(db);
    data.insertHold({
      id: 'h1', ref_hash: 'r1', status: 'pending', type_id: null, type_name: 'Bilan', mode: 'cabinet', location: '',
      buffer_before_min: 0, buffer_after_min: 0, start_utc: '2026-11-17T09:00:00.000Z', end_utc: '2026-11-17T10:00:00.000Z',
      name: 'Marie', email: 'marie@example.org', phone: '', message: '', token_hash: 't', cancel_token: null,
      amount_cents: 5000, currency: 'chf', checkout_id: null, payment_intent: null, booking_id: null,
      created_at: NOW.toISOString(), expires_at: NOW.toISOString(), last_error: null,
    });
    data.updateHold('h1', { status: 'paid', payment_intent: 'pi_1' });
    data.updateHold('h1', { status: 'paid' }); // déjà payé : pas de second fait
    data.insertBooking({ ...bookingRow('b2', 'Marie', 'marie@example.org', '2026-11-17T09:00:00.000Z'), payment_amount_cents: 5000, payment_currency: 'chf', payment_status: 'paid' });
    data.setPaymentStatus('b2', 'refunded', null);
    const facts = factsAfter(db, 0);
    expect(facts.map((f) => f.type)).toEqual(['payment.received', 'booking.created', 'payment.refunded']);
    expect(facts[0].data).toMatchObject({ holdId: 'h1', amountCents: 5000, currency: 'chf' });
    expect(facts[1].data.deposit).toEqual({ amountCents: 5000, currency: 'chf' });
    expect(facts[2].data).toMatchObject({ bookingId: 'b2', amountCents: 5000 });
  });

  it('chaque lecteur garde sa position, et n’est prévenu qu’après validation', async () => {
    const db = openDb(':memory:');
    const seen: string[] = [];
    const stop = onFacts(db, (types) => seen.push(...types));
    const reader = new OutboxReader(db, 'essai');
    db.tx(() => {
      recordFact(db, 'video.guest_waiting', 'salle-1', { slug: 's', guestName: 'Léa' });
      expect(reader.pending()).toHaveLength(1); // visible dans la transaction
    });
    expect(() => db.tx(() => {
      recordFact(db, 'video.guest_joined', 'salle-1', { slug: 's', guestName: 'Tom' });
      throw new Error('annulé');
    })).toThrow('annulé');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['video.guest_waiting']);
    const pending = reader.pending();
    expect(pending.map((f) => f.data.guestName)).toEqual(['Léa']);
    reader.ack(pending[0].seq);
    expect(reader.pending()).toEqual([]);
    reader.ack(0); // une position ne recule jamais
    expect(reader.position).toBe(pending[0].seq);
    expect(new OutboxReader(db, 'autre').pending()).toHaveLength(1);
    stop();
  });

  it('documente chaque type de fait', () => {
    const doc = readFileSync(join('docs', 'JOURNAL.md'), 'utf8');
    for (const type of Object.keys(FACT_TYPES)) expect(doc, type).toContain(`\`${type}\``);
  });
});
