// API de la prise de rendez-vous, contre le calendrier local.
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Booking, BookingAdminState, BookingConfirmation, BookingType, CalendarInfo, Occurrence, PublicBooking, PublicBookingInfo, PublicSlots,
} from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer, MailMessage } from '../server/booking/mail.js';
import type { BookingLimits } from '../server/booking/routes.js';
import { BookingService, hashToken, locationLabel, slugify, type BookingOptions } from '../server/booking/service.js';
import { RateLimiter, rateKey } from '../server/booking/ratelimit.js';
import type { CaldavSync } from '../server/caldav.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
/** Dimanche 15 novembre 2026, 12:00 à Zurich. */
const NOW = '2026-11-15T11:00:00Z';
/** Lundi 16 novembre, 09:00 à Zurich. */
const MONDAY_9 = '2026-11-16T08:00:00.000Z';

interface SetupOptions {
  limits?: Partial<BookingLimits>;
  mail?: 'ok' | 'fail' | 'none';
  caldav?: CaldavSync | null;
  syncTimeoutMs?: number;
  /** Options du moteur. Par défaut, les plafonds par adresse sont larges : chaque test fixe celui qu'il vérifie. */
  service?: Partial<BookingOptions>;
  /** Envoi d'e-mails remplacé (serveur lent, panne passagère…). */
  send?: (message: MailMessage) => Promise<void>;
}

async function setup(opts: SetupOptions = {}) {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const service = new CalendarService(store, null, 'Europe/Zurich');
  const clock = { now: new Date(NOW) };
  const sent: MailMessage[] = [];
  const mode = opts.mail ?? 'ok';
  const mailer: Mailer = {
    configured: mode !== 'none',
    from: 'Antoine Quarroz <info@antoinequarroz.ch>',
    notifyTo: 'info@antoinequarroz.ch',
    async send(message) {
      if (opts.send) await opts.send(message);
      else if (mode !== 'ok') throw new Error('connexion SMTP refusée');
      sent.push(message);
    },
  };
  const booking = new BookingService({
    store, calendar: service, caldav: opts.caldav ?? null, timezone: 'Europe/Zurich', mailer,
    publicUrl: 'https://alfred.example.ch', defaultPublicName: 'Antoine Quarroz', now: () => clock.now,
    syncTimeoutMs: opts.syncTimeoutMs, maxPerEmailPerDay: 100, quietCancelMinutes: 0, ...opts.service,
  });
  const app = createApp({
    store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking,
    bookingLimits: { bookOk: [1000, 3_600_000], ...opts.limits },
  });
  const json = (path: string, method = 'GET', body?: unknown, extra: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method,
      headers: {
        'sec-fetch-site': 'same-origin',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(extra.cookie ? { cookie: extra.cookie } : {}),
        ...(extra.ip ? { 'x-forwarded-for': extra.ip } : {}),
        ...extra.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const login = await json('/api/login', 'POST', { password: PASSWORD });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) => json(path, method, body, { cookie });
  const calendar = store.listCalendars()[0];
  return { app, store, service, booking, clock, sent, json, admin, cookie, calendar };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Ouvre la prise de rendez-vous avec un type « Consultation » de 30 minutes. */
async function open(ctx: Ctx, type: Record<string, unknown> = {}): Promise<BookingType> {
  expect((await ctx.admin('/api/booking/settings', 'PUT', { enabled: true })).status).toBe(200);
  const res = await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, location: 'Rue du Lac 1, Sion', ...type });
  expect(res.status).toBe(201);
  return (await res.json()) as BookingType;
}

const CLIENT = { name: 'Élodie Müller', email: 'elodie@example.org', phone: '+41 79 123 45 67', message: 'Première visite.' };

function bookRequest(ctx: Ctx, over: Record<string, unknown> = {}, ip?: string) {
  return ctx.json('/api/public/booking/book', 'POST', { typeSlug: 'consultation', start: MONDAY_9, ...CLIENT, ...over }, { ip });
}

