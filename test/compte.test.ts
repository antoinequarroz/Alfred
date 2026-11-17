import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { settings } from '../server/compte.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const ISSUER = 'https://compte.test/api/auth';
/** Mot de passe de secours, tiré au sort à chaque lancement. */
const BACKUP = randomUUID();
const compte = settings({
  COMPTE_URL: 'https://compte.test',
  COMPTE_CLIENT_ID: 'alfred',
  COMPTE_CLIENT_SECRET: 'x'.repeat(40),
  APP_URL: 'https://alfred.test',
});

type Claims = Record<string, unknown>;

/** Faux service de compte : découverte et échange du code, comme Better Auth. */
function fakeCompte(claims: (nonce: string) => Claims, { down = false } = {}) {
  let lastNonce = '';
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (down) throw new TypeError('fetch failed');
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth2/authorize`, token_endpoint: `${ISSUER}/oauth2/token`, end_session_endpoint: `${ISSUER}/oauth2/endsession` });
    }
    if (url === `${ISSUER}/oauth2/token`) {
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code')).toBe('le-code');
      expect(body.get('redirect_uri')).toBe('https://alfred.test/api/auth/compte/callback');
      const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return Response.json({ id_token: `${part({ alg: 'RS256' })}.${part(claims(lastNonce))}.sig` });
    }
    return new Response('introuvable', { status: 404 });
  });
  return { calls, setNonce: (n: string) => (lastNonce = n) };
}

async function setup(allowed: string[] = [], withCompte = true, s = compte) {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const app = createApp({
    store,
    service: new CalendarService(store, null, 'Europe/Zurich'),
    caldav: null,
    passwordHash: await hashPassword(BACKUP),
    secureCookies: false,
    sessionDays: 30,
    compte: withCompte ? { settings: s, allowed } : undefined,
  });
  return app;
}

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

/** Parcours complet : /start, le service « connecte » la personne, puis /callback. */
async function signIn(app: Awaited<ReturnType<typeof setup>>, fake: ReturnType<typeof fakeCompte>, tamperState = false) {
  const start = await app.request('/api/auth/compte/start');
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get('location')!);
  expect(to.origin + to.pathname).toBe(`${ISSUER}/oauth2/authorize`);
  expect(to.searchParams.get('client_id')).toBe('alfred');
  expect(to.searchParams.get('code_challenge_method')).toBe('S256');
  fake.setNonce(to.searchParams.get('nonce')!);
  const pending = cookieOf(start, 'compte_pending')!;
  expect(pending).toBeTruthy();
  const state = tamperState ? 'autre' : to.searchParams.get('state')!;
  return app.request(`/api/auth/compte/callback?code=le-code&state=${state}&iss=${encodeURIComponent(ISSUER)}`, { headers: { cookie: pending } });
}

const now = () => Math.floor(Date.now() / 1000);
const antoine = (nonce: string): Claims => ({ iss: ISSUER, aud: 'alfred', nonce, exp: now() + 300, sub: 'u1', email: 'antoine@exemple.ch', name: 'Antoine', role: 'admin' });

afterEach(() => vi.unstubAllGlobals());

describe('connexion avec le compte PostMelo', () => {
  it('ouvre une session Alfred pour un administrateur de la suite', async () => {
    const app = await setup();
    const fake = fakeCompte(antoine);
    const res = await signIn(app, fake);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const session = cookieOf(res, 'alfred_session')!;
    expect(session).toBeTruthy();
    const me = await (await app.request('/api/me', { headers: { cookie: session } })).json();
    expect(me).toEqual({ authenticated: true, compte: true });
    expect((await app.request('/api/calendars', { headers: { cookie: session } })).status).toBe(200);
  });

  it('refuse un membre qui n\'est pas dans la liste, accepte celui qui y est', async () => {
    const member = (nonce: string) => ({ ...antoine(nonce), sub: 'u2', email: 'Marie@Exemple.ch', role: 'member' });
    let app = await setup();
    let res = await signIn(app, fakeCompte(member));
    expect(res.headers.get('location')).toMatch(/^\/\?compte_erreur=.*pas%20acc%C3%A8s/);
    expect(cookieOf(res, 'alfred_session')).toBeUndefined();

    app = await setup(['marie@exemple.ch']);
    res = await signIn(app, fakeCompte(member));
    expect(res.headers.get('location')).toBe('/');
    expect(cookieOf(res, 'alfred_session')).toBeTruthy();
  });

  it('refuse un retour dont l\'état ne correspond pas', async () => {
    const app = await setup();
    const res = await signIn(app, fakeCompte(antoine), true);
    expect(res.headers.get('location')).toMatch(/^\/\?compte_erreur=La%20connexion%20a%20expir/);
    expect(cookieOf(res, 'alfred_session')).toBeUndefined();
  });

  it('refuse un jeton émis pour un autre outil ou avec un autre nonce', async () => {
    let app = await setup();
    let res = await signIn(app, fakeCompte((n) => ({ ...antoine(n), aud: 'cairn' })));
    expect(res.headers.get('location')).toMatch(/compte_erreur=/);
    app = await setup();
    res = await signIn(app, fakeCompte((n) => ({ ...antoine(n), nonce: n + 'x' })));
    expect(res.headers.get('location')).toMatch(/compte_erreur=/);
    expect(cookieOf(res, 'alfred_session')).toBeUndefined();
  });

  it('service de compte en panne : retour à la connexion, le mot de passe de secours marche', async () => {
    // Une autre adresse : la découverte réussie des autres tests est gardée en mémoire par adresse.
    const app = await setup([], true, settings({ COMPTE_URL: 'https://panne.test', COMPTE_CLIENT_SECRET: 'x'.repeat(40), COMPTE_CLIENT_ID: 'alfred', APP_URL: 'https://alfred.test' }));
    fakeCompte(antoine, { down: true });
    const res = await app.request('/api/auth/compte/start');
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('mot de passe de secours');
    const login = await app.request('/api/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ password: BACKUP }),
    });
    expect(login.status).toBe(200);
  });

  it('sans configuration : pas de bouton, routes absentes', async () => {
    const app = await setup([], false);
    expect(await (await app.request('/api/me')).json()).toEqual({ authenticated: false, compte: false });
    expect((await app.request('/api/auth/compte/start')).status).toBe(404);
    expect((await app.request('/api/auth/compte/callback?code=a&state=b')).status).toBe(404);
  });

  it('un secret trop court désactive la connexion par compte', () => {
    expect(settings({ COMPTE_URL: 'https://compte.test', COMPTE_CLIENT_ID: 'alfred', COMPTE_CLIENT_SECRET: 'court', APP_URL: 'https://alfred.test' })).toBeNull();
  });
});
