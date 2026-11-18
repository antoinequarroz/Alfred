// Notifications (Web Push) : chiffrement RFC 8291, VAPID, abonnements, passes du planificateur, routes.
import { createDecipheriv, createECDH, hkdfSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PushState, PushTestResult } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { PushService } from '../server/push/service.js';
import { allowedEndpoint, encryptPayload, generateVapidKeys, vapidAuthorization, vapidPublicKey, validPushKeys, type FetchLike } from '../server/push/webpush.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';
import { VideoService, type VideoBackend } from '../server/video/service.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
const APPLE = 'https://web.push.apple.com/QGuQyavXutnMH_k4PxS3D2GOKPSoGIRuuyY2XyQKpQzQkF7pTRvCFhR';

/** Un faux appareil : sa paire de clés, et de quoi déchiffrer ce qu'il reçoit. */
function device(endpoint = `${APPLE}${randomBytes(4).toString('hex')}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const shared = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const data = body.subarray(21 + idlen);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    expect(plain[plain.length - 1]).toBe(2);
    return JSON.parse(plain.subarray(0, -1).toString('utf8')) as { title: string; body: string; url: string; tag: string };
  };
  return { endpoint, keys, decrypt };
}

/** Faux services de push : chaque envoi est retenu, et la réponse est réglable par adresse. */
function fakePush() {
  const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const status = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    const s = status.get(url) ?? 201;
    return { status: s, text: async () => (s >= 400 ? 'erreur' : '') };
  };
  return { fetch, calls, status };
}

function setup() {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const clock = { now: new Date('2026-11-16T09:00:00Z') };
  const net = fakePush();
  const push = new PushService({
    db: store.db, store, publicUrl: 'https://alfred.example.ch', timezone: 'Europe/Zurich',
    bookingVideoUrl: (id) => (id === 'b-visio' ? 'https://alfred.example.ch/v/abc123' : null),
    now: () => clock.now, fetch: net.fetch,
  });
  const insertBooking = (b: { id: string; start: string; end?: string; created?: string; status?: string; cancelledAt?: string; cancelledBy?: string; name?: string }) =>
    store.db.prepare(`INSERT INTO bookings (id, type_name, start_utc, end_utc, name, email, status, token_hash, created_at, cancelled_at, cancelled_by)
      VALUES (?, 'Consultation', ?, ?, ?, 'marie@example.com', ?, ?, ?, ?, ?)`).run(
      b.id, b.start, b.end ?? new Date(Date.parse(b.start) + 3_600_000).toISOString(), b.name ?? 'Marie Dupont', b.status ?? 'confirmed',
      randomBytes(8).toString('hex'), b.created ?? clock.now.toISOString(), b.cancelledAt ?? null, b.cancelledBy ?? null,
    );
  return { store, clock, net, push, insertBooking };
}

describe('chiffrement et VAPID', () => {
  it('reproduit le vecteur de test de la RFC 8291', () => {
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    }, { ephemeralPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'), salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') });
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signe un jeton VAPID vérifiable avec la clé publique', () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    const header = vapidAuthorization(keys, 'https://web.push.apple.com', 'https://alfred.example.ch', 1_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(m[2], 'base64url').toString())).toEqual({ aud: 'https://web.push.apple.com', exp: 1_000_000 + 43_200, sub: 'https://alfred.example.ch' });
    const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: vapidPublicKey(keys.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    expect(ok).toBe(true);
  });

  it('n’accepte que les services de push connus et des clés valides', () => {
    expect(allowedEndpoint(`${APPLE}x`)).toBe(true);
    expect(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(allowedEndpoint('http://web.push.apple.com/x')).toBe(false);
    expect(allowedEndpoint('https://web.push.apple.com:8443/x')).toBe(false);
    expect(allowedEndpoint('https://evilpush.apple.com.example.org/x')).toBe(false);
    expect(allowedEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(validPushKeys(device().keys)).toBe(true);
    expect(validPushKeys({ p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: randomBytes(16).toString('base64url') })).toBe(false);
    expect(validPushKeys({ p256dh: device().keys.p256dh, auth: 'court' })).toBe(false);
  });
});

describe('appareils et envoi', () => {
  it('garde la même paire de clés VAPID d’un démarrage à l’autre', () => {
    const { store, push } = setup();
    const again = new PushService({ db: store.db, store, publicUrl: 'https://alfred.example.ch', timezone: 'Europe/Zurich' });
    expect(again.publicKey).toBe(push.publicKey);
  });

  it('abonne un appareil, envoie un essai chiffré pour lui, et oublie un appareil désabonné', async () => {
    const { push, net } = setup();
    const phone = device();
    const mac = device('https://fcm.googleapis.com/fcm/send/mac');
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    push.subscribe({ endpoint: mac.endpoint, keys: mac.keys, label: 'Mac (Chrome)' });
    // Réabonnement du même appareil : pas de doublon.
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone d’Antoine' });
    expect(push.state().devices.map((d) => [d.label, d.service])).toEqual([['iPhone d’Antoine', 'Apple'], ['Mac (Chrome)', 'Google']]);

    net.status.set(mac.endpoint, 410);
    const results = await push.test();
    expect(results.map((r) => [r.label, r.ok, r.removed])).toEqual([['iPhone d’Antoine', true, false], ['Mac (Chrome)', false, true]]);
    const call = net.calls.find((c) => c.url === phone.endpoint)!;
    expect(call.headers['Content-Encoding']).toBe('aes128gcm');
    expect(call.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(phone.decrypt(call.body)).toMatchObject({ title: 'Alfred', url: '/#reglages' });
    expect(push.state().devices.map((d) => d.label)).toEqual(['iPhone d’Antoine']);
    expect(push.state().devices[0].lastSuccessAt).not.toBeNull();
  });

  it('refuse un service inconnu et retient une erreur passagère', async () => {
    const { push, net } = setup();
    const d = device();
    expect(() => push.subscribe({ endpoint: 'https://example.org/push', keys: d.keys })).toThrow(/non reconnu/);
    push.subscribe({ endpoint: d.endpoint, keys: d.keys, label: 'iPhone' });
    net.status.set(d.endpoint, 503);
    const [r] = await push.test();
    expect(r).toMatchObject({ ok: false, removed: false });
    expect(push.state().devices[0].lastError).toMatch(/503/);
  });

  it('garde le nom de l’appareil quand le navigateur renouvelle l’abonnement', () => {
    const { push } = setup();
    const old = device();
    const renewed = device();
    push.subscribe({ endpoint: old.endpoint, keys: old.keys, label: 'iPhone' });
    push.subscribe({ endpoint: renewed.endpoint, keys: renewed.keys, replaces: old.endpoint });
    expect(push.state().devices.map((d) => d.label)).toEqual(['iPhone']);
  });
});

describe('planificateur', () => {
  it('signale un nouveau rendez-vous et une annulation une seule fois, pas ceux d’avant', async () => {
    const { push, net, clock, insertBooking, store } = setup();
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    insertBooking({ id: 'ancien', start: '2026-11-20T09:00:00Z', created: '2026-11-15T09:00:00Z' });
    clock.now = new Date('2026-11-16T09:01:00Z');
    insertBooking({ id: 'b1', start: '2026-11-18T13:00:00Z' });
    await push.tick();
    await push.tick();
    expect(net.calls).toHaveLength(1);
    expect(phone.decrypt(net.calls[0].body)).toEqual({ title: 'Nouveau rendez-vous', body: 'Marie Dupont · Consultation, mercredi 18 novembre à 14:00', url: '/#rendez-vous', tag: 'rdv-b1' });

    clock.now = new Date('2026-11-16T10:00:00Z');
    store.db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'client' WHERE id = 'b1'").run(clock.now.toISOString());
    await push.tick();
    await push.tick();
    expect(net.calls).toHaveLength(2);
    expect(phone.decrypt(net.calls[1].body).title).toBe('Rendez-vous annulé');
  });

  it('se tait pour une réservation annulée avant d’être vue, et respecte les choix', async () => {
    const { push, net, insertBooking } = setup();
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    insertBooking({ id: 'vite', start: '2026-11-18T13:00:00Z', status: 'cancelled', cancelledAt: '2026-11-16T09:00:10Z', cancelledBy: 'client' });
    push.setPrefs({ newBooking: false });
    insertBooking({ id: 'muet', start: '2026-11-19T13:00:00Z' });
    await push.tick();
    expect(net.calls).toHaveLength(0);
    // Réactiver ne fait pas remonter les rendez-vous déjà passés sous silence.
    push.setPrefs({ newBooking: true });
    await push.tick();
    expect(net.calls).toHaveLength(0);
  });

  it('masque les détails si demandé', async () => {
    const { push, net, insertBooking } = setup();
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    push.setPrefs({ details: false });
    insertBooking({ id: 'b2', start: '2026-11-18T13:00:00Z' });
    await push.tick();
    const msg = phone.decrypt(net.calls[0].body);
    expect(`${msg.title} ${msg.body}`).not.toMatch(/Marie|Consultation/);
  });

  it('rappelle un rendez-vous avant son début, avec le lien de la visio', async () => {
    const { push, net, clock, insertBooking } = setup();
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    insertBooking({ id: 'b-visio', start: '2026-11-16T10:00:00Z', created: '2026-11-16T08:00:00Z' });
    push.setPrefs({ newBooking: false, reminderMinutes: 15 });
    await push.tick(); // vu comme nouveau (muet), trop tôt pour le rappel
    expect(net.calls).toHaveLength(0);
    clock.now = new Date('2026-11-16T09:46:00Z');
    await push.tick();
    await push.tick();
    expect(net.calls).toHaveLength(1);
    expect(phone.decrypt(net.calls[0].body)).toMatchObject({ title: 'Dans 14 min : Consultation avec Marie Dupont', body: '11:00 – 12:00 · En visio', url: '/v/abc123' });
    expect(net.calls[0].headers.Urgency).toBe('high');
  });

  it('ne rappelle pas un rendez-vous déjà commencé depuis plus d’une minute', async () => {
    const { push, net, clock, insertBooking } = setup();
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    push.setPrefs({ newBooking: false });
    insertBooking({ id: 'b3', start: '2026-11-16T09:00:00Z', created: '2026-11-16T08:00:00Z' });
    clock.now = new Date('2026-11-16T09:02:00Z');
    await push.tick();
    expect(net.calls).toHaveLength(0);
  });

  it('rappelle tous les événements à heure fixe si demandé', async () => {
    const { push, net, store } = setup();
    const service = new CalendarService(store, null, 'Europe/Zurich');
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    push.setPrefs({ reminders: 'all', reminderMinutes: 10 });
    const cal = store.listCalendars()[0].id;
    await service.create({ calendarId: cal, title: 'Dentiste', start: '2026-11-16T09:05:00Z', end: '2026-11-16T09:35:00Z', allDay: false, location: 'Sion' });
    await service.create({ calendarId: cal, title: 'Anniversaire', start: '2026-11-16', end: '2026-11-17', allDay: true });
    await push.tick();
    expect(net.calls).toHaveLength(1);
    expect(phone.decrypt(net.calls[0].body)).toMatchObject({ title: 'Dans 5 min : Dentiste', body: '10:05 – 10:35 · Sion', url: '/' });
  });
});

describe('visio et routes', () => {
  it('prévient quand un invité entre dans une salle, sans répéter s’il recharge la page', async () => {
    const { push, net, store } = setup();
    const phone = device();
    push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' });
    const backend: VideoBackend = {
      health: async () => true, createRoom: async () => undefined, listRooms: async () => [], listParticipants: async () => [], deleteRoom: async () => undefined,
    };
    const video = new VideoService({
      db: store.db, publicUrl: 'https://alfred.example.ch', timezone: 'Europe/Zurich', backend,
      server: { apiKey: 'k', apiSecret: 'x'.repeat(40), internalUrl: 'http://livekit:7880', publicUrl: 'wss://alfred.example.ch' },
      hostName: () => 'Antoine', onGuestJoin: (room, name) => void push.guestArrived(room, name),
    });
    const room = video.createRoom({ title: 'Point hebdo' });
    const slug = room.url.split('/v/')[1];
    await video.join(slug, { name: 'Léa' }, false);
    await video.join(slug, { name: 'Léa' }, false);
    await video.join(slug, { name: 'Antoine' }, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(net.calls).toHaveLength(1);
    expect(phone.decrypt(net.calls[0].body)).toMatchObject({ title: 'Léa est dans la visio', url: `/v/${slug}` });
    await push.guestArrived({ slug: 'autre', title: 'Bilan' }, 'Tom', true);
    expect(phone.decrypt(net.calls[1].body)).toMatchObject({ title: 'Tom attend d’entrer dans la visio', body: '« Bilan » · touche pour le faire entrer' });
  });

  it('expose l’état, les choix, les appareils et l’essai derrière la session', async () => {
    const { store, push } = setup();
    const service = new CalendarService(store, null, 'Europe/Zurich');
    const app = createApp({ store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, push });
    const req = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(path, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    expect((await req('/api/push')).status).toBe(401);
    const cookie = (await req('/api/login', 'POST', { password: PASSWORD })).headers.get('set-cookie')!.split(';')[0];

    const initial = (await (await req('/api/push', 'GET', undefined, cookie)).json()) as PushState;
    expect(initial.publicKey).toBe(push.publicKey);
    expect(initial.prefs).toMatchObject({ newBooking: true, reminders: 'bookings', reminderMinutes: 10 });

    expect((await req('/api/push/test', 'POST', {}, cookie)).status).toBe(409);
    expect((await req('/api/push/prefs', 'PUT', { reminderMinutes: 7 }, cookie)).status).toBe(400);
    const prefs = (await (await req('/api/push/prefs', 'PUT', { reminders: 'all', reminderMinutes: 30 }, cookie)).json()) as PushState;
    expect(prefs.prefs).toMatchObject({ reminders: 'all', reminderMinutes: 30 });

    const d = device();
    const added = await req('/api/push/devices', 'POST', { endpoint: d.endpoint, keys: d.keys, label: 'iPhone' }, cookie);
    expect(added.status).toBe(201);
    const state = (await added.json()) as PushState;
    expect(state.devices).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain(d.endpoint);
    const test = (await (await req('/api/push/test', 'POST', { id: state.devices[0].id }, cookie)).json()) as { results: PushTestResult[] };
    expect(test.results[0].ok).toBe(true);
    const removed = (await (await req(`/api/push/devices/${state.devices[0].id}`, 'DELETE', undefined, cookie)).json()) as PushState;
    expect(removed.devices).toHaveLength(0);
    expect((await req('/api/push/devices/inconnu', 'DELETE', undefined, cookie)).status).toBe(404);
  });
});