async function slotsOf(ctx: Ctx, from = '2026-11-16', to = '2026-11-16', slug = 'consultation'): Promise<string[]> {
  const res = await ctx.json(`/api/public/booking/types/${slug}/slots?from=${from}&to=${to}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as PublicSlots).days.flatMap((d) => d.slots);
}

function tokenOf(confirmation: BookingConfirmation): string {
  return confirmation.cancelUrl.split('/').pop()!;
}

const rawEvent = (uid: string, lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

describe('prise de rendez-vous : accès', () => {
  it('garde l’API privée fermée sans session', async () => {
    const ctx = await setup();
    const calls: [string, string, unknown?][] = [
      ['/api/booking/settings', 'GET'],
      ['/api/booking/settings', 'PUT', { enabled: true }],
      ['/api/booking/types', 'GET'],
      ['/api/booking/types', 'POST', { name: 'X', durationMin: 30 }],
      ['/api/booking/types/abc', 'PUT', { name: 'Y' }],
      ['/api/booking/types/abc', 'DELETE'],
      ['/api/booking/types/abc/slots?from=2026-11-16&to=2026-11-16', 'GET'],
      ['/api/booking/hours', 'GET'],
      ['/api/booking/hours', 'PUT', []],
      ['/api/booking/calendars', 'GET'],
      ['/api/booking/calendars/abc', 'PATCH', { blocksBooking: false }],
      ['/api/booking/bookings', 'GET'],
      ['/api/booking/bookings/abc/cancel', 'POST'],
      ['/api/booking/bookings/abc/resend', 'POST'],
    ];
    for (const [path, method, body] of calls) {
      const res = await ctx.json(path, method, body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(ctx.booking.getSettings().enabled).toBe(false);
    expect(ctx.booking.listTypes()).toEqual([]);
  });

  it('est fermée par défaut : la page publique le dit et l’API refuse', async () => {
    const ctx = await setup();
    // Un type existe, mais rien n'est activé.
    expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30 })).status).toBe(201);
    const info = (await (await ctx.json('/api/public/booking')).json()) as PublicBookingInfo;
    expect(info).toEqual({ enabled: false, publicName: 'Antoine Quarroz', welcomeText: '', timezone: 'Europe/Zurich', types: [] });

    const slots = await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-16');
    expect(slots.status).toBe(403);
    expect(await slots.json()).toEqual({ error: 'La prise de rendez-vous n’est pas ouverte.', code: 'closed' });
    const book = await bookRequest(ctx);
    expect(book.status).toBe(403);
    expect(((await book.json()) as { code: string }).code).toBe('closed');
    expect(ctx.booking.listBookings('upcoming')).toEqual([]);
    expect(ctx.sent).toEqual([]);
  });

  it('referme tout dès que la prise de rendez-vous est désactivée', async () => {
    const ctx = await setup();
    await open(ctx);
    expect(await slotsOf(ctx)).toHaveLength(14);
    await ctx.admin('/api/booking/settings', 'PUT', { enabled: false });
    expect((await bookRequest(ctx)).status).toBe(403);
    expect((await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-16')).status).toBe(403);
  });

  it('ne sert rien de privé sous /api/public et ne met rien en cache', async () => {
    const ctx = await setup();
    await open(ctx);
    const info = await ctx.json('/api/public/booking');
    expect(info.headers.get('cache-control')).toBe('no-store');
    expect(info.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect((await ctx.json('/api/public/booking/bookings')).status).toBe(404);
    expect((await ctx.json('/api/public/events')).status).toBe(404);
    // La session ne change rien à ce que voit la partie publique.
    const withCookie = (await (await ctx.admin('/api/public/booking')).json()) as PublicBookingInfo;
    expect(withCookie).toEqual(await (await ctx.json('/api/public/booking')).json());
    expect(Object.keys(withCookie.types[0]).sort()).toEqual(['currency', 'depositCents', 'description', 'durationMin', 'horizonDays', 'locationLabel', 'mode', 'name', 'phoneRequired', 'slug']);
  });

  it('refuse une réservation ou une annulation venue d’un autre site', async () => {
    const ctx = await setup();
    await open(ctx);
    const cross = await ctx.app.request('/api/public/booking/book', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: 'alfred.example.ch', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ typeSlug: 'consultation', start: MONDAY_9, ...CLIENT }),
    });
    expect(cross.status).toBe(403);
    // Formulaire classique d'un autre site (sans JSON) : refusé par la protection CSRF commune.
    const form = await ctx.app.request('/api/public/booking/cancel/abc', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'a=1',
    });
    expect(form.status).toBe(403);
    expect(ctx.booking.listBookings('upcoming')).toEqual([]);
  });
});

describe('prise de rendez-vous : réglages', () => {
  it('lit et modifie les réglages', async () => {
    const ctx = await setup();
    const state = (await (await ctx.admin('/api/booking/settings')).json()) as BookingAdminState;
    expect(state.settings).toEqual({ enabled: false, publicName: 'Antoine Quarroz', welcomeText: '', calendarId: null, slotStepMin: 30, allDayBlocks: true,
      reminderHours: [24, 1], allowReschedule: true, changeNoticeHours: 0,
    });
    expect(state.effectiveCalendarId).toBe(ctx.calendar.id);
    expect(state.timezone).toBe('Europe/Zurich');
    expect(state.publicPageUrl).toBe('https://alfred.example.ch/rdv');
    expect(state.mail).toEqual({ configured: true, from: 'Antoine Quarroz <info@antoinequarroz.ch>', notifyTo: 'info@antoinequarroz.ch', sentLast24h: 0, dailyLimit: 200 });
    expect(state.warnings.join(' ')).toContain('Aucun type de rendez-vous actif');
    expect(state.warnings.join(' ')).toContain('fermée');

    const res = await ctx.admin('/api/booking/settings', 'PUT', {
      enabled: true, publicName: 'Cabinet Quarroz', welcomeText: 'Bienvenue.\nChoisissez un créneau.', calendarId: ctx.calendar.id, slotStepMin: 15,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()) as BookingAdminState;
    expect(next.settings).toEqual({
      enabled: true, publicName: 'Cabinet Quarroz', welcomeText: 'Bienvenue.\nChoisissez un créneau.', calendarId: ctx.calendar.id, slotStepMin: 15,
      allDayBlocks: true, reminderHours: [24, 1], allowReschedule: true, changeNoticeHours: 0,
    });
    // Modification partielle : le reste est conservé.
    const partial = (await (await ctx.admin('/api/booking/settings', 'PUT', { slotStepMin: 60 })).json()) as BookingAdminState;
    expect(partial.settings.publicName).toBe('Cabinet Quarroz');
    expect(partial.settings.slotStepMin).toBe(60);
    expect(partial.settings.enabled).toBe(true);
  });

  it('refuse des réglages invalides sans rien modifier', async () => {
    const ctx = await setup();
    const res = await ctx.admin('/api/booking/settings', 'PUT', { enabled: 'oui', slotStepMin: 20, calendarId: 'inconnu', publicName: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; fields: Record<string, string> };
    expect(body.code).toBe('invalid');
    expect(Object.keys(body.fields).sort()).toEqual(['calendarId', 'enabled', 'publicName', 'slotStepMin']);
    expect(ctx.booking.getSettings().slotStepMin).toBe(30);
    expect(ctx.booking.getSettings().enabled).toBe(false);
  });

  it('propose lundi à vendredi 09:00-12:00 et 13:30-17:30, et remplace les horaires', async () => {
    const ctx = await setup();
    const hours = (await (await ctx.admin('/api/booking/hours')).json()) as { weekday: number; startMin: number; endMin: number }[];
    expect(hours).toHaveLength(10);
    expect(hours.filter((h) => h.weekday === 1)).toEqual([
      { weekday: 1, startMin: 540, endMin: 720 },
      { weekday: 1, startMin: 810, endMin: 1050 },
    ]);
    expect(new Set(hours.map((h) => h.weekday))).toEqual(new Set([1, 2, 3, 4, 5]));

    const put = await ctx.admin('/api/booking/hours', 'PUT', [
      { weekday: 6, startMin: 600, endMin: 720 },
      { weekday: 1, startMin: 480, endMin: 600 },
    ]);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual([
      { weekday: 1, startMin: 480, endMin: 600 },
      { weekday: 6, startMin: 600, endMin: 720 },
    ]);
    for (const bad of [
      [{ weekday: 0, startMin: 0, endMin: 60 }],
      [{ weekday: 1, startMin: 600, endMin: 600 }],
      [{ weekday: 1, startMin: 600, endMin: 1500 }],
      [{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 700, endMin: 800 }],
      'nimporte',
    ]) {
      expect((await ctx.admin('/api/booking/hours', 'PUT', bad)).status).toBe(400);
    }
    // Le message nomme le jour et parle d'heures, pas de « minutes depuis minuit ».
    const inverted = (await (await ctx.admin('/api/booking/hours', 'PUT', [{ weekday: 1, startMin: 840, endMin: 720 }])).json()) as { fields: { hours: string } };
    expect(inverted.fields.hours).toBe('Lundi : la fin d’une plage doit être après son début');
    const overlap = (await (await ctx.admin('/api/booking/hours', 'PUT', [
      { weekday: 3, startMin: 540, endMin: 720 }, { weekday: 3, startMin: 700, endMin: 800 },
    ])).json()) as { fields: { hours: string } };
    expect(overlap.fields.hours).toBe('Mercredi : deux plages se chevauchent');
    expect((await (await ctx.admin('/api/booking/hours')).json() as unknown[])).toHaveLength(2);
    // Vider les horaires est permis, et ils ne reviennent pas tout seuls.
    expect(await (await ctx.admin('/api/booking/hours', 'PUT', [])).json()).toEqual([]);
  });

  it('rejoue la migration sans effet : horaires vidés conservés, colonne ajoutée à une base de la v1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-test-'));
    try {
      let db = openDb(dir);
      new Store(db).ensureLocalCalendar();
      db.exec('DELETE FROM booking_hours');
      // Base telle que la v1 l'a créée : pas encore de drapeau sur les calendriers.
      db.exec('ALTER TABLE calendars DROP COLUMN blocks_booking');
      // Base de la première version de la prise de rendez-vous : colonnes ajoutées depuis.
      db.exec('ALTER TABLE events DROP COLUMN busy');
      db.exec('ALTER TABLE bookings DROP COLUMN event_uid');
      db.exec('ALTER TABLE bookings DROP COLUMN notified_start');
      db.close();
      db = openDb(dir);
      const store = new Store(db);
      expect(store.listCalendars()[0].blocks_booking).toBe(1);
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
      expect(columns('events')).toContain('busy');
      expect(columns('bookings')).toEqual(expect.arrayContaining(['event_uid', 'notified_start']));
      expect(db.prepare('SELECT COUNT(*) AS n FROM booking_hours').get()).toEqual({ n: 0 });
      db.close();
      db = openDb(dir);
      expect(new Store(db).listCalendars()).toHaveLength(1);
      db.close();
    } finally {
      for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
      rmdirSync(dir);
    }
  });

  it('règle le drapeau « bloque les créneaux » de chaque calendrier', async () => {
    const ctx = await setup();
    const list = (await (await ctx.admin('/api/booking/calendars')).json()) as CalendarInfo[];
    expect(list).toHaveLength(1);
    expect(list[0].blocksBooking).toBe(true);
    const id = encodeURIComponent(list[0].id);
    const res = await ctx.admin(`/api/booking/calendars/${id}`, 'PATCH', { blocksBooking: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CalendarInfo).blocksBooking).toBe(false);
    expect(((await (await ctx.admin('/api/calendars')).json()) as CalendarInfo[])[0].blocksBooking).toBe(false);
    expect((await ctx.admin(`/api/booking/calendars/${id}`, 'PATCH', { blocksBooking: 'non' })).status).toBe(400);
    expect((await ctx.admin('/api/booking/calendars/inconnu', 'PATCH', { blocksBooking: true })).status).toBe(404);
  });
});

describe('prise de rendez-vous : types', () => {
  it('crée, modifie, ordonne et supprime des types', async () => {
    const ctx = await setup();
    const created = await ctx.admin('/api/booking/types', 'POST', { name: 'Première séance (découverte)', durationMin: 45 });
    expect(created.status).toBe(201);
    const first = (await created.json()) as BookingType;
    expect(first).toMatchObject({
      slug: 'premiere-seance-decouverte', name: 'Première séance (découverte)', durationMin: 45, description: '', mode: 'cabinet', location: '',
      bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeHours: 12, horizonDays: 60, active: true, sort: 0,
    });
    const second = (await (await ctx.admin('/api/booking/types', 'POST', {
      name: 'Appel', slug: 'appel', durationMin: 15, mode: 'telephone', bufferAfterMin: 5, minNoticeHours: 2, horizonDays: 30, description: 'Un court appel.',
    })).json()) as BookingType;
    expect(second).toMatchObject({ slug: 'appel', mode: 'telephone', bufferAfterMin: 5, minNoticeHours: 2, horizonDays: 30, sort: 1 });
    // Même nom : l'identifiant reste unique.
    const twin = (await (await ctx.admin('/api/booking/types', 'POST', { name: 'Appel', durationMin: 20 })).json()) as BookingType;
    expect(twin.slug).toBe('appel-2');

    const dup = await ctx.admin(`/api/booking/types/${twin.id}`, 'PUT', { slug: 'appel' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe('slug_taken');

    const upd = await ctx.admin(`/api/booking/types/${second.id}`, 'PUT', { name: 'Appel découverte', durationMin: 20, active: false });
    expect(upd.status).toBe(200);
    expect(await upd.json()).toMatchObject({ id: second.id, slug: 'appel', name: 'Appel découverte', durationMin: 20, active: false, mode: 'telephone' });

    const order = await ctx.admin('/api/booking/types/order', 'PUT', { ids: [twin.id, first.id, second.id] });
    expect(order.status).toBe(200);
    expect(((await order.json()) as BookingType[]).map((t) => t.id)).toEqual([twin.id, first.id, second.id]);
    expect((await ctx.admin('/api/booking/types/order', 'PUT', { ids: [twin.id] })).status).toBe(400);

    expect((await ctx.admin(`/api/booking/types/${twin.id}`, 'DELETE')).status).toBe(200);
    expect((await ctx.admin(`/api/booking/types/${twin.id}`, 'DELETE')).status).toBe(404);
    const list = (await (await ctx.admin('/api/booking/types')).json()) as BookingType[];
    expect(list.map((t) => t.slug)).toEqual(['premiere-seance-decouverte', 'appel']);

    // Côté public : seuls les types actifs, sans identifiant interne ni réglages.
    await ctx.admin('/api/booking/settings', 'PUT', { enabled: true });
    const info = (await (await ctx.json('/api/public/booking')).json()) as PublicBookingInfo;
    expect(info.types).toEqual([
      { slug: 'premiere-seance-decouverte', name: 'Première séance (découverte)', durationMin: 45, description: '', mode: 'cabinet', locationLabel: 'Au cabinet', phoneRequired: false, horizonDays: 60, depositCents: 0, currency: 'CHF' },
    ]);
  });

  it('valide les champs d’un type', async () => {
    const ctx = await setup();
    const res = await ctx.admin('/api/booking/types', 'POST', {
      name: '', durationMin: 2, mode: 'pigeon', bufferBeforeMin: -1, minNoticeHours: 1.5, horizonDays: 0, slug: 'Pas Bon', active: 'oui',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; fields: Record<string, string> };
    expect(body.code).toBe('invalid');
    expect(Object.keys(body.fields).sort()).toEqual(['active', 'bufferBeforeMin', 'durationMin', 'horizonDays', 'minNoticeHours', 'mode', 'name', 'slug']);
    expect((await ctx.admin('/api/booking/types', 'POST', { durationMin: 30 })).status).toBe(400);
    expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Sans durée' })).status).toBe(400);
    expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Ailleurs', durationMin: 30, mode: 'autre' })).status).toBe(400);
    expect((await ctx.admin('/api/booking/types/inconnu', 'PUT', { name: 'X' })).status).toBe(404);
    expect(ctx.booking.listTypes()).toEqual([]);
  });

  it('écrit le lieu en clair selon le mode', () => {
    expect(locationLabel('cabinet', '')).toBe('Au cabinet');
    expect(locationLabel('cabinet', 'Rue du Lac 1, Sion')).toBe('Rue du Lac 1, Sion');
    expect(locationLabel('telephone', '')).toBe('Par téléphone');
    expect(locationLabel('visio', 'lien envoyé la veille')).toBe('En visio (lien envoyé la veille)');
    expect(locationLabel('autre', 'À domicile')).toBe('À domicile');
    expect(slugify('  Séance d’été — 2ᵉ  ')).toBe('seance-d-ete-2');
    expect(slugify('***')).toBe('rendez-vous');
  });
});

describe('prise de rendez-vous : créneaux', () => {
  it('ne renvoie que des débuts de créneaux libres, jamais de détail d’événement', async () => {
    const ctx = await setup();
    await open(ctx);
    // Événement privé d'Antoine, lundi 10:00-11:00.
    await ctx.service.create({
      calendarId: ctx.calendar.id, title: 'Dentiste TRES-SECRET', start: '2026-11-16T09:00:00.000Z', end: '2026-11-16T10:00:00.000Z',
      allDay: false, location: 'Clinique SECRETE', description: 'Détail SECRET',
    });
    const res = await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-17');
    const text = await res.text();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('Dentiste');
    const body = JSON.parse(text) as PublicSlots;
    expect(Object.keys(body).sort()).toEqual(['days', 'durationMin', 'timezone']);
    expect(body.timezone).toBe('Europe/Zurich');
    expect(body.durationMin).toBe(30);
    expect(body.days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17']);
    expect(Object.keys(body.days[0]).sort()).toEqual(['date', 'slots']);
    expect(body.days[0].slots).toHaveLength(12);
    expect(body.days[0].slots).not.toContain('2026-11-16T09:00:00.000Z');
    expect(body.days[0].slots).not.toContain('2026-11-16T09:30:00.000Z');
    expect(body.days[0].slots.slice(0, 3)).toEqual(['2026-11-16T08:00:00.000Z', '2026-11-16T08:30:00.000Z', '2026-11-16T10:00:00.000Z']);
    expect(body.days[1].slots).toHaveLength(14);
  });

  it('tient compte des événements « disponible », annulés et « journée entière » venus d’Apple Calendar', async () => {
    const ctx = await setup();
    await open(ctx);
    const save = (uid: string, lines: string[]) => ctx.store.saveEvent({ calendarId: ctx.calendar.id, href: null, etag: null, ics: rawEvent(uid, lines) });
    // Lundi : « disponible » 09:00-12:00 (ne bloque pas) ; annulé 13:30-15:00 (ne bloque pas) ; opaque 16:00-17:00 (bloque).
    save('libre', ['DTSTART:20261116T080000Z', 'DTEND:20261116T110000Z', 'SUMMARY:Bureau', 'TRANSP:TRANSPARENT']);
    save('annule', ['DTSTART:20261116T123000Z', 'DTEND:20261116T140000Z', 'SUMMARY:Réunion', 'STATUS:CANCELLED']);
    save('pris', ['DTSTART:20261116T150000Z', 'DTEND:20261116T160000Z', 'SUMMARY:Rendez-vous']);
    // Mardi : journée entière opaque. Mercredi : journée entière « disponible », comme Apple Calendar
    // marque celles qu'il crée (congés compris).
    save('conge', ['DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118', 'SUMMARY:Congé']);
    save('anniv', ['DTSTART;VALUE=DATE:20261118', 'DTEND;VALUE=DATE:20261119', 'SUMMARY:Anniversaire', 'TRANSP:TRANSPARENT']);
    // Jeudi : série hebdomadaire 09:00-10:00 dont l'occurrence du 19 est « disponible » par exception.
    save('serie', ['DTSTART:20261112T080000Z', 'DTEND:20261112T090000Z', 'SUMMARY:Cours', 'RRULE:FREQ=WEEKLY']);

    const get = async () => ((await (await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-19')).json()) as PublicSlots).days;
    // Par défaut, une journée entière bloque toute la journée, même marquée « disponible ».
    expect((await get()).map((d) => d.date)).toEqual(['2026-11-16', '2026-11-19']);
    // Réglage décoché : seules les journées entières « occupé » bloquent (comportement iCalendar strict).
    expect((await ctx.admin('/api/booking/settings', 'PUT', { allDayBlocks: false })).status).toBe(200);
    const days = await get();
    expect(days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-18', '2026-11-19']);
    expect(days[0].slots).toHaveLength(12);
    expect(days[0].slots).not.toContain('2026-11-16T15:00:00.000Z');
    expect(days[0].slots).toContain('2026-11-16T08:00:00.000Z');
    expect(days[0].slots).toContain('2026-11-16T12:30:00.000Z');
    expect(days[1].slots).toHaveLength(14);
    expect(days[2].slots).toHaveLength(12);
    expect(days[2].slots[0]).toBe('2026-11-19T09:00:00.000Z');
  });

  it('ne relit ni ne redéveloppe l’agenda à chaque demande : l’occupation est gardée tant que rien ne change', async () => {
    const ctx = await setup();
    await open(ctx);
    const save = (uid: string, lines: string[]) => ctx.store.saveEvent({ calendarId: ctx.calendar.id, href: null, etag: null, ics: rawEvent(uid, lines) });
    save('serie', ['DTSTART:20200106T080000Z', 'DTEND:20200106T090000Z', 'SUMMARY:Cours', 'RRULE:FREQ=WEEKLY']);
    save('simple', ['DTSTART:20261117T080000Z', 'DTEND:20261117T090000Z', 'SUMMARY:Rendez-vous']);
    let reads = 0;
    const original = ctx.store.busyOccurrences.bind(ctx.store);
    ctx.store.busyOccurrences = (from, to) => {
      reads++;
      return original(from, to);
    };
    const get = async (from: string, to: string, ip: string) =>
      ((await (await ctx.json(`/api/public/booking/types/consultation/slots?from=${from}&to=${to}`, 'GET', undefined, { ip })).json()) as PublicSlots).days;
    const first = await get('2026-11-16', '2026-11-30', '203.0.113.1');
    expect(first[0].slots[0]).toBe('2026-11-16T09:00:00.000Z'); // lundi 09:00-10:00 pris par la série
    expect(first[1].slots[0]).toBe('2026-11-17T09:00:00.000Z'); // mardi 09:00-10:00 pris par l'événement simple
    // Vingt autres demandes, sur d'autres périodes : aucune nouvelle lecture de l'agenda.
    for (let i = 0; i < 20; i++) await get(`2026-12-${String(1 + i).padStart(2, '0')}`, '2026-12-31', `203.0.113.${2 + i}`);
    expect(reads).toBe(1);
    // L'agenda change (ici une synchro qui ramène un événement) : l'occupation est recalculée une fois.
    save('nouveau', ['DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Dentiste']);
    expect((await get('2026-11-16', '2026-11-16', '203.0.113.40'))[0].slots[0]).toBe('2026-11-16T10:00:00.000Z');
    await get('2026-11-17', '2026-11-20', '203.0.113.41');
    expect(reads).toBe(2);
    // Une réservation invalide aussi le cache : le créneau pris disparaît aussitôt.
    expect((await bookRequest(ctx, { start: '2026-11-16T10:00:00.000Z' })).status).toBe(201);
    expect((await get('2026-11-16', '2026-11-16', '203.0.113.42'))[0].slots[0]).toBe('2026-11-16T10:30:00.000Z');
  });

  it('lit l’occupation des événements simples sans leur iCalendar, y compris pour les lignes d’avant la mise à jour', async () => {
    const ctx = await setup();
    await open(ctx);
    const save = (uid: string, lines: string[]) => ctx.store.saveEvent({ calendarId: ctx.calendar.id, href: null, etag: null, ics: rawEvent(uid, lines) });
    const id = save('pris', ['DTSTART:20261116T080000Z', 'DTEND:20261116T090000Z', 'SUMMARY:Rendez-vous']);
    save('libre', ['DTSTART:20261116T090000Z', 'DTEND:20261116T100000Z', 'SUMMARY:Bureau', 'TRANSP:TRANSPARENT']);
    save('conge', ['DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261119', 'SUMMARY:Congé']);
    const busy = () => ctx.store.db.prepare('SELECT busy FROM events WHERE id = ?').get(id) as { busy: string | null };
    expect(JSON.parse(busy().busy!)).toEqual([['2026-11-16T08:00:00.000Z', '2026-11-16T09:00:00.000Z', 0, 0, 0]]);
    const expected = ['2026-11-16T09:00:00.000Z', '2026-11-19T08:00:00.000Z'];
    const firstSlots = async () => {
      const days = ((await (await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-19')).json()) as PublicSlots).days;
      return days.map((d) => d.slots[0]);
    };
    expect(await firstSlots()).toEqual(expected);
    // Lignes enregistrées avant l'ajout de la colonne : même résultat, et la colonne est complétée à la lecture.
    ctx.store.db.exec('UPDATE events SET busy = NULL');
    ctx.store.setCalendarBlocksBooking(ctx.calendar.id, true); // invalide le cache d'occupation
    expect(await firstSlots()).toEqual(expected);
    expect(busy().busy).not.toBeNull();
    // Une fois la colonne remplie, l'iCalendar n'est plus lu : le rendre illisible ne change rien.
    ctx.store.db.exec("UPDATE events SET ics = 'illisible' WHERE recurring = 0");
    ctx.store.setCalendarBlocksBooking(ctx.calendar.id, true);
    expect(await firstSlots()).toEqual(expected);
  });

  it('ignore les calendriers non bloquants et compte ceux qui sont masqués', async () => {
    const ctx = await setup();
    await open(ctx);
    await ctx.service.create({ calendarId: ctx.calendar.id, title: 'Occupé', start: '2026-11-16T08:00:00.000Z', end: '2026-11-16T11:00:00.000Z', allDay: false });
    expect(await slotsOf(ctx)).toHaveLength(8);
    // Masquer un calendrier dans l'affichage ne libère pas les créneaux.
    ctx.store.setCalendarVisible(ctx.calendar.id, false);
    expect(await slotsOf(ctx)).toHaveLength(8);
    await ctx.admin(`/api/booking/calendars/${encodeURIComponent(ctx.calendar.id)}`, 'PATCH', { blocksBooking: false });
    expect(await slotsOf(ctx)).toHaveLength(14);
  });

  it('applique le pas, le préavis, l’horizon et les tampons du type', async () => {
    const ctx = await setup();
    const type = await open(ctx, { minNoticeHours: 24, horizonDays: 3, bufferBeforeMin: 30, bufferAfterMin: 30 });
    await ctx.service.create({ calendarId: ctx.calendar.id, title: 'Occupé', start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T10:00:00.000Z', allDay: false });
    const res = await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-01&to=2026-12-10');
    const days = ((await res.json()) as PublicSlots).days;
    // Maintenant : dimanche 12:00. Préavis 24 h → lundi dès 13:30. Horizon 3 jours → jusqu'à mercredi 18.
    expect(days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
    expect(days[0].slots[0]).toBe('2026-11-16T12:30:00.000Z');
    // Mardi, événement 10:00-11:00 avec 30 min de tampon de chaque côté : 09:00 puis 11:30.
    expect(days[1].slots.slice(0, 2)).toEqual(['2026-11-17T08:00:00.000Z', '2026-11-17T10:30:00.000Z']);
    await ctx.admin('/api/booking/settings', 'PUT', { slotStepMin: 60 });
    expect((await slotsOf(ctx, '2026-11-18', '2026-11-18')).map((s) => s.slice(11, 16))).toEqual(['08:00', '09:00', '10:00', '12:30', '13:30', '14:30', '15:30']);
    // L'aperçu de l'admin donne la même chose.
    const preview = (await (await ctx.admin(`/api/booking/types/${type.id}/slots?from=2026-11-18&to=2026-11-18`)).json()) as PublicSlots;
    expect(preview.days[0].slots).toHaveLength(7);
  });

  it('refuse une période invalide ou trop longue, et un type inconnu ou inactif', async () => {
    const ctx = await setup();
    const type = await open(ctx);
    const get = (q: string, slug = 'consultation') => ctx.json(`/api/public/booking/types/${slug}/slots${q}`);
    expect((await get('')).status).toBe(400);
    expect((await get('?from=2026-11-16')).status).toBe(400);
    expect((await get('?from=2026-11-17&to=2026-11-16')).status).toBe(400);
    expect((await get('?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await get('?from=2026-11-16&to=2027-03-01')).status).toBe(400);
    expect((await get('?from=2026-11-16&to=2026-11-16', 'inconnu')).status).toBe(404);
    await ctx.admin(`/api/booking/types/${type.id}`, 'PUT', { active: false });
    const inactive = await get('?from=2026-11-16&to=2026-11-16');
    expect(inactive.status).toBe(404);
    expect(((await inactive.json()) as { code: string }).code).toBe('unknown_type');
  });
});

describe('prise de rendez-vous : réservation', () => {
  it('réserve un créneau : événement créé, e-mails envoyés, récapitulatif renvoyé', async () => {
    const ctx = await setup();
    await open(ctx);
    const res = await bookRequest(ctx);
    expect(res.status).toBe(201);
    const confirmation = (await res.json()) as BookingConfirmation;
    expect(confirmation.booking).toEqual({
      typeName: 'Consultation', start: MONDAY_9, end: '2026-11-16T08:30:00.000Z', timezone: 'Europe/Zurich',
      locationLabel: 'Rue du Lac 1, Sion', name: 'Élodie Müller', status: 'confirmed', cancellable: true, videoUrl: null,
      reschedulable: true, changeUntil: MONDAY_9, mode: 'cabinet', durationMin: 30, horizonDays: 60, deposit: null,
    });
    expect(confirmation.emailSent).toBe(true);
    expect(confirmation.cancelUrl).toMatch(/^https:\/\/alfred\.example\.ch\/rdv\/gerer\/[A-Za-z0-9_-]{43}$/);

    // L'événement est dans le calendrier d'Antoine.
    const events = (await (await ctx.admin('/api/events?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z')).json()) as Occurrence[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Consultation : Élodie Müller', start: MONDAY_9, end: '2026-11-16T08:30:00.000Z', allDay: false,
      location: 'Rue du Lac 1, Sion', calendarId: ctx.calendar.id,
    });
    expect(events[0].description).toBe('Rendez-vous pris en ligne.\nNom : Élodie Müller\nE-mail : elodie@example.org\nTéléphone : +41 79 123 45 67\nMessage : Première visite.');

    // Deux e-mails : confirmation au client (avec .ics), avis à Antoine.
    expect(ctx.sent).toHaveLength(2);
    const [toClient, toOwner] = ctx.sent;
    expect(toClient.to).toEqual({ name: 'Élodie Müller', address: 'elodie@example.org' });
    expect(toClient.text).toContain(confirmation.cancelUrl);
    expect(toClient.attachments?.[0].content).toContain('METHOD:PUBLISH');
    expect(toOwner.to).toBe('info@antoinequarroz.ch');
    expect(toOwner.subject).toBe('Nouveau rendez-vous : Consultation, Élodie Müller');
    expect(toOwner.text).toContain('Première visite.');

    // Le créneau n'est plus proposé, les autres le sont toujours.
    const slots = await slotsOf(ctx);
    expect(slots).not.toContain(MONDAY_9);
    expect(slots).toHaveLength(13);

    // L'admin voit la réservation.
    const list = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      typeName: 'Consultation', location: 'Rue du Lac 1, Sion', start: MONDAY_9, end: '2026-11-16T08:30:00.000Z',
      name: 'Élodie Müller', email: 'elodie@example.org', phone: '+41 79 123 45 67', message: 'Première visite.',
      status: 'confirmed', cancelledAt: null, cancelledBy: null, eventId: events[0].eventId, calendarId: ctx.calendar.id,
      eventState: 'ok', eventStart: null, mailError: null, createdAt: '2026-11-15T11:00:00.000Z',
    });
    expect(await (await ctx.admin('/api/booking/bookings?scope=past')).json()).toEqual([]);

    // Le jeton n'existe nulle part en clair : seule son empreinte est en base.
    const token = tokenOf(confirmation);
    const rows = ctx.store.db.prepare('SELECT * FROM bookings').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain(String(rows[0].token_hash));
  });

  it('n’accepte qu’un créneau exactement proposé', async () => {
    const ctx = await setup();
    await open(ctx);
    for (const start of [
      '2026-11-16T08:10:00.000Z', // pas aligné sur le pas
      '2026-11-16T11:00:00.000Z', // pause de midi
      '2026-11-16T16:30:00.000Z', // après la fermeture
      '2026-11-15T13:00:00.000Z', // dimanche, et préavis non respecté
      '2026-11-14T08:00:00.000Z', // passé
      '2027-06-14T07:00:00.000Z', // au-delà de l'horizon
    ]) {
      const res = await bookRequest(ctx, { start });
      expect(res.status, start).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('slot_unavailable');
    }
    // Le même instant écrit avec un décalage horaire est accepté.
    expect((await bookRequest(ctx, { start: '2026-11-16T09:00:00+01:00' })).status).toBe(201);
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(1);
  });

  it('valide strictement les champs saisis', async () => {
    const ctx = await setup({ limits: { book: [100, 60_000] } });
    await open(ctx);
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'name'],
      [{ name: 'A' }, 'name'],
      [{ name: 'x'.repeat(61) }, 'name'],
      // Le nom ouvre l'e-mail envoyé à une adresse non vérifiée : ni lien, ni domaine nu, ni chiffre, ni caractère invisible.
      [{ name: 'Compte bloqué, validez sur evil-banque.ch/login' }, 'name'],
      [{ name: 'Validez sur evil-banque.ch' }, 'name'],
      [{ name: 'Jean evil.ch' }, 'name'],
      [{ name: 'Appelez le 0900 123 456' }, 'name'],
      [{ name: 'Jean/Dupont' }, 'name'],
      [{ name: 'Jean:Dupont' }, 'name'],
      [{ name: 'Jean\u200bDupont' }, 'name'],
      [{ name: 'Jean \u202eDupont' }, 'name'],
      [{ name: 'Bob\r\nBcc: victime@example.net' }, 'name'],
      [{ name: 'Gagnez sur https://spam.example' }, 'name'],
      [{ name: 42 }, 'name'],
      [{ email: 'pas-une-adresse' }, 'email'],
      [{ email: 'a@b' }, 'email'],
      [{ email: 'a b@example.org' }, 'email'],
      [{ email: 'a@example.org\r\nBcc: x@example.net' }, 'email'],
      [{ email: 'a@example.org, autre@example.net' }, 'email'],
      [{ email: `${'x'.repeat(250)}@example.org` }, 'email'],
      [{ phone: 'appelez-moi' }, 'phone'],
      [{ phone: '+41 79 123 45 67 89 00 11 22 33 44 55' }, 'phone'],
      [{ message: 'x'.repeat(2001) }, 'message'],
      [{ message: { a: 1 } }, 'message'],
      [{ start: 'demain' }, 'start'],
      [{ start: '2026-11-16' }, 'start'],
      [{ start: 1_794_000_000_000 }, 'start'],
    ];
    for (const [over, field] of cases) {
      const res = await bookRequest(ctx, over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      const body = (await res.json()) as { code: string; fields: Record<string, string> };
      expect(body.code).toBe('invalid');
      expect(Object.keys(body.fields), JSON.stringify(over)).toEqual([field]);
    }
    const many = (await (await bookRequest(ctx, { name: '', email: '', start: '' })).json()) as { fields: Record<string, string> };
    expect(Object.keys(many.fields).sort()).toEqual(['email', 'name', 'start']);
    expect((await bookRequest(ctx, { typeSlug: 'inconnu' })).status).toBe(404);
    expect((await bookRequest(ctx, { typeSlug: 12 })).status).toBe(404);
    expect((await ctx.json('/api/public/booking/book', 'POST', ['liste'])).status).toBe(400);
    expect(ctx.booking.listBookings('upcoming')).toEqual([]);
    expect(ctx.sent).toEqual([]);
    // Téléphone et message sont facultatifs.
    expect((await bookRequest(ctx, { phone: undefined, message: undefined })).status).toBe(201);
    expect(ctx.booking.listBookings('upcoming')[0]).toMatchObject({ phone: '', message: '' });
  });

  it('exige le téléphone pour un rendez-vous par téléphone', async () => {
    const ctx = await setup();
    await open(ctx, { mode: 'telephone', location: '' });
    const info = (await (await ctx.json('/api/public/booking')).json()) as PublicBookingInfo;
    expect(info.types[0]).toMatchObject({ phoneRequired: true, locationLabel: 'Par téléphone' });
    const res = await bookRequest(ctx, { phone: '' });
    expect(res.status).toBe(400);
    expect(Object.keys(((await res.json()) as { fields: Record<string, string> }).fields)).toEqual(['phone']);
    expect((await bookRequest(ctx)).status).toBe(201);
  });

  it('refuse un corps qui n’est pas du JSON, illisible ou trop gros', async () => {
    const ctx = await setup();
    await open(ctx);
    const post = (headers: Record<string, string>, body: string) =>
      ctx.app.request('/api/public/booking/book', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', ...headers }, body });
    const valid = JSON.stringify({ typeSlug: 'consultation', start: MONDAY_9, ...CLIENT });
    expect((await post({ 'content-type': 'text/plain' }, valid)).status).toBe(415);
    expect((await post({ 'content-type': 'application/json' }, '{pas du json')).status).toBe(400);
    const huge = JSON.stringify({ typeSlug: 'consultation', start: MONDAY_9, ...CLIENT, message: 'x'.repeat(20_000) });
    expect((await post({ 'content-type': 'application/json', 'content-length': String(huge.length) }, huge)).status).toBe(413);
    expect(ctx.booking.listBookings('upcoming')).toEqual([]);
  });

  it('piège les robots : le champ caché rempli fait refuser la demande', async () => {
    const ctx = await setup();
    await open(ctx);
    const res = await bookRequest(ctx, { website: 'https://spam.example' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Demande refusée.', code: 'rejected' });
    expect(ctx.booking.listBookings('upcoming')).toEqual([]);
    expect(ctx.sent).toEqual([]);
    expect(await slotsOf(ctx)).toContain(MONDAY_9);
    // Vide, comme le laisse un humain : accepté.
    expect((await bookRequest(ctx, { website: '' })).status).toBe(201);
  });

  it('n’accorde le créneau qu’une fois quand deux clients le demandent en même temps', async () => {
    const ctx = await setup();
    await open(ctx);
    const results = await Promise.all([
      bookRequest(ctx, { name: 'Alice Martin', email: 'alice@example.org' }),
      bookRequest(ctx, { name: 'Bruno Favre', email: 'bruno@example.org' }),
      bookRequest(ctx, { name: 'Chloé Rey', email: 'chloe@example.org' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(((await loser.json()) as { code: string }).code).toBe('slot_unavailable');
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(1);
    const events = ctx.store.occurrences(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'));
    expect(events).toHaveLength(1);
    // Un seul client reçoit une confirmation.
    expect(ctx.sent.filter((m) => m.subject.startsWith('Rendez-vous confirmé'))).toHaveLength(1);
  });

  it('refuse des créneaux qui se chevauchent entre types différents, tampons compris', async () => {
    const ctx = await setup();
    await open(ctx, { bufferAfterMin: 30 });
    await ctx.admin('/api/booking/types', 'POST', { name: 'Bilan', slug: 'bilan', durationMin: 60 });
    expect((await bookRequest(ctx, { start: '2026-11-16T09:00:00.000Z' })).status).toBe(201); // consultation 10:00-10:30 (+30)
    const bilan = await slotsOf(ctx, '2026-11-16', '2026-11-16', 'bilan');
    // Un bilan d'une heure : 09:00 finit à 10:00 (libre), 09:30 chevauche, 10:30 empiète sur le tampon, 11:00 est libre.
    expect(bilan.slice(0, 2)).toEqual(['2026-11-16T08:00:00.000Z', '2026-11-16T10:00:00.000Z']);
    const res = await bookRequest(ctx, { typeSlug: 'bilan', start: '2026-11-16T09:30:00.000Z', email: 'autre@example.org' });
    expect(res.status).toBe(409);
  });

  it('bloque le créneau par la réservation même si l’événement n’est pas dans un calendrier bloquant', async () => {
    const ctx = await setup();
    await open(ctx);
    await ctx.admin(`/api/booking/calendars/${encodeURIComponent(ctx.calendar.id)}`, 'PATCH', { blocksBooking: false });
    expect((await bookRequest(ctx)).status).toBe(201);
    expect(await slotsOf(ctx)).not.toContain(MONDAY_9);
    expect((await bookRequest(ctx, { email: 'autre@example.org' })).status).toBe(409);
  });

  it('accepte les vrais noms : accents, tirets, apostrophes, particules, abréviations', async () => {
    const ctx = await setup();
    await open(ctx);
    const slots = await slotsOf(ctx);
    const names = ['Jean-Pierre O’Brien', "Anne-Sophie d'Aubigné", 'Dr. Élodie Müller', 'J.-P. de La Tour', 'Nguyễn Thị Minh', 'Łukasz Żółć'];
    for (const [i, name] of names.entries()) {
      const res = await bookRequest(ctx, { start: slots[i], name, email: `n${i}@example.org` });
      expect([name, res.status]).toEqual([name, 201]);
    }
  });

  it('plafonne les réservations créées en 24 h pour une même adresse, annulations comprises, sans rien révéler', async () => {
    const ctx = await setup({ service: { maxPerEmailPerDay: 3 } });
    await open(ctx);
    const slots = await slotsOf(ctx);
    // Réserver puis annuler aussitôt ne redonne pas le droit de recommencer.
    for (let i = 0; i < 3; i++) {
      const res = await bookRequest(ctx, { start: slots[i] });
      expect(res.status).toBe(201);
      const cancel = await ctx.json(`/api/public/booking/cancel/${tokenOf((await res.json()) as BookingConfirmation)}`, 'POST');
      expect(cancel.status).toBe(200);
    }
    const mails = ctx.sent.length;
    const res = await bookRequest(ctx, { start: slots[3], email: 'ELODIE@example.org' });
    // Même réponse que la limite de débit : on n'apprend rien sur les rendez-vous de cette adresse.
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Trop de demandes. Réessayez un peu plus tard.', code: 'rate_limited' });
    expect(ctx.sent).toHaveLength(mails);
    expect(await slotsOf(ctx)).toContain(slots[3]);
    expect((await bookRequest(ctx, { start: slots[3], email: 'autre@example.org' })).status).toBe(201);
    // Vingt-quatre heures plus tard, l'adresse peut de nouveau réserver.
    ctx.clock.now = new Date('2026-11-16T11:00:01Z');
    expect((await bookRequest(ctx, { start: '2026-11-17T12:30:00.000Z' })).status).toBe(201);
  });

  it('tient le plafond par adresse face à des demandes simultanées, même pendant l’attente d’iCloud', async () => {
    const slow = {
      sync: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
      configured: true,
      getStatus: () => ({ configured: true, running: true, lastSuccessAt: null, lastError: null, lastErrorAt: null }),
    } as unknown as CaldavSync;
    const ctx = await setup({ caldav: slow, service: { maxPerEmailPerDay: 3 } });
    await open(ctx);
    const slots = (await slotsOf(ctx)).slice(0, 10);
    const results = await Promise.all(slots.map((start) => bookRequest(ctx, { start })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 429, 429, 429, 429, 429, 429, 429]);
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(3);
    expect(ctx.sent.filter((m) => typeof m.to !== 'string')).toHaveLength(3);
  });

  it('relit le type sous le verrou : supprimé, désactivé ou modifié pendant l’attente de la synchro', async () => {
    let during: () => Promise<unknown> = async () => undefined;
    const caldav = {
      sync: async () => { await during(); },
      configured: true,
      getStatus: () => ({ configured: true, running: false, lastSuccessAt: null, lastError: null, lastErrorAt: null }),
    } as unknown as CaldavSync;
    const ctx = await setup({ caldav });
    const type = await open(ctx);

    // Durée portée à 60 min pendant l'attente : la réservation prend la durée à jour.
    during = () => ctx.admin(`/api/booking/types/${type.id}`, 'PUT', { durationMin: 60, location: 'Avenue de la Gare 3, Sion' });
    const changed = await bookRequest(ctx);
    expect(changed.status).toBe(201);
    expect(((await changed.json()) as BookingConfirmation).booking).toMatchObject({ end: '2026-11-16T09:00:00.000Z', locationLabel: 'Avenue de la Gare 3, Sion' });

    // Type désactivé pendant l'attente : refus net, rien n'est créé.
    during = () => ctx.admin(`/api/booking/types/${type.id}`, 'PUT', { active: false });
    const off = await bookRequest(ctx, { start: '2026-11-16T12:30:00.000Z', email: 'b@example.org' });
    expect(off.status).toBe(404);
    expect(((await off.json()) as { code: string }).code).toBe('unknown_type');

    // Type supprimé pendant l'attente : même refus (et non une erreur interne), aucun événement orphelin.
    await ctx.admin(`/api/booking/types/${type.id}`, 'PUT', { active: true });
    during = () => ctx.admin(`/api/booking/types/${type.id}`, 'DELETE');
    const gone = await bookRequest(ctx, { start: '2026-11-16T12:30:00.000Z', email: 'c@example.org' });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe('unknown_type');
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(1);
    expect(ctx.store.occurrences(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))).toHaveLength(1);
  });

  it('conserve la réservation quand l’e-mail échoue, et le signale dans l’admin', async () => {
    const ctx = await setup({ mail: 'fail' });
    await open(ctx);
    const res = await bookRequest(ctx);
    expect(res.status).toBe(201);
    const confirmation = (await res.json()) as BookingConfirmation;
    expect(confirmation.emailSent).toBe(false);
    expect(confirmation.cancelUrl).toContain('/rdv/gerer/');
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.status).toBe('confirmed');
    expect(b.eventState).toBe('ok');
    expect(b.mailError).toContain('Confirmation au client : envoi en échec');
    expect(b.mailError).toContain('connexion SMTP refusée');
  });

  it('fonctionne sans SMTP configuré, avec un avertissement dans l’admin', async () => {
    const ctx = await setup({ mail: 'none' });
    await open(ctx);
    const res = await bookRequest(ctx);
    expect(res.status).toBe(201);
    expect(((await res.json()) as BookingConfirmation).emailSent).toBe(false);
    const state = (await (await ctx.admin('/api/booking/settings')).json()) as BookingAdminState;
    expect(state.mail.configured).toBe(false);
    expect(state.warnings.some((w) => w.includes('e-mails n’est pas configuré'))).toBe(true);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.mailError).toBe('E-mails non configurés : aucun message envoyé');
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST')).status).toBe(400);
  });

  it('renvoie une confirmation avec un nouveau lien ; l’ancienne route d’essai d’envoi n’existe plus', async () => {
    const ctx = await setup();
    await open(ctx);
    // L'essai d'envoi passe par /api/connections/smtp/test, qui est limité en débit : plus de route parallèle ici.
    expect((await ctx.admin('/api/booking/mail/test', 'POST')).status).toBe(404);
    expect(ctx.sent).toHaveLength(0);

    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    ctx.sent.length = 0;
    const resend = await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST');
    expect(resend.status).toBe(200);
    expect(ctx.sent).toHaveLength(1);
    const link = /https:\/\/alfred\.example\.ch\/rdv\/gerer\/[A-Za-z0-9_-]{43}/.exec(ctx.sent[0].text)![0];
    expect(link).not.toBe(confirmation.cancelUrl);
    // L'ancien lien ne fonctionne plus, le nouveau oui.
    expect((await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`)).status).toBe(404);
    expect((await ctx.json(`/api/public/booking/cancel/${link.split('/').pop()}`)).status).toBe(200);
  });

  it('garde l’ancien lien d’annulation quand le renvoi de la confirmation échoue', async () => {
    let down = false;
    const ctx = await setup({ send: async () => { if (down) throw new Error('connect ECONNREFUSED'); } });
    await open(ctx);
    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    down = true;
    const resend = await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST');
    expect(resend.status).toBe(200);
    expect(((await resend.json()) as Booking).mailError).toContain('envoi en échec (connect ECONNREFUSED)');
    // Le nouveau lien n'est jamais parti : celui que le client a reçu doit continuer de fonctionner.
    expect((await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`)).status).toBe(200);
    // Une fois la messagerie rétablie, le renvoi remplace le lien.
    down = false;
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST')).status).toBe(200);
    expect((await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`)).status).toBe(404);
  });

  it('répond sans attendre un serveur d’e-mails lent : réservation confirmée, envoi poursuivi en arrière-plan', async () => {
    const release: (() => void)[] = [];
    const ctx = await setup({ service: { mailWaitMs: 40 }, send: () => new Promise<void>((resolve) => release.push(resolve)) });
    await open(ctx);
    const started = Date.now();
    const res = await bookRequest(ctx);
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(1500);
    const confirmation = (await res.json()) as BookingConfirmation;
    // Le client voit son récapitulatif et son lien, avec l'avertissement « e-mail non envoyé ».
    expect(confirmation.emailSent).toBe(false);
    expect(confirmation.cancelUrl).toContain('/rdv/gerer/');
    let [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.mailError).toContain('en cours');
    // Le serveur finit par répondre : les deux messages partent et l'état est mis à jour.
    release.forEach((fn) => fn());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.sent).toHaveLength(2);
    [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.mailError).toBeNull();
  });

  it('compte comme un échec un envoi qui n’aboutit jamais, et le note sur la réservation', async () => {
    const ctx = await setup({ service: { mailWaitMs: 20, mailTimeoutMs: 60 }, send: () => new Promise<void>(() => undefined) });
    await open(ctx);
    expect((await bookRequest(ctx)).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.mailError).toContain('délai dépassé');
    // L'annulation ne reste pas bloquée non plus.
    const started = Date.now();
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/cancel`, 'POST', {})).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('plafonne les e-mails sortants sur 24 h et le signale dans l’admin', async () => {
    const ctx = await setup({ service: { mailDailyLimit: 3 } });
    await open(ctx);
    const slots = await slotsOf(ctx);
    expect((await bookRequest(ctx, { start: slots[0], email: 'a@example.org' })).status).toBe(201);
    // Deuxième réservation : un seul message passe encore, la confirmation au client.
    const second = await bookRequest(ctx, { start: slots[1], email: 'b@example.org' });
    expect(second.status).toBe(201);
    expect(ctx.sent).toHaveLength(3);
    const third = (await (await bookRequest(ctx, { start: slots[2], email: 'c@example.org' })).json()) as BookingConfirmation;
    expect(third.emailSent).toBe(false);
    expect(ctx.sent).toHaveLength(3);
    const state = (await (await ctx.admin('/api/booking/settings')).json()) as BookingAdminState;
    expect(state.mail).toMatchObject({ sentLast24h: 3, dailyLimit: 3 });
    expect(state.warnings.join(' ')).toContain('plafond de 3 e-mails');
    const list = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(list[2].mailError).toContain('plafond de 3 e-mails par 24 heures atteint');
    // Le lendemain, les envois reprennent.
    ctx.clock.now = new Date('2026-11-16T11:00:01Z');
    expect((await ctx.admin(`/api/booking/bookings/${list[2].id}/resend`, 'POST')).status).toBe(200);
    expect(ctx.sent).toHaveLength(4);
  });

  it('n’attend pas une synchro iCloud trop lente pour confirmer', async () => {
    let syncs = 0;
    const slow = {
      sync: () => {
        syncs++;
        return new Promise<void>(() => undefined); // ne répond jamais
      },
      configured: true,
      getStatus: () => ({ configured: true, running: true, lastSuccessAt: null, lastError: null, lastErrorAt: null }),
    } as unknown as CaldavSync;
    const ctx = await setup({ caldav: slow, syncTimeoutMs: 30 });
    await open(ctx);
    const started = Date.now();
    expect((await bookRequest(ctx)).status).toBe(201);
    expect(syncs).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('répond proprement quand le calendrier refuse l’événement, sans rien enregistrer', async () => {
    const ctx = await setup();
    await open(ctx);
    ctx.store.db.prepare('UPDATE calendars SET read_only = 1').run();
    const res = await bookRequest(ctx);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('calendar_unavailable');
    expect(ctx.booking.listBookings('upcoming')).toEqual([]);
    expect(ctx.sent).toEqual([]);
    const state = (await (await ctx.admin('/api/booking/settings')).json()) as BookingAdminState;
    expect(state.effectiveCalendarId).toBeNull();
    expect(state.warnings.some((w) => w.includes('Aucun calendrier modifiable'))).toBe(true);
  });
});

describe('prise de rendez-vous : annulation', () => {
  it('annule par le lien reçu : événement retiré, réservation marquée, e-mails envoyés', async () => {
    const ctx = await setup();
    await open(ctx);
    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const token = tokenOf(confirmation);
    ctx.sent.length = 0;

    // Page de confirmation : récapitulatif.
    const view = await ctx.json(`/api/public/booking/cancel/${token}`);
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual(confirmation.booking);
    // Consulter n'annule rien.
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(1);

    const res = await ctx.json(`/api/public/booking/cancel/${token}`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...confirmation.booking, status: 'cancelled', cancellable: false, reschedulable: false, emailSent: true });

    expect(ctx.store.occurrences(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))).toEqual([]);
    expect(await (await ctx.admin('/api/booking/bookings')).json()).toEqual([]);
    const [past] = (await (await ctx.admin('/api/booking/bookings?scope=past')).json()) as Booking[];
    expect(past).toMatchObject({ status: 'cancelled', cancelledBy: 'client', cancelledAt: '2026-11-15T11:00:00.000Z', eventState: null });

    expect(ctx.sent).toHaveLength(2);
    expect(ctx.sent[0].to).toEqual({ name: 'Élodie Müller', address: 'elodie@example.org' });
    expect(ctx.sent[0].subject).toContain('Rendez-vous annulé');
    expect(ctx.sent[0].text).toContain('a bien été annulé');
    expect(ctx.sent[1].to).toBe('info@antoinequarroz.ch');
    expect(ctx.sent[1].subject).toBe('Rendez-vous annulé : Consultation, Élodie Müller');

    // Le créneau est de nouveau libre.
    expect(await slotsOf(ctx)).toContain(MONDAY_9);
    expect((await bookRequest(ctx, { email: 'autre@example.org' })).status).toBe(201);
  });

  it('répond la même chose pour un jeton inconnu, mal formé ou déjà utilisé', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    expect((await ctx.json(`/api/public/booking/cancel/${token}`, 'POST')).status).toBe(200);
    ctx.sent.length = 0;

    const unknown = 'A'.repeat(43);
    const answers: { status: number; body: string }[] = [];
    for (const t of [token, unknown, 'court', `${token}x`]) {
      for (const method of ['GET', 'POST']) {
        const res = await ctx.json(`/api/public/booking/cancel/${encodeURIComponent(t)}`, method);
        answers.push({ status: res.status, body: await res.text() });
      }
    }
    expect(new Set(answers.map((a) => `${a.status} ${a.body}`)).size).toBe(1);
    expect(answers[0].status).toBe(404);
    expect(JSON.parse(answers[0].body)).toEqual({ error: 'Ce lien n’est plus valable : rendez-vous introuvable ou déjà annulé.', code: 'not_found' });
    // Une seconde annulation n'envoie rien.
    expect(ctx.sent).toEqual([]);
  });

  it('n’annule qu’une fois quand le lien est cliqué deux fois en même temps', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    ctx.sent.length = 0;
    const results = await Promise.all([1, 2].map(() => ctx.json(`/api/public/booking/cancel/${token}`, 'POST')));
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(ctx.sent).toHaveLength(2);
  });

  it('refuse l’annulation en ligne d’un rendez-vous commencé ou passé', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    ctx.clock.now = new Date('2026-11-16T08:10:00Z');
    const view = (await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as { cancellable: boolean; status: string };
    expect(view).toMatchObject({ status: 'confirmed', cancellable: false });
    const res = await ctx.json(`/api/public/booking/cancel/${token}`, 'POST');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('too_late');
    // Une fois terminé, il passe dans l'historique.
    ctx.clock.now = new Date('2026-11-16T09:00:00Z');
    expect(await (await ctx.admin('/api/booking/bookings')).json()).toEqual([]);
    const past = (await (await ctx.admin('/api/booking/bookings?scope=past')).json()) as Booking[];
    expect(past[0]).toMatchObject({ status: 'confirmed', eventState: 'ok' });
  });

  it('reste possible quand la prise de rendez-vous est refermée', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    await ctx.admin('/api/booking/settings', 'PUT', { enabled: false });
    expect((await ctx.json(`/api/public/booking/cancel/${token}`)).status).toBe(200);
    expect((await ctx.json(`/api/public/booking/cancel/${token}`, 'POST')).status).toBe(200);
  });

  it('signale « événement supprimé » ou « déplacé » quand Antoine a touché à l’événement, et tolère l’annulation', async () => {
    const ctx = await setup();
    await open(ctx);
    const first = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    await bookRequest(ctx, { start: '2026-11-16T09:00:00.000Z', email: 'autre@example.org', name: 'Marc Rey' });
    let list = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(list.map((b) => b.eventState)).toEqual(['ok', 'ok']);

    // Antoine supprime le premier événement et déplace le second (comme dans Apple Calendar, après synchro).
    ctx.store.deleteEvent(list[0].eventId!);
    await ctx.service.update(list[1].eventId!, {
      calendarId: ctx.calendar.id, title: 'Consultation : Marc Rey', start: '2026-11-16T13:00:00.000Z', end: '2026-11-16T13:30:00.000Z', allDay: false,
    }, 'all', null);
    list = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(list[0]).toMatchObject({ status: 'confirmed', eventState: 'missing', eventStart: null });
    // La réservation suit l'événement ; l'horaire que le client connaît est conservé pour l'admin.
    expect(list[1]).toMatchObject({
      status: 'confirmed', eventState: 'moved', start: '2026-11-16T13:00:00.000Z', end: '2026-11-16T13:30:00.000Z',
      eventStart: '2026-11-16T13:00:00.000Z', eventEnd: '2026-11-16T13:30:00.000Z', notifiedStart: '2026-11-16T09:00:00.000Z',
    });
    // Aucun e-mail automatique en v1.1 : seules les deux réservations en ont envoyé.
    expect(ctx.sent).toHaveLength(4);

    // Le client annule quand même : l'événement a déjà disparu, ce n'est pas une erreur.
    const res = await ctx.json(`/api/public/booking/cancel/${tokenOf(first)}`, 'POST');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('cancelled');
  });

  it('retrouve l’événement changé de calendrier : pas « supprimé », et l’annulation le retire bien', async () => {
    const ctx = await setup();
    await open(ctx);
    ctx.store.upsertCalendar({ id: 'local:pro', source: 'local', url: null, name: 'Cabinet', color: '#30a46c', read_only: 0, sort: 1 });
    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const [before] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    // Antoine déplace l'événement dans un autre calendrier : l'identifiant local change, pas l'UID.
    const newId = await ctx.service.update(before.eventId!, {
      calendarId: 'local:pro', title: 'Consultation : Élodie Müller', start: MONDAY_9, end: '2026-11-16T08:30:00.000Z', allDay: false,
    }, 'all', null);
    expect(newId).not.toBe(before.eventId);
    const [after] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(after).toMatchObject({ eventState: 'ok', eventId: newId, calendarId: 'local:pro' });
    // Le client annule : l'événement est retiré du nouveau calendrier et le créneau est libéré.
    const res = await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`, 'POST');
    expect(res.status).toBe(200);
    expect(ctx.store.occurrences(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'))).toEqual([]);
    expect(await slotsOf(ctx)).toContain(MONDAY_9);
  });

  it('complète l’UID d’une réservation d’avant la mise à jour dès que son événement est retrouvé', async () => {
    const ctx = await setup();
    await open(ctx);
    await bookRequest(ctx);
    // Réservation créée avant l'ajout de la colonne : l'UID est complété dès que l'événement est retrouvé.
    ctx.store.db.exec('UPDATE bookings SET event_uid = NULL');
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.eventState).toBe('ok');
    const row = ctx.store.db.prepare('SELECT event_uid FROM bookings').get() as { event_uid: string | null };
    expect(row.event_uid).toBe(ctx.store.getEvent(b.eventId!)!.uid);
  });

  it('suit l’événement déplacé dans le temps : ancien créneau libéré, nouveau protégé avec ses tampons, client à prévenir', async () => {
    const ctx = await setup();
    await open(ctx, { bufferAfterMin: 30 });
    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const token = tokenOf(confirmation);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    // Antoine déplace le rendez-vous au mardi 14:00, dans un calendrier qui ne bloque pas les créneaux.
    await ctx.service.update(b.eventId!, {
      calendarId: ctx.calendar.id, title: 'Consultation : Élodie Müller', start: '2026-11-17T13:00:00.000Z', end: '2026-11-17T13:30:00.000Z', allDay: false,
    }, 'all', null);
    ctx.store.setCalendarBlocksBooking(ctx.calendar.id, false);

    // Lundi 09:00 est de nouveau proposé. Mardi : 13:30 (son propre tampon empiéterait sur 14:00),
    // 14:00 (le rendez-vous) et 14:30 (tampon du rendez-vous) ne le sont pas ; 15:00 l'est.
    expect(await slotsOf(ctx)).toContain(MONDAY_9);
    const tuesday = await slotsOf(ctx, '2026-11-17', '2026-11-17');
    expect(tuesday).toContain('2026-11-17T10:00:00.000Z');
    expect(tuesday).not.toContain('2026-11-17T12:30:00.000Z');
    expect(tuesday).not.toContain('2026-11-17T13:00:00.000Z');
    expect(tuesday).not.toContain('2026-11-17T13:30:00.000Z');
    expect(tuesday).toContain('2026-11-17T14:00:00.000Z');

    // La page d'annulation du client montre le nouvel horaire.
    const view = (await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as { start: string; end: string; cancellable: boolean };
    expect(view).toMatchObject({ start: '2026-11-17T13:00:00.000Z', end: '2026-11-17T13:30:00.000Z', cancellable: true });
    // L'ancien horaire est passé, le nouveau non : l'annulation en ligne reste possible.
    ctx.clock.now = new Date('2026-11-16T12:00:00Z');
    expect(((await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as { cancellable: boolean }).cancellable).toBe(true);
    let [moved] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(moved).toMatchObject({ eventState: 'moved', start: '2026-11-17T13:00:00.000Z', notifiedStart: MONDAY_9 });

    // « Renvoyer l'e-mail » annonce le nouvel horaire : la réservation n'est plus « à prévenir ».
    ctx.sent.length = 0;
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST')).status).toBe(200);
    expect(ctx.sent[0].subject).toContain('mardi 17 novembre 2026, de 14:00 à 14:30');
    [moved] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(moved).toMatchObject({ eventState: 'ok', notifiedStart: null });

    // Remis à l'horaire d'origine après un nouveau déplacement : plus rien à signaler.
    await ctx.service.update(b.eventId!, {
      calendarId: ctx.calendar.id, title: 'Consultation : Élodie Müller', start: '2026-11-18T13:00:00.000Z', end: '2026-11-18T13:30:00.000Z', allDay: false,
    }, 'all', null);
    expect(((await (await ctx.admin('/api/booking/bookings')).json()) as Booking[])[0]).toMatchObject({ eventState: 'moved', notifiedStart: '2026-11-17T13:00:00.000Z' });
    await ctx.service.update(b.eventId!, {
      calendarId: ctx.calendar.id, title: 'Consultation : Élodie Müller', start: '2026-11-17T13:00:00.000Z', end: '2026-11-17T13:30:00.000Z', allDay: false,
    }, 'all', null);
    expect(((await (await ctx.admin('/api/booking/bookings')).json()) as Booking[])[0]).toMatchObject({ eventState: 'ok', notifiedStart: null });
  });

  it('n’envoie pas d’e-mail au client qui annule aussitôt après avoir réservé, et le dit dans la réponse', async () => {
    const ctx = await setup({ service: { quietCancelMinutes: 15 } });
    await open(ctx);
    const slots = await slotsOf(ctx);
    // Aller-retour immédiat : seul Antoine est prévenu, l'adresse saisie ne reçoit pas un second message.
    const first = (await (await bookRequest(ctx, { start: slots[0] })).json()) as BookingConfirmation;
    ctx.sent.length = 0;
    const quick = await ctx.json(`/api/public/booking/cancel/${tokenOf(first)}`, 'POST');
    expect(((await quick.json()) as { status: string; emailSent: boolean })).toMatchObject({ status: 'cancelled', emailSent: false });
    expect(ctx.sent.map((m) => m.to)).toEqual(['info@antoinequarroz.ch']);
    // Plus tard, l'annulation est confirmée par e-mail comme d'habitude.
    const second = (await (await bookRequest(ctx, { start: slots[1] })).json()) as BookingConfirmation;
    ctx.clock.now = new Date('2026-11-15T11:16:00Z');
    ctx.sent.length = 0;
    const later = await ctx.json(`/api/public/booking/cancel/${tokenOf(second)}`, 'POST');
    expect(((await later.json()) as { emailSent: boolean }).emailSent).toBe(true);
    expect(ctx.sent).toHaveLength(2);
  });

  it('annonce « aucun e-mail » à l’annulation quand rien n’a pu partir', async () => {
    const ctx = await setup({ mail: 'none' });
    await open(ctx);
    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const res = await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`, 'POST');
    expect(((await res.json()) as { status: string; emailSent: boolean })).toMatchObject({ status: 'cancelled', emailSent: false });
    const failing = await setup({ mail: 'fail' });
    await open(failing);
    const other = (await (await bookRequest(failing)).json()) as BookingConfirmation;
    const res2 = await failing.json(`/api/public/booking/cancel/${tokenOf(other)}`, 'POST');
    expect(((await res2.json()) as { emailSent: boolean }).emailSent).toBe(false);
  });

  it('laisse Antoine annuler depuis l’admin, avec ou sans e-mail au client', async () => {
    const ctx = await setup();
    await open(ctx);
    await bookRequest(ctx);
    await bookRequest(ctx, { start: '2026-11-16T09:00:00.000Z', email: 'autre@example.org' });
    const [a, b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    ctx.sent.length = 0;

    const res = await ctx.admin(`/api/booking/bookings/${a.id}/cancel`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: a.id, status: 'cancelled', cancelledBy: 'admin', eventState: null, mailError: null });
    // Un seul e-mail : au client (Antoine n'a pas besoin d'être prévenu de ce qu'il fait).
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].to).toEqual({ name: 'Élodie Müller', address: 'elodie@example.org' });
    expect(ctx.sent[0].text).toContain('a dû être annulé');
    expect(ctx.store.getEvent(a.eventId!)).toBeUndefined();

    ctx.sent.length = 0;
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/cancel`, 'POST', { notifyClient: false })).status).toBe(200);
    expect(ctx.sent).toEqual([]);

    const again = await ctx.admin(`/api/booking/bookings/${a.id}/cancel`, 'POST');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('already_cancelled');
    expect((await ctx.admin('/api/booking/bookings/inconnue/cancel', 'POST')).status).toBe(404);
    expect(await slotsOf(ctx)).toHaveLength(14);
  });

  it('garde les réservations d’un type supprimé', async () => {
    const ctx = await setup();
    const type = await open(ctx);
    await bookRequest(ctx);
    expect((await ctx.admin(`/api/booking/types/${type.id}`, 'DELETE')).status).toBe(200);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b).toMatchObject({ typeId: null, typeName: 'Consultation', status: 'confirmed', eventState: 'ok' });
  });
});

