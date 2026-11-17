import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { toCalendarInfo, type Store } from '../store.js';
import { RateLimiter, rateKey } from './ratelimit.js';
import { BookingError, type BookingService } from './service.js';

/** Limites de débit de la partie publique : [nombre de requêtes, fenêtre en ms]. */
export interface BookingLimits {
  /** Lectures légères (infos, consultation par jeton), par adresse IP. */
  read: [number, number];
  /** Demandes de créneaux, par adresse IP. */
  slots: [number, number];
  /** Demandes de créneaux, toutes adresses confondues : un afflux ne doit pas accaparer le processus. */
  slotsGlobal: [number, number];
  /** Essais de réservation (aboutis ou non), par adresse IP. */
  book: [number, number];
  /** Réservations abouties, par adresse IP. */
  bookOk: [number, number];
  /** Réservations abouties, toutes adresses confondues (garde-fou contre un afflux distribué). */
  bookGlobal: [number, number];
  /** Annulations par jeton, par adresse IP. */
  cancel: [number, number];
  /** Essais de déplacement par jeton, par adresse IP. */
  reschedule: [number, number];
}

export const DEFAULT_BOOKING_LIMITS: BookingLimits = {
  read: [120, 60_000],
  slots: [30, 60_000],
  slotsGlobal: [600, 60_000],
  book: [30, 3_600_000],
  bookOk: [5, 3_600_000],
  bookGlobal: [60, 3_600_000],
  cancel: [10, 3_600_000],
  reschedule: [20, 3_600_000],
};

/**
 * Adresse du client : dernier élément de X-Forwarded-For (posé par Caddy, donc non
 * falsifiable par le client), sinon l'adresse de la socket.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const last = forwarded.split(',').pop()!.trim();
    if (last) return rateKey(last);
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } }; server?: { incoming?: { socket?: { remoteAddress?: string } } } } | undefined;
  const address = env?.incoming?.socket?.remoteAddress ?? env?.server?.incoming?.socket?.remoteAddress;
  return address ? rateKey(address) : 'inconnue';
}

/** Routes publiques, sans session : /api/public/booking/*. À enregistrer avant le contrôle de session. */
export function registerPublicBookingRoutes(app: Hono, booking: BookingService, limits: BookingLimits = DEFAULT_BOOKING_LIMITS): void {
  const read = new RateLimiter(...limits.read);
  const slots = new RateLimiter(...limits.slots);
  const slotsGlobal = new RateLimiter(...limits.slotsGlobal, 1);
  const book = new RateLimiter(...limits.book);
  const bookOk = new RateLimiter(...limits.bookOk);
  const bookGlobal = new RateLimiter(...limits.bookGlobal, 1);
  const cancel = new RateLimiter(...limits.cancel);
  const reschedule = new RateLimiter(...limits.reschedule);

  const tooMany = (c: Context, retryAfterSec?: number): Response => {
    if (retryAfterSec) c.header('Retry-After', String(retryAfterSec));
    return c.json({ error: 'Trop de demandes. Réessayez un peu plus tard.', code: 'rate_limited' }, 429);
  };
  const limited = (c: Context, limiter: RateLimiter, key = clientIp(c)): Response | null => {
    const res = limiter.take(key);
    return res.ok ? null : tooMany(c, res.retryAfterSec);
  };

  app.use('/api/public/*', bodyLimit({ maxSize: 16 * 1024 }));
  app.use('/api/public/*', async (c, next) => {
    // Rien de public ne doit rester dans un cache : les créneaux changent, les jetons sont secrets.
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      // En plus de la protection CSRF commune : une page d'un autre site ne peut ni réserver ni annuler.
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      let foreign = site === 'cross-site';
      if (origin) {
        try {
          foreign ||= new URL(origin).host !== (c.req.header('x-forwarded-host') ?? c.req.header('host'));
        } catch {
          foreign = true;
        }
      }
      if (foreign) return c.json({ error: 'Requête refusée', code: 'forbidden' }, 403);
    }
    await next();
  });

  app.get('/api/public/booking', (c) => limited(c, read) ?? c.json(booking.publicInfo()));

  app.get('/api/public/booking/types/:slug/slots', (c) =>
    limited(c, slots) ?? limited(c, slotsGlobal, '*') ?? c.json(booking.publicSlots(c.req.param('slug'), c.req.query('from'), c.req.query('to'))),
  );

  app.post('/api/public/booking/book', async (c) => {
    const ip = clientIp(c);
    const blocked = limited(c, book, ip);
    if (blocked) return blocked;
    // Les plafonds de réservations abouties ne comptent pas les essais ratés : une faute de
    // frappe ou un créneau pris ne ferment la page à personne.
    if (bookOk.isBlocked(ip) || bookGlobal.isBlocked('*')) return tooMany(c);
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      throw new BookingError(415, 'unsupported', 'Le corps doit être en JSON (Content-Type: application/json)');
    }
    // Comptés dans la section critique, juste avant de créer l'événement : des demandes
    // simultanées ne peuvent pas passer toutes ensemble sous le plafond.
    const admit = () => {
      if (bookOk.isBlocked(ip) || bookGlobal.isBlocked('*')) throw new BookingError(429, 'rate_limited', 'Trop de demandes. Réessayez un peu plus tard.');
      bookOk.take(ip);
      bookGlobal.take('*');
    };
    return c.json(await booking.book(await c.req.json(), admit), 201);
  });

  app.get('/api/public/booking/cancel/:token', (c) => limited(c, read) ?? c.json(booking.getByToken(c.req.param('token'))));

  app.post('/api/public/booking/cancel/:token', async (c) =>
    limited(c, cancel) ?? c.json(await booking.cancelByToken(c.req.param('token'))),
  );

  // Déplacement par le client : autres créneaux, puis choix de l'un d'eux. Même jeton que l'annulation.
  app.get('/api/public/booking/manage/:token/slots', (c) =>
    limited(c, slots) ?? limited(c, slotsGlobal, '*') ?? c.json(booking.manageSlots(c.req.param('token'), c.req.query('from'), c.req.query('to'))),
  );

  app.post('/api/public/booking/manage/:token/reschedule', async (c) => {
    const blocked = limited(c, reschedule);
    if (blocked) return blocked;
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      throw new BookingError(415, 'unsupported', 'Le corps doit être en JSON (Content-Type: application/json)');
    }
    return c.json(await booking.rescheduleByToken(c.req.param('token'), await c.req.json()));
  });

  // La route « introuvable » des /api/public/* est posée par createApp, après les routes publiques de la visio.
}

