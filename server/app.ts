import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { EditScope, EventInput, RepeatRule } from '../shared/types.js';
import { DEFAULT_BOOKING_LIMITS, registerAdminBookingRoutes, registerPublicBookingRoutes, type BookingLimits } from './booking/routes.js';
import { BookingError, BookingService } from './booking/service.js';
import { ConflictError, RemoteError, type CaldavSync } from './caldav.js';
import { ConnectionError, type ConnectionsService } from './connections.js';
import { DEFAULT_CONNECTION_LIMITS, registerConnectionRoutes, type ConnectionLimits } from './connections-routes.js';
import { IcsError } from './ics.js';
import { verifyPassword } from './password.js';
import { registerPushRoutes } from './push/routes.js';
import { PushError, type PushService } from './push/service.js';
import { ForbiddenError, NotFoundError, type CalendarService } from './service.js';
import { toCalendarInfo, type Store } from './store.js';
import { DEFAULT_VIDEO_LIMITS, registerAdminVideoRoutes, registerPublicVideoRoutes, type VideoLimits } from './video/routes.js';
import { VideoError, VideoService } from './video/service.js';

const COOKIE = 'alfred_session';
const MAX_RANGE_MS = 400 * 86_400_000;
const REPEATS: RepeatRule[] = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'];

export interface AppDeps {
  store: Store;
  service: CalendarService;
  caldav: CaldavSync | null;
  passwordHash: string;
  secureCookies: boolean;
  sessionDays: number;
  /** Prise de rendez-vous. Par défaut : un moteur sans envoi d'e-mails, en Europe/Zurich. */
  booking?: BookingService;
  /** Limites de débit de la partie publique (valeurs par défaut sinon). */
  bookingLimits?: Partial<BookingLimits>;
  /** Connexions réglables depuis l'app (SMTP, CalDAV). Sans elles, les routes /api/connections n'existent pas. */
  connections?: ConnectionsService;
  connectionLimits?: Partial<ConnectionLimits>;
  /** Visioconférence. Par défaut : un service sans serveur de visio (non configuré). */
  video?: VideoService;
  videoLimits?: Partial<VideoLimits>;
  /** Notifications sur les appareils (Web Push). Sans elles, les routes /api/push n'existent pas. */
  push?: PushService;
}

class BadRequest extends Error {}

function parseInput(body: unknown): EventInput {
  if (!body || typeof body !== 'object') throw new BadRequest('Corps de requête invalide');
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
  const calendarId = str('calendarId');
  const title = str('title');
  const start = str('start');
  const end = str('end');
  if (!calendarId || title === undefined || !start || !end) throw new BadRequest('Champs manquants');
  const repeat = str('repeat') as RepeatRule | undefined;
  if (repeat !== undefined && !REPEATS.includes(repeat)) throw new BadRequest('Répétition invalide');
  if (title.length > 500 || (str('description')?.length ?? 0) > 20_000 || (str('location')?.length ?? 0) > 1000) {
    throw new BadRequest('Texte trop long');
  }
  return { calendarId, title, start, end, allDay: b.allDay === true, location: str('location'), description: str('description'), repeat };
}

function parseScope(v: unknown): EditScope {
  return v === 'this' ? 'this' : 'all';
}

/** Limite simple des tentatives de connexion (un seul utilisateur). */
class LoginThrottle {
  private failures: number[] = [];
  blockedFor(): number {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 15 * 60_000);
    if (this.failures.length < 5) return 0;
    return 15 * 60_000 - (now - this.failures[this.failures.length - 5]);
  }
  fail(): void { this.failures.push(Date.now()); }
  reset(): void { this.failures = []; }
}

