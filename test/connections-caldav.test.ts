// Identifiants CalDAV réglés depuis l'app, contre un vrai serveur (Radicale).
// Lancer : RADICALE_URL=http://127.0.0.1:5232 RADICALE_USER=antoine RADICALE_PASSWORD=secret npm test
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaldavSaveResult, ConnectionsState, ConnectionTest } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { CaldavSync, probeCaldav } from '../server/caldav.js';
import { ConnectionsService, type ConnectionEnv } from '../server/connections.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { SecretBox } from '../server/secrets.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const url = process.env.RADICALE_URL;
const user = process.env.RADICALE_USER ?? '';
const password = process.env.RADICALE_PASSWORD ?? '';
const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
// Mot de passe volontairement faux, assemblé pour ne ressembler à aucun vrai secret.
const FAUX = ['faux', 'mot', 'de', 'passe', 'Zq4'].join('-');
const LOGIN = ['mot', 'de', 'passe', 'alfred'].join(' ');

afterEach(() => vi.restoreAllMocks());

async function setup(env: ConnectionEnv, allowPrivateHosts = true) {
  const store = new Store(openDb(':memory:'));
  const caldav = new CaldavSync(store, null);
  const connections = new ConnectionsService({ store, caldav, secrets: new SecretBox({ dataDir: ':memory:' }), env, allowPrivateHosts, caldavTimeoutMs: 15_000 });
  caldav.reconfigure(connections.caldavOptions());
  const service = new CalendarService(store, caldav, 'Europe/Zurich');
  const app = createApp({
    store, service, caldav, passwordHash: await hashPassword(LOGIN), secureCookies: false, sessionDays: 30, connections,
    connectionLimits: { test: [100, 60_000] },
  });
  const login = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: LOGIN }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { store, caldav, connections, service, admin };
}

