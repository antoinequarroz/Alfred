// Connexions réglables depuis l'app : API privée, secrets, priorité app > .env > défaut, SMTP à chaud.
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookingAdminState, CaldavSaveResult, ConnectionsState, ConnectionTest, SmtpSaveResult } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { BookingService } from '../server/booking/service.js';
import { CaldavSync, type CaldavOptions, type ProbeResult } from '../server/caldav.js';
import { ConnectionsService, type ConnectionEnv } from '../server/connections.js';
import type { ConnectionLimits } from '../server/connections-routes.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { KEY_FILE, SecretBox } from '../server/secrets.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';
import { startFakeSmtp, type FakeSmtp } from './helpers/smtp.js';

// Valeurs factices, assemblées pour ne ressembler à aucun vrai secret.
const LOGIN = ['mot', 'de', 'passe', 'alfred'].join(' ');
const passwordHash = await hashPassword(LOGIN);
const SMTP_PASS = ['Factice', 'smtp', 'Zq7'].join('-');
const SMTP_PASS_2 = ['Autre', 'smtp', 'Wx3'].join('-');
const ENV_PASS = ['Env', 'smtp', 'Kp9'].join('-');
const CALDAV_PASS = ['mnbv', 'cxzl', 'kjhg', 'fdsa'].join('-');
const CALDAV_PASS_2 = ['qrst', 'uvwx', 'yzab', 'cdef'].join('-');
const BOX = 'info@antoinequarroz.ch';

/** Toutes les formes sous lesquelles un secret pourrait fuir. */
const forms = (secret: string) => [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret), secret.slice(0, 6), secret.slice(-5)];

interface SetupOptions {
  env?: ConnectionEnv;
  dataDir?: string;
  allowPrivateHosts?: boolean;
  limits?: Partial<ConnectionLimits>;
  resolver?: (host: string) => Promise<string[]>;
  probe?: (opts: CaldavOptions) => Promise<ProbeResult>;
  envKey?: string;
}

const dirs: string[] = [];
const smtps: FakeSmtp[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const s of smtps.splice(0)) await s.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'alfred-connexions-'));
  dirs.push(dir);
  return dir;
};
const fakeSmtp = async (opts?: Parameters<typeof startFakeSmtp>[0]) => {
  const s = await startFakeSmtp(opts);
  smtps.push(s);
  return s;
};

async function setup(opts: SetupOptions = {}) {
  const dataDir = opts.dataDir ?? ':memory:';
  const db = openDb(dataDir);
  dbs.push(db);
  const store = new Store(db);
  store.ensureLocalCalendar();
  const caldav = new CaldavSync(store, null);
  const probed: CaldavOptions[] = [];
  const connections = new ConnectionsService({
    store, caldav, secrets: new SecretBox({ dataDir, envKey: opts.envKey }), env: opts.env,
    allowPrivateHosts: opts.allowPrivateHosts ?? false, smtpRequireTls: false, smtpTimeoutMs: 1500,
    resolver: opts.resolver ?? (async () => ['83.166.143.44']),
    probe: async (o) => {
      probed.push(o);
      return opts.probe ? opts.probe(o) : { ok: true, calendars: 2 };
    },
  });
  // Dans ces tests, la synchro ne doit jamais partir vers un vrai serveur.
  const sync = vi.spyOn(caldav, 'sync').mockResolvedValue();
  caldav.reconfigure(connections.caldavOptions());
  const service = new CalendarService(store, caldav, 'Europe/Zurich');
  const booking = new BookingService({ store, calendar: service, caldav, timezone: 'Europe/Zurich', mailer: connections.mailer, mailProblem: () => connections.smtpProblem(), publicUrl: 'https://alfred.example.ch' });
  connections.mailContext = () => ({ publicName: 'Antoine Quarroz', timezone: 'Europe/Zurich', publicUrl: 'https://alfred.example.ch' });
  const app = createApp({
    store, service, caldav, passwordHash, secureCookies: false, sessionDays: 30, booking, connections,
    connectionLimits: { test: [1000, 60_000], write: [1000, 60_000], ...opts.limits },
  });
  /** Tout ce que le serveur a renvoyé, pour vérifier qu'aucun secret n'en sort. */
  const bodies: string[] = [];
  const raw = async (path: string, method = 'GET', body?: unknown, extra: { cookie?: string | null; headers?: Record<string, string> } = {}) => {
    const res = await app.request(path, {
      method,
      headers: {
        'sec-fetch-site': 'same-origin',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(extra.cookie ? { cookie: extra.cookie } : {}),
        ...extra.headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.clone().text();
    bodies.push(`${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${text}`);
    return res;
  };
  const login = await raw('/api/login', 'POST', { password: LOGIN });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => raw(path, method, body, { cookie, headers });
  const state = async () => (await (await admin('/api/connections')).json()) as ConnectionsState;
  return { app, db, store, caldav, connections, booking, raw, admin, state, bodies, probed, sync, cookie };
}

/** Capture tout ce qui est écrit dans les journaux pendant le test. */
function captureLogs(): string[] {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.stack} ${JSON.stringify(a, Object.getOwnPropertyNames(a))}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  return lines;
}

describe('API des connexions : accès', () => {
  it('exige une session pour tout, lecture comprise', async () => {
    const ctx = await setup();
    for (const [method, path, body] of [
      ['GET', '/api/connections'], ['PUT', '/api/connections/smtp', { host: 'mail.exemple.ch' }], ['POST', '/api/connections/smtp/test'],
      ['DELETE', '/api/connections/smtp'], ['DELETE', '/api/connections/smtp/host'], ['PUT', '/api/connections/caldav', { username: 'a@b.ch', password: CALDAV_PASS }],
      ['POST', '/api/connections/caldav/test'], ['DELETE', '/api/connections/caldav'],
    ] as [string, string, unknown?][]) {
      const res = await ctx.raw(path, method, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toEqual({ error: 'Non connecté' });
    }
    expect(ctx.probed).toHaveLength(0);
    expect((await ctx.raw('/api/connections', 'GET', undefined, { cookie: 'alfred_session=faux' })).status).toBe(401);
  });

  it('refuse les écritures venues d’un autre site et les corps qui ne sont pas du JSON', async () => {
    const ctx = await setup();
    const cross = await ctx.admin('/api/connections/smtp', 'PUT', { host: 'mail.exemple.ch' }, { 'sec-fetch-site': 'cross-site' });
    expect(cross.status).toBe(403);
    const origin = await ctx.admin('/api/connections/smtp', 'DELETE', undefined, { origin: 'https://evil.example', host: 'alfred.example.ch' });
    expect(origin.status).toBe(403);
    const form = await ctx.app.request('/api/connections/smtp', { method: 'PUT', headers: { cookie: ctx.cookie, 'content-type': 'text/plain', origin: 'https://evil.example' }, body: '{"host":"mail.exemple.ch"}' });
    expect(form.status).toBe(403);
    const plain = await ctx.app.request('/api/connections/smtp', { method: 'PUT', headers: { cookie: ctx.cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/xml' }, body: '{"host":"mail.exemple.ch"}' });
    expect(plain.status).toBe(415);
    expect((await ctx.state()).smtp.host).toEqual({ value: 'mail.infomaniak.com', source: 'default' });
  });

  it('borne la taille des corps et ne met rien en cache', async () => {
    const ctx = await setup();
    const big = await ctx.admin('/api/connections/smtp', 'PUT', { user: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    const res = await ctx.admin('/api/connections');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await ctx.admin('/api/connections/inconnu')).status).toBe(404);
    expect((await ctx.admin('/api/connections/smtp', 'PUT', '{pas du json')).status).toBe(400);
  });

  it('limite le débit des essais de connexion', async () => {
    const smtp = await fakeSmtp();
    const ctx = await setup({ limits: { test: [3, 60_000] }, allowPrivateHosts: true });
    await ctx.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1', port: smtp.port, user: BOX, password: SMTP_PASS });
    expect((await ctx.admin('/api/connections/smtp/test', 'POST')).status).toBe(200);
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { test: true })).status).toBe(200);
    expect((await ctx.admin('/api/connections/caldav/test', 'POST', { username: 'a@b.ch', password: CALDAV_PASS })).status).toBe(200);
    // Quatrième essai, quelle que soit la route : refusé, sans connexion sortante.
    const before = smtp.mails.length;
    for (const [method, path, body] of [
      ['POST', '/api/connections/smtp/test'], ['PUT', '/api/connections/smtp', { test: true }], ['PUT', '/api/connections/caldav', { username: 'a@b.ch', password: CALDAV_PASS }],
      ['POST', '/api/connections/caldav/test', {}], ['DELETE', '/api/connections/caldav'],
    ] as [string, string, unknown?][]) {
      const res = await ctx.admin(path, method, body);
      expect(res.status, `${method} ${path}`).toBe(429);
      expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(((await res.json()) as { code: string }).code).toBe('rate_limited');
    }
    expect(smtp.mails).toHaveLength(before);
    expect(ctx.probed).toHaveLength(1);
    // L'ancienne route d'essai de la prise de rendez-vous n'existe plus : la limite ne se contourne pas par là.
    for (let i = 0; i < 3; i++) expect((await ctx.admin('/api/booking/mail/test', 'POST')).status).toBe(404);
    expect(smtp.mails).toHaveLength(before);
    // Enregistrer sans tester reste possible.
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { notifyTo: 'avis@exemple.ch' })).status).toBe(200);
  });
});