export function createApp(deps: AppDeps): Hono {
  const { store, service, caldav } = deps;
  const booking = deps.booking ?? new BookingService({ store, calendar: service, caldav, timezone: 'Europe/Zurich' });
  const video = deps.video ?? new VideoService({
    db: store.db, publicUrl: 'http://localhost', timezone: 'Europe/Zurich',
    server: { internalUrl: 'http://127.0.0.1:7880', publicUrl: 'ws://127.0.0.1:7880' },
  });
  // Le navigateur ouvre une WebSocket vers le serveur de visio : même hôte (derrière Caddy) ou hôte dédié.
  const videoOrigin = (() => {
    try {
      const u = new URL(video.publicWsUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  })();
  const throttle = new LoginThrottle();
  const app = new Hono();

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", ...(videoOrigin ? [videoOrigin] : [])],
      mediaSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }));
  // Derrière Caddy, l'URL vue par le serveur est en http : on compare donc les hôtes.
  app.use('/api/*', csrf({
    origin: (origin, c) => {
      try {
        return new URL(origin).host === (c.req.header('x-forwarded-host') ?? c.req.header('host'));
      } catch {
        return false;
      }
    },
  }));

  app.use('/api/*', bodyLimit({ maxSize: 128 * 1024 }));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: 'Requête refusée' }, err.status);
    if (err instanceof PushError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof VideoError) return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
    if (err instanceof BookingError) return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
    if (err instanceof ConnectionError) {
      return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}), ...(err.reason ? { reason: err.reason } : {}) }, err.status);
    }
    if (err instanceof BadRequest || err instanceof IcsError) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'Requête illisible' }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
    if (err instanceof ConflictError) return c.json({ error: `${err.message}. La dernière version a été rechargée.` }, 409);
    if (err instanceof RemoteError) return c.json({ error: err.message }, 502);
    // Une erreur imprévue est journalisée sans ses éventuels secrets (mots de passe de connexion, identifiants dans une URL).
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[alfred]', deps.connections ? deps.connections.redact(detail) : detail);
    return c.json({ error: 'Erreur interne' }, 500);
  });

  const authed = (c: Context) => {
    const sid = getCookie(c, COOKIE);
    return Boolean(sid && store.isSessionValid(sid));
  };

  // --- prise de rendez-vous, partie publique (sans session) -----------------

  registerPublicBookingRoutes(app, booking, { ...DEFAULT_BOOKING_LIMITS, ...deps.bookingLimits });
  registerPublicVideoRoutes(app, video, authed, { ...DEFAULT_VIDEO_LIMITS, ...deps.videoLimits });
  app.all('/api/public/*', (c) => c.json({ error: 'Introuvable', code: 'not_found' }, 404));

  // --- connexion -----------------------------------------------------------

  app.post('/api/login', async (c) => {
    const wait = throttle.blockedFor();
    if (wait > 0) return c.json({ error: `Trop d’essais. Réessaie dans ${Math.ceil(wait / 60_000)} min.` }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== 'string' || body.password.length > 1024) return c.json({ error: 'Mot de passe incorrect' }, 401);
    // L'essai est compté avant la vérification (lente) : des requêtes simultanées ne contournent pas la limite.
    if (throttle.blockedFor() > 0) return c.json({ error: 'Trop d’essais. Réessaie plus tard.' }, 429);
    throttle.fail();
    const ok = await verifyPassword(body.password, deps.passwordHash);
    if (!ok) return c.json({ error: 'Mot de passe incorrect' }, 401);
    throttle.reset();
    store.purgeSessions();
    const session = store.createSession(deps.sessionDays);
    setCookie(c, COOKIE, session.id, {
      httpOnly: true, secure: deps.secureCookies, sameSite: 'Lax', path: '/', expires: session.expires,
    });
    return c.json({ ok: true });
  });

  app.post('/api/logout', (c) => {
    const sid = getCookie(c, COOKIE);
    if (sid) store.deleteSession(sid);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => c.json({ authenticated: authed(c) }));

  app.use('/api/*', async (c, next) => {
    if (!authed(c)) return c.json({ error: 'Non connecté' }, 401);
    await next();
  });

  // --- calendriers ---------------------------------------------------------

  app.get('/api/calendars', (c) => c.json(store.listCalendars().map(toCalendarInfo)));

  app.patch('/api/calendars/:id', async (c) => {
    const id = c.req.param('id');
    if (!store.getCalendar(id)) throw new NotFoundError('Calendrier introuvable');
    const body = (await c.req.json().catch(() => ({}))) as { visible?: unknown };
    if (typeof body.visible === 'boolean') store.setCalendarVisible(id, body.visible);
    return c.json(toCalendarInfo(store.getCalendar(id)!));
  });

  // --- événements ----------------------------------------------------------

  app.get('/api/events', (c) => {
    const from = new Date(c.req.query('start') ?? '');
    const to = new Date(c.req.query('end') ?? '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new BadRequest('Période invalide');
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new BadRequest('Période trop longue');
    return c.json(store.occurrences(from, to));
  });

  app.post('/api/events', async (c) => {
    const id = await service.create(parseInput(await c.req.json()));
    return c.json({ id }, 201);
  });

  app.put('/api/events/:id', async (c) => {
    const body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
    const occurrenceId = typeof body.occurrenceId === 'string' ? body.occurrenceId : null;
    const id = await service.update(c.req.param('id'), parseInput(body.event), parseScope(body.scope), occurrenceId);
    return c.json({ id });
  });

  app.delete('/api/events/:id', async (c) => {
    await service.remove(c.req.param('id'), parseScope(c.req.query('scope')), c.req.query('occurrenceId') ?? null);
    return c.json({ ok: true });
  });

  // --- prise de rendez-vous, administration --------------------------------

  registerAdminBookingRoutes(app, booking, store);

  // --- visioconférence -------------------------------------------------------

  registerAdminVideoRoutes(app, video);

  // --- notifications ---------------------------------------------------------

  if (deps.push) registerPushRoutes(app, deps.push);

  // --- connexions (SMTP, CalDAV) --------------------------------------------

  if (deps.connections) registerConnectionRoutes(app, deps.connections, { ...DEFAULT_CONNECTION_LIMITS, ...deps.connectionLimits });

  // --- synchro -------------------------------------------------------------

  app.get('/api/sync', (c) =>
    c.json(caldav?.getStatus() ?? { configured: false, running: false, lastSuccessAt: null, lastError: null, lastErrorAt: null }),
  );

  app.post('/api/sync', async (c) => {
    if (!caldav?.configured) return c.json({ error: 'Synchronisation non configurée' }, 400);
    await caldav.sync();
    return c.json(caldav.getStatus());
  });

  return app;
}
