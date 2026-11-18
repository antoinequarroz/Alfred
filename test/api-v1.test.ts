// API v1 en lecture et flux iCalendar (phase 4, ALFRED-303).
import { describe, expect, it } from 'vitest';
import type { ApiToken, ApiTokenCreated, ApiV1Busy, ApiV1Event, BookingConfirmation, BookingType, CalendarInfo } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer } from '../server/booking/mail.js';
import { BookingService } from '../server/booking/service.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
/** Dimanche 15 novembre 2026, 12:00 à Zurich. */
const NOW = '2026-11-15T11:00:00Z';

async function setup() {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const service = new CalendarService(store, null, 'Europe/Zurich');
  const mailer: Mailer = { configured: false, from: 'A <a@example.ch>', notifyTo: 'a@example.ch', async send() {} };
  const booking = new BookingService({
    store, calendar: service, caldav: null, timezone: 'Europe/Zurich', mailer,
    publicUrl: 'https://alfred.example.ch', defaultPublicName: 'Antoine', now: () => new Date(NOW), maxPerEmailPerDay: 100, quietCancelMinutes: 0,
  });
  const app = createApp({ store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking, bookingLimits: { bookOk: [1000, 3_600_000] } });
  const request = (path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        'sec-fetch-site': 'same-origin',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  const login = await request('/api/login', { method: 'POST', body: { password: PASSWORD } });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) => request(path, { method, body, cookie });
  const calendarId = store.listCalendars()[0].id;
  const newToken = async (body: Record<string, unknown>) => {
    const res = await admin('/api/tokens', 'POST', body);
    expect(res.status).toBe(201);
    return (await res.json()) as ApiTokenCreated;
  };
  return { app, store, booking, request, admin, calendarId, newToken };
}

describe('API v1 : accès', () => {
  it('demande une session ou un jeton d’API, en lecture seule', async () => {
    const ctx = await setup();
    expect((await ctx.request('/api/v1/calendars')).status).toBe(401);
    expect((await ctx.request('/api/v1')).status).toBe(401);
    expect((await ctx.request('/api/v1/calendars', { bearer: 'alf_faux' })).status).toBe(401);
    expect((await ctx.admin('/api/v1/calendars')).status).toBe(200);

    const created = await ctx.newToken({ name: 'Suite PostMelo' });
    expect(created.token).toMatch(/^alf_[A-Za-z0-9_-]{43}$/);
    expect(created.feedPath).toBeNull();
    const cals = (await (await ctx.request('/api/v1/calendars', { bearer: created.token })).json()) as CalendarInfo[];
    expect(cals.map((c) => c.id)).toEqual([ctx.calendarId]);
    // Seule l'empreinte est gardée ; la liste ne redonne jamais le jeton.
    const list = (await (await ctx.admin('/api/tokens')).json()) as ApiToken[];
    expect(list).toEqual([expect.objectContaining({ id: created.id, name: 'Suite PostMelo', kind: 'api', lastUsedAt: expect.any(String) })]);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(JSON.stringify(ctx.store.db.all('SELECT * FROM api_tokens WHERE space_id = ?', ctx.store.db.spaceId))).not.toContain(created.token);

    // Le jeton n'ouvre que /api/v1, et seulement en lecture.
    expect((await ctx.request('/api/people', { bearer: created.token })).status).toBe(401);
    expect((await ctx.request('/api/tokens', { bearer: created.token })).status).toBe(401);
    expect((await ctx.request('/api/v1/calendars', { method: 'POST', bearer: created.token, body: {} })).status).toBe(405);
    expect((await ctx.request('/api/v1/resolve?address=media://alfred/person/inconnu', { bearer: created.token })).status).toBe(404);

    // Retiré : l'accès est coupé tout de suite.
    expect((await ctx.admin(`/api/tokens/${created.id}`, 'DELETE')).status).toBe(200);
    expect((await ctx.request('/api/v1/calendars', { bearer: created.token })).status).toBe(401);
    expect((await ctx.admin(`/api/tokens/${created.id}`, 'DELETE')).status).toBe(404);
  });

  it('refuse un jeton sans nom ou un flux sans calendrier', async () => {
    const ctx = await setup();
    expect((await ctx.admin('/api/tokens', 'POST', { name: '' })).status).toBe(400);
    expect((await ctx.admin('/api/tokens', 'POST', { name: 'iPhone', kind: 'feed' })).status).toBe(400);
    expect((await ctx.admin('/api/tokens', 'POST', { name: 'iPhone', kind: 'feed', calendarId: 'inconnu' })).status).toBe(400);
    expect((await ctx.admin('/api/tokens', 'POST', { name: 'x', kind: 'admin' })).status).toBe(400);
  });
});

