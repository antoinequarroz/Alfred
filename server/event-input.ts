import type { EditScope, EventInput, RepeatRule } from '../shared/types.js';

// Lecture d'un événement envoyé par l'app (/api/events) ou par la suite (/api/v1/events).

export class BadRequest extends Error {}

const REPEATS: RepeatRule[] = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'];

export function parseInput(body: unknown): EventInput {
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

export function parseScope(v: unknown): EditScope {
  return v === 'this' ? 'this' : 'all';
}