describe('API des connexions : priorité app > .env > défaut', () => {
  const env: ConnectionEnv = {
    smtp: { host: 'smtp.env.exemple.ch', user: 'env@exemple.ch', password: ENV_PASS, from: 'Env <env@exemple.ch>' },
    caldav: { username: 'antoine@exemple.ch', password: CALDAV_PASS },
  };

  it('sans rien : valeurs par défaut, rien de configuré', async () => {
    const ctx = await setup();
    const s = await ctx.state();
    expect(s.smtp).toMatchObject({
      configured: false, hasAppValues: false, lastTest: null,
      host: { value: 'mail.infomaniak.com', source: 'default' }, port: { value: '587', source: 'default' }, user: { value: '', source: 'none' },
      password: { configured: false, source: 'none', unreadable: false },
      from: { value: 'Antoine Quarroz <info@antoinequarroz.ch>', source: 'default' }, notifyTo: { value: 'info@antoinequarroz.ch', source: 'default' },
    });
    expect(s.caldav).toMatchObject({
      configured: false, hasAppValues: false, accountLocked: false, canRevertToEnv: false,
      url: { value: 'https://caldav.icloud.com', source: 'default' }, username: { value: '', source: 'none' }, password: { configured: false, source: 'none', unreadable: false },
    });
    expect(s.notices).toEqual([]);
    expect(ctx.connections.mailer.configured).toBe(false);
    expect(ctx.caldav.configured).toBe(false);
  });

  it('le .env passe avant le défaut, l’app avant le .env, réglage par réglage', async () => {
    const ctx = await setup({ env });
    let s = await ctx.state();
    expect(s.smtp).toMatchObject({
      configured: true, hasAppValues: false,
      host: { value: 'smtp.env.exemple.ch', source: 'env' }, port: { value: '587', source: 'default' }, user: { value: 'env@exemple.ch', source: 'env' },
      password: { configured: true, source: 'env', unreadable: false }, from: { value: 'Env <env@exemple.ch>', source: 'env' },
      notifyTo: { value: 'env@exemple.ch', source: 'default' },
    });
    expect(s.caldav).toMatchObject({ configured: true, username: { value: 'antoine@exemple.ch', source: 'env' }, password: { configured: true, source: 'env' } });
    expect(ctx.caldav.configured).toBe(true);

    const saved = await ctx.admin('/api/connections/smtp', 'PUT', { host: 'Mail.App.Exemple.ch', port: '465', notifyTo: 'avis@exemple.ch', password: SMTP_PASS });
    expect(saved.status).toBe(200);
    s = ((await saved.json()) as SmtpSaveResult).state;
    expect(s.smtp).toMatchObject({
      configured: true, hasAppValues: true,
      host: { value: 'mail.app.exemple.ch', source: 'app' }, port: { value: '465', source: 'app' }, user: { value: 'env@exemple.ch', source: 'env' },
      password: { configured: true, source: 'app' }, from: { value: 'Env <env@exemple.ch>', source: 'env' }, notifyTo: { value: 'avis@exemple.ch', source: 'app' },
    });
    expect(ctx.connections.smtpOptions()).toMatchObject({ host: 'mail.app.exemple.ch', port: 465, secure: true, user: 'env@exemple.ch', password: SMTP_PASS, notifyTo: 'avis@exemple.ch', guard: { allowInternal: false } });
  });

  it('une valeur identique à celle du .env ou au défaut n’est pas recopiée dans l’app', async () => {
    const ctx = await setup({ env });
    const res = await ctx.admin('/api/connections/smtp', 'PUT', { host: 'smtp.env.exemple.ch', port: 587, user: 'env@exemple.ch', password: ENV_PASS, from: 'Env <env@exemple.ch>', notifyTo: '' });
    expect(res.status).toBe(200);
    const s = await ctx.state();
    expect(s.smtp.hasAppValues).toBe(false);
    expect(s.smtp.host.source).toBe('env');
    expect(s.smtp.password.source).toBe('env');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    // L'hôte du .env est de confiance : pas de garde-fou réseau sur lui.
    expect(ctx.connections.smtpOptions()?.guard).toBeUndefined();
  });

  it('effacer un réglage, ou tous, redonne la main au .env', async () => {
    const ctx = await setup({ env });
    await ctx.admin('/api/connections/smtp', 'PUT', { host: 'mail.app.exemple.ch', user: 'app@exemple.ch', password: SMTP_PASS, from: 'App <app@exemple.ch>' });
    expect((await ctx.state()).smtp).toMatchObject({ host: { source: 'app' }, user: { value: 'app@exemple.ch', source: 'app' }, password: { source: 'app' }, from: { source: 'app' } });
    expect(ctx.connections.smtpOptions()).toMatchObject({ user: 'app@exemple.ch', password: SMTP_PASS });

    const one = await ctx.admin('/api/connections/smtp/password', 'DELETE');
    expect(one.status).toBe(200);
    // Le mot de passe du .env ne va pas au serveur saisi dans l'app : l'envoi compte comme non configuré.
    expect(((await one.json()) as SmtpSaveResult).state.smtp).toMatchObject({ configured: false, password: { configured: false, source: 'env', otherServer: true }, user: { source: 'app' }, hasAppValues: true });
    expect(ctx.connections.smtpOptions()).toBeNull();
    // Serveur du .env de retour : son mot de passe sert de nouveau.
    await ctx.admin('/api/connections/smtp/host', 'DELETE');
    expect(ctx.connections.smtpOptions()).toMatchObject({ host: 'smtp.env.exemple.ch', user: 'app@exemple.ch', password: ENV_PASS });

    // Un champ vidé dans le formulaire revient lui aussi au .env.
    await ctx.admin('/api/connections/smtp', 'PUT', { user: '' });
    expect((await ctx.state()).smtp.user).toEqual({ value: 'env@exemple.ch', source: 'env' });

    const all = await ctx.admin('/api/connections/smtp', 'DELETE');
    expect(((await all.json()) as SmtpSaveResult).state.smtp).toMatchObject({ hasAppValues: false, host: { value: 'smtp.env.exemple.ch', source: 'env' }, from: { source: 'env' } });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM connection_settings WHERE key LIKE 'smtp.%'").get()).toEqual({ n: 0 });
    expect((await ctx.admin('/api/connections/smtp/inconnu', 'DELETE')).status).toBe(400);
  });

  it('un mot de passe laissé vide garde l’actuel', async () => {
    const smtp = await fakeSmtp();
    const ctx = await setup({ allowPrivateHosts: true });
    await ctx.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1', port: smtp.port, user: BOX, password: SMTP_PASS });
    const sealed = () => (ctx.db.prepare("SELECT value FROM settings WHERE module = 'connections' AND key = 'smtp.password'").get() as { value: string }).value;
    const before = sealed();
    for (const body of [{ user: 'autre@antoinequarroz.ch', password: '' }, { notifyTo: 'avis@exemple.ch' }, { password: '   ' }, { password: null }]) {
      expect((await ctx.admin('/api/connections/smtp', 'PUT', body)).status).toBe(200);
      expect(sealed()).toBe(before);
    }
    expect((await ctx.state()).smtp).toMatchObject({ configured: true, user: { value: 'autre@antoinequarroz.ch' }, password: { configured: true, source: 'app' } });
    const test = ((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test;
    expect(test.ok).toBe(true);
    expect(smtp.logins).toEqual([['autre@antoinequarroz.ch', SMTP_PASS]]);
  });
});

describe('API des connexions : validation', () => {
  it('refuse les hôtes internes, par adresse, par nom, ou par résolution', async () => {
    const resolver = async (host: string) => (host === 'piege.exemple.ch' ? ['172.18.0.12'] : ['83.166.143.44']);
    const ctx = await setup({ resolver });
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '172.18.0.12', '192.168.1.2', '169.254.169.254', '[::1]', 'postgres', 'redis.internal', 'piege.exemple.ch', '2130706433', '0x7f.1']) {
      const res = await ctx.admin('/api/connections/smtp', 'PUT', { host, port: 25, user: BOX, password: SMTP_PASS });
      expect(res.status, host).toBe(400);
      const body = (await res.json()) as { code: string; fields: Record<string, string> };
      expect(body.code).toBe('invalid');
      expect(Object.keys(body.fields)).toEqual(['host']);
    }
    // Rien n'a été enregistré, même pas les autres champs de la même requête.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    for (const url of ['https://127.0.0.1/', 'https://localhost:5232/', 'http://caldav.exemple.ch/', 'https://10.0.0.8/dav', 'https://piege.exemple.ch/', 'https://u:p@caldav.exemple.ch/', 'ftp://caldav.exemple.ch/', 'caldav.exemple.ch', 'https://radicale:5232/']) {
      const res = await ctx.admin('/api/connections/caldav', 'PUT', { url, username: 'a@b.ch', password: CALDAV_PASS });
      expect(res.status, url).toBe(400);
      expect(Object.keys(((await res.json()) as { fields: Record<string, string> }).fields)).toEqual(['url']);
    }
    expect(ctx.probed).toHaveLength(0);
    expect((await ctx.admin('/api/connections/caldav/test', 'POST', { url: 'https://192.168.0.1/', username: 'a@b.ch', password: CALDAV_PASS })).status).toBe(400);
    expect(ctx.probed).toHaveLength(0);
  });

  it('un hôte introuvable s’enregistre quand même (l’essai le dira), un hôte public aussi', async () => {
    const resolver = async (host: string) => {
      if (host === 'absent.exemple.ch') throw new Error('ENOTFOUND');
      return ['83.166.143.44'];
    };
    const ctx = await setup({ resolver });
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { host: 'absent.exemple.ch' })).status).toBe(200);
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { host: 'smtp.exemple.ch' })).status).toBe(200);
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { host: '83.166.143.44' })).status).toBe(200);
  });

  it('n’accepte le bouclage qu’avec la variable de développement', async () => {
    const strict = await setup();
    expect((await strict.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1' })).status).toBe(400);
    const dev = await setup({ allowPrivateHosts: true });
    expect((await dev.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1' })).status).toBe(200);
    expect((await dev.admin('/api/connections/smtp', 'PUT', { host: 'localhost' })).status).toBe(200);
    expect(dev.connections.smtpOptions()).toBeNull();
    const ok = await dev.admin('/api/connections/caldav', 'PUT', { url: 'http://127.0.0.1:5232/', username: 'a@b.ch', password: CALDAV_PASS });
    expect(ok.status).toBe(200);
  });

  it('contrôle le port, les longueurs, les retours à la ligne et les adresses, sans jamais répéter la saisie', async () => {
    const ctx = await setup();
    const marker = ['Saisie', 'Reconnaissable', '42'].join('');
    const cases: [Record<string, unknown>, string][] = [
      [{ port: 0 }, 'port'], [{ port: 65_536 }, 'port'], [{ port: -1 }, 'port'], [{ port: 587.5 }, 'port'], [{ port: `${marker}` }, 'port'], [{ port: '5 87' }, 'port'], [{ port: true }, 'port'],
      [{ host: `mail.exemple.ch\r\n${marker}` }, 'host'], [{ host: `${marker} exemple.ch` }, 'host'], [{ host: 42 }, 'host'], [{ host: `${'a'.repeat(250)}.ch` }, 'host'],
      [{ user: `${marker}\nRCPT TO:<x@y.ch>` }, 'user'], [{ user: `${marker}${'u'.repeat(250)}` }, 'user'], [{ user: ['x'] }, 'user'],
      [{ password: `${marker}\r\nMAIL FROM` }, 'password'], [{ password: `${marker}\u0000` }, 'password'], [{ password: `${marker}${'p'.repeat(1024)}` }, 'password'], [{ password: 12 }, 'password'],
      [{ from: `${marker} <pas-une-adresse>` }, 'from'], [{ from: `${marker}\r\nBcc: x@y.ch <a@b.ch>` }, 'from'], [{ from: `"${marker}" <a@b.ch> <c@d.ch>` }, 'from'], [{ from: `${marker}@` }, 'from'],
      [{ from: `${'n'.repeat(101)} <a@b.ch>` }, 'from'],
      [{ notifyTo: `${marker}` }, 'notifyTo'], [{ notifyTo: `a@b.ch\n${marker}` }, 'notifyTo'], [{ notifyTo: `a@b.ch, ${marker}@d.ch` }, 'notifyTo'],
    ];
    for (const [body, field] of cases) {
      const res = await ctx.admin('/api/connections/smtp', 'PUT', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = (await res.json()) as { code: string; error: string; fields: Record<string, string> };
      expect(json.code).toBe('invalid');
      expect(Object.keys(json.fields), JSON.stringify(body)).toEqual([field]);
    }
    for (const body of [[], 'texte', 12, null]) expect((await ctx.admin('/api/connections/smtp', 'PUT', JSON.stringify(body))).status).toBe(400);
    for (const [body, field] of [
      [{ username: `${marker} avec espace`, password: CALDAV_PASS }, 'username'], [{ username: `a@b.ch\n${marker}`, password: CALDAV_PASS }, 'username'], [{ password: CALDAV_PASS }, 'username'],
      [{ username: 'a@b.ch' }, 'password'], [{ username: 'a@b.ch', password: '' }, 'password'], [{ username: 'a@b.ch', password: `${marker}\n` + 'x' }, 'password'],
      [{ username: 'a@b.ch', password: CALDAV_PASS, url: `https://${marker} x/` }, 'url'], [{ username: 'a@b.ch', password: CALDAV_PASS, url: `https://caldav.exemple.ch/?x=${marker}` }, 'url'],
    ] as [Record<string, unknown>, string][]) {
      const res = await ctx.admin('/api/connections/caldav', 'PUT', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(((await res.json()) as { fields: Record<string, string> }).fields)).toEqual([field]);
    }
    expect(ctx.bodies.join('\n')).not.toContain(marker);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    // Les formes valides de l'expéditeur.
    for (const from of ['Cabinet Quarroz <cabinet@antoinequarroz.ch>', 'cabinet@antoinequarroz.ch', '"Antoine Q." <info@antoinequarroz.ch>']) {
      expect((await ctx.admin('/api/connections/smtp', 'PUT', { from })).status, from).toBe(200);
    }
    expect((await ctx.state()).smtp.from.value).toBe('Antoine Q. <info@antoinequarroz.ch>');
  });
});

describe('les mots de passe ne sortent jamais du serveur', () => {
  it('ni dans une réponse, ni dans un journal, ni en clair dans la base : SMTP', async () => {
    const logs = captureLogs();
    // Le faux serveur n'accepte que SMTP_PASS et répète dans son refus ce qu'il a reçu.
    const smtp = await fakeSmtp({ requireAuth: [BOX, SMTP_PASS] });
    const ctx = await setup({ allowPrivateHosts: true, env: { smtp: { password: ENV_PASS, user: BOX }, caldav: {} } });

    // Mauvais mot de passe : l'enregistrement est accepté, l'essai le signale clairement.
    const wrong = await ctx.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1', port: smtp.port, user: BOX, password: SMTP_PASS_2, test: true });
    expect(wrong.status).toBe(200);
    const wrongBody = (await wrong.json()) as SmtpSaveResult;
    expect(wrongBody.test).toMatchObject({ ok: false, code: 'auth' });
    expect(wrongBody.test!.message).toBe('Identifiants refusés par le serveur d’envoi : vérifie l’identifiant (l’adresse de la boîte) et le mot de passe.');
    expect(wrongBody.state.smtp).toMatchObject({ configured: true, password: { configured: true, source: 'app', unreadable: false }, lastTest: { ok: false, code: 'auth' } });
    expect(smtp.logins).toEqual([[BOX, SMTP_PASS_2]]);

    // Bon mot de passe : enregistré et testé en une action.
    const right = await ctx.admin('/api/connections/smtp', 'PUT', { password: SMTP_PASS, test: true });
    expect(((await right.json()) as SmtpSaveResult).test).toMatchObject({ ok: true, code: 'ok', message: `E-mail d’essai envoyé à ${BOX}.` });
    expect(smtp.mails).toHaveLength(1);

    // Lectures, erreurs de validation, effacement, état de la prise de rendez-vous.
    await ctx.state();
    await ctx.admin('/api/booking/settings');
    await ctx.admin('/api/connections/smtp', 'PUT', { password: SMTP_PASS_2, port: 0 });
    await ctx.admin('/api/connections/smtp', 'PUT', { password: `${SMTP_PASS_2}\n` + 'x' });
    await ctx.admin('/api/connections/smtp/password', 'DELETE');
    await ctx.admin('/api/connections/smtp', 'DELETE');
    await ctx.admin('/api/sync');

    const everything = [...ctx.bodies.slice(1), ...logs].join('\n');
    for (const secret of [SMTP_PASS, SMTP_PASS_2, ENV_PASS]) {
      for (const form of forms(secret)) expect(everything, `fuite de ${form}`).not.toContain(form);
    }
    expect(everything).not.toContain('Authentification refusée pour');
    // Les journaux disent quoi a changé, sans valeur.
    expect(logs.join('\n')).toContain('réglages d’envoi des e-mails modifiés dans l’app (host, port, user, password)');
    expect(logs.some((l) => l.includes('envoi SMTP en échec') && l.includes('auth'))).toBe(true);
  });

  it('en base, le mot de passe est chiffré et lié à son champ', async () => {
    const ctx = await setup();
    await ctx.admin('/api/connections/smtp', 'PUT', { user: BOX, password: SMTP_PASS });
    await ctx.admin('/api/connections/caldav', 'PUT', { username: 'a@b.ch', password: CALDAV_PASS });
    const rows = ctx.db.prepare("SELECT key, value, secret FROM settings WHERE module = 'connections' ORDER BY key").all() as { key: string; value: string; secret: number }[];
    expect(rows.map((r) => [r.key, r.secret])).toEqual([['caldav.password', 1], ['caldav.username', 0], ['smtp.password', 1], ['smtp.passwordFor', 0], ['smtp.user', 0]]);
    const dump = JSON.stringify(rows);
    for (const secret of [SMTP_PASS, CALDAV_PASS]) for (const form of forms(secret)) expect(dump).not.toContain(form);
    for (const r of rows.filter((x) => x.secret)) expect(r.value).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    // Recopié dans l'autre champ, le chiffré ne s'ouvre pas : le mot de passe d'envoi ne devient pas celui du calendrier.
    const smtpSealed = rows.find((r) => r.key === 'smtp.password')!.value;
    ctx.db.prepare("UPDATE settings SET value = ? WHERE module = 'connections' AND key = 'caldav.password'").run(smtpSealed);
    const s = await ctx.state();
    expect(s.caldav.password).toEqual({ configured: false, source: 'app', unreadable: true, otherServer: false });
    expect(s.smtp.password).toEqual({ configured: true, source: 'app', unreadable: false, otherServer: false });
  });

  it('ni dans une réponse ni dans un journal : CalDAV, essais réussis et ratés', async () => {
    const logs = captureLogs();
    let fail = false;
    const ctx = await setup({
      env: { smtp: {}, caldav: { username: 'antoine@exemple.ch', password: CALDAV_PASS } },
      probe: async () => (fail ? { ok: false, code: 'auth', message: 'Identifiants refusés par le serveur de calendrier : vérifie l’identifiant et le mot de passe d’application.' } : { ok: true, calendars: 2 }),
    });
    await ctx.admin('/api/connections/caldav/test', 'POST');
    await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: CALDAV_PASS_2 });
    fail = true;
    await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: SMTP_PASS });
    await ctx.admin('/api/connections/caldav/test', 'POST', { password: SMTP_PASS_2 });
    await ctx.admin('/api/connections/caldav', 'PUT', { username: 'autre@exemple.ch', password: SMTP_PASS });
    await ctx.admin('/api/connections/caldav', 'DELETE');
    await ctx.state();
    const everything = [...ctx.bodies.slice(1), ...logs].join('\n');
    for (const secret of [CALDAV_PASS, CALDAV_PASS_2, SMTP_PASS, SMTP_PASS_2]) {
      for (const form of forms(secret)) expect(everything, `fuite de ${form}`).not.toContain(form);
    }
  });

  it('une erreur interne imprévue est journalisée sans les mots de passe', async () => {
    const logs = captureLogs();
    const ctx = await setup();
    await ctx.admin('/api/connections/smtp', 'PUT', { user: BOX, password: SMTP_PASS });
    vi.spyOn(ctx.connections, 'state').mockImplementation(() => {
      throw new Error(`panne avec ${SMTP_PASS} et https://moi:${SMTP_PASS_2}@exemple.ch/`);
    });
    const res = await ctx.admin('/api/connections');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Erreur interne' });
    const all = logs.join('\n');
    expect(all).toContain('panne avec');
    expect(all).not.toContain(SMTP_PASS);
    expect(all).not.toContain(SMTP_PASS_2);
  });
});

