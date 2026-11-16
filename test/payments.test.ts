// Acomptes payés en ligne (Stripe Checkout), contre un faux Stripe en mémoire.
import { describe, expect, it } from 'vitest';
import type {
  Booking, BookingConfirmation, BookingType, Occurrence, PaymentSettingsState, PublicBooking, PublicBookingInfo, PublicPaymentStatus, PublicSlots,
} from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { Mailer, MailMessage } from '../server/booking/mail.js';
import { BookingService } from '../server/booking/service.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/password.js';
import { PaymentsService } from '../server/payments/service.js';
import { formEncode, type FetchLike } from '../server/payments/stripe.js';
import { SecretBox } from '../server/secrets.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const PASSWORD = 'correct horse battery';
const passwordHash = await hashPassword(PASSWORD);
/** Dimanche 15 novembre 2026, 12:00 à Zurich. */
const NOW = '2026-11-15T11:00:00Z';
/** Lundi 16 novembre, 09:00 à Zurich. */
const MONDAY_9 = '2026-11-16T08:00:00.000Z';
/** Fausse clé de test, assemblée ici pour ne pas ressembler à un secret dans le dépôt. */
const KEY = ['sk', 'test', 'FAUSSECLEPOURLESTESTS0123'].join('_');

interface FakeSession {
  id: string;
  url: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  payment_intent: string | null;
  amount_total: number;
  currency: string;
  params: URLSearchParams;
}

/** Faux Stripe : enregistre les appels, garde les sessions, peut tomber en panne. */
function fakeStripe() {
  const sessions = new Map<string, FakeSession>();
  const refunds: { pi: string; key: string }[] = [];
  const calls: { method: string; path: string; auth: string; idempotency?: string }[] = [];
  const state = { down: false, rejectKey: false, refundError: null as null | { status: number; code: string; message: string } };
  let n = 0;
  const reply = (status: number, body: unknown) => ({ status, json: async () => body });
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, auth: init.headers.authorization, idempotency: init.headers['idempotency-key'] });
    if (state.down) throw new Error('ECONNREFUSED');
    if (state.rejectKey) return reply(401, { error: { message: 'Invalid API Key provided: sk_test_***' } });
    const params = new URLSearchParams(init.body ?? u.search.slice(1));
    if (init.method === 'GET' && u.pathname === '/v1/checkout/sessions') return reply(200, { data: [] });
    if (init.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      if (params.getAll('payment_method_types[1]').includes('twint') && params.get('line_items[0][price_data][currency]') !== 'chf') {
        return reply(400, { error: { message: 'TWINT requires CHF', param: 'payment_method_types' } });
      }
      const id = `cs_test_${++n}`;
      const s: FakeSession = {
        id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', payment_intent: null,
        amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), currency: 'chf', params,
      };
      sessions.set(id, s);
      return reply(200, s);
    }
    const m = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(u.pathname);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return reply(404, { error: { code: 'resource_missing', message: 'No such checkout.session' } });
      if (m[2]) {
        if (s.status !== 'open') return reply(400, { error: { message: 'Only Checkout Sessions with a status in [open] can be expired.' } });
        s.status = 'expired';
      }
      return reply(200, s);
    }
    if (init.method === 'POST' && u.pathname === '/v1/refunds') {
      if (state.refundError) return reply(state.refundError.status, { error: { code: state.refundError.code, message: state.refundError.message } });
      const pi = params.get('payment_intent')!;
      if (refunds.some((r) => r.pi === pi)) return reply(400, { error: { code: 'charge_already_refunded', message: 'Charge has already been refunded.' } });
      refunds.push({ pi, key: init.headers['idempotency-key'] ?? '' });
      return reply(200, { id: `re_${refunds.length}`, status: 'succeeded' });
    }
    return reply(404, { error: { message: 'unknown' } });
  };
  /** Le client paie sur la page Stripe. */
  const pay = (id: string) => {
    const s = sessions.get(id)!;
    s.status = 'complete';
    s.payment_status = 'paid';
    s.payment_intent = `pi_${id}`;
  };
  return { fetchFn, sessions, refunds, calls, state, pay };
}

