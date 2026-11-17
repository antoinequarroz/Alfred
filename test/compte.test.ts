import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { settings } from '../server/compte.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const SECRET = 'un-secret-de-test-de-plus-de-32-caracteres';
const APP_URL = 'http://alfred.test';

/** Faux service de compte : annonce OpenID Connect et échange de code, comme compte.postmelo.ch. */
let server: Server;
let issuer = '';
/** Ce que le faux service répond à l'échange du code. */
let answer: { status: number; claims?: Record<string, unknown> } = { status: 200 };
let lastTokenRequest: { authorization: string; body: URLSearchParams } | null = null;
let nonce = '';

const idToken = (claims: Record<string, unknown>) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/api/auth/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token` }));
      return;
    }
    if (url.pathname === '/api/auth/oauth2/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        lastTokenRequest = { authorization: req.headers.authorization ?? '', body: new URLSearchParams(raw) };
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        const now = Math.floor(Date.now() / 1000);
        res.end(JSON.stringify(answer.status === 200
          ? { id_token: idToken({ iss: issuer, aud: 'alfred', nonce, exp: now + 300, sub: 'p1', email: 'antoine@exemple.ch', name: 'Antoine', role: 'admin', ...answer.claims }) }
          : { error: 'access_denied' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
});

afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

async function setup(withCompte = true) {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const compte = withCompte ? settings({ COMPTE_URL: issuer.replace(/\/api\/auth$/, ''), COMPTE_CLIENT_SECRET: SECRET, APP_URL }) : null;
  const app = createApp({
    store,
    service: new CalendarService(store, null, 'Europe/Zurich'),
    caldav: null,
    passwordHash: await hashPassword('correct horse battery'),
    secureCookies: false,
    sessionDays: 30,
    compte,
  });
  return { app };
}

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c !== `${name}=`);

/** Départ vers le compte, puis retour avec un code, comme le ferait le navigateur. */
async function signIn(app: Awaited<ReturnType<typeof setup>>['app'], tamper: { state?: string } = {}) {
  const start = await app.request('/api/auth/compte/start');
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get('location')!);
  nonce = to.searchParams.get('nonce')!;
  const pending = cookieOf(start, 'compte_pending')!;
  const back = await app.request(`/api/auth/compte/callback?code=abc&state=${tamper.state ?? to.searchParams.get('state')}&iss=${encodeURIComponent(issuer)}`, { headers: { cookie: pending } });
  return { to, back };
}

describe('Connexion par le Compte Postmelo', () => {
  it('reste éteinte sans réglages : le mot de passe continue de marcher', async () => {
    expect(settings({})).toBeNull();
    expect(settings({ COMPTE_URL: 'https://compte.exemple.ch', COMPTE_CLIENT_SECRET: 'trop court', APP_URL })).toBeNull();
    const { app } = await setup(false);
    expect(await (await app.request('/api/me')).json()).toEqual({ authenticated: false, compte: false });
    expect((await app.request('/api/auth/compte/start')).status).toBe(404);
    expect((await app.request('/api/auth/compte/callback?code=abc&state=x')).status).toBe(404);
    const login = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    expect(login.status).toBe(200);
  });

  it('envoie vers le compte puis ouvre la session au retour', async () => {
    const { app } = await setup();
    expect(await (await app.request('/api/me')).json()).toEqual({ authenticated: false, compte: true });
    answer = { status: 200 };
    const { to, back } = await signIn(app);
    expect(to.origin + to.pathname).toBe(`${issuer}/oauth2/authorize`);
    expect(to.searchParams.get('client_id')).toBe('alfred');
    expect(to.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/auth/compte/callback`);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/');
    expect(lastTokenRequest!.authorization).toBe(`Basic ${Buffer.from(`alfred:${SECRET}`).toString('base64')}`);
    expect(lastTokenRequest!.body.get('code')).toBe('abc');
    expect(lastTokenRequest!.body.get('code_verifier')).toBeTruthy();
    const session = cookieOf(back, 'alfred_session')!;
    expect(await (await app.request('/api/me', { headers: { cookie: session } })).json()).toMatchObject({ authenticated: true });
    expect((await app.request('/api/calendars', { headers: { cookie: session } })).status).toBe(200);
    // Le mot de passe reste un secours.
    const login = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    expect(login.status).toBe(200);
  });

  it('n’ouvre rien quand le compte refuse ou que la réponse ne colle pas', async () => {
    const { app } = await setup();
    const refused = async (back: Response, message: string) => {
      expect(back.status).toBe(302);
      expect(back.headers.get('location')).toBe(`/?connexion=${encodeURIComponent(message)}`);
      expect(cookieOf(back, 'alfred_session')).toBeUndefined();
    };
    answer = { status: 403 };
    await refused((await signIn(app)).back, "Cet outil n'est pas ouvert à ton compte");
    answer = { status: 200, claims: { aud: 'cairn' } };
    await refused((await signIn(app)).back, 'Réponse du service de compte invalide');
    answer = { status: 200, claims: { nonce: 'un-autre' } };
    await refused((await signIn(app)).back, 'Réponse du service de compte invalide');
    answer = { status: 200 };
    await refused((await signIn(app, { state: 'faux' })).back, 'La connexion a expiré, recommence');
    // Sans le cookie posé au départ, un retour ne vaut rien.
    await refused(await app.request('/api/auth/compte/callback?code=abc&state=x'), 'La connexion a expiré, recommence');
  });
});