describe('SMTP réglé à chaud', () => {
  it('enregistrer puis envoyer, sans redémarrage ; le bandeau de la prise de rendez-vous disparaît', async () => {
    const smtp = await fakeSmtp({ requireAuth: [BOX, SMTP_PASS] });
    const ctx = await setup({ allowPrivateHosts: true });
    const bookingState = async () => (await (await ctx.admin('/api/booking/settings')).json()) as BookingAdminState;
    let b = await bookingState();
    expect(b.mail.configured).toBe(false);
    expect(b.warnings.some((w) => w.includes('e-mails n’est pas configuré'))).toBe(true);
    const none = ((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test;
    expect(none).toMatchObject({ ok: false, code: 'not_configured' });

    const saved = await ctx.admin('/api/connections/smtp', 'PUT', {
      host: '127.0.0.1', port: smtp.port, user: BOX, password: SMTP_PASS, from: 'Cabinet Quarroz <info@antoinequarroz.ch>', notifyTo: 'avis@antoinequarroz.ch', test: true,
    });
    const body = (await saved.json()) as SmtpSaveResult;
    expect(body.test).toMatchObject({ ok: true, message: 'E-mail d’essai envoyé à avis@antoinequarroz.ch.' });
    expect(body.state.smtp.lastTest?.ok).toBe(true);
    expect(smtp.logins).toEqual([[BOX, SMTP_PASS]]);
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].to).toEqual(['avis@antoinequarroz.ch']);
    expect(smtp.mails[0].raw).toContain('From: Cabinet Quarroz <info@antoinequarroz.ch>');
    expect(smtp.mails[0].raw).not.toContain(SMTP_PASS);

    // Le moteur de la prise de rendez-vous voit tout de suite la nouvelle configuration.
    b = await bookingState();
    expect(b.mail).toMatchObject({ configured: true, from: 'Cabinet Quarroz <info@antoinequarroz.ch>', notifyTo: 'avis@antoinequarroz.ch' });
    expect(b.warnings.some((w) => w.includes('e-mails'))).toBe(false);
    expect(((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test.ok).toBe(true);
    expect(smtp.mails).toHaveLength(2);

    // Changement de port à chaud : l'envoi suivant va vers le nouveau serveur.
    const second = await fakeSmtp();
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { port: second.port, password: SMTP_PASS })).status).toBe(200);
    expect(((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test.ok).toBe(true);
    expect(second.mails).toHaveLength(1);
    expect(smtp.mails).toHaveLength(2);

    // Tout effacer : l'envoi redevient « non configuré », sans redémarrage non plus.
    await ctx.admin('/api/connections/smtp', 'DELETE');
    expect((await bookingState()).mail.configured).toBe(false);
  });

  it('diagnostique en clair : serveur fermé, hôte introuvable, serveur muet', async () => {
    const ctx = await setup({ allowPrivateHosts: true });
    // Port fermé : on ouvre puis on ferme un serveur pour obtenir un port libre.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const test = async (body: Record<string, unknown>) =>
      ((await (await ctx.admin('/api/connections/smtp', 'PUT', { user: BOX, password: SMTP_PASS, ...body, test: true })).json()) as SmtpSaveResult).test!;

    const refused = await test({ host: '127.0.0.1', port });
    expect(refused).toMatchObject({ ok: false, code: 'connection_refused' });
    expect(refused.message).toContain('refuse la connexion');

    const missing = await test({ host: 'serveur-inexistant.invalid', port: 587 });
    expect(missing).toMatchObject({ ok: false, code: 'host_not_found' });
    expect(missing.message).toContain('Hôte introuvable');

    // Un serveur qui accepte la connexion mais ne dit jamais rien : délai dépassé, pas d'attente sans fin.
    const sockets = new Set<Socket>();
    const mute = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      const silent = await test({ host: '127.0.0.1', port: (mute.address() as AddressInfo).port });
      expect(silent).toMatchObject({ ok: false, code: 'timeout' });
      expect(silent.message).toContain('Délai dépassé');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => mute.close(resolve));
    }
  }, 20_000);

  it('revérifie l’hôte au moment de l’envoi : un nom devenu interne après l’enregistrement n’est pas contacté', async () => {
    const smtp = await fakeSmtp();
    // À l'enregistrement, le nom résout vers une adresse publique (résolveur du test) ; à l'envoi,
    // la résolution réelle de « localhost » donne le bouclage : l'envoi doit être refusé.
    const ctx = await setup({ allowPrivateHosts: false });
    ctx.db.prepare("INSERT INTO settings (module, key, value, secret, updated_at) VALUES ('connections', 'smtp.host', 'localhost', 0, '2026-11-16T00:00:00.000Z')").run();
    await ctx.admin('/api/connections/smtp', 'PUT', { port: smtp.port, user: BOX, password: SMTP_PASS });
    const test = ((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test;
    expect(test).toMatchObject({ ok: false, code: 'host_refused' });
    expect(smtp.logins).toHaveLength(0);
  });
});

describe('clé de chiffrement absente ou différente', () => {
  it('l’app démarre, le secret compte comme non configuré, un message demande de le ressaisir', async () => {
    const dir = tempDir();
    const env: ConnectionEnv = { smtp: { user: BOX, password: ENV_PASS }, caldav: { username: 'antoine@exemple.ch', password: CALDAV_PASS } };
    const first = await setup({ dataDir: dir, env });
    await first.admin('/api/connections/smtp', 'PUT', { password: SMTP_PASS });
    await first.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: CALDAV_PASS_2 });
    expect(existsSync(join(dir, KEY_FILE))).toBe(true);
    expect((await first.state()).secretKey).toEqual({ source: 'file', problem: null });
    first.db.close();
    dbs.splice(dbs.indexOf(first.db), 1);

    // Volume restauré sans le fichier de clé.
    unlinkSync(join(dir, KEY_FILE));
    const second = await setup({ dataDir: dir, env });
    const s = await second.state();
    expect(s.smtp).toMatchObject({ configured: false, password: { configured: false, source: 'app', unreadable: true } });
    expect(s.caldav).toMatchObject({ configured: false, accountLocked: true, password: { configured: false, source: 'app', unreadable: true } });
    expect(s.notices).toHaveLength(2);
    expect(s.notices[0]).toContain('Ressaisis-le');
    expect(s.notices[1]).toContain('iCloud');
    // Pas de repli silencieux sur le mot de passe du .env, qui n'est peut-être plus le bon.
    expect(second.connections.mailer.configured).toBe(false);
    expect(second.caldav.configured).toBe(false);
    expect(second.connections.smtpOptions()).toBeNull();
    const test = ((await (await second.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test;
    expect(test).toMatchObject({ ok: false, code: 'not_configured' });
    expect(test.message).toContain('ressaisis-le');
    // Le reste de l'app fonctionne.
    expect((await second.admin('/api/calendars')).status).toBe(200);
    expect((await second.admin('/api/booking/settings')).status).toBe(200);

    // Ressaisie : une nouvelle clé est créée, tout repart, pour le même compte seulement.
    expect((await second.admin('/api/connections/caldav', 'PUT', { username: 'autre@exemple.ch', password: CALDAV_PASS_2 })).status).toBe(409);
    expect((await second.admin('/api/connections/smtp', 'PUT', { password: SMTP_PASS })).status).toBe(200);
    expect((await second.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: CALDAV_PASS_2 })).status).toBe(200);
    const after = await second.state();
    expect(after.notices).toEqual([]);
    expect(after.smtp.configured).toBe(true);
    expect(after.caldav.configured).toBe(true);
    expect(second.caldav.configured).toBe(true);
    expect(readFileSync(join(dir, KEY_FILE))).toHaveLength(32);
  });

  it('avec une clé invalide dans ALFRED_SECRET_KEY, l’enregistrement d’un mot de passe est refusé proprement', async () => {
    const ctx = await setup({ envKey: 'beaucoup-trop-courte' });
    const s = await ctx.state();
    expect(s.secretKey.source).toBe('none');
    expect(s.notices.join(' ')).toContain('ALFRED_SECRET_KEY');
    const res = await ctx.admin('/api/connections/smtp', 'PUT', { user: BOX, password: SMTP_PASS });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('secret_key');
    expect(body.error).not.toContain(SMTP_PASS);
    // Rien n'a été écrit, pas même l'identifiant de la même requête ; les réglages sans secret restent possibles.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { port: 465 })).status).toBe(200);
  });
});

