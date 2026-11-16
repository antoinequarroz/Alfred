import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

async function setup() {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const app = createApp({
    store,
    service: new CalendarService(store, null, 'Europe/Zurich'),
    caldav: null,
    passwordHash: await hashPassword('correct horse battery'),
    secureCookies: false,
    sessionDays: 30,
  });
  const json = (path: string, method: string, body?: unknown, cookie?: string) =>
    app.request(path, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { app, json };
}

describe('API', () => {
  it('protège les données derrière la connexion', async () => {
    const { app, json } = await setup();
    expect((await json('/api/events?start=2026-11-01T00:00:00Z&end=2026-12-01T00:00:00Z', 'GET')).status).toBe(401);
    expect((await json('/api/login', 'POST', { password: 'faux' })).status).toBe(401);
    const cross = await app.request('/api/logout', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    expect(cross.status).toBe(403);
  });

  it('bloque après cinq mauvais mots de passe', async () => {
    const { json } = await setup();
    for (let i = 0; i < 5; i++) expect((await json('/api/login', 'POST', { password: 'faux' })).status).toBe(401);
    expect((await json('/api/login', 'POST', { password: 'correct horse battery' })).status).toBe(429);
  });

  it('crée, modifie et supprime un événement local', async () => {
    const { json } = await setup();
    const login = await json('/api/login', 'POST', { password: 'correct horse battery' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const [cal] = (await (await json('/api/calendars', 'GET', undefined, cookie)).json()) as { id: string }[];
    const range = '/api/events?start=2026-11-01T00:00:00Z&end=2026-12-01T00:00:00Z';
    const event = { calendarId: cal.id, title: 'Test', start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T10:00:00.000Z', allDay: false, repeat: 'weekly' };

    const created = await json('/api/events', 'POST', event, cookie);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    let list = (await (await json(range, 'GET', undefined, cookie)).json()) as { title: string; occurrenceId: string }[];
    expect(list).toHaveLength(2);

    const upd = await json(`/api/events/${id}`, 'PUT', { event: { ...event, title: 'Une fois', start: '2026-11-24T10:00:00.000Z', end: '2026-11-24T11:00:00.000Z' }, scope: 'this', occurrenceId: list[1].occurrenceId }, cookie);
    expect(upd.status).toBe(200);
    list = (await (await json(range, 'GET', undefined, cookie)).json()) as { title: string; occurrenceId: string }[];
    expect(list.map((o) => o.title)).toEqual(['Test', 'Une fois']);

    expect((await json(`/api/events/${id}?scope=this&occurrenceId=${encodeURIComponent(list[0].occurrenceId)}`, 'DELETE', undefined, cookie)).status).toBe(200);
    list = (await (await json(range, 'GET', undefined, cookie)).json()) as { title: string; occurrenceId: string }[];
    expect(list.map((o) => o.title)).toEqual(['Une fois']);

    expect((await json(`/api/events/${id}?scope=all`, 'DELETE', undefined, cookie)).status).toBe(200);
    expect(await (await json(range, 'GET', undefined, cookie)).json()).toEqual([]);
    expect((await json('/api/events', 'POST', { ...event, title: '' }, cookie)).status).toBe(400);
  });
});
