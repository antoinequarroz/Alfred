// Visioconférence : jetons, salles, entrée, lien dans les rendez-vous. Le serveur de visio est simulé.
import { describe, expect, it } from 'vitest';
import type {
  BookingConfirmation, Occurrence, PublicVideoRoom, VideoAdminState, VideoJoinInfo, VideoRoom, VideoWaiter, VideoWaitInfo, VideoWaitStatus,
} from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer, MailMessage } from '../server/booking/mail.js';
import { BookingService } from '../server/booking/service.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';
import { cleanGuestName, isRoomSlug, newRoomSlug, VideoService, type VideoBackend } from '../server/video/service.js';
import { signAccessToken, verifyAccessToken } from '../server/video/token.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
const NOW = '2026-11-15T11:00:00Z';
const MONDAY_9 = '2026-11-16T08:00:00.000Z';
const KEY = 'alfredkey';
const SECRET = 'x'.repeat(40);

/** Faux serveur de visio : retient les salles et leurs participants. */
function fakeBackend() {
  const rooms = new Map<string, { max: number; participants: { identity: string; name: string }[] }>();
  const state = { up: true, deleted: [] as string[] };
  const check = () => {
    if (!state.up) throw new Error('injoignable');
  };
  const backend: VideoBackend = {
    health: async () => state.up,
    createRoom: async (name, max) => {
      check();
      if (!rooms.has(name)) rooms.set(name, { max, participants: [] });
    },
    listRooms: async () => {
      check();
      return [...rooms].map(([name, r]) => ({ name, numParticipants: r.participants.length }));
    },
    listParticipants: async (name) => {
      check();
      return rooms.get(name)?.participants ?? [];
    },
    deleteRoom: async (name) => {
      check();
      rooms.delete(name);
      state.deleted.push(name);
    },
  };
  return { backend, rooms, state };
}