async function setup(opts: { configure?: boolean } = {}) {
  const store = new Store(openDb(':memory:'));
  store.ensureLocalCalendar();
  const service = new CalendarService(store, null, 'Europe/Zurich');
  const clock = { now: new Date(NOW) };
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    configured: true, from: 'Antoine Quarroz <info@antoinequarroz.ch>', notifyTo: 'info@antoinequarroz.ch',
    async send(message) { sent.push(message); },
  };
  const stripe = fakeStripe();
  const secrets = new SecretBox({ dataDir: ':memory:' });
  let bookingRef: BookingService | null = null;
  const payments = new PaymentsService({ db: store.db, secrets, fetch: stripe.fetchFn, pendingCount: () => bookingRef?.pendingPayments() ?? 0 });
  const booking = new BookingService({
    store, calendar: service, caldav: null, timezone: 'Europe/Zurich', mailer, payments,
    publicUrl: 'https://alfred.example.ch', defaultPublicName: 'Antoine Quarroz', now: () => clock.now,
    maxPerEmailPerDay: 100, quietCancelMinutes: 0,
  });
  bookingRef = booking;
  const app = createApp({
    store, service, caldav: null, passwordHash, secureCookies: false, sessionDays: 30, booking, payments,
    bookingLimits: { bookOk: [1000, 3_600_000] },
  });
  const json = (path: string, method = 'GET', body?: unknown, cookie?: string) =>
    app.request(path, {
      method,
      headers: {
        'sec-fetch-site': 'same-origin',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const login = await json('/api/login', 'POST', { password: PASSWORD });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const admin = (path: string, method = 'GET', body?: unknown) => json(path, method, body, cookie);
  if (opts.configure !== false) {
    const res = await admin('/api/payments', 'PUT', { secretKey: KEY });
    expect(res.status).toBe(200);
  }
  return { app, store, booking, payments, clock, sent, json, admin, stripe };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function openWithDeposit(ctx: Ctx, depositCents = 5000): Promise<BookingType> {
  expect((await ctx.admin('/api/booking/settings', 'PUT', { enabled: true })).status).toBe(200);
  const res = await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, location: 'Rue du Lac 1, Sion', depositCents });
  expect(res.status).toBe(201);
  return (await res.json()) as BookingType;
}

const CLIENT = { name: 'Élodie Müller', email: 'elodie@example.org', phone: '+41 79 123 45 67', message: 'Première visite.' };

async function book(ctx: Ctx, start = MONDAY_9): Promise<BookingConfirmation> {
  const res = await ctx.json('/api/public/booking/book', 'POST', { typeSlug: 'consultation', start, ...CLIENT });
  expect(res.status).toBe(201);
  return (await res.json()) as BookingConfirmation;
}

async function slots(ctx: Ctx): Promise<string[]> {
  const res = await ctx.json('/api/public/booking/types/consultation/slots?from=2026-11-16&to=2026-11-16');
  return ((await res.json()) as PublicSlots).days.flatMap((d) => d.slots);
}

async function status(ctx: Ctx, ref: string): Promise<PublicPaymentStatus> {
  const res = await ctx.json(`/api/public/booking/payment/${ref}`);
  expect(res.status).toBe(200);
  return (await res.json()) as PublicPaymentStatus;
}

const events = (ctx: Ctx): Occurrence[] => ctx.store.occurrences(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'));

describe('paiement en ligne : réglages', () => {
  it('enregistre la clé chiffrée après l’avoir essayée, sans jamais la renvoyer', async () => {
    const ctx = await setup({ configure: false });
    const empty = (await (await ctx.admin('/api/payments')).json()) as PaymentSettingsState;
    expect(empty).toMatchObject({ configured: false, mode: null, keyHint: null, twint: true, refundHours: 24, currency: 'CHF' });

    // Clé publiable, ou clé mal formée : refusées sans appeler Stripe.
    const pk = await ctx.admin('/api/payments', 'PUT', { secretKey: 'pk_test_abcdefghijklmnop' });
    expect(pk.status).toBe(400);
    expect(((await pk.json()) as { fields: Record<string, string> }).fields.secretKey).toMatch(/publiable/);
    expect(ctx.stripe.calls).toHaveLength(0);

    // Clé refusée par Stripe : rien n'est enregistré.
    ctx.stripe.state.rejectKey = true;
    const refused = await ctx.admin('/api/payments', 'PUT', { secretKey: KEY });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).not.toContain(KEY);
    expect(ctx.payments.configured).toBe(false);

    ctx.stripe.state.rejectKey = false;
    const ok = await ctx.admin('/api/payments', 'PUT', { secretKey: KEY, twint: false, refundHours: 48 });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).state).toMatchObject({ configured: true, mode: 'test', keyHint: KEY.slice(-4), twint: false, refundHours: 48 });
    expect(ctx.stripe.calls.at(-1)!.auth).toBe(`Bearer ${KEY}`);
    // En base : chiffrée.
    const stored = ctx.store.db.prepare("SELECT value, secret FROM connection_settings WHERE key = 'stripe.secretKey'").get() as { value: string; secret: number };
    expect(stored.secret).toBe(1);
    expect(stored.value).not.toContain('sk_test');

    const never = await ctx.admin('/api/payments', 'PUT', { refundHours: null });
    expect(((await never.json()) as { state: PaymentSettingsState }).state.refundHours).toBeNull();

    expect((await ctx.json('/api/payments')).status).toBe(401);
    const cleared = await ctx.admin('/api/payments', 'DELETE');
    expect(((await cleared.json()) as { state: PaymentSettingsState }).state.configured).toBe(false);
  });

  it('n’accepte un acompte que si Stripe est configuré, et le valide', async () => {
    const ctx = await setup({ configure: false });
    await ctx.admin('/api/booking/settings', 'PUT', { enabled: true });
    const res = await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, depositCents: 5000 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields.depositCents).toMatch(/clé Stripe/);
    await ctx.admin('/api/payments', 'PUT', { secretKey: KEY });
    for (const bad of [20, 5003, -1, 1.5, 200_000]) {
      const r = await ctx.admin('/api/booking/types', 'POST', { name: 'X', durationMin: 30, depositCents: bad });
      expect(r.status, String(bad)).toBe(400);
    }
    expect((await ctx.admin('/api/booking/types', 'POST', { name: 'Consultation', durationMin: 30, depositCents: 5000 })).status).toBe(201);
    const info = (await (await ctx.json('/api/public/booking')).json()) as PublicBookingInfo;
    expect(info.types[0]).toMatchObject({ depositCents: 5000, currency: 'CHF' });

    // Clé retirée : le type avec acompte disparaît de la page publique, l'admin est prévenu.
    await ctx.admin('/api/payments', 'DELETE');
    expect(((await (await ctx.json('/api/public/booking')).json()) as PublicBookingInfo).types).toEqual([]);
    expect(ctx.booking.adminState().warnings.join(' ')).toMatch(/paiement en ligne n’est pas configuré/);
  });
});

