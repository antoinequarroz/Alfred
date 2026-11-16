// API de la prise de rendez-vous, contre le calendrier local.
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Booking, BookingAdminState, BookingConfirmation, BookingType, CalendarInfo, Occurrence, PublicBookingInfo, PublicSlots,
} from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer, MailMessage } from '../server/booking/mail.js';
import type { BookingLimits } from '../server/booking/routes.js';
import { BookingService, hashToken, locationLabel, slugify } from '../server/booking/service.js';
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
      if (mode !== 'ok') throw new Error('connexion SMTP refusée');
      sent.push(message);
    },
  };
  const booking = new BookingService({
    store, calendar: service, caldav: opts.caldav ?? null, timezone: 'Europe/Zurich', mailer,
    publicUrl: 'https://alfred.example.ch', defaultPublicName: 'Antoine Quarroz', now: () => clock.now,
    syncTimeoutMs: opts.syncTimeoutMs,
  });
  const app = createApp({
    store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking, bookingLimits: opts.limits,
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
      ['/api/booking/mail/test', 'POST'],
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
    expect(Object.keys(withCookie.types[0]).sort()).toEqual(['description', 'durationMin', 'horizonDays', 'locationLabel', 'mode', 'name', 'phoneRequired', 'slug']);
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
    expect(state.settings).toEqual({ enabled: false, publicName: 'Antoine Quarroz', welcomeText: '', calendarId: null, slotStepMin: 30 });
    expect(state.effectiveCalendarId).toBe(ctx.calendar.id);
    expect(state.timezone).toBe('Europe/Zurich');
    expect(state.publicPageUrl).toBe('https://alfred.example.ch/rdv');
    expect(state.mail).toEqual({ configured: true, from: 'Antoine Quarroz <info@antoinequarroz.ch>', notifyTo: 'info@antoinequarroz.ch' });
    expect(state.warnings.join(' ')).toContain('Aucun type de rendez-vous actif');
    expect(state.warnings.join(' ')).toContain('fermée');

    const res = await ctx.admin('/api/booking/settings', 'PUT', {
      enabled: true, publicName: 'Cabinet Quarroz', welcomeText: 'Bienvenue.\nChoisissez un créneau.', calendarId: ctx.calendar.id, slotStepMin: 15,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()) as BookingAdminState;
    expect(next.settings).toEqual({
      enabled: true, publicName: 'Cabinet Quarroz', welcomeText: 'Bienvenue.\nChoisissez un créneau.', calendarId: ctx.calendar.id, slotStepMin: 15,
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
      db.close();
      db = openDb(dir);
      const store = new Store(db);
      expect(store.listCalendars()[0].blocks_booking).toBe(1);
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
      { slug: 'premiere-seance-decouverte', name: 'Première séance (découverte)', durationMin: 45, description: '', mode: 'cabinet', locationLabel: 'Au cabinet', phoneRequired: false, horizonDays: 60 },
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
    // Mardi : journée entière opaque. Mercredi : journée entière « disponible » (anniversaire).
    save('conge', ['DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118', 'SUMMARY:Congé']);
    save('anniv', ['DTSTART;VALUE=DATE:20261118', 'DTEND;VALUE=DATE:20261119', 'SUMMARY:Anniversaire', 'TRANSP:TRANSPARENT']);
    // Jeudi : série hebdomadaire 09:00-10:00 dont l'occurrence du 19 est « disponible » par exception.
    save('serie', ['DTSTART:20261112T080000Z', 'DTEND:20261112T090000Z', 'SUMMARY:Cours', 'RRULE:FREQ=WEEKLY']);

    const res = await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-19');
    const days = ((await res.json()) as PublicSlots).days;
    expect(days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-18', '2026-11-19']);
    expect(days[0].slots).toHaveLength(12);
    expect(days[0].slots).not.toContain('2026-11-16T15:00:00.000Z');
    expect(days[0].slots).toContain('2026-11-16T08:00:00.000Z');
    expect(days[0].slots).toContain('2026-11-16T12:30:00.000Z');
    expect(days[1].slots).toHaveLength(14);
    expect(days[2].slots).toHaveLength(12);
    expect(days[2].slots[0]).toBe('2026-11-19T09:00:00.000Z');
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
    const res = await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-01&to=2026-12-15');
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
      locationLabel: 'Rue du Lac 1, Sion', name: 'Élodie Müller', status: 'confirmed', cancellable: true,
    });
    expect(confirmation.emailSent).toBe(true);
    expect(confirmation.cancelUrl).toMatch(/^https:\/\/alfred\.example\.ch\/rdv\/annulation\/[A-Za-z0-9_-]{43}$/);

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
      [{ name: 'x'.repeat(81) }, 'name'],
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

  it('limite le nombre de rendez-vous à venir pour une même adresse', async () => {
    const ctx = await setup();
    await open(ctx);
    const slots = await slotsOf(ctx);
    for (let i = 0; i < 5; i++) expect((await bookRequest(ctx, { start: slots[i] })).status).toBe(201);
    const res = await bookRequest(ctx, { start: slots[5], email: 'ELODIE@example.org' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('too_many_bookings');
    expect((await bookRequest(ctx, { start: slots[5], email: 'autre@example.org' })).status).toBe(201);
  });

  it('conserve la réservation quand l’e-mail échoue, et le signale dans l’admin', async () => {
    const ctx = await setup({ mail: 'fail' });
    await open(ctx);
    const res = await bookRequest(ctx);
    expect(res.status).toBe(201);
    const confirmation = (await res.json()) as BookingConfirmation;
    expect(confirmation.emailSent).toBe(false);
    expect(confirmation.cancelUrl).toContain('/rdv/annulation/');
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(b.status).toBe('confirmed');
    expect(b.eventState).toBe('ok');
    expect(b.mailError).toContain('Confirmation au client : envoi en échec');
    expect(b.mailError).toContain('connexion SMTP refusée');
    const test = await ctx.admin('/api/booking/mail/test', 'POST');
    expect(test.status).toBe(502);
    expect(((await test.json()) as { code: string }).code).toBe('mail_failed');
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
    expect((await ctx.admin('/api/booking/mail/test', 'POST')).status).toBe(400);
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST')).status).toBe(400);
  });

  it('envoie un message d’essai et renvoie une confirmation avec un nouveau lien', async () => {
    const ctx = await setup();
    await open(ctx);
    const test = await ctx.admin('/api/booking/mail/test', 'POST');
    expect(await test.json()).toEqual({ ok: true, to: 'info@antoinequarroz.ch' });
    expect(ctx.sent[0].subject).toBe('Essai d’envoi depuis Alfred');

    const confirmation = (await (await bookRequest(ctx)).json()) as BookingConfirmation;
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    ctx.sent.length = 0;
    const resend = await ctx.admin(`/api/booking/bookings/${b.id}/resend`, 'POST');
    expect(resend.status).toBe(200);
    expect(ctx.sent).toHaveLength(1);
    const link = /https:\/\/alfred\.example\.ch\/rdv\/annulation\/[A-Za-z0-9_-]{43}/.exec(ctx.sent[0].text)![0];
    expect(link).not.toBe(confirmation.cancelUrl);
    // L'ancien lien ne fonctionne plus, le nouveau oui.
    expect((await ctx.json(`/api/public/booking/cancel/${tokenOf(confirmation)}`)).status).toBe(404);
    expect((await ctx.json(`/api/public/booking/cancel/${link.split('/').pop()}`)).status).toBe(200);
  });

  it('n’attend pas une synchro iCloud trop lente pour confirmer', async () => {
    let syncs = 0;
    const slow = {
      sync: () => {
        syncs++;
        return new Promise<void>(() => undefined); // ne répond jamais
      },
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
    expect(await res.json()).toEqual({ ...confirmation.booking, status: 'cancelled', cancellable: false });

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
    expect(list[1]).toMatchObject({ status: 'confirmed', eventState: 'moved', eventStart: '2026-11-16T13:00:00.000Z', eventEnd: '2026-11-16T13:30:00.000Z' });
    // Aucun e-mail automatique en v1.1 : seules les deux réservations en ont envoyé.
    expect(ctx.sent).toHaveLength(4);

    // Le client annule quand même : l'événement a déjà disparu, ce n'est pas une erreur.
    const res = await ctx.json(`/api/public/booking/cancel/${tokenOf(first)}`, 'POST');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('cancelled');
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
    // Les essais ratés comptent aussi, et une autre adresse n'est pas touchée.
    expect((await bookRequest(ctx, { start: slots[3], email: 'c3@example.org' }, '203.0.113.7, 198.51.100.4')).status).toBe(201);
    expect(ctx.booking.listBookings('upcoming')).toHaveLength(4);
  });

  it('limite les lectures et les annulations', async () => {
    const ctx = await setup({ limits: { read: [4, 60_000], cancel: [2, 60_000] } });
    await open(ctx);
    const ip = { ip: '203.0.113.9' };
    for (let i = 0; i < 4; i++) expect((await ctx.json('/api/public/booking', 'GET', undefined, ip)).status).toBe(200);
    expect((await ctx.json('/api/public/booking', 'GET', undefined, ip)).status).toBe(429);
    expect((await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-16', 'GET', undefined, ip)).status).toBe(429);
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

  it('borne la mémoire du limiteur et regroupe les adresses IPv6 par /64', () => {
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
    expect(rateKey('2001:db8:1:2::1')).not.toBe(rateKey('2001:db8:1:3::1'));
    expect(rateKey('::1')).toBe('0:0:0:0::/64');
  });
});