describe('CalDAV réglé depuis l’app (essai de connexion simulé)', () => {
  const env: ConnectionEnv = { smtp: {}, caldav: { username: 'antoine@exemple.ch', password: CALDAV_PASS } };

  it('première configuration : essai, enregistrement, client recréé, synchro lancée', async () => {
    const ctx = await setup();
    expect(ctx.caldav.configured).toBe(false);
    const res = await ctx.admin('/api/connections/caldav', 'PUT', { username: ' Antoine@Exemple.ch ', password: ` ${CALDAV_PASS} ` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaldavSaveResult;
    expect(body.test).toMatchObject({ ok: true, code: 'ok', message: 'Connexion réussie : 2 calendriers trouvés.' });
    expect(body.warning).toBeNull();
    expect(body.state.caldav).toMatchObject({
      configured: true, accountLocked: true, hasAppValues: true, canRevertToEnv: false,
      url: { value: 'https://caldav.icloud.com', source: 'default' }, username: { value: 'Antoine@Exemple.ch', source: 'app' }, password: { configured: true, source: 'app' },
    });
    expect(ctx.probed).toHaveLength(1);
    expect(ctx.probed[0]).toMatchObject({ serverUrl: 'https://caldav.icloud.com', username: 'Antoine@Exemple.ch', password: CALDAV_PASS });
    // L'adresse par défaut est de confiance ; une adresse saisie passe par le garde-fou réseau.
    expect(ctx.probed[0].fetch).toBeUndefined();
    expect(ctx.caldav.configured).toBe(true);
    await ctx.connections.pendingSync;
    expect(ctx.sync).toHaveBeenCalled();
    expect((await (await ctx.admin('/api/sync')).json()) as { configured: boolean }).toMatchObject({ configured: true });
  });

  it('un autre serveur CalDAV saisi dans l’app passe par le garde-fou réseau', async () => {
    const ctx = await setup();
    const res = await ctx.admin('/api/connections/caldav', 'PUT', { url: 'https://dav.exemple.ch/caldav/', username: 'antoine', password: SMTP_PASS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaldavSaveResult;
    // Pas d'avertissement « forme Apple » pour un autre serveur.
    expect(body.warning).toBeNull();
    expect(body.state.caldav.url).toEqual({ value: 'https://dav.exemple.ch/caldav', source: 'app' });
    expect(typeof ctx.probed[0].fetch).toBe('function');
    expect(typeof ctx.connections.caldavOptions()?.fetch).toBe('function');
  });

  it('avertit, sans bloquer, quand le mot de passe n’a pas la forme d’un mot de passe d’application Apple', async () => {
    const ctx = await setup();
    for (const ok of [CALDAV_PASS, CALDAV_PASS.replace(/-/g, '')]) {
      const body = (await (await ctx.admin('/api/connections/caldav/test', 'POST', { username: 'a@b.ch', password: ok })).json()) as { warning: string | null };
      expect(body.warning).toBeNull();
    }
    for (const odd of [SMTP_PASS, 'abcdefghijklmno', 'ABCD-EFGH-IJKL-MNOP', 'abcd-efghijkl-mnop']) {
      const res = await ctx.admin('/api/connections/caldav/test', 'POST', { username: 'a@b.ch', password: odd });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warning: string | null; test: ConnectionTest };
      expect(body.warning).toContain('16 lettres minuscules');
      expect(body.warning).not.toContain(odd);
      expect(body.test.ok).toBe(true);
    }
    const saved = (await (await ctx.admin('/api/connections/caldav', 'PUT', { username: 'a@b.ch', password: SMTP_PASS })).json()) as CaldavSaveResult;
    expect(saved.warning).toContain('16 lettres minuscules');
    expect(saved.state.caldav.configured).toBe(true);
  });

  it('change le mot de passe du même compte ; refuse un autre identifiant ou un autre serveur', async () => {
    const ctx = await setup({ env });
    const before = ctx.connections.caldavOptions();
    expect(before).toMatchObject({ username: 'antoine@exemple.ch', password: CALDAV_PASS });

    for (const body of [
      { username: 'quelquun.dautre@exemple.ch', password: CALDAV_PASS_2 },
      { username: 'antoine@exemple.ch', password: CALDAV_PASS_2, url: 'https://dav.exemple.ch/' },
    ]) {
      const res = await ctx.admin('/api/connections/caldav', 'PUT', body);
      expect(res.status).toBe(409);
      const json = (await res.json()) as { code: string; error: string };
      expect(json.code).toBe('account_change');
      expect(json.error).toContain('Changer de compte');
      expect(json.error).toContain('même identifiant');
      expect((await ctx.admin('/api/connections/caldav/test', 'POST', body)).status).toBe(409);
    }
    expect(ctx.probed).toHaveLength(0);
    expect(ctx.connections.caldavOptions()).toEqual(before);

    // Même identifiant (la casse et l'adresse par défaut répétée ne comptent pas) : accepté.
    const res = await ctx.admin('/api/connections/caldav', 'PUT', { username: 'ANTOINE@exemple.ch', password: CALDAV_PASS_2, url: 'https://caldav.icloud.com/' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaldavSaveResult;
    expect(body.state.caldav).toMatchObject({ configured: true, password: { source: 'app' }, canRevertToEnv: true, hasAppValues: true });
    expect(ctx.connections.caldavOptions()).toMatchObject({ password: CALDAV_PASS_2 });
  });

  it('essai échoué : rien n’est enregistré, l’ancienne configuration reste active', async () => {
    let result: ProbeResult = { ok: false, code: 'auth', message: 'Identifiants refusés par le serveur de calendrier : vérifie l’identifiant et le mot de passe d’application.' };
    const ctx = await setup({ env, probe: async () => result });
    const reconfigure = vi.spyOn(ctx.caldav, 'reconfigure');
    ctx.sync.mockClear();
    const res = await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: SMTP_PASS });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { code: string; reason: string; error: string };
    expect(json).toMatchObject({ code: 'connection_failed', reason: 'auth' });
    expect(json.error).toContain('Identifiants refusés');
    expect(json.error).toContain('la synchro continue avec la configuration actuelle');
    expect(json.error).toContain('16 lettres minuscules');
    expect(reconfigure).not.toHaveBeenCalled();
    expect(ctx.sync).not.toHaveBeenCalled();
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    expect(ctx.connections.caldavOptions()).toMatchObject({ password: CALDAV_PASS });
    const s = await ctx.state();
    // L'essai d'identifiants refusés, jamais enregistrés, ne reste pas affiché comme celui de la configuration en place.
    expect(s.caldav).toMatchObject({ configured: true, password: { source: 'env' }, lastTest: null });
    const candidate = (await (await ctx.admin('/api/connections/caldav/test', 'POST', { username: 'antoine@exemple.ch', password: SMTP_PASS })).json()) as CaldavSaveResult;
    expect(candidate.test).toMatchObject({ ok: false, code: 'auth' });
    expect(candidate.state.caldav.lastTest).toBeNull();
    // L'essai de la configuration en place (corps vide), lui, est gardé.
    const current = (await (await ctx.admin('/api/connections/caldav/test', 'POST', {})).json()) as CaldavSaveResult;
    expect(current.state.caldav.lastTest).toMatchObject({ ok: false, code: 'auth' });
    expect(ctx.probed.at(-1)).toMatchObject({ username: 'antoine@exemple.ch', password: CALDAV_PASS });

    result = { ok: true, calendars: 1 };
    const ok = (await (await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: CALDAV_PASS_2 })).json()) as CaldavSaveResult;
    expect(ok.test.message).toBe('Connexion réussie : 1 calendrier trouvé.');
    expect(reconfigure).toHaveBeenCalledTimes(1);
  });

  it('revenir au .env : seulement pour le même compte, et seulement si ses identifiants fonctionnent', async () => {
    let envWorks = false;
    const ctx = await setup({ env, probe: async (o) => (o.password === CALDAV_PASS && !envWorks ? { ok: false, code: 'auth', message: 'Identifiants refusés.' } : { ok: true, calendars: 2 }) });
    await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: CALDAV_PASS_2 });
    // Le mot de passe du .env ne marche plus (c'est pour ça qu'il a été changé dans l'app) : on ne casse pas la synchro.
    const refused = await ctx.admin('/api/connections/caldav', 'DELETE');
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain('la configuration de l’app reste active');
    expect(ctx.connections.caldavOptions()).toMatchObject({ password: CALDAV_PASS_2 });
    envWorks = true;
    const ok = await ctx.admin('/api/connections/caldav', 'DELETE');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as CaldavSaveResult).state.caldav).toMatchObject({ hasAppValues: false, password: { source: 'env' }, username: { source: 'env' } });
    expect(ctx.connections.caldavOptions()).toMatchObject({ password: CALDAV_PASS });

    // Sans identifiants dans le .env, il n'y a rien vers quoi revenir.
    const alone = await setup();
    await alone.admin('/api/connections/caldav', 'PUT', { username: 'a@b.ch', password: CALDAV_PASS });
    const no = await alone.admin('/api/connections/caldav', 'DELETE');
    expect(no.status).toBe(409);
    expect(((await no.json()) as { code: string }).code).toBe('no_env');
    expect(alone.caldav.configured).toBe(true);
  });

  it('un compte dont les calendriers sont en base reste « en place » même si son mot de passe a disparu du .env', async () => {
    const ctx = await setup({ env: { smtp: {}, caldav: { username: 'antoine@exemple.ch' } } });
    expect((await ctx.state()).caldav.accountLocked).toBe(false);
    ctx.store.upsertCalendar({ id: 'caldav:x', source: 'caldav', url: 'https://p42-caldav.icloud.com/1/calendars/home/', name: 'Perso', color: '#0a84ff', read_only: 0, sort: 0 });
    expect((await ctx.state()).caldav).toMatchObject({ accountLocked: true, configured: false, calendars: 1 });
    expect((await ctx.admin('/api/connections/caldav', 'PUT', { username: 'autre@exemple.ch', password: CALDAV_PASS })).status).toBe(409);
    expect((await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@exemple.ch', password: CALDAV_PASS })).status).toBe(200);
  });
});