/** Routes privées : /api/booking/*. À enregistrer après le contrôle de session. */
export function registerAdminBookingRoutes(app: Hono, booking: BookingService, store: Store): void {
  const body = (c: Context) => c.req.json().catch(() => ({})) as Promise<unknown>;

  // --- réglages ------------------------------------------------------------
  app.get('/api/booking/settings', (c) => c.json(booking.adminState()));
  app.put('/api/booking/settings', async (c) => {
    booking.updateSettings(await c.req.json());
    return c.json(booking.adminState());
  });

  // --- types ---------------------------------------------------------------
  app.get('/api/booking/types', (c) => c.json(booking.listTypes()));
  app.post('/api/booking/types', async (c) => c.json(booking.createType(await c.req.json()), 201));
  app.put('/api/booking/types/order', async (c) => c.json(booking.reorderTypes(await c.req.json())));
  app.put('/api/booking/types/:id', async (c) => c.json(booking.updateType(c.req.param('id'), await c.req.json())));
  app.delete('/api/booking/types/:id', (c) => {
    booking.deleteType(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/booking/types/:id/slots', (c) => c.json(booking.adminSlots(c.req.param('id'), c.req.query('from'), c.req.query('to'))));

  // --- horaires ------------------------------------------------------------
  app.get('/api/booking/hours', (c) => c.json(booking.getHours()));
  app.put('/api/booking/hours', async (c) => c.json(booking.setHours(await c.req.json())));

  // --- calendriers ---------------------------------------------------------
  app.get('/api/booking/calendars', (c) => c.json(store.listCalendars().map(toCalendarInfo)));
  app.patch('/api/booking/calendars/:id', async (c) => {
    const id = c.req.param('id');
    booking.setCalendarBlocks(id, await c.req.json());
    return c.json(toCalendarInfo(store.getCalendar(id)!));
  });

  // --- réservations --------------------------------------------------------
  app.get('/api/booking/bookings', (c) => {
    const scope = c.req.query('scope') === 'past' ? 'past' : 'upcoming';
    const num = (name: string, fallback: number, max: number) => {
      const n = Number.parseInt(c.req.query(name) ?? '', 10);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
    };
    return c.json(booking.listBookings(scope, Math.max(1, num('limit', 100, 500)), num('offset', 0, 1_000_000)));
  });
  app.post('/api/booking/bookings/:id/cancel', async (c) => {
    const b = (await body(c)) as { notifyClient?: unknown } | null;
    return c.json(await booking.cancelByAdmin(c.req.param('id'), b?.notifyClient !== false));
  });
  app.post('/api/booking/bookings/:id/resend', async (c) => c.json(await booking.resendConfirmation(c.req.param('id'))));
  // L'e-mail d'essai part par POST /api/connections/smtp/test, seule route d'essai : sa limite de débit ne se contourne pas par ici.
}