describe('prise de rendez-vous : limitation de débit', () => {
  it('limite les réservations par adresse IP, d’après le dernier élément de X-Forwarded-For', async () => {
    const ctx = await setup({ limits: { book: [3, 60_000] } });
    await open(ctx);
    const slots = await slotsOf(ctx);
    // Le client ne peut pas se faire passer pour un autre : seul le dernier élément (posé par Caddy) compte.
    for (let i = 0; i < 3; i++) {
      const res = await bookRequest(ctx, { start: slots[i], email: `c${i}@example.org` }, `10.9.9.${i}, 203.0.113.7`);
      expect(res.status).toBe(201);
    }
    const blocked = await bookRequest(ctx, { start: slots[3], email: 'c3@example.org' }, '10.1.1.1, 203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'Trop de demandes. Réessayez un peu plus tard.', code: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Une autre adresse n'est pas touchée.
    expect((await bookRequest(ctx, { start: slots[3], email: 'c3@example.org' }, '203.0.113.7, 198.51.100.4')).status).toBe(201);
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(4);
  });

  it('limite les lectures et les annulations', async () => {
    const ctx = await setup({ limits: { read: [4, 60_000], cancel: [2, 60_000] } });
    await open(ctx);
    const ip = { ip: '203.0.113.9' };
    for (let i = 0; i < 4; i++) expect((await ctx.json('/api/public/booking', 'GET', undefined, ip)).status).toBe(200);
    expect((await ctx.json('/api/public/booking', 'GET', undefined, ip)).status).toBe(429);
    expect((await ctx.json(`/api/public/booking/cancel/${'A'.repeat(43)}`, 'GET', undefined, ip)).status).toBe(429);
    expect((await ctx.json('/api/public/booking', 'GET', undefined, { ip: '203.0.113.10' })).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await ctx.json(`/api/public/booking/cancel/${'A'.repeat(43)}`, 'POST', undefined, ip)).status).toBe(404);
    expect((await ctx.json(`/api/public/booking/cancel/${'A'.repeat(43)}`, 'POST', undefined, ip)).status).toBe(429);
    // L'API privée n'est pas concernée.
    expect((await ctx.admin('/api/booking/settings')).status).toBe(200);
  });

  it('plafonne les réservations abouties toutes adresses confondues', async () => {
    const ctx = await setup({ limits: { bookGlobal: [2, 60_000] } });
    await open(ctx);
    const slots = await slotsOf(ctx);
    // Des essais ratés ne consomment pas le plafond global.
    for (let i = 0; i < 3; i++) expect((await bookRequest(ctx, { email: 'faux' }, `203.0.113.${i}`)).status).toBe(400);
    for (let i = 0; i < 2; i++) expect((await bookRequest(ctx, { start: slots[i], email: `g${i}@example.org` }, `203.0.113.${20 + i}`)).status).toBe(201);
    expect((await bookRequest(ctx, { start: slots[2], email: 'g2@example.org' }, '203.0.113.30')).status).toBe(429);
  });

  it('limite les demandes de créneaux par adresse, puis toutes adresses confondues', async () => {
    const ctx = await setup({ limits: { slots: [3, 60_000], slotsGlobal: [5, 60_000] } });
    await open(ctx);
    const get = (ip: string) => ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-16', 'GET', undefined, { ip });
    for (let i = 0; i < 3; i++) expect((await get('203.0.113.9')).status).toBe(200);
    const blocked = await get('203.0.113.9');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Les autres lectures et les autres adresses ne sont pas touchées…
    expect((await ctx.json('/api/public/booking', 'GET', undefined, { ip: '203.0.113.9' })).status).toBe(200);
    expect((await get('203.0.113.10')).status).toBe(200);
    expect((await get('203.0.113.11')).status).toBe(200);
    // … jusqu'au plafond global : le calcul des créneaux ne peut pas accaparer le processus.
    expect((await get('203.0.113.12')).status).toBe(429);
    expect((await ctx.admin('/api/booking/settings')).status).toBe(200);
  });

  it('compte à part les essais et les réservations abouties d’une même adresse IP', async () => {
    const ctx = await setup({ limits: { bookOk: [2, 60_000] } });
    await open(ctx);
    const slots = await slotsOf(ctx);
    const ip = '203.0.113.50';
    // Les essais ratés (faute de frappe, créneau pris) ne consomment pas le plafond des réservations abouties.
    for (let i = 0; i < 4; i++) expect((await bookRequest(ctx, { email: 'faux' }, ip)).status).toBe(400);
    // Demandes simultanées : deux passent, pas une de plus.
    const results = await Promise.all([0, 1, 2, 3].map((i) => bookRequest(ctx, { start: slots[i], email: `s${i}@example.org` }, ip)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 429, 429]);
    expect((await bookRequest(ctx, { start: slots[4], email: 's4@example.org' }, ip)).status).toBe(429);
    expect((await bookRequest(ctx, { start: slots[4], email: 's4@example.org' }, '203.0.113.51')).status).toBe(201);
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(3);
  });

  it('borne la mémoire du limiteur et regroupe les adresses IPv6 par /56', () => {
    const limiter = new RateLimiter(2, 1000, 100);
    for (let i = 0; i < 1000; i++) expect(limiter.take(`ip-${i}`, 0).ok).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(100);
    // Fenêtre fixe : la limite tombe, puis se relève.
    expect(limiter.take('a', 0).ok).toBe(true);
    expect(limiter.take('a', 10).ok).toBe(true);
    expect(limiter.take('a', 20)).toEqual({ ok: false, retryAfterSec: 1 });
    expect(limiter.isBlocked('a', 20)).toBe(true);
    expect(limiter.take('a', 1001).ok).toBe(true);
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(rateKey('2001:0db8:0001:0002::1'));
    // Tout un /56 (256 sous-réseaux /64 d'un même abonné ou hébergement) compte pour un seul client.
    expect(rateKey('2001:db8:1:2::1')).toBe(rateKey('2001:db8:1:ff::1'));
    expect(rateKey('2001:db8:1:1200::1')).toBe(rateKey('2001:db8:1:12ff:ffff::9'));
    expect(rateKey('2001:db8:1:1200::1')).not.toBe(rateKey('2001:db8:1:1300::1'));
    expect(rateKey('2001:db8:1:2::1')).not.toBe(rateKey('2001:db8:2:2::1'));
    expect(rateKey('2001:db8:1:12ab::1')).toBe('2001:db8:1:1200::/56');
    expect(rateKey('::1')).toBe('0:0:0:0::/56');
  });
});