describe.skipIf(!url)('identifiants CalDAV réglés depuis l’app (Radicale)', () => {
  it('diagnostique un essai de connexion : réussi, identifiants refusés, serveur absent', async () => {
    const ok = await probeCaldav({ serverUrl: url!, username: user, password });
    expect(ok.ok).toBe(true);
    const refused = await probeCaldav({ serverUrl: url!, username: user, password: FAUX });
    expect(refused).toMatchObject({ ok: false, code: 'auth' });
    expect(JSON.stringify(refused)).not.toContain(FAUX);
    // Un port libre : ouvert puis refermé.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const absent = await probeCaldav({ serverUrl: `http://127.0.0.1:${port}/`, username: user, password });
    expect(absent).toMatchObject({ ok: false, code: 'connection_refused' });
    const notDav = await probeCaldav({ serverUrl: 'http://serveur-inexistant.invalid/', username: user, password });
    expect(notDav).toMatchObject({ ok: false, code: 'host_not_found' });
  }, 30_000);

  it('change le mot de passe à chaud : la synchro en échec repart sans redémarrage, et l’écriture suit', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    const name = `reglages-${Date.now()}`;
    expect((await fetch(`${url}/${user}/${name}/`, { method: 'MKCALENDAR', headers: { authorization: auth } })).status).toBe(201);
    // Le .env porte un mot de passe périmé (révoqué chez Apple, par exemple).
    const ctx = await setup({ smtp: {}, caldav: { url, username: user, password: FAUX } });
    await ctx.caldav.sync();
    const failing = ctx.caldav.getStatus();
    expect(failing.lastError).toBe('Identifiants refusés par le serveur de calendrier : vérifie l’identifiant et le mot de passe d’application.');
    expect(ctx.store.listCalendars()).toHaveLength(0);

    // Un autre identifiant est refusé avant tout essai de connexion.
    const other = await ctx.admin('/api/connections/caldav', 'PUT', { username: `${user}-autre`, password });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { code: string }).code).toBe('account_change');

    // Le bon mot de passe, même identifiant : essai, enregistrement, client recréé, synchro lancée.
    const saved = await ctx.admin('/api/connections/caldav', 'PUT', { username: user, password });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as CaldavSaveResult;
    expect(body.test.ok).toBe(true);
    expect(body.test.message).toMatch(/^Connexion réussie : \d+ calendriers? trouvés?\.$/);
    expect(body.state.caldav).toMatchObject({ configured: true, password: { configured: true, source: 'app' }, url: { source: 'env' } });
    await ctx.connections.pendingSync;
    const status = ctx.caldav.getStatus();
    expect(status.lastError).toBeNull();
    expect(status.lastSuccessAt).not.toBeNull();
    const cal = ctx.store.listCalendars().find((c) => c.url?.endsWith(`/${name}/`))!;
    expect(cal).toBeDefined();
    const state = (await (await ctx.admin('/api/connections')).json()) as ConnectionsState;
    expect(state.caldav.calendars).toBeGreaterThanOrEqual(1);
    expect(state.caldav.sync.lastError).toBeNull();

    // L'écriture passe par le nouveau client.
    const id = await ctx.service.create({ calendarId: cal.id, title: 'Après changement de mot de passe', start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T10:00:00.000Z', allDay: false });
    const remote = await fetch(ctx.store.getEvent(id)!.href!, { headers: { authorization: auth } });
    expect(await remote.text()).toContain('SUMMARY:Après changement de mot de passe');

    // Essai raté ensuite : rien ne change, la synchro continue de fonctionner avec l'ancienne configuration.
    const wrong = await ctx.admin('/api/connections/caldav', 'PUT', { username: user, password: FAUX });
    expect(wrong.status).toBe(422);
    const failure = (await wrong.json()) as { code: string; reason: string; error: string };
    expect(failure).toMatchObject({ code: 'connection_failed', reason: 'auth' });
    expect(failure.error).toContain('la synchro continue avec la configuration actuelle');
    expect(ctx.connections.caldavOptions()).toMatchObject({ username: user, password });
    await fetch(new URL('ext-reglages.ics', cal.url!).href, {
      method: 'PUT', headers: { authorization: auth, 'content-type': 'text/calendar' },
      body: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//FR', 'BEGIN:VEVENT', 'UID:ext-reglages', 'DTSTAMP:20261116T000000Z', 'DTSTART:20261118T100000Z', 'DTEND:20261118T110000Z', 'SUMMARY:Ajouté ailleurs', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
    });
    await ctx.caldav.sync();
    expect(ctx.caldav.getStatus().lastError).toBeNull();
    const titles = ctx.store.occurrences(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z')).filter((o) => o.calendarId === cal.id).map((o) => o.title).sort();
    expect(titles).toEqual(['Ajouté ailleurs', 'Après changement de mot de passe']);

    // Un essai de la configuration actuelle, sans rien saisir.
    const test = ((await (await ctx.admin('/api/connections/caldav/test', 'POST')).json()) as { test: ConnectionTest }).test;
    expect(test.ok).toBe(true);

    expect((await fetch(cal.url!, { method: 'DELETE', headers: { authorization: auth } })).status).toBeLessThan(300);
    const all = logs.join('\n');
    expect(all).not.toContain(FAUX);
    expect(all).not.toContain(Buffer.from(`${user}:${FAUX}`).toString('base64'));
    expect(all).not.toContain(Buffer.from(`${user}:${password}`).toString('base64'));
  }, 60_000);

  it('première configuration avec une adresse saisie dans l’app : acceptée seulement avec la variable de développement', async () => {
    const strict = await setup({ smtp: {}, caldav: {} }, false);
    const refused = await strict.admin('/api/connections/caldav', 'PUT', { url, username: user, password });
    expect(refused.status).toBe(400);
    expect(strict.caldav.configured).toBe(false);

    const dev = await setup({ smtp: {}, caldav: {} }, true);
    expect(dev.caldav.configured).toBe(false);
    const saved = await dev.admin('/api/connections/caldav', 'PUT', { url, username: user, password });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as CaldavSaveResult).state.caldav).toMatchObject({ configured: true, url: { source: 'app' }, username: { source: 'app' }, accountLocked: true });
    // La synchro passe par le fetch vérifié (adresse venue de l'app) et aboutit.
    await dev.connections.pendingSync;
    expect(dev.caldav.getStatus()).toMatchObject({ configured: true, lastError: null });
    expect(dev.caldav.getStatus().lastSuccessAt).not.toBeNull();
  }, 60_000);

  it('calendriers en base sans identifiant connu : le vrai essai reconnaît le compte auquel ils appartiennent', async () => {
    const probe = await probeCaldav({ serverUrl: url!, username: user, password });
    if (!probe.ok || !probe.urls?.length) return; // compte sans calendrier : rien à reconnaître
    // Calendrier d'un autre compte en base : relier ce compte-ci le supprimerait, c'est refusé.
    const other = await setup({ smtp: {}, caldav: {} }, true);
    other.store.upsertCalendar({ id: 'caldav:ailleurs', source: 'caldav', url: `${url}/quelquun-dautre/agenda/`, name: 'Ailleurs', color: '#0a84ff', read_only: 0, sort: 0 });
    const refused = await other.admin('/api/connections/caldav', 'PUT', { url, username: user, password });
    expect(refused.status).toBe(409);
    expect(other.caldav.configured).toBe(false);
    expect(other.store.getCalendar('caldav:ailleurs')).toBeDefined();
    // Un calendrier de ce compte en base : accepté.
    const same = await setup({ smtp: {}, caldav: {} }, true);
    same.store.upsertCalendar({ id: 'caldav:connu', source: 'caldav', url: probe.urls[0], name: 'Connu', color: '#0a84ff', read_only: 0, sort: 0 });
    const ok = await same.admin('/api/connections/caldav', 'PUT', { url, username: user, password });
    expect(ok.status).toBe(200);
    await same.connections.pendingSync;
  }, 60_000);
});