describe('paiement en ligne : réservation avec acompte', () => {
  it('retient le créneau, envoie vers Stripe (carte + TWINT), puis confirme au retour du client', async () => {
    const ctx = await setup();
    await openWithDeposit(ctx);
    const confirmation = await book(ctx);
    expect(confirmation.payment).toMatchObject({ amountCents: 5000, currency: 'CHF' });
    expect(confirmation.payment!.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(confirmation.cancelUrl).toMatch(/\/rdv\/(gerer|annulation)\/[A-Za-z0-9_-]{43}$/);
    expect(confirmation.emailSent).toBe(false);

    const session = [...ctx.stripe.sessions.values()][0];
    expect(session.params.get('payment_method_types[0]')).toBe('card');
    expect(session.params.get('payment_method_types[1]')).toBe('twint');
    expect(session.params.get('line_items[0][price_data][currency]')).toBe('chf');
    expect(session.params.get('line_items[0][price_data][unit_amount]')).toBe('5000');
    expect(session.params.get('customer_email')).toBe(CLIENT.email);
    expect(session.params.get('success_url')).toBe(`https://alfred.example.ch/rdv/paiement/${confirmation.payment!.ref}`);
    expect(Number(session.params.get('expires_at')) - Date.parse(NOW) / 1000).toBeGreaterThanOrEqual(30 * 60);

    // Rien d'écrit ni d'envoyé tant que ce n'est pas payé, mais le créneau n'est plus proposé.
    expect(events(ctx)).toHaveLength(0);
    expect(ctx.sent).toHaveLength(0);
    expect(await slots(ctx)).not.toContain(MONDAY_9);
    const other = await ctx.json('/api/public/booking/book', 'POST', { typeSlug: 'consultation', start: MONDAY_9, ...CLIENT, email: 'autre@example.org' });
    expect(other.status).toBe(409);

    expect((await status(ctx, confirmation.payment!.ref)).status).toBe('pending');

    ctx.stripe.pay(session.id);
    const paid = await status(ctx, confirmation.payment!.ref);
    expect(paid.status).toBe('confirmed');
    expect(paid.booking).toMatchObject({ start: MONDAY_9, status: 'confirmed', cancellable: true, deposit: { amountCents: 5000, refundOnCancel: false, refundHours: 24, refunded: false } });
    // Le rendez-vous est dans 21 heures : moins que les 24 heures de la règle par défaut.
    expect(events(ctx)).toHaveLength(1);
    expect(events(ctx)[0].description).toContain('Acompte payé en ligne : CHF 50.00');

    // Confirmation au client avec le lien d'annulation reçu à la réservation, avis à Antoine.
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.sent[0].text).toContain(confirmation.cancelUrl);
    expect(ctx.sent[0].text).toContain('Acompte : CHF 50.00, payé en ligne');
    // Le jeton en clair ne reste pas en base.
    expect(ctx.store.db.prepare('SELECT cancel_token FROM payment_holds').get()).toEqual({ cancel_token: null });

    // Interroger à nouveau ne recrée rien.
    await status(ctx, confirmation.payment!.ref);
    await ctx.booking.sweepPayments();
    expect(events(ctx)).toHaveLength(1);
    expect(ctx.sent).toHaveLength(2);

    const list = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    expect(list[0].payment).toMatchObject({ amountCents: 5000, currency: 'CHF', status: 'paid' });
    expect(list[0].payment!.dashboardUrl).toBe(`https://dashboard.stripe.com/test/payments/pi_${session.id}`);
  });

  it('confirme aussi un client qui a payé puis fermé la page (suivi régulier)', async () => {
    const ctx = await setup();
    await openWithDeposit(ctx);
    await book(ctx);
    const session = [...ctx.stripe.sessions.values()][0];
    await ctx.booking.sweepPayments();
    expect(events(ctx)).toHaveLength(0);
    ctx.stripe.pay(session.id);
    await Promise.all([ctx.booking.sweepPayments(), ctx.booking.sweepPayments()]);
    expect(events(ctx)).toHaveLength(1);
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.booking.pendingPayments()).toBe(0);
  });

  it('libère le créneau si le client abandonne le paiement, ou si la page expire', async () => {
    const ctx = await setup();
    await openWithDeposit(ctx);
    const first = await book(ctx);
    const res = await ctx.json(`/api/public/booking/payment/${first.payment!.ref}/abandon`, 'POST');
    expect(((await res.json()) as PublicPaymentStatus).status).toBe('expired');
    expect(await slots(ctx)).toContain(MONDAY_9);

    // Page expirée chez Stripe sans paiement : libérée au suivi suivant.
    await book(ctx);
    expect(await slots(ctx)).not.toContain(MONDAY_9);
    const session = [...ctx.stripe.sessions.values()][1];
    session.status = 'expired';
    await ctx.booking.sweepPayments();
    expect(await slots(ctx)).toContain(MONDAY_9);
    expect(events(ctx)).toHaveLength(0);
    expect(ctx.sent).toHaveLength(0);

    // Abandon après paiement (retour arrière tardif) : c'est le paiement qui l'emporte.
    const third = await book(ctx);
    ctx.stripe.pay([...ctx.stripe.sessions.values()][2].id);
    const late = await ctx.json(`/api/public/booking/payment/${third.payment!.ref}/abandon`, 'POST');
    expect(((await late.json()) as PublicPaymentStatus).status).toBe('confirmed');
  });

  it('garde le créneau retenu tant que Stripe ne répond pas, et ne réserve rien sans page de paiement', async () => {
    const ctx = await setup();
    await openWithDeposit(ctx);
    ctx.stripe.state.down = true;
    const res = await ctx.json('/api/public/booking/book', 'POST', { typeSlug: 'consultation', start: MONDAY_9, ...CLIENT });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe('payment_unavailable');
    expect(await slots(ctx)).toContain(MONDAY_9);

    ctx.stripe.state.down = false;
    const confirmation = await book(ctx);
    ctx.stripe.state.down = true;
    const stillPending = await status(ctx, confirmation.payment!.ref);
    expect(stillPending.status).toBe('pending');
    ctx.clock.now = new Date(Date.parse(NOW) + 3 * 3_600_000);
    await ctx.booking.sweepPayments();
    expect(await slots(ctx)).not.toContain(MONDAY_9);
  });

  it('réserve sans paiement les types sans acompte', async () => {
    const ctx = await setup();
    await openWithDeposit(ctx, 0);
    const confirmation = await book(ctx);
    expect(confirmation.payment).toBeUndefined();
    expect(confirmation.booking.deposit).toBeNull();
    expect(ctx.stripe.sessions.size).toBe(0);
    expect(events(ctx)).toHaveLength(1);
  });

  it('refuse une référence de paiement inconnue', async () => {
    const ctx = await setup();
    expect((await ctx.json(`/api/public/booking/payment/${'a'.repeat(43)}`)).status).toBe(404);
    expect((await ctx.json('/api/public/booking/payment/court')).status).toBe(404);
  });
});