/** Mardi 17 novembre, 09:00 à Zurich. */
const TUESDAY_9 = '2026-11-17T08:00:00.000Z';

describe('prise de rendez-vous : rappels', () => {
  it('envoie le rappel 24 h puis 1 h avant, une seule fois chacun, avec un lien de gestion valable', async () => {
    const ctx = await setup();
    await open(ctx);
    const confirmation = (await (await bookRequest(ctx, { start: TUESDAY_9 })).json()) as BookingConfirmation;
    ctx.sent.length = 0;

    ctx.clock.now = new Date('2026-11-16T07:59:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(0);
    ctx.clock.now = new Date('2026-11-16T08:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(1);
    expect(await ctx.booking.sendDueReminders()).toBe(0);
    expect(ctx.sent).toHaveLength(1);
    const reminder = ctx.sent[0];
    expect(reminder.to).toEqual({ name: 'Élodie Müller', address: 'elodie@example.org' });
    expect(reminder.subject).toBe('Rappel : Consultation, demain à 09:00');
    expect(reminder.text).toContain('Petit rappel : votre rendez-vous a lieu demain à 09:00.');
    expect(reminder.text).toContain('Rue du Lac 1, Sion');
    expect(reminder.text).toContain('déplacer ou annuler');
    // Un nouveau lien, distinct de celui de la confirmation, qui fonctionne aussi.
    const link = /https:\/\/alfred\.example\.ch\/rdv\/gerer\/([A-Za-z0-9_-]{43})/.exec(reminder.text)![1];
    expect(link).not.toBe(tokenOf(confirmation));
    expect((await ctx.json(`/api/public/booking/cancel/${link}`)).status).toBe(200);
    expect((await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`)).status).toBe(200);

    ctx.clock.now = new Date('2026-11-17T07:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(1);
    expect(ctx.sent[1].subject).toBe('Rappel : Consultation, aujourd’hui à 09:00');
    expect(ctx.sent[1].text.split('\n')[0]).toBe('Bonjour Élodie Müller,');
    ctx.clock.now = new Date('2026-11-17T07:30:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(0);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.remindersSent).toEqual([24, 1]);
    expect(b.mailError).toBeNull();
  });

  it('n’envoie pas le rappel dont le moment précède la réservation, ni deux messages après une interruption', async () => {
    const ctx = await setup();
    await open(ctx);
    // Pris dimanche 12:00 pour lundi 09:00 : le client connaît l'horaire depuis moins de 24 h.
    await bookRequest(ctx);
    ctx.sent.length = 0;
    ctx.clock.now = new Date('2026-11-15T12:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(0);
    ctx.clock.now = new Date('2026-11-16T07:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(1);
    expect(ctx.sent).toHaveLength(1);

    // Alfred arrêté pendant les deux moments de rappel : un seul message, les deux notés.
    const ctx2 = await setup();
    await open(ctx2);
    await bookRequest(ctx2, { start: TUESDAY_9 });
    ctx2.sent.length = 0;
    ctx2.clock.now = new Date('2026-11-17T07:40:00Z');
    expect(await ctx2.booking.sendDueReminders()).toBe(1);
    expect(await ctx2.booking.sendDueReminders()).toBe(0);
    expect(ctx2.sent[0].subject).toBe('Rappel : Consultation, aujourd’hui à 09:00');
    expect(ctx2.sent[0].html).toContain('Votre rendez-vous commence bientôt');
    expect(((await (await ctx2.admin('/api/booking/bookings')).json()) as Booking[])[0].remindersSent).toEqual([24, 1]);
  });

  it('ne rappelle ni un rendez-vous annulé, ni sans envoi configuré, ni quand les rappels sont désactivés', async () => {
    const ctx = await setup();
    await open(ctx);
    const confirmation = (await (await bookRequest(ctx, { start: TUESDAY_9 })).json()) as BookingConfirmation;
    await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`, 'POST');
    ctx.clock.now = new Date('2026-11-16T09:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(0);

    const none = await setup({ mail: 'none' });
    await open(none);
    await bookRequest(none, { start: TUESDAY_9 });
    none.clock.now = new Date('2026-11-16T09:00:00Z');
    expect(await none.booking.sendDueReminders()).toBe(0);

    const off = await setup();
    await open(off);
    expect((await off.admin('/api/booking/settings', 'PUT', { reminderHours: [] })).status).toBe(200);
    await bookRequest(off, { start: TUESDAY_9 });
    off.sent.length = 0;
    off.clock.now = new Date('2026-11-17T07:30:00Z');
    expect(await off.booking.sendDueReminders()).toBe(0);
    expect(off.sent).toHaveLength(0);
  });

  it('suit les moments de rappel réglés, et refuse des valeurs inconnues', async () => {
    const ctx = await setup();
    await open(ctx);
    const res = await ctx.admin('/api/booking/settings', 'PUT', { reminderHours: [1, 48] });
    expect(((await res.json()) as BookingAdminState).settings.reminderHours).toEqual([48, 1]);
    for (const bad of [[3], 'oui', [24, 24, 24, 24, 24, 24, 24, 24]]) {
      expect((await ctx.admin('/api/booking/settings', 'PUT', { reminderHours: bad })).status).toBe(400);
    }
    expect((await ctx.admin('/api/booking/settings', 'PUT', { changeNoticeHours: 5 })).status).toBe(400);
    expect((await ctx.admin('/api/booking/settings', 'PUT', { allowReschedule: 'oui' })).status).toBe(400);
    await bookRequest(ctx, { start: '2026-11-18T08:00:00.000Z' });
    ctx.sent.length = 0;
    ctx.clock.now = new Date('2026-11-16T08:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(1);
    ctx.clock.now = new Date('2026-11-17T08:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(0);
  });

  it('annonce le nouvel horaire quand Antoine a déplacé l’événement, et le rappel le met à jour', async () => {
    const ctx = await setup();
    await open(ctx);
    await bookRequest(ctx, { start: TUESDAY_9 });
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    // Antoine déplace le rendez-vous au mercredi 14:00 deux jours avant.
    await ctx.service.update(b.eventId!, {
      calendarId: ctx.calendar.id, title: 'Consultation : Élodie Müller', start: '2026-11-18T13:00:00.000Z', end: '2026-11-18T13:30:00.000Z', allDay: false,
    }, 'all', null);
    ctx.sent.length = 0;
    ctx.clock.now = new Date('2026-11-16T08:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(0);
    ctx.clock.now = new Date('2026-11-17T13:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(1);
    expect(ctx.sent[0].subject).toBe('Rappel : Consultation, demain à 14:00');
    expect(ctx.sent[0].text).toContain('l’horaire a changé');
    expect(ctx.sent[0].attachments?.[0].content).toContain('DTSTART;TZID=Europe/Zurich:20261118T140000');
    const [after] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(after).toMatchObject({ eventState: 'ok', notifiedStart: null });
  });

  it('ne propose plus de lien quand il est trop tard pour changer en ligne', async () => {
    const ctx = await setup();
    await open(ctx);
    await ctx.admin('/api/booking/settings', 'PUT', { changeNoticeHours: 24 });
    await bookRequest(ctx, { start: TUESDAY_9 });
    ctx.sent.length = 0;
    ctx.clock.now = new Date('2026-11-17T07:00:00Z');
    expect(await ctx.booking.sendDueReminders()).toBe(1);
    expect(ctx.sent[0].text).toContain('Répondez simplement à cet e-mail.');
    expect(ctx.sent[0].text).not.toContain('/rdv/gerer/');
  });
});

describe('prise de rendez-vous : déplacement par le client', () => {
  async function manageSlots(ctx: Ctx, token: string, from = '2026-11-16', to = '2026-11-17') {
    const res = await ctx.json(`/api/public/booking/manage/${token}/slots?from=${from}&to=${to}`);
    return { res, slots: res.status === 200 ? ((await res.json()) as PublicSlots).days.flatMap((d) => d.slots) : [] };
  }
  const move = (ctx: Ctx, token: string, start: string) => ctx.json(`/api/public/booking/manage/${token}/reschedule`, 'POST', { start });

  it('déplace le rendez-vous : même événement à la nouvelle heure, créneaux mis à jour, e-mails envoyés', async () => {
    const ctx = await setup();
    await open(ctx);
    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const token = tokenOf(confirmation);
    const [before] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    const uid = ctx.store.findEvent(before.eventId, null)!.uid;

    // L'horaire actuel n'est pas proposé ; 09:30, qu'il ne bloque que pour lui-même, l'est.
    const { slots } = await manageSlots(ctx, token);
    expect(slots).not.toContain(MONDAY_9);
    expect(slots).toContain('2026-11-16T08:30:00.000Z');
    expect(slots).toContain(TUESDAY_9);

    ctx.sent.length = 0;
    const res = await move(ctx, token, TUESDAY_9);
    expect(res.status).toBe(200);
    const moved = (await res.json()) as PublicBooking;
    expect(moved).toMatchObject({ start: TUESDAY_9, end: '2026-11-17T08:30:00.000Z', status: 'confirmed', emailSent: true, reschedulable: true });

    // Même événement (même UID), à la nouvelle heure, avec la trace du déplacement.
    const events = (await (await ctx.admin('/api/events?start=2026-11-16T00:00:00Z&end=2026-11-18T00:00:00Z')).json()) as Occurrence[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: TUESDAY_9, title: 'Consultation : Élodie Müller', location: 'Rue du Lac 1, Sion' });
    expect(events[0].description).toContain('Déplacé en ligne par le client (horaire précédent : lundi 16 novembre 2026, de 09:00 à 09:30).');
    expect(ctx.store.findEvent(null, uid)?.startMs).toBe(Date.parse(TUESDAY_9));

    // Lundi 09:00 est libre, mardi 09:00 pris.
    expect(await slotsOf(ctx)).toContain(MONDAY_9);
    expect(await slotsOf(ctx, '2026-11-17', '2026-11-17')).not.toContain(TUESDAY_9);

    // Client : nouvel horaire, ancien pour mémoire, même lien, événement à jour. Antoine : un avis.
    expect(ctx.sent).toHaveLength(2);
    const [toClient, toOwner] = ctx.sent;
    expect(toClient.subject).toBe('Rendez-vous déplacé : Consultation, mardi 17 novembre 2026, de 09:00 à 09:30');
    expect(toClient.text).toContain('Ancien horaire : lundi 16 novembre 2026, de 09:00 à 09:30');
    expect(toClient.text).toContain(confirmation.cancelUrl);
    expect(toClient.attachments?.[0].content).toContain('SEQUENCE:1');
    expect(toOwner.to).toBe('info@antoinequarroz.ch');
    expect(toOwner.subject).toBe('Rendez-vous déplacé : Consultation, Élodie Müller');

    const [after] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(after).toMatchObject({ start: TUESDAY_9, eventState: 'ok', notifiedStart: null, clientReschedules: 1, remindersSent: [] });
    // Le lien reste valable, et l'annulation fonctionne toujours.
    expect((await ctx.json(`/api/public/booking/cancel/${token}`, 'POST')).status).toBe(200);
  });

  it('refuse un créneau pris, le même horaire, un créneau invalide ou un jeton inconnu', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    await bookRequest(ctx, { start: TUESDAY_9, email: 'autre@example.org' });
    expect((await manageSlots(ctx, token)).slots).not.toContain(TUESDAY_9);
    const taken = await move(ctx, token, TUESDAY_9);
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe('slot_unavailable');
    expect(((await (await move(ctx, token, MONDAY_9)).json()) as { code: string }).code).toBe('same_slot');
    expect((await move(ctx, token, '2026-11-16T08:07:00.000Z')).status).toBe(409);
    expect((await move(ctx, token, 'demain')).status).toBe(400);
    expect((await move(ctx, 'x'.repeat(43), TUESDAY_9)).status).toBe(404);
    expect((await manageSlots(ctx, 'x'.repeat(43))).res.status).toBe(404);
    // Rien n'a bougé.
    expect(ctx.booking.listBookings('upcoming').map((b) => b.start)).toEqual([MONDAY_9, TUESDAY_9]);
  });

  it('respecte les réglages : déplacement désactivé, délai avant le rendez-vous, nombre de déplacements', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);

    await ctx.admin('/api/booking/settings', 'PUT', { allowReschedule: false });
    expect(((await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as PublicBooking).reschedulable).toBe(false);
    let res = await move(ctx, token, TUESDAY_9);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('reschedule_disabled');
    expect((await manageSlots(ctx, token)).res.status).toBe(403);

    // Lundi 09:00 est dans 21 heures : avec un délai de 24 heures, ni déplacement ni annulation en ligne.
    await ctx.admin('/api/booking/settings', 'PUT', { allowReschedule: true, changeNoticeHours: 24 });
    const view = (await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as PublicBooking;
    expect(view).toMatchObject({ cancellable: false, reschedulable: false, changeUntil: '2026-11-15T08:00:00.000Z' });
    res = await move(ctx, token, TUESDAY_9);
    expect(((await res.json()) as { code: string; error: string })).toMatchObject({ code: 'too_late' });
    res = await ctx.json(`/api/public/booking/cancel/${token}`, 'POST');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('moins de 24 heures');

    // Trois déplacements au plus.
    await ctx.admin('/api/booking/settings', 'PUT', { changeNoticeHours: 0 });
    for (const start of [TUESDAY_9, '2026-11-17T09:00:00.000Z', '2026-11-17T10:00:00.000Z']) expect((await move(ctx, token, start)).status).toBe(200);
    res = await move(ctx, token, '2026-11-17T12:30:00.000Z');
    expect(((await res.json()) as { code: string }).code).toBe('too_many_changes');

    // Prise de rendez-vous fermée : plus de déplacement, l'annulation reste possible.
    const other = await setup();
    await open(other);
    const t2 = tokenOf((await (await bookRequest(other)).json()) as BookingConfirmation);
    await other.admin('/api/booking/settings', 'PUT', { enabled: false });
    expect((await move(other, t2, TUESDAY_9)).status).toBe(403);
    expect((await other.json(`/api/public/booking/cancel/${t2}`, 'POST')).status).toBe(200);
  });

  it('n’accorde le nouveau créneau qu’une fois quand deux clients le demandent en même temps', async () => {
    const ctx = await setup();
    await open(ctx);
    const a = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    const b = tokenOf((await (await bookRequest(ctx, { start: '2026-11-16T09:00:00.000Z', email: 'b@example.org' })).json()) as BookingConfirmation);
    const results = await Promise.all([move(ctx, a, TUESDAY_9), move(ctx, b, TUESDAY_9)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('ne déplace pas un rendez-vous dont l’événement a été supprimé du calendrier', async () => {
    const ctx = await setup();
    await open(ctx);
    const token = tokenOf((await (await bookRequest(ctx)).json()) as BookingConfirmation);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    await ctx.service.remove(b.eventId!, 'all', null);
    const res = await move(ctx, token, TUESDAY_9);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('not_reschedulable');
    expect(ctx.booking.listBookings('upcoming')[0].start).toBe(MONDAY_9);
  });
});