describe('un mot de passe ne part que vers le serveur pour lequel il a été saisi', () => {
  it('SMTP, mot de passe du .env : changer de serveur sans le ressaisir est refusé, et rien ne part vers le nouveau serveur', async () => {
    const legit = await fakeSmtp();
    const thief = await fakeSmtp();
    const env: ConnectionEnv = { smtp: { host: '127.0.0.1', port: String(legit.port), user: BOX, password: ENV_PASS }, caldav: {} };
    const ctx = await setup({ env, allowPrivateHosts: true });
    for (const body of [{ host: 'localhost', port: thief.port, test: true }, { port: thief.port, test: true }, { host: 'localhost', port: thief.port, password: '' }]) {
      const res = await ctx.admin('/api/connections/smtp', 'PUT', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: Record<string, string> }).fields).toEqual({ password: 'Ressaisis le mot de passe : le serveur ou le port change' });
    }
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    expect(((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test.ok).toBe(true);
    expect(legit.logins).toEqual([[BOX, ENV_PASS]]);
    expect(thief.logins).toEqual([]);

    // Avec un nouveau mot de passe, le changement passe : c'est celui-là, et lui seul, qui va au nouveau serveur.
    const moved = await ctx.admin('/api/connections/smtp', 'PUT', { host: 'localhost', port: thief.port, password: SMTP_PASS, test: true });
    expect(moved.status).toBe(200);
    expect(thief.logins).toEqual([[BOX, SMTP_PASS]]);
    // Même identique à celui du .env, un mot de passe saisi pour un serveur de l'app est enregistré dans l'app, pour ce serveur.
    await ctx.admin('/api/connections/smtp', 'PUT', { password: ENV_PASS });
    expect((await ctx.state()).smtp.password).toMatchObject({ configured: true, source: 'app' });
    // Le mot de passe de l'app retiré : celui du .env ne suit pas vers le serveur de l'app.
    await ctx.admin('/api/connections/smtp/password', 'DELETE');
    const s = await ctx.state();
    expect(s.smtp).toMatchObject({ configured: false, password: { configured: false, source: 'env', otherServer: true } });
    expect(s.notices.join(' ')).toContain('n’est pas utilisé avec un serveur réglé dans l’app');
    const test = ((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test;
    expect(test).toMatchObject({ ok: false, code: 'not_configured' });
    expect(thief.logins).toHaveLength(1);
    for (const form of forms(ENV_PASS)) for (const body of ctx.bodies) expect(body).not.toContain(form);
  });

  it('SMTP, mot de passe de l’app : il reste lié à son serveur, même si l’hôte change par un autre chemin', async () => {
    const legit = await fakeSmtp();
    const thief = await fakeSmtp();
    const ctx = await setup({ allowPrivateHosts: true });
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1', port: legit.port, user: BOX, password: SMTP_PASS, test: true })).status).toBe(200);
    expect(legit.logins).toEqual([[BOX, SMTP_PASS]]);

    const refused = await ctx.admin('/api/connections/smtp', 'PUT', { host: 'localhost', port: thief.port, test: true });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { fields: Record<string, string> }).fields.password).toContain('Ressaisis le mot de passe');
    expect(thief.logins).toEqual([]);
    // Les autres réglages se changent toujours sans ressaisir le mot de passe.
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1', port: legit.port, notifyTo: 'avis@exemple.ch', user: BOX })).status).toBe(200);

    // Hôte ou port modifié sans passer par l'enregistrement (réglage retiré, ligne changée en base) :
    // le mot de passe, lié à sa destination, n'est plus utilisé.
    ctx.db.prepare("UPDATE settings SET value = ? WHERE module = 'connections' AND key = 'smtp.port'").run(String(thief.port));
    await ctx.admin('/api/connections/smtp', 'PUT', {}); // vide le cache de l'expéditeur
    let s = await ctx.state();
    expect(s.smtp).toMatchObject({ configured: false, password: { configured: false, source: 'app', unreadable: false, otherServer: true } });
    expect(s.notices.join(' ')).toContain('enregistré pour un autre serveur');
    expect(ctx.connections.smtpOptions()).toBeNull();
    expect(((await (await ctx.admin('/api/connections/smtp/test', 'POST')).json()) as { test: ConnectionTest }).test).toMatchObject({ ok: false, code: 'not_configured' });
    // Même en recopiant la destination à la main, le chiffré ne s'ouvre pas : elle fait partie des données authentifiées.
    ctx.db.prepare("UPDATE settings SET value = ? WHERE module = 'connections' AND key = 'smtp.passwordFor'").run(`127.0.0.1:${thief.port}`);
    s = await ctx.state();
    expect(s.smtp.password).toMatchObject({ configured: false, unreadable: true });
    expect(thief.logins).toEqual([]);

    // Retirer le serveur de l'app (retour à celui par défaut) n'emmène pas non plus le mot de passe.
    ctx.db.prepare("UPDATE settings SET value = ? WHERE module = 'connections' AND key = 'smtp.passwordFor'").run(`127.0.0.1:${legit.port}`);
    ctx.db.prepare("UPDATE settings SET value = ? WHERE module = 'connections' AND key = 'smtp.port'").run(String(legit.port));
    expect((await ctx.state()).smtp.configured).toBe(true);
    await ctx.admin('/api/connections/smtp/host', 'DELETE');
    expect((await ctx.state()).smtp).toMatchObject({ configured: false, host: { value: 'mail.infomaniak.com' }, password: { otherServer: true } });
    // Ressaisi pour le nouveau serveur : tout repart.
    expect((await ctx.admin('/api/connections/smtp', 'PUT', { host: 'localhost', port: thief.port, password: SMTP_PASS_2, test: true })).status).toBe(200);
    expect(thief.logins).toEqual([[BOX, SMTP_PASS_2]]);
  });

  it('CalDAV : le mot de passe du .env n’est pas envoyé à une autre adresse ni avec un autre identifiant', async () => {
    // .env avec un mot de passe mais sans identifiant : aucun compte n'est « en place ».
    const ctx = await setup({ env: { smtp: {}, caldav: { password: CALDAV_PASS } }, allowPrivateHosts: true });
    for (const body of [{ username: 'voleur@exemple.org', url: 'https://dav.exemple.org' }, { username: 'voleur@exemple.org' }]) {
      const res = await ctx.admin('/api/connections/caldav/test', 'POST', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: Record<string, string> }).fields.password).toContain('Saisis le mot de passe d’application');
    }
    expect(ctx.probed).toHaveLength(0);
    // Compte en place par le .env : un essai avec un autre identifiant ne reprend pas son mot de passe non plus.
    const locked = await setup({ env: { smtp: {}, caldav: { username: 'antoine@exemple.ch', password: CALDAV_PASS } } });
    expect((await locked.admin('/api/connections/caldav/test', 'POST', { username: 'autre@exemple.ch' })).status).toBe(400);
    expect(locked.probed).toHaveLength(0);
    // L'essai de la configuration en place, lui, utilise bien le mot de passe enregistré.
    expect((await locked.admin('/api/connections/caldav/test', 'POST', {})).status).toBe(200);
    expect(locked.probed).toHaveLength(1);
    expect(locked.probed[0]).toMatchObject({ username: 'antoine@exemple.ch', password: CALDAV_PASS });
  });
});

