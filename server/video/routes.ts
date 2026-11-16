import type { Context, Hono } from 'hono';
import { RateLimiter } from '../booking/ratelimit.js';
import { clientIp } from '../booking/routes.js';
import type { VideoService } from './service.js';

/** Limites de débit de la partie publique de la visio : [nombre de requêtes, fenêtre en ms]. */
export interface VideoLimits {
  /** Lectures d'une salle par son lien, par adresse IP. */
  read: [number, number];
  /** Demandes d'entrée (jetons), par adresse IP. */
  join: [number, number];
  /** Suivi d'une demande en salle d'attente (une toutes les 3 secondes par invité), par adresse IP. */
  wait: [number, number];
}

export const DEFAULT_VIDEO_LIMITS: VideoLimits = {
  read: [60, 60_000],
  join: [20, 600_000],
  wait: [150, 60_000],
};

/**
 * Routes publiques : /api/public/video/*. À enregistrer après le garde commun des /api/public/*
 * (posé par les routes de la prise de rendez-vous) et avant le contrôle de session.
 * isHost : la requête porte une session Alfred valide.
 */
export function registerPublicVideoRoutes(app: Hono, video: VideoService, isHost: (c: Context) => boolean, limits: VideoLimits = DEFAULT_VIDEO_LIMITS): void {
  const read = new RateLimiter(...limits.read);
  const join = new RateLimiter(...limits.join);
  const wait = new RateLimiter(...limits.wait);
  const limited = (c: Context, limiter: RateLimiter): Response | null => {
    const res = limiter.take(clientIp(c));
    if (res.ok) return null;
    c.header('Retry-After', String(res.retryAfterSec));
    return c.json({ error: 'Trop de demandes. Réessayez un peu plus tard.', code: 'rate_limited' }, 429);
  };

  app.get('/api/public/video/rooms/:slug', (c) => limited(c, read) ?? c.json(video.publicRoom(c.req.param('slug'), isHost(c))));

  app.post('/api/public/video/rooms/:slug/join', async (c) => {
    const blocked = limited(c, join);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => ({}));
    return c.json(await video.join(c.req.param('slug'), body, isHost(c), clientIp(c)));
  });

  // Salle d'attente : l'invité suit sa demande avec son ticket, ou y renonce.
  app.post('/api/public/video/rooms/:slug/wait', async (c) => {
    const blocked = limited(c, wait);
    if (blocked) return blocked;
    return c.json(await video.waitStatus(c.req.param('slug'), await c.req.json().catch(() => ({}))));
  });
  app.post('/api/public/video/rooms/:slug/wait/leave', async (c) => {
    const blocked = limited(c, wait);
    if (blocked) return blocked;
    video.leaveWait(c.req.param('slug'), await c.req.json().catch(() => ({})));
    return c.json({ ok: true });
  });
}

/** Routes privées : /api/video/*. À enregistrer après le contrôle de session. */
export function registerAdminVideoRoutes(app: Hono, video: VideoService): void {
  const body = (c: Context) => c.req.json().catch(() => ({})) as Promise<unknown>;

  app.get('/api/video', async (c) => c.json(await video.adminState()));
  app.put('/api/video/settings', async (c) => {
    video.updateSettings(await c.req.json());
    return c.json(await video.adminState());
  });
  app.post('/api/video/rooms', async (c) => c.json(video.createRoom(await body(c)), 201));
  app.post('/api/video/personal', async (c) => {
    const b = (await body(c)) as { renew?: unknown } | null;
    return c.json(video.personalRoom(b?.renew === true));
  });
  app.post('/api/video/rooms/:id/end', async (c) => {
    await video.endMeeting(c.req.param('id'));
    return c.json({ ok: true });
  });
  // Depuis la page de la salle, l'hôte ne connaît que le lien.
  app.post('/api/video/by-slug/:slug/end', async (c) => {
    await video.endMeetingBySlug(c.req.param('slug'));
    return c.json({ ok: true });
  });
  // Salle d'attente : qui patiente, faire entrer, refuser.
  app.get('/api/video/by-slug/:slug/waiting', (c) => c.json({ waiting: video.waitingList(c.req.param('slug')) }));
  app.post('/api/video/by-slug/:slug/admit', async (c) => c.json({ waiting: await video.admit(c.req.param('slug'), await body(c)) }));
  app.post('/api/video/by-slug/:slug/deny', async (c) => c.json({ waiting: video.deny(c.req.param('slug'), await body(c)) }));
  app.delete('/api/video/rooms/:id', (c) => {
    video.deleteRoom(c.req.param('id'));
    return c.json({ ok: true });
  });
}