describe('paiement en ligne : annulation et remboursement', () => {
  async function paidBooking(ctx: Ctx): Promise<BookingConfirmation> {
    await openWithDeposit(ctx);
    const confirmation = await book(ctx);
    ctx.stripe.pay([...ctx.stripe.sessions.values()][0].id);
    expect((await status(ctx, confirmation.payment!.ref)).status).toBe('confirmed');
    ctx.sent.length = 0;
    return confirmation;
  }

  it('rembourse le client qui annule assez tôt, et le lui dit', async () => {
    const ctx = await setup();
    const confirmation = await paidBooking(ctx);
    // Le rendez-vous est dans 21 heures : remboursé si la règle demande 12 heures.
    await ctx.admin('/api/payments', 'PUT', { refundHours: 12 });
    const token = confirmation.cancelUrl.split('/').pop()!;
    const before = (await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as PublicBooking;
    expect(before.deposit).toMatchObject({ refundOnCancel: true, refundHours: 12 });
    const res = await ctx.json(`/api/public/booking/cancel/${token}`, 'POST');
    const after = (await res.json()) as PublicBooking;
    expect(after.deposit).toMatchObject({ refunded: true });
    expect(ctx.stripe.refunds).toHaveLength(1);
    expect(ctx.sent[0].text).toMatch(/acompte de CHF 50\.00 vous est remboursé/);
  });

  it('ne rembourse pas une annulation tardive', async () => {
    const ctx = await setup();
    const confirmation = await paidBooking(ctx);
    await ctx.admin('/api/payments', 'PUT', { refundHours: 24 });
    const token = confirmation.cancelUrl.split('/').pop()!;
    const before = (await (await ctx.json(`/api/public/booking/cancel/${token}`)).json()) as PublicBooking;
    expect(before.deposit!.refundOnCancel).toBe(false);
    const after = (await (await ctx.json(`/api/public/booking/cancel/${token}`, 'POST')).json()) as PublicBooking;
    expect(after.deposit!.refunded).toBe(false);
    expect(ctx.stripe.refunds).toHaveLength(0);
    expect(ctx.sent[0].text).toMatch(/L’acompte de CHF 50\.00 n’est pas remboursé/);
  });

  it('rembourse à l’annulation par Antoine sauf avis contraire, et permet de réessayer un remboursement en échec', async () => {
    const ctx = await setup();
    await paidBooking(ctx);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    ctx.stripe.state.refundError = { status: 402, code: 'balance_insufficient', message: 'Insufficient balance' };
    const cancelled = (await (await ctx.admin(`/api/booking/bookings/${b.id}/cancel`, 'POST', { notifyClient: true })).json()) as Booking;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.payment).toMatchObject({ status: 'refund_failed' });
    expect(cancelled.payment!.error).toMatch(/Insufficient balance/);

    ctx.stripe.state.refundError = null;
    const retried = await ctx.admin(`/api/booking/bookings/${b.id}/refund`, 'POST');
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as Booking).payment).toMatchObject({ status: 'refunded', error: null });
    expect((await ctx.admin(`/api/booking/bookings/${b.id}/refund`, 'POST')).status).toBe(409);
    expect(ctx.stripe.refunds).toHaveLength(1);
  });

  it('n’envoie aucun remboursement quand Antoine décoche « rembourser »', async () => {
    const ctx = await setup();
    await paidBooking(ctx);
    const [b] = (await (await ctx.admin('/api/booking/bookings')).json()) as Booking[];
    const cancelled = (await (await ctx.admin(`/api/booking/bookings/${b.id}/cancel`, 'POST', { notifyClient: false, refund: false })).json()) as Booking;
    expect(cancelled.payment!.status).toBe('paid');
    expect(ctx.stripe.refunds).toHaveLength(0);
  });
});

describe('client Stripe', () => {
  it('encode les paramètres comme Stripe les attend', () => {
    expect(formEncode({ a: 1, b: ['x', 'y'], c: { d: 'é' }, e: [{ f: 2 }], g: undefined })).toEqual([
      'a=1', 'b%5B0%5D=x', 'b%5B1%5D=y', 'c%5Bd%5D=%C3%A9', 'e%5B0%5D%5Bf%5D=2',
    ]);
  });
});