async function setup(opts: { configured?: boolean; waitingRoom?: boolean } = {}) {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const service = new CalendarService(store, null, 'Europe/Zurich');
  const clock = { now: new Date(NOW) };
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    configured: true, from: 'Antoine Quarroz <info@antoinequarroz.ch>', notifyTo: 'info@antoinequarroz.ch',
    async send(message) { sent.push(message); },
  };
  const fake = fakeBackend();
  let bookingRef: BookingService | null = null;
  const configured = opts.configured ?? true;
  const arrivals: string[] = [];
  const video = new VideoService({
    onGuestJoin: (room, name, waiting) => { arrivals.push(`${name}${waiting ? ' (attente)' : ''} @ ${room.title}`); },
    db: store.db, publicUrl: 'https://alfred.example.ch', timezone: 'Europe/Zurich',
    server: { apiKey: configured ? KEY : undefined, apiSecret: configured ? SECRET : undefined, internalUrl: 'http://livekit:7880', publicUrl: 'wss://alfred.example.ch' },
    backend: configured ? fake.backend : undefined,
    hostName: () => 'Antoine Quarroz',
    bookingLink: (id) => bookingRef?.videoLink(id) ?? null,
    now: () => clock.now,
  });
  const booking = new BookingService({
    store, calendar: service, caldav: null, timezone: 'Europe/Zurich', mailer, video,
    publicUrl: 'https://alfred.example.ch', defaultPublicName: 'Antoine Quarroz', now: () => clock.now,
    maxPerEmailPerDay: 100, quietCancelMinutes: 0,
  });
  bookingRef = booking;
  // Les essais d'entrée directe se font sans salle d'attente ; elle a ses propres essais plus bas.
  if (!opts.waitingRoom) video.updateSettings({ waitingRoom: false });
  const app = createApp({ store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking, video, videoLimits: { join: [1000, 60_000] } });
  const json = (path: string, method = 'GET', body?: unknown, cookie?: string) =>
    app.request(path, {
      method,
      headers: { 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const login = await json('/api/login', 'POST', { password: PASSWORD });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) => json(path, method, body, cookie);
  return { app, store, video, booking, clock, sent, json, admin, fake, arrivals };
}

const slugOf = (room: VideoRoom) => room.url.split('/v/')[1];

describe('jetons', () => {
  it('signe un jeton lisible par le serveur de visio', () => {
    const token = signAccessToken(KEY, SECRET, { identity: 'host', name: 'Antoine', ttlSec: 60, video: { room: 'r', roomJoin: true }, now: 1_000_000 });
    const payload = verifyAccessToken(token, SECRET)!;
    expect(payload).toMatchObject({ iss: KEY, sub: 'host', name: 'Antoine', exp: 1060, video: { room: 'r', roomJoin: true } });
    expect(verifyAccessToken(token, 'y'.repeat(40))).toBeNull();
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('fabrique des liens de salle imprévisibles et valide les noms', () => {
    const a = newRoomSlug();
    expect(isRoomSlug(a)).toBe(true);
    expect(a).not.toBe(newRoomSlug());
    expect(isRoomSlug('../etc')).toBe(false);
    expect(cleanGuestName('  Élodie   Müller ')).toBe('Élodie Müller');
    expect(cleanGuestName('<script>')).toBeNull();
    expect(cleanGuestName('')).toBeNull();
    expect(cleanGuestName('x'.repeat(51))).toBeNull();
  });
});

describe('salles', () => {
  it('exige une session pour l’administration', async () => {
    const ctx = await setup();
    expect((await ctx.json('/api/video')).status).toBe(401);
    expect((await ctx.json('/api/video/rooms', 'POST', {})).status).toBe(401);
  });

  it('crée une réunion instantanée, y fait entrer l’hôte et un invité', async () => {
    const ctx = await setup();
    const res = await ctx.admin('/api/video/rooms', 'POST', {});
    expect(res.status).toBe(201);
    const room = (await res.json()) as VideoRoom;
    expect(room.url).toMatch(/^https:\/\/alfred\.example\.ch\/v\/[a-z2-9-]{14}$/);
    const slug = slugOf(room);

    const pub = (await (await ctx.json(`/api/public/video/rooms/${slug}`)).json()) as PublicVideoRoom;
    expect(pub).toMatchObject({ status: 'open', hostName: 'Antoine Quarroz', isHost: false });
    expect(((await (await ctx.admin(`/api/public/video/rooms/${slug}`)).json()) as PublicVideoRoom).isHost).toBe(true);

    // Invité sans nom : refusé. Avec un nom : jeton d'invité, sans droit d'administration.
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', {})).status).toBe(400);
    const guest = (await (await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Élodie Müller' })).json()) as VideoJoinInfo;
    expect(guest.isHost).toBe(false);
    expect(guest.url).toBe('wss://alfred.example.ch');
    const g = verifyAccessToken(guest.token, SECRET) as { sub: string; name: string; video: Record<string, unknown> };
    expect(g.sub).toMatch(/^invite-[0-9a-f]{12}$/);
    expect(g.name).toBe('Élodie Müller');
    expect(g.video.roomJoin).toBe(true);
    expect(g.video.roomAdmin).toBeUndefined();
    expect(g.video.room).toBe(`alfred-${room.id}`);

    const host = (await (await ctx.admin(`/api/public/video/rooms/${slug}/join`, 'POST', {})).json()) as VideoJoinInfo;
    const h = verifyAccessToken(host.token, SECRET) as { sub: string; name: string; video: Record<string, unknown> };
    expect(h).toMatchObject({ sub: 'host', name: 'Antoine Quarroz' });
    expect(h.video.roomAdmin).toBe(true);
    // Côté serveur de visio, plafond dur ; le réglage (4) est appliqué par Alfred. Jeton valable 2 minutes.
    expect(ctx.fake.rooms.get(`alfred-${room.id}`)?.max).toBe(8);
    const g2 = verifyAccessToken(guest.token, SECRET) as { exp: number; nbf: number };
    expect(g2.exp - g2.nbf).toBe(130);
    // Un invité ne peut pas prendre le nom de l'hôte.
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'antoine  QUARROZ' })).status).toBe(400);
  });

  it('refuse un invité quand la salle est pleine, en gardant une place pour l’hôte', async () => {
    const ctx = await setup();
    await ctx.admin('/api/video/settings', 'PUT', { maxParticipants: 2 });
    const room = (await (await ctx.admin('/api/video/rooms', 'POST', {})).json()) as VideoRoom;
    const slug = slugOf(room);
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Un' })).status).toBe(200);
    // Le jeton délivré compte comme une place prise avant même la connexion (entrées simultanées).
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Deux' })).status).toBe(409);
    // Jamais connecté : la place se libère après une minute.
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Un' })).status).toBe(200);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    ctx.fake.rooms.get(`alfred-${room.id}`)!.participants.push({ identity: 'invite-1', name: 'Un' });
    const full = await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Deux' });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { code: string }).code).toBe('full');
    expect((await ctx.admin(`/api/public/video/rooms/${slug}/join`, 'POST', {})).status).toBe(200);
  });

  it('ferme une salle supprimée, garde le lien après « terminer »', async () => {
    const ctx = await setup();
    const room = (await (await ctx.admin('/api/video/rooms', 'POST', { title: 'Point hebdo' })).json()) as VideoRoom;
    const slug = slugOf(room);
    await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Un' });
    expect((await ctx.admin(`/api/video/by-slug/${slug}/end`, 'POST', {})).status).toBe(200);
    expect(ctx.fake.state.deleted).toContain(`alfred-${room.id}`);
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Un' })).status).toBe(200);
    // « Terminer » demande une session.
    expect((await ctx.json(`/api/video/by-slug/${slug}/end`, 'POST', {})).status).toBe(401);

    expect((await ctx.admin(`/api/video/rooms/${room.id}`, 'DELETE')).status).toBe(200);
    const gone = await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Un' });
    expect(gone.status).toBe(410);
    expect(((await (await ctx.json(`/api/public/video/rooms/${slug}`)).json()) as PublicVideoRoom).status).toBe('closed');
  });

  it('garde ouverte la visio d’un événement (déplacé, récurrent) mais la sort de la liste ; périme une réunion instantanée', async () => {
    const ctx = await setup();
    const res = await ctx.admin('/api/video/rooms', 'POST', { title: 'Séance', start: '2026-11-16T08:00:00Z', end: '2026-11-16T09:00:00Z' });
    const room = (await res.json()) as VideoRoom;
    expect(room.kind).toBe('event');
    ctx.clock.now = new Date('2026-11-16T14:59:00Z');
    expect((await ctx.json(`/api/public/video/rooms/${slugOf(room)}/join`, 'POST', { name: 'Un' })).status).toBe(200);
    const instant = (await (await ctx.admin('/api/video/rooms', 'POST', {})).json()) as VideoRoom;
    expect(((await (await ctx.admin('/api/video')).json()) as VideoAdminState).rooms).toHaveLength(2);
    ctx.clock.now = new Date('2026-11-16T15:01:00Z');
    expect((await ctx.json(`/api/public/video/rooms/${slugOf(room)}/join`, 'POST', { name: 'Un' })).status).toBe(200);
    expect(((await (await ctx.admin('/api/video')).json()) as VideoAdminState).rooms.map((r) => r.id)).toEqual([instant.id]);
    ctx.clock.now = new Date('2026-11-17T12:00:00Z');
    expect((await ctx.json(`/api/public/video/rooms/${slugOf(instant)}/join`, 'POST', { name: 'Un' })).status).toBe(410);
    expect(((await (await ctx.admin('/api/video')).json()) as VideoAdminState).rooms).toHaveLength(0);
    expect((await ctx.admin('/api/video/rooms', 'POST', { start: 'demain', end: 'après' })).status).toBe(400);
  });

  it('garde une salle permanente, et change son lien à la demande', async () => {
    const ctx = await setup();
    const a = (await (await ctx.admin('/api/video/personal', 'POST', {})).json()) as VideoRoom;
    const again = (await (await ctx.admin('/api/video/personal', 'POST', {})).json()) as VideoRoom;
    expect(again.url).toBe(a.url);
    const b = (await (await ctx.admin('/api/video/personal', 'POST', { renew: true })).json()) as VideoRoom;
    expect(b.url).not.toBe(a.url);
    expect((await ctx.json(`/api/public/video/rooms/${slugOf(a)}/join`, 'POST', { name: 'Un' })).status).toBe(410);
    expect((await ctx.json(`/api/public/video/rooms/${slugOf(b)}/join`, 'POST', { name: 'Un' })).status).toBe(200);
    const state = (await (await ctx.admin('/api/video')).json()) as VideoAdminState;
    expect(state.personalRoom?.url).toBe(b.url);
    expect(state.server).toMatchObject({ configured: true, reachable: true });
  });

  it('répond proprement quand la visio est désactivée, absente ou en panne', async () => {
    const ctx = await setup();
    const room = (await (await ctx.admin('/api/video/rooms', 'POST', {})).json()) as VideoRoom;
    ctx.fake.state.up = false;
    const down = await ctx.json(`/api/public/video/rooms/${slugOf(room)}/join`, 'POST', { name: 'Un' });
    expect(down.status).toBe(503);
    ctx.fake.state.up = true;
    await ctx.admin('/api/video/settings', 'PUT', { enabled: false });
    expect(((await (await ctx.json(`/api/public/video/rooms/${slugOf(room)}`)).json()) as PublicVideoRoom).status).toBe('unavailable');
    expect((await ctx.admin('/api/video/rooms', 'POST', {})).status).toBe(403);
    expect((await ctx.admin('/api/video/settings', 'PUT', { maxParticipants: 50 })).status).toBe(400);

    const bare = await setup({ configured: false });
    const state = (await (await bare.admin('/api/video')).json()) as VideoAdminState;
    expect(state.available).toBe(false);
    expect(state.server.configured).toBe(false);
    expect((await bare.admin('/api/video/rooms', 'POST', {})).status).toBe(503);
    expect((await bare.json('/api/public/video/rooms/abcd-efgh-ijkm')).status).toBe(404);
    expect((await bare.json('/api/public/inconnu')).status).toBe(404);
  });
});

describe('salle d’attente', () => {
  async function waitingSetup() {
    const ctx = await setup({ waitingRoom: true });
    const room = (await (await ctx.admin('/api/video/rooms', 'POST', {})).json()) as VideoRoom;
    const slug = slugOf(room);
    const base = `/api/public/video/rooms/${slug}`;
    const ask = async (name: string) => (await (await ctx.json(`${base}/join`, 'POST', { name })).json()) as VideoWaitInfo;
    const poll = (ticket: string) => ctx.json(`${base}/wait`, 'POST', { ticket });
    const list = async () => ((await (await ctx.admin(`/api/video/by-slug/${slug}/waiting`)).json()) as { waiting: VideoWaiter[] }).waiting;
    return { ...ctx, room, slug, base, ask, poll, list, lk: `alfred-${room.id}` };
  }

  it('est active par défaut et se règle depuis l’app', async () => {
    const ctx = await setup({ waitingRoom: true });
    const state = (await (await ctx.admin('/api/video')).json()) as VideoAdminState;
    expect(state.settings.waitingRoom).toBe(true);
    expect((await ctx.admin('/api/video/settings', 'PUT', { waitingRoom: 'oui' })).status).toBe(400);
    const off = (await (await ctx.admin('/api/video/settings', 'PUT', { waitingRoom: false })).json()) as VideoAdminState;
    expect(off.settings.waitingRoom).toBe(false);
  });

  it('fait patienter l’invité sans jeton, jusqu’à ce que l’hôte le fasse entrer', async () => {
    const ctx = await waitingSetup();
    expect(((await (await ctx.json(ctx.base)).json()) as PublicVideoRoom).waitingRoom).toBe(true);
    expect(((await (await ctx.admin(ctx.base)).json()) as PublicVideoRoom).waitingRoom).toBe(false);

    const asked = await ctx.ask('Élodie Müller');
    expect(asked).toMatchObject({ waiting: true, hostPresent: false });
    expect(asked.ticket.length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(asked)).not.toContain('token');
    // L'hôte est prévenu dès la demande (notification), pas une seconde fois à l'entrée.
    expect(ctx.arrivals).toEqual(['Élodie Müller (attente) @ Réunion']);
    // Rien n'est créé côté serveur de visio tant que personne n'est admis.
    expect(ctx.fake.rooms.has(ctx.lk)).toBe(false);
    expect((await (await ctx.poll(asked.ticket)).json()) as VideoWaitStatus).toEqual({ state: 'waiting', hostPresent: false });

    // L'hôte, lui, entre directement ; la file ne se lit qu'avec une session.
    const host = (await (await ctx.admin(`${ctx.base}/join`, 'POST', {})).json()) as VideoJoinInfo;
    expect(host.token).toBeTruthy();
    expect((await ctx.json(`/api/video/by-slug/${ctx.slug}/waiting`)).status).toBe(401);
    expect((await ctx.json(`/api/video/by-slug/${ctx.slug}/admit`, 'POST', { id: 'x' })).status).toBe(401);
    const waiting = await ctx.list();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ name: 'Élodie Müller' });
    expect(waiting[0].id).toMatch(/^invite-[0-9a-f]{12}$/);
    // Le ticket de l'invité n'est jamais montré, et la liste des salles compte les personnes en attente.
    expect(JSON.stringify(waiting)).not.toContain(asked.ticket);
    const state = (await (await ctx.admin('/api/video')).json()) as VideoAdminState;
    expect(state.rooms[0].waiting).toBe(1);

    expect((await ctx.admin(`/api/video/by-slug/${ctx.slug}/admit`, 'POST', { id: waiting[0].id })).status).toBe(200);
    expect(await ctx.list()).toHaveLength(0);
    const admitted = (await (await ctx.poll(asked.ticket)).json()) as VideoWaitStatus;
    if (admitted.state !== 'admitted') throw new Error('non admis');
    const g = verifyAccessToken(admitted.join.token, SECRET) as { sub: string; name: string; video: Record<string, unknown> };
    expect(g).toMatchObject({ sub: waiting[0].id, name: 'Élodie Müller' });
    expect(g.video).toMatchObject({ room: ctx.lk, roomJoin: true, canPublish: true });
    expect(g.video.roomAdmin).toBeUndefined();
    expect(ctx.arrivals).toHaveLength(1);
    // Le jeton n'est donné qu'une fois.
    expect((await ctx.poll(asked.ticket)).status).toBe(404);
  });

  it('refuse un invité, qui l’apprend à sa demande suivante', async () => {
    const ctx = await waitingSetup();
    const asked = await ctx.ask('Inconnu');
    const [w] = await ctx.list();
    expect((await ctx.admin(`/api/video/by-slug/${ctx.slug}/deny`, 'POST', { id: w.id })).status).toBe(200);
    expect(await ctx.list()).toHaveLength(0);
    expect((await (await ctx.poll(asked.ticket)).json()) as VideoWaitStatus).toEqual({ state: 'denied' });
    expect((await ctx.poll(asked.ticket)).status).toBe(404);
    expect((await ctx.admin(`/api/video/by-slug/${ctx.slug}/deny`, 'POST', { id: w.id })).status).toBe(404);
  });

  it('oublie un invité parti, garde celui qui patiente, et n’accepte un ticket que pour sa salle', async () => {
    const ctx = await waitingSetup();
    const gone = await ctx.ask('Parti');
    const quiet = await ctx.ask('Silencieux');
    const stay = await ctx.ask('Patiente');
    expect(await ctx.list()).toHaveLength(3);
    // Annulation explicite : retiré tout de suite.
    expect((await ctx.json(`${ctx.base}/wait/leave`, 'POST', { ticket: gone.ticket })).status).toBe(200);
    expect((await ctx.list()).map((w) => w.name)).toEqual(['Silencieux', 'Patiente']);
    // Plus de nouvelles depuis 90 secondes : retiré ; celui qui continue de demander reste.
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
    expect((await ctx.poll(stay.ticket)).status).toBe(200);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 40_000);
    expect((await ctx.list()).map((w) => w.name)).toEqual(['Patiente']);
    const expired = await ctx.poll(quiet.ticket);
    expect(expired.status).toBe(404);
    expect(((await expired.json()) as { code: string }).code).toBe('wait_expired');
    // Un ticket ne vaut que pour sa salle.
    const other = (await (await ctx.admin('/api/video/rooms', 'POST', {})).json()) as VideoRoom;
    expect((await ctx.json(`/api/public/video/rooms/${slugOf(other)}/wait`, 'POST', { ticket: stay.ticket })).status).toBe(404);
    expect((await ctx.json(`${ctx.base}/wait`, 'POST', {})).status).toBe(404);
  });

  it('n’admet pas au-delà des places, et libère la place d’un admis qui ne vient pas', async () => {
    const ctx = await waitingSetup();
    await ctx.admin('/api/video/settings', 'PUT', { maxParticipants: 2 });
    const a = await ctx.ask('Un');
    await ctx.ask('Deux');
    const [w1, w2] = await ctx.list();
    expect((await ctx.admin(`/api/video/by-slug/${ctx.slug}/admit`, 'POST', { id: w1.id })).status).toBe(200);
    const full = await ctx.admin(`/api/video/by-slug/${ctx.slug}/admit`, 'POST', { id: w2.id });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { code: string }).code).toBe('full');
    // Le second attend toujours ; le premier ne vient jamais chercher son jeton : sa place se libère.
    expect((await ctx.list()).map((w) => w.name)).toEqual(['Deux']);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 80_000);
    expect((await ctx.poll((await ctx.ask('Trois')).ticket)).status).toBe(200);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 45_000);
    expect((await ctx.poll(a.ticket)).status).toBe(404);
    const [w3] = await ctx.list();
    expect(w3.name).toBe('Trois');
    expect((await ctx.admin(`/api/video/by-slug/${ctx.slug}/admit`, 'POST', { id: w3.id })).status).toBe(200);
  });

  it('borne la file, et la vide quand la salle ferme', async () => {
    const ctx = await waitingSetup();
    const first = await ctx.ask('Invité 0');
    for (let i = 1; i < 12; i++) await ctx.ask(`Invité ${i}`);
    const over = await ctx.json(`${ctx.base}/join`, 'POST', { name: 'De trop' });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe('wait_full');
    // Salle supprimée : la file se vide et l'invité apprend que la visio est fermée.
    await ctx.admin(`/api/video/rooms/${ctx.room.id}`, 'DELETE');
    expect((await ctx.poll(first.ticket)).status).toBe(410);
    expect((await ctx.admin(`/api/video/by-slug/${ctx.slug}/admit`, 'POST', { id: 'invite-000000000000' })).status).toBe(410);
  });

  it('dit à l’invité que l’hôte est déjà dans la salle', async () => {
    const ctx = await waitingSetup();
    ctx.fake.rooms.set(ctx.lk, { max: 8, participants: [{ identity: 'host', name: 'Antoine Quarroz' }] });
    expect((await ctx.ask('Élodie')).hostPresent).toBe(true);
    ctx.fake.state.up = false;
    const fresh = await waitingSetup();
    fresh.fake.state.up = false;
    expect((await fresh.ask('Élodie')).hostPresent).toBeNull();
  });
});