describe('calendriers déjà en base sans identifiant connu', () => {
  const HOME = 'https://p42-caldav.icloud.com/1234/calendars/home/';
  it('seul le compte qui retrouve ces calendriers peut être relié', async () => {
    let urls: string[] | undefined = ['https://p07-caldav.icloud.com/9999/calendars/home/'];
    const ctx = await setup({ probe: async () => ({ ok: true, calendars: urls?.length ?? 2, urls }) });
    ctx.store.upsertCalendar({ id: 'caldav:x', source: 'caldav', url: HOME, name: 'Perso', color: '#0a84ff', read_only: 0, sort: 0 });
    ctx.sync.mockClear();

    // Un autre compte (ou une faute dans l'identifiant) : refusé, rien n'est enregistré, aucune synchro ne part.
    const res = await ctx.admin('/api/connections/caldav', 'PUT', { username: 'quelquun.dautre@icloud.com', password: CALDAV_PASS });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe('account_change');
    expect(json.error).toContain('aucun des calendriers déjà enregistrés');
    const tested = (await (await ctx.admin('/api/connections/caldav/test', 'POST', { username: 'quelquun.dautre@icloud.com', password: CALDAV_PASS })).json()) as CaldavSaveResult;
    expect(tested.test).toMatchObject({ ok: false, code: 'account_change' });
    // Un essai qui ne dit pas quels calendriers il a trouvés ne suffit pas.
    urls = undefined;
    expect((await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@icloud.com', password: CALDAV_PASS })).status).toBe(409);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_settings').get()).toEqual({ n: 0 });
    expect(ctx.caldav.configured).toBe(false);
    expect(ctx.sync).not.toHaveBeenCalled();
    expect(ctx.store.listCalendars().filter((c) => c.source === 'caldav')).toHaveLength(1);

    // Le bon compte retrouve le calendrier (à une barre finale près) : accepté.
    urls = [HOME.replace(/\/$/, ''), 'https://p42-caldav.icloud.com/1234/calendars/travail/'];
    const ok = await ctx.admin('/api/connections/caldav', 'PUT', { username: 'antoine@icloud.com', password: CALDAV_PASS });
    expect(ok.status).toBe(200);
    expect(ctx.caldav.configured).toBe(true);
    expect(ctx.sync).toHaveBeenCalledTimes(1);
  });
});

