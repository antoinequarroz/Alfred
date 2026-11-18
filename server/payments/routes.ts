import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RateLimiter } from '../booking/ratelimit.js';
import { PaymentSettingsError, type PaymentsService } from './service.js';

/**
 * Routes privées du paiement en ligne : /api/payments. À enregistrer après le contrôle de
 * session. La clé Stripe n'est jamais renvoyée, même en partie (seuls ses 4 derniers caractères).
 */
export function registerPaymentRoutes(app: Hono, payments: PaymentsService, limit: [number, number] = [10, 10 * 60_000]): void {
  // Chaque enregistrement de clé ou essai interroge Stripe : limite globale (un seul utilisateur).
  const tests = new RateLimiter(...limit, 1);
  const take = (c: Context): void => {
    const res = tests.take('*');
    if (res.ok) return;
    c.header('Retry-After', String(res.retryAfterSec));
    throw new PaymentSettingsError(400, 'rate_limited', `Trop d’essais. Réessaie dans ${Math.max(1, Math.ceil(res.retryAfterSec / 60))} min.`);
  };

  app.use('/api/payments', bodyLimit({ maxSize: 8 * 1024 }));
  app.use('/api/payments/*', bodyLimit({ maxSize: 8 * 1024 }));
  const guard = async (c: Context, next: () => Promise<void>) => {
    c.header('Cache-Control', 'no-store');
    await next();
  };
  app.use('/api/payments', guard);
  app.use('/api/payments/*', guard);

  app.get('/api/payments', (c) => c.json(payments.state()));
  app.put('/api/payments', async (c) => {
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: 'Le corps doit être en JSON (Content-Type: application/json)', code: 'unsupported' }, 415);
    }
    const body = (await c.req.json()) as { secretKey?: unknown } | null;
    if (body && typeof body.secretKey === 'string' && body.secretKey !== '') take(c);
    return c.json(await payments.save(body));
  });
  app.post('/api/payments/test', async (c) => {
    take(c);
    return c.json(await payments.testSaved());
  });
  app.delete('/api/payments', (c) => c.json({ state: payments.clear(), test: null }));
}