describe('rendez-vous en visio', () => {
  async function openVisio(ctx: Awaited<ReturnType<typeof setup>>) {
    await ctx.admin('/api/booking/settings', 'PUT', { enabled: true });
    expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, mode: 'visio' })).status).toBe(201);
  }
  const book = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.json('/api/public/booking/book', 'POST', { typeSlug: 'consultation', start: MONDAY_9, name: 'Élodie Müller', email: 'elodie@example.org' });

  it('donne un lien de visio au rendez-vous : événement, e-mail, pièce jointe, page de confirmation', async () => {
    const ctx = await setup();
    await openVisio(ctx);
    const res = await book(ctx);
    expect(res.status).toBe(201);
    const confirmation = (await res.json()) as BookingConfirmation;
    const url = confirmation.booking.videoUrl!;
    expect(url).toMatch(/^https:\/\/alfred\.example\.ch\/v\//);

    const events = (await (await ctx.admin('/api/events?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z')).json()) as Occurrence[];
    expect(events[0].location).toBe(url);
    expect(events[0].description).toContain(`Visio : ${url}`);

    const mail = ctx.sent.find((m) => m.subject.startsWith('Rendez-vous confirmé'))!;
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(`href="${url}"`);
    expect(String(mail.attachments![0].content)).toContain(`URL:${url}`);

    const state = (await (await ctx.admin('/api/video')).json()) as VideoAdminState;
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0]).toMatchObject({ kind: 'booking', url, startsAt: MONDAY_9 });
    const slug = url.split('/v/')[1];
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Élodie Müller' })).status).toBe(200);

    // Annulation : la salle ferme.
    const token = confirmation.cancelUrl.split('/').pop()!;
    expect((await ctx.json(`/api/public/booking/cancel/${token}`, 'POST')).status).toBe(200);
    expect((await ctx.json(`/api/public/video/rooms/${slug}/join`, 'POST', { name: 'Élodie Müller' })).status).toBe(410);
    expect(((await (await ctx.admin('/api/video')).json()) as VideoAdminState).rooms).toHaveLength(0);
  });

  it('garde le lien du type (Zoom, Meet…) quand il en porte un, sans salle Alfred', async () => {
    const ctx = await setup();
    await ctx.admin('/api/booking/settings', 'PUT', { enabled: true });
    await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, mode: 'visio', location: 'https://zoom.example/j/123' });
    const confirmation = (await (await book(ctx)).json()) as BookingConfirmation;
    expect(confirmation.booking.videoUrl).toBeNull();
    expect(((await (await ctx.admin('/api/video')).json()) as VideoAdminState).rooms).toHaveLength(0);
  });

  it('ne diffuse plus le lien quand la visio est désactivée après coup', async () => {
    const ctx = await setup();
    await openVisio(ctx);
    const confirmation = (await (await book(ctx)).json()) as BookingConfirmation;
    expect(confirmation.booking.videoUrl).not.toBeNull();
    await ctx.admin('/api/video/settings', 'PUT', { enabled: false });
    const token = confirmation.cancelUrl.split('/').pop()!;
    expect(((await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as { videoUrl: string | null }).videoUrl).toBeNull();
  });

  it('laisse le rendez-vous tel quel quand la visio n’est pas disponible', async () => {
    const ctx = await setup({ configured: false });
    await openVisio(ctx);
    const confirmation = (await (await book(ctx)).json()) as BookingConfirmation;
    expect(confirmation.booking.videoUrl).toBeNull();
    const events = (await (await ctx.admin('/api/events?start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z')).json()) as Occurrence[];
    expect(events[0].location).toBe('En visio');
  });
});
