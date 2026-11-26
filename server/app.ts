import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { DEFAULT_BOOKING_LIMITS, registerAdminBookingRoutes, registerPublicBookingRoutes, type BookingLimits } from './booking/routes.js';
import { BookingError, BookingService } from './booking/service.js';
import { ConflictError, RemoteError, type CaldavSync } from './caldav.js';
import { CALLBACK_PATH, finishSignIn, PENDING_COOKIE, PENDING_MAX_AGE, START_PATH, startSignIn, type Settings as CompteSettings } from './compte.js';
import { ConnectionError, type ConnectionsService } from './connections.js';
import { reportError } from './error-reporting.js';
import { DEFAULT_CONNECTION_LIMITS, registerConnectionRoutes, type ConnectionLimits } from './connections-routes.js';
import { registerExportRoutes, IMPORT_MAX_BYTES } from './export-routes.js';
import { ApiTokens, TokenError } from './api-tokens.js';
import { registerApiV1Guard, registerApiV1Routes, registerTokenRoutes, V1Error } from './api-v1.js';
import { BadRequest, parseInput, parseScope } from './event-input.js';
import { IcsError } from './ics.js';
import { verifyPassword } from './password.js';
import { registerPushRoutes } from './push/routes.js';
import { PushError, type PushService } from './push/service.js';
import { PeopleError, PeopleService } from './people.js';
import { registerPeopleRoutes } from './people-routes.js';
import { ForbiddenError, NotFoundError, type CalendarService } from './service.js';
import { toCalendarInfo, type Store } from './store.js';
import { PaymentSettingsError, type PaymentsService } from './payments/service.js';
import { registerPaymentRoutes } from './payments/routes.js';
import { DEFAULT_VIDEO_LIMITS, registerAdminVideoRoutes, registerPublicVideoRoutes, type VideoLimits } from './video/routes.js';
import { VideoError, VideoService } from './video/service.js';

const COOKIE = 'alfred_session';
const MAX_RANGE_MS = 400 * 86_400_000;

