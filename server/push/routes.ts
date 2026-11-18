import type { Context, Hono } from 'hono';
import type { PushService } from './service.js';

/** Routes privées : /api/push/*. À enregistrer après le contrôle de session. */
export function registerPushRoutes(app: Hono, push: PushService): void {
  const body = (c: Context) => c.req.json().catch(() => ({})) as Promise<unknown>;

  app.get('/api/push', (c) => c.json(push.state()));
  app.put('/api/push/prefs', async (c) => {
    push.setPrefs(await body(c));
    return c.json(push.state());
  });
  app.post('/api/push/devices', async (c) => {
    push.subscribe(await body(c));
    return c.json(push.state(), 201);
  });
  app.delete('/api/push/devices/:id', (c) => {
    push.remove(c.req.param('id'));
    return c.json(push.state());
  });
  app.post('/api/push/test', async (c) => {
    const b = (await body(c)) as { id?: unknown } | null;
    const results = await push.test(typeof b?.id === 'string' ? b.id : undefined);
    return c.json({ results, state: push.state() });
  });
}