describe('API v1 : lecture', () => {
  it('donne les événements d’une période, récurrences développées, calendriers masqués compris', async () => {
    const ctx = await setup();
    const weekly = { calendarId: ctx.calendarId, title: 'Cours', start: '2026-11-16T08:00:00.000Z', end: '2026-11-16T09:00:00.000Z', allDay: false, repeat: 'weekly' };
    expect((await ctx.admin('/api/events', 'POST', weekly)).status).toBe(201);
    await ctx.admin('/api/events', 'POST', { calendarId: ctx.calendarId, title: 'Congé', start: '2026-11-20', end: '2026-11-21', allDay: true });
    await ctx.admin(`/api/calendars/${encodeURIComponent(ctx.calendarId)}`, 'PATCH', { visible: false });
    const { token } = await ctx.newToken({ name: 'Suite' });

    const res = await ctx.request('/api/v1/events?start=2026-11-16T00:00:00Z&end=2026-12-01T00:00:00Z', { bearer: token });
    expect(res.status).toBe(200);
    const events = (await res.json()) as ApiV1Event[];
    expect(events.map((e) => [e.title, e.start])).toEqual([
      ['Cours', '2026-11-16T08:00:00.000Z'],
      ['Congé', '2026-11-20'],
      ['Cours', '2026-11-23T08:00:00.000Z'],
      ['Cours', '2026-11-30T08:00:00.000Z'],
    ]);
    expect(events[0]).toMatchObject({ calendarId: ctx.calendarId, recurring: true, allDay: false, address: expect.stringMatching(/^media:\/\/alfred\/event\//) });
    expect(events[0].occurrenceId).not.toBeNull();

    // Filtre par calendrier, période invalide ou trop longue.
    expect(((await (await ctx.request(`/api/v1/events?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z&calendar=${encodeURIComponent(ctx.calendarId)}`, { bearer: token })).json()) as ApiV1Event[])).toHaveLength(1);
    expect((await ctx.request('/api/v1/events?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z&calendar=inconnu', { bearer: token })).status).toBe(404);
    expect((await ctx.request('/api/v1/events?start=demain&end=2026-11-17T00:00:00Z', { bearer: token })).status).toBe(400);
    expect((await ctx.request('/api/v1/events?start=2026-01-01T00:00:00Z&end=2028-01-01T00:00:00Z', { bearer: token })).status).toBe(400);
  });

  it('donne l’occupation, les types, leurs créneaux et les réservations', async () => {
    const ctx = await setup();
    expect((await ctx.admin('/api/booking/settings', 'PUT', { enabled: true })).status).toBe(200);
    const type = (await (await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30 })).json()) as BookingType;
    const book = await ctx.request('/api/public/booking/book', { method: 'POST', body: { typeSlug: type.slug, start: '2026-11-16T08:00:00.000Z', name: 'Élodie', email: 'elodie@example.org', message: '', phone: '' } });
    expect(book.status).toBe(201);
    const confirmation = (await book.json()) as BookingConfirmation;
    const { token } = await ctx.newToken({ name: 'Suite' });

    const busy = (await (await ctx.request('/api/v1/busy?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z', { bearer: token })).json()) as ApiV1Busy[];
    expect(busy).toEqual([{ start: '2026-11-16T08:00:00.000Z', end: '2026-11-16T08:30:00.000Z', allDay: false }]);

    const types = (await (await ctx.request('/api/v1/booking-types', { bearer: token })).json()) as { id: string; name: string }[];
    expect(types).toEqual([expect.objectContaining({ id: type.id, name: 'Consultation', durationMin: 30 })]);
    const slots = await ctx.request(`/api/v1/booking-types/${type.id}/slots?from=2026-11-16&to=2026-11-16`, { bearer: token });
    expect(slots.status).toBe(200);
    const day = ((await slots.json()) as { days: { date: string; slots: string[] }[] }).days[0];
    expect(JSON.stringify(day)).not.toContain('2026-11-16T08:00:00.000Z'); // créneau pris

    const bookings = (await (await ctx.request('/api/v1/bookings?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z', { bearer: token })).json()) as Record<string, unknown>[];
    expect(bookings).toEqual([expect.objectContaining({
      status: 'confirmed', name: 'Élodie', email: 'elodie@example.org', start: confirmation.booking.start,
      address: expect.stringMatching(/^media:\/\/alfred\/booking\//), personAddress: expect.stringMatching(/^media:\/\/alfred\/person\//),
    })]);
  });
});

describe('flux iCalendar', () => {
  it('sert un calendrier à un jeton de flux, et à lui seul', async () => {
    const ctx = await setup();
    await ctx.admin('/api/events', 'POST', { calendarId: ctx.calendarId, title: 'Cours', start: '2026-11-16T08:00:00.000Z', end: '2026-11-16T09:00:00.000Z', allDay: false, repeat: 'weekly' });
    const feed = await ctx.newToken({ name: 'iPhone', kind: 'feed', calendarId: ctx.calendarId });
    expect(feed.token).toMatch(/^alfcal_/);
    expect(feed.feedPath).toBe(`/api/v1/feeds/${feed.token}.ics`);

    const res = await ctx.request(feed.feedPath!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const ics = await res.text();
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain('X-WR-CALNAME:Personnel');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT15M');
    expect(ics).toContain('SUMMARY:Cours');
    expect(ics).toContain('RRULE:FREQ=WEEKLY');

    // Jeton faux, jeton d'API, ou jeton de flux présenté comme jeton d'API : refusés.
    const api = await ctx.newToken({ name: 'Suite' });
    expect((await ctx.request('/api/v1/feeds/alfcal_faux.ics')).status).toBe(404);
    expect((await ctx.request(`/api/v1/feeds/${api.token}.ics`)).status).toBe(404);
    expect((await ctx.request('/api/v1/calendars', { bearer: feed.token })).status).toBe(401);

    // Calendrier supprimé ou jeton retiré : le flux s'arrête.
    expect((await ctx.admin(`/api/tokens/${feed.id}`, 'DELETE')).status).toBe(200);
    expect((await ctx.request(feed.feedPath!)).status).toBe(404);
  });
});