export interface AppDeps {
  store: Store;
  service: CalendarService;
  caldav: CaldavSync | null;
  passwordHash: string;
  secureCookies: boolean;
  sessionDays: number;
  /** Connexion par le Compte Postmelo (OpenID Connect). Absente : seul le mot de passe d'Alfred ouvre l'app. */
  compte?: CompteSettings | null;
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
  /** Paiement en ligne des acomptes (Stripe). Sans lui, les routes /api/payments n'existent pas. */
  payments?: PaymentsService;
  /** Notifications sur les appareils (Web Push). Sans elles, les routes /api/push n'existent pas. */
  push?: PushService;
  /** Annuaire des personnes et liens. Par défaut : construit sur la même base, Cairn à son adresse habituelle. */
  people?: PeopleService;
  /** Jetons de l'API v1 et des flux iCalendar. Par défaut : sur la même base. */
  tokens?: ApiTokens;
  /**
   * Origines qui peuvent afficher Alfred dans un cadre (Lamio, pour ses appels : ALFRED-313).
   * Vide : personne (frame-ancestors 'none').
   */
  embedOrigins?: string[];
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
  const people = deps.people ?? new PeopleService({ db: store.db, store, booking, cairnUrl: 'https://cairn.antoinequarroz.ch' });
  const throttle = new LoginThrottle();
  const app = new Hono();

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' : le flou d'arrière-plan de la visio compile un module WebAssembly servi par Alfred.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", ...(videoOrigin ? [videoOrigin] : [])],
      mediaSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      // blob: : le flou d'arrière-plan cadence ses images depuis un petit worker créé à la volée.
      workerSrc: ["'self'", 'blob:'],
      frameAncestors: deps.embedOrigins?.length ? deps.embedOrigins : ["'none'"],
    },
    // Avec des origines permises, frame-ancestors suffit (X-Frame-Options ne sait pas en nommer).
    xFrameOptions: deps.embedOrigins?.length ? false : 'SAMEORIGIN',
    // La visio dans le cadre de la suite a besoin de la caméra, du micro et du partage d'écran.
    permissionsPolicy: deps.embedOrigins?.length
      ? { camera: ['self', ...deps.embedOrigins], microphone: ['self', ...deps.embedOrigins], displayCapture: ['self', ...deps.embedOrigins], fullscreen: ['self', ...deps.embedOrigins] }
      : {},
  }));
  // Derrière Caddy, l'URL vue par le serveur est en http : on compare donc les hôtes.
  // Une requête de /api/v1 portant un jeton (« Authorization: Bearer ») vient d'un autre serveur
  // (Lamio) : un navigateur n'ajoute jamais cet en-tête de lui-même, elle n'a rien d'un CSRF.
  const csrfGuard = csrf({
    origin: (origin, c) => {
      try {
        return new URL(origin).host === (c.req.header('x-forwarded-host') ?? c.req.header('host'));
      } catch {
        return false;
      }
    },
  });
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/v1/') && c.req.header('authorization') ? next() : csrfGuard(c, next)));

  // Import des données : un fichier d'export complet, bien plus gros qu'une requête ordinaire.
  const smallBody = bodyLimit({ maxSize: 128 * 1024 });
  const importBody = bodyLimit({ maxSize: IMPORT_MAX_BYTES });
  app.use('/api/*', (c, next) => (c.req.path === '/api/import' ? importBody(c, next) : smallBody(c, next)));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: 'Requête refusée' }, err.status);
    if (err instanceof PushError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof VideoError) return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
    if (err instanceof PaymentSettingsError) return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
    if (err instanceof V1Error || err instanceof TokenError) return c.json({ error: err.message, code: err.code, ...(err instanceof TokenError && err.fields ? { fields: err.fields } : {}) }, err.status);
    if (err instanceof PeopleError) return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
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
    // Envoyée aussi à Orbi (si SENTRY_DSN est réglé), expurgée de la même façon.
    reportError(err, { method: c.req.method, path: c.req.path }, deps.connections ? (v) => deps.connections!.redact(v) : undefined);
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

  // --- connexion par le Compte Postmelo ---------------------------------------
  // Le service de compte décide qui entre (il refuse de donner une identité si Alfred n'est pas
  // ouvert à la personne) : une identité reçue ouvre donc la même session que le mot de passe.

  const compte = deps.compte ?? null;
  const backToLogin = (c: Context, message: string) => c.redirect(`/?connexion=${encodeURIComponent(message)}`);

  app.get(START_PATH, async (c) => {
    if (!compte) return c.json({ error: 'Introuvable' }, 404);
    try {
      const { url, cookie } = await startSignIn({}, compte);
      setCookie(c, PENDING_COOKIE, cookie, { httpOnly: true, secure: deps.secureCookies, sameSite: 'Lax', path: '/', maxAge: PENDING_MAX_AGE });
      return c.redirect(url);
    } catch (err) {
      console.error('[alfred] compte :', err instanceof Error ? err.message : err);
      return backToLogin(c, 'Le Compte Postmelo ne répond pas. Réessaie, ou utilise le mot de passe.');
    }
  });

  app.get(CALLBACK_PATH, async (c) => {
    if (!compte) return c.json({ error: 'Introuvable' }, 404);
    const pending = getCookie(c, PENDING_COOKIE);
    deleteCookie(c, PENDING_COOKIE, { path: '/' });
    try {
      const person = await finishSignIn(c.req.url, pending, compte);
      store.purgeSessions();
      const session = store.createSession(deps.sessionDays);
      setCookie(c, COOKIE, session.id, {
        httpOnly: true, secure: deps.secureCookies, sameSite: 'Lax', path: '/', expires: session.expires,
      });
      console.log(`[alfred] connexion par le Compte Postmelo : ${person.email}`);
      return c.redirect(person.next);
    } catch (err) {
      return backToLogin(c, err instanceof Error ? err.message : 'La connexion a échoué');
    }
  });

  app.post('/api/logout', (c) => {
    const sid = getCookie(c, COOKIE);
    if (sid) store.deleteSession(sid);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => c.json({ authenticated: authed(c), compte: Boolean(compte) }));

  // API v1 en lecture : session ou jeton d'API (server/api-v1.ts), flux iCalendar par jeton de flux.
  const tokens = deps.tokens ?? new ApiTokens(store.db);
  const v1 = { store, booking, tokens, authed, service, video };
  registerApiV1Guard(app, v1);
  registerApiV1Routes(app, v1);

  app.use('/api/*', async (c, next) => {
    // /api/v1 a sa propre garde (session ou jeton), placée plus haut.
    if (c.req.path.startsWith('/api/v1/') || c.req.path === '/api/v1') return next();
    if (!authed(c)) return c.json({ error: 'Non connecté' }, 401);
    await next();
  });

  registerTokenRoutes(app, tokens);

  // --- personnes et liens (phase 4) ------------------------------------------

  registerPeopleRoutes(app, people);

  // --- export et import des données (phase 4) ---------------------------------

  registerExportRoutes(app, store);

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

  if (deps.payments) registerPaymentRoutes(app, deps.payments);

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
