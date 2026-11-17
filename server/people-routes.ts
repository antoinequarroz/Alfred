import type { Hono } from 'hono';
import { PeopleError, type PeopleService } from './people.js';

/**
 * Routes de l'annuaire et des liens, derrière la session :
 * - GET    /api/people?q=            fiches Personnes
 * - GET    /api/people/:id           une fiche, ses rendez-vous et ses liens
 * - GET    /api/links?from=|eventId= liens d'un objet (adresse media://, ou identifiant d'événement)
 * - POST   /api/links                { from | eventId, target, title? }
 * - DELETE /api/links/:id
 * - GET    /api/v1/resolve?address=  ce que désigne une adresse media://alfred/…
 */
export function registerPeopleRoutes(app: Hono, people: PeopleService): void {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  app.get('/api/people', (c) => c.json(people.list(c.req.query('q') ?? '')));

  app.get('/api/people/:id', (c) => c.json(people.get(c.req.param('id'))));

  const sourceOf = (from: string, eventId: string): string => {
    if (eventId) return people.eventAddress(eventId);
    if (!from) throw new PeopleError(400, 'invalid', 'Objet d’origine manquant');
    return from;
  };

  app.get('/api/links', (c) => {
    const from = sourceOf(c.req.query('from') ?? '', c.req.query('eventId') ?? '');
    if (!people.resolve(from)) throw new PeopleError(404, 'not_found', 'Objet introuvable');
    return c.json(people.listLinks(people.resolve(from)!.address));
  });

  app.post('/api/links', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const from = sourceOf(str(body.from), str(body.eventId));
    return c.json(people.addLink(from, str(body.target), str(body.title)), 201);
  });

  app.delete('/api/links/:id', (c) => {
    people.removeLink(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/v1/resolve', (c) => {
    const resolved = people.resolve(c.req.query('address') ?? '');
    if (!resolved) return c.json({ error: 'Adresse inconnue', code: 'not_found' }, 404);
    return c.json(resolved);
  });
}
