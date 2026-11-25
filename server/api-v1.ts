import type { Context, Hono } from 'hono';
import type { ApiV1Busy, ApiV1Event, BookingType } from '../shared/types.js';
import { ApiTokens } from './api-tokens.js';
import type { BookingService } from './booking/service.js';
import { parseInput, parseScope } from './event-input.js';
import type { CalendarService } from './service.js';
import { exportIcs } from './export.js';
import { addressOf } from './ids.js';
import { toCalendarInfo, type Store } from './store.js';

// API v1 (phase 4, ALFRED-303 en lecture, ALFRED-312 en écriture). Documentation : docs/API.md.
//
// Pour que la suite PostMelo affiche l'agenda d'Alfred sans le recopier : calendriers, événements
// d'une période (récurrences développées), occupation, types de rendez-vous et créneaux libres,
// réservations. Accès : la session d'Alfred, ou un jeton d'API (« Authorization: Bearer alf_… »),
// en lecture seulement. Un jeton d'écriture (« alfw_… ») lit aussi et crée, modifie ou supprime les
// événements (POST, PUT, DELETE /api/v1/events) : Lamio s'en sert pour son onglet Calendrier.
// Plus un flux iCalendar par calendrier, avec un jeton de flux dans l'adresse.

/** Période la plus longue qu'on peut demander d'un coup (événements, occupation, réservations). */
const MAX_RANGE_MS = 400 * 86_400_000;
/** Fréquence de relecture conseillée aux applications abonnées au flux. */
const FEED_REFRESH_MIN = 15;

export const API_VERSION = 1;

export class V1Error extends Error {
  constructor(readonly status: 400 | 404, readonly code: string, message: string) {
    super(message);
  }
}