describe('dernier essai d’envoi', () => {
  it('un échec reste signalé dans la rubrique Rendez-vous, et survit à un redémarrage', async () => {
    const smtp = await fakeSmtp({ requireAuth: [BOX, SMTP_PASS] });
    const dataDir = tempDir();
    let ctx = await setup({ dataDir, allowPrivateHosts: true });
    const warnings = async () => ((await (await ctx.admin('/api/booking/settings')).json()) as BookingAdminState).warnings;
    const wrong = await ctx.admin('/api/connections/smtp', 'PUT', { host: '127.0.0.1', port: smtp.port, user: BOX, password: SMTP_PASS_2, test: true });
    expect(((await wrong.json()) as SmtpSaveResult).test).toMatchObject({ ok: false, code: 'auth' });
    // Identifiant et mot de passe sont en place, mais l'essai a échoué : l'en-tête le dit.
    let w = await warnings();
    expect(w.some((x) => x.includes('n’est pas configuré'))).toBe(false);
    expect(w.find((x) => x.startsWith('Le dernier essai d’envoi d’e-mails a échoué'))).toContain('Identifiants refusés par le serveur d’envoi');

    // Redémarrage : même base, nouveau service.
    ctx = await setup({ dataDir, allowPrivateHosts: true });
    expect((await ctx.state()).smtp).toMatchObject({ configured: true, lastTest: { ok: false, code: 'auth' } });
    w = await warnings();
    expect(w.some((x) => x.startsWith('Le dernier essai d’envoi d’e-mails a échoué'))).toBe(true);
    // Ce qui est gardé en base est le diagnostic, sans rien de sensible, et ne compte pas comme un réglage.
    const row = ctx.db.prepare("SELECT value, secret FROM settings WHERE module = 'connections' AND key = 'status.smtp.lastTest'").get() as { value: string };
    for (const form of [...forms(SMTP_PASS_2), ...forms(SMTP_PASS)]) expect(row.value).not.toContain(form);

    // Bon mot de passe, essai réussi : l'avertissement disparaît, et le reste après un redémarrage.
    await ctx.admin('/api/connections/smtp', 'PUT', { password: SMTP_PASS, test: true });
    expect((await warnings()).some((x) => x.includes('e-mails'))).toBe(false);
    ctx = await setup({ dataDir, allowPrivateHosts: true });
    expect((await ctx.state()).smtp.lastTest).toMatchObject({ ok: true });
    await ctx.admin('/api/connections/smtp', 'DELETE');
    expect((await ctx.state()).smtp).toMatchObject({ lastTest: null, hasAppValues: false });
  });

  it('l’état dit si le fichier .env suffit à envoyer (pour « Revenir au fichier .env »)', async () => {
    const none = await setup();
    await none.admin('/api/connections/smtp', 'PUT', { user: BOX, password: SMTP_PASS });
    expect((await none.state()).smtp).toMatchObject({ hasAppValues: true, envConfigured: false });
    const withEnv = await setup({ env: { smtp: { user: BOX, password: ENV_PASS }, caldav: {} } });
    expect((await withEnv.state()).smtp.envConfigured).toBe(true);
    const half = await setup({ env: { smtp: { user: BOX }, caldav: {} } });
    expect((await half.state()).smtp.envConfigured).toBe(false);
  });
});

