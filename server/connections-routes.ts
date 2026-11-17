import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RateLimiter } from './booking/ratelimit.js';
import { ConnectionError, type ConnectionsService } from './connections.js';

/** Limites de débit : [nombre, fenêtre en ms]. */
export interface ConnectionLimits {
  /** Essais de connexion (envoi d'essai, essai ou enregistrement CalDAV) : chacun fait sortir une connexion du serveur. */
  test: [number, number];
  /** Enregistrements et effacements. */
  write: [number, number];
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  test: [10, 10 * 60_000],
  write: [60, 10 * 60_000],
};

/**
 * Routes privées des connexions : /api/connections/*. À enregistrer après le contrôle de
 * session. Aucune ne renvoie un mot de passe, même en partie : l'état dit seulement s'il
 * y en a un, et d'où il vient.
 */
export function registerConnectionRoutes(app: Hono, connections: ConnectionsService, limits: ConnectionLimits = DEFAULT_CONNECTION_LIMITS): void {
  // Un seul utilisateur : la limite est globale, une session volée n'y gagne rien à changer d'adresse.
  const tests = new RateLimiter(...limits.test, 1);
  const writes = new RateLimiter(...limits.write, 1);
  const take = (c: Context, limiter: RateLimiter): void => {
    const res = limiter.take('*');
    if (res.ok) return;
    c.header('Retry-After', String(res.retryAfterSec));
    throw new ConnectionError(429, 'rate_limited', `Trop d’essais. Réessaie dans ${Math.max(1, Math.ceil(res.retryAfterSec / 60))} min.`);
  };

  app.use('/api/connections/*', bodyLimit({ maxSize: 8 * 1024 }));
  app.use('/api/connections', bodyLimit({ maxSize: 8 * 1024 }));
  const guard = async (c: Context, next: () => Promise<void>) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      // En plus de la protection CSRF commune : aucune écriture venue d'un autre site.
      const origin = c.req.header('origin');
      let foreign = c.req.header('sec-fetch-site') === 'cross-site';
      if (origin) {
        try {
          foreign ||= new URL(origin).host !== (c.req.header('x-forwarded-host') ?? c.req.header('host'));
        } catch {
          foreign = true;
        }
      }
      if (foreign) return c.json({ error: 'Requête refusée', code: 'forbidden' }, 403);
      if (c.req.method === 'PUT' && !/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
        return c.json({ error: 'Le corps doit être en JSON (Content-Type: application/json)', code: 'unsupported' }, 415);
      }
    }
    await next();
  };
  app.use('/api/connections', guard);
  app.use('/api/connections/*', guard);

  const optionalBody = async (c: Context): Promise<unknown> => {
    const text = await c.req.text();
    if (!text.trim()) return {};
    return JSON.parse(text) as unknown;
  };

  app.get('/api/connections', (c) => c.json(connections.state()));

  // --- e-mails (SMTP) ------------------------------------------------------
  app.put('/api/connections/smtp', async (c) => {
    const body = (await c.req.json()) as unknown;
    take(c, writes);
    if (body && typeof body === 'object' && (body as { test?: unknown }).test === true) take(c, tests);
    return c.json(await connections.saveSmtpAndMaybeTest(body));
  });
  app.post('/api/connections/smtp/test', async (c) => {
    take(c, tests);
    const test = await connections.testSmtp();
    return c.json({ state: connections.state(), test });
  });
  app.delete('/api/connections/smtp', (c) => {
    take(c, writes);
    connections.clearSmtp();
    return c.json({ state: connections.state(), test: null });
  });
  app.delete('/api/connections/smtp/:field', (c) => {
    take(c, writes);
    connections.clearSmtp(c.req.param('field'));
    return c.json({ state: connections.state(), test: null });
  });

  // --- calendrier (CalDAV) -------------------------------------------------
  app.put('/api/connections/caldav', async (c) => {
    const body = (await c.req.json()) as unknown;
    take(c, tests);
    return c.json(await connections.saveCaldav(body));
  });
  app.post('/api/connections/caldav/test', async (c) => {
    const body = await optionalBody(c);
    take(c, tests);
    const { test, warning } = await connections.testCaldav(body);
    return c.json({ state: connections.state(), test, warning });
  });
  app.delete('/api/connections/caldav', async (c) => {
    take(c, tests);
    return c.json(await connections.clearCaldav());
  });

  app.all('/api/connections/*', (c) => c.json({ error: 'Introuvable', code: 'not_found' }, 404));
}