function range(c: Context): { from: Date; to: Date } {
  const from = new Date(c.req.query('start') ?? '');
  const to = new Date(c.req.query('end') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new V1Error(400, 'invalid_range', 'Période invalide : start et end en ISO 8601, end après start');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new V1Error(400, 'invalid_range', 'Période trop longue (400 jours au plus)');
  return { from, to };
}

export interface ApiV1Deps {
  store: Store;
  booking: BookingService;
  tokens: ApiTokens;
  service: CalendarService;
  /** Vrai si la requête porte une session d'Alfred valide. */
  authed: (c: Context) => boolean;
}

/**
 * Garde d'accès de /api/v1 : à placer avant la garde de session de /api/*, qui laisse passer
 * /api/v1. Les routes v1 déclarées ailleurs (GET /api/v1/resolve) en profitent aussi.
 */
export function registerApiV1Guard(app: Hono, deps: ApiV1Deps): void {
  app.use('/api/v1/*', async (c, next) => {
    // Le flux iCalendar vérifie lui-même son jeton (dans l'adresse).
    if (c.req.path.startsWith('/api/v1/feeds/')) return next();
    const auth = c.req.header('authorization');
    if (auth !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
      const writer = m ? deps.tokens.check(m[1], 'write') : null;
      if (!m || (!writer && !deps.tokens.check(m[1], 'api'))) {
        c.header('WWW-Authenticate', 'Bearer realm="alfred", error="invalid_token"');
        return c.json({ error: 'Jeton invalide ou retiré', code: 'invalid_token' }, 401);
      }
      if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
      // Un jeton d'API ne fait que lire ; un jeton d'écriture n'écrit que les événements.
      if (!writer) return c.json({ error: 'API en lecture seule', code: 'read_only' }, 405);
      if (!/^\/api\/v1\/events(\/[^/]+)?$/.test(c.req.path)) return c.json({ error: 'Écriture non permise ici', code: 'read_only' }, 405);
      return next();
    }
    if (deps.authed(c)) return next();
    c.header('WWW-Authenticate', 'Bearer realm="alfred"');
    return c.json({ error: 'Non connecté', code: 'unauthorized' }, 401);
  });
}

export function registerApiV1Routes(app: Hono, deps: ApiV1Deps): void {
  const { store, booking, tokens, service } = deps;

  app.get('/api/v1', (c) => c.json({
    version: API_VERSION,
    docs: 'docs/API.md',
    endpoints: [
      'GET /api/v1/calendars',
      'GET /api/v1/events?start=&end=&calendar=',
      'POST /api/v1/events',
      'PUT /api/v1/events/:id',
      'DELETE /api/v1/events/:id?scope=&occurrenceId=',
      'GET /api/v1/busy?start=&end=',
      'GET /api/v1/booking-types',
      'GET /api/v1/booking-types/:id/slots?from=&to=',
      'GET /api/v1/bookings?start=&end=',
      'GET /api/v1/resolve?address=',
      'GET /api/v1/feeds/:token.ics',
    ],
  }));

  app.get('/api/v1/calendars', (c) => c.json(store.listCalendars().map(toCalendarInfo)));

  app.get('/api/v1/events', (c) => {
    const { from, to } = range(c);
    const wanted = (c.req.query('calendar') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length) {
      const known = new Set(store.listCalendars().map((cal) => cal.id));
      const unknown = wanted.find((id) => !known.has(id));
      if (unknown) throw new V1Error(404, 'unknown_calendar', `Calendrier inconnu : ${unknown}`);
    }
    // Tous les calendriers, affichés ou non dans Alfred (la suite choisit ce qu'elle montre).
    const list = store.occurrences(from, to, wanted.length ? wanted : undefined, true);
    const uids = store.uidsOf([...new Set(list.map((o) => o.eventId))]);
    return c.json(list.map((o): ApiV1Event => ({
      id: o.eventId, address: addressOf('event', uids.get(o.eventId) ?? o.eventId), occurrenceId: o.occurrenceId,
      calendarId: o.calendarId, title: o.title, start: o.start, end: o.end, allDay: o.allDay,
      location: o.location, description: o.description, recurring: o.recurring, repeat: o.repeat,
    })));
  });

  // Écriture (jeton d'écriture ou session) : mêmes règles que l'app (calendrier en lecture seule
  // refusé, iCloud écrit par CalDAV). Répond l'identifiant de l'événement, qui change quand il
  // change de calendrier.
  app.post('/api/v1/events', async (c) => c.json({ id: await service.create(parseInput(await c.req.json())) }, 201));

  app.put('/api/v1/events/:id', async (c) => {
    const body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
    const occurrenceId = typeof body.occurrenceId === 'string' ? body.occurrenceId : null;
    return c.json({ id: await service.update(c.req.param('id'), parseInput(body.event), parseScope(body.scope), occurrenceId) });
  });

  app.delete('/api/v1/events/:id', async (c) => {
    await service.remove(c.req.param('id'), parseScope(c.req.query('scope')), c.req.query('occurrenceId') ?? null);
    return c.json({ ok: true });
  });

  app.get('/api/v1/busy', (c) => {
    const { from, to } = range(c);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const out: ApiV1Busy[] = store.busyOccurrences(from, to)
      .filter((o) => !o.transparent && !o.cancelled)
      // Journées entières (dates) gardées telles quelles ; heures limitées à la période demandée.
      .filter((o) => (o.allDay ? o.start <= toIso.slice(0, 10) && o.end > fromIso.slice(0, 10) : o.start < toIso && o.end > fromIso))
      .map((o) => ({ start: o.start, end: o.end, allDay: o.allDay }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return c.json(out);
  });

  app.get('/api/v1/booking-types', (c) => c.json(booking.listTypes().map((t: BookingType) => ({
    id: t.id, slug: t.slug, name: t.name, durationMin: t.durationMin, mode: t.mode, active: t.active,
  }))));

  // Créneaux libres d'un type (même si la prise de rendez-vous est fermée au public).
  app.get('/api/v1/booking-types/:id/slots', (c) => c.json(booking.adminSlots(c.req.param('id'), c.req.query('from'), c.req.query('to'))));

  app.get('/api/v1/bookings', (c) => {
    const { from, to } = range(c);
    return c.json(booking.bookingsBetween(from, to).map((b) => ({
      id: b.id, address: addressOf('booking', b.id), status: b.status, typeId: b.typeId, typeName: b.typeName,
      start: b.start, end: b.end, location: b.location, name: b.name, email: b.email, phone: b.phone,
      personId: b.personId ?? null, personAddress: b.personId ? addressOf('person', b.personId) : null,
      eventId: b.eventId, calendarId: b.calendarId, videoUrl: b.videoUrl ?? null, createdAt: b.createdAt, cancelledAt: b.cancelledAt,
    })));
  });

  // Flux iCalendar d'un calendrier : webcal://<hôte>/api/v1/feeds/<jeton>.ics dans Apple Calendrier.
  app.get('/api/v1/feeds/:file', (c) => {
    const file = c.req.param('file');
    const token = file.endsWith('.ics') ? file.slice(0, -4) : file;
    const t = tokens.check(token, 'feed');
    const cal = t?.calendarId ? store.getCalendar(t.calendarId) : undefined;
    if (!t || !cal) return c.text('Flux introuvable ou retiré', 404);
    const ics = exportIcs(store.db, cal.id, { name: cal.name, refreshMinutes: FEED_REFRESH_MIN });
    return c.body(ics, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="${cal.id.replace(/[^A-Za-z0-9_-]/g, '_')}.ics"`,
      'cache-control': 'private, max-age=300',
    });
  });
}

/** Gestion des jetons, derrière la session (Réglages > Accès à l'agenda). */
export function registerTokenRoutes(app: Hono, tokens: ApiTokens): void {
  app.get('/api/tokens', (c) => c.json(tokens.list()));
  app.post('/api/tokens', async (c) => c.json(tokens.create(await c.req.json().catch(() => ({}))), 201));
  app.delete('/api/tokens/:id', (c) => {
    tokens.remove(c.req.param('id'));
    return c.json({ ok: true });
  });
}