describe('migration', () => {
  it('ajoute la table à une base existante qui ne l’a pas, sans toucher au reste, et se rejoue sans effet', () => {
    const dir = tempDir();
    // Base « d'avant » : le schéma actuel moins la table, avec des données.
    const old = openDb(dir);
    old.exec('DROP TABLE connection_settings');
    const store = new Store(old);
    store.ensureLocalCalendar();
    old.prepare("INSERT INTO booking_settings (key, value) VALUES ('publicName', 'Antoine Quarroz')").run();
    const calendars = store.listCalendars().length;
    const hours = (old.prepare('SELECT COUNT(*) AS n FROM booking_hours').get() as { n: number }).n;
    old.close();
    const raw = new DatabaseSync(join(dir, 'alfred.db'));
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection_settings'").get()).toBeUndefined();
    raw.close();

    for (let pass = 0; pass < 2; pass++) {
      const db = openDb(dir);
      // space_id : ajoutée à toute table qui n'en a pas (phase 4, server/migrations.ts).
      const columns = (db.prepare('PRAGMA table_info(connection_settings)').all() as unknown as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(['key', 'value', 'secret', 'updated_at', 'space_id']);
      expect(new Store(db).listCalendars()).toHaveLength(calendars);
      expect((db.prepare('SELECT COUNT(*) AS n FROM booking_hours').get() as { n: number }).n).toBe(hours);
      expect((db.prepare("SELECT value FROM booking_settings WHERE key = 'publicName'").get() as { value: string }).value).toBe('Antoine Quarroz');
      if (pass === 0) db.prepare("INSERT INTO connection_settings (key, value, secret, updated_at) VALUES ('smtp.host', 'mail.exemple.ch', 0, '2026-11-16T00:00:00.000Z')").run();
      else expect(db.prepare('SELECT value FROM connection_settings').get()).toEqual({ value: 'mail.exemple.ch' });
      db.close();
    }
  });

  it('une base mise à jour sans rien régler dans l’app se comporte comme avant : tout vient du .env', async () => {
    const ctx = await setup({ env: { smtp: {}, caldav: { url: 'https://caldav.icloud.com', username: 'antoine@exemple.ch', password: CALDAV_PASS } } });
    const s = await ctx.state();
    expect(s.caldav).toMatchObject({ configured: true, hasAppValues: false, url: { source: 'env' }, username: { source: 'env' }, password: { source: 'env' } });
    expect(s.smtp.configured).toBe(false);
    expect(ctx.connections.caldavOptions()).toEqual({ serverUrl: 'https://caldav.icloud.com', username: 'antoine@exemple.ch', password: CALDAV_PASS, fetch: undefined });
    expect(ctx.caldav.configured).toBe(true);
  });
});
