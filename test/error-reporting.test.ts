import { describe, expect, it } from 'vitest';
import { redactedError, scrubEvent } from '../server/error-reporting.js';

describe('scrubEvent', () => {
  it('ne garde que le chemin de la requête', () => {
    const event = scrubEvent({
      request: {
        url: 'https://alfred.postmelo.ch/api/connexion?token=secret#frag',
        cookies: { session: 's' },
        headers: { authorization: 'Bearer t' },
        data: { password: 'p' },
        query_string: 'token=secret',
      },
      user: { email: 'a@b.ch' },
    });
    expect(event).toEqual({ request: { url: 'https://alfred.postmelo.ch/api/connexion' } });
  });

  it('laisse passer un événement sans requête', () => {
    expect(scrubEvent({})).toEqual({});
  });
});

describe('redactedError', () => {
  it('retire les secrets du message et de la pile', () => {
    const err = new TypeError('connexion refusée pour motdepasse123');
    const copy = redactedError(err, (v) => v.replaceAll('motdepasse123', '***'));
    expect(copy.name).toBe('TypeError');
    expect(copy.message).toBe('connexion refusée pour ***');
    expect(copy.stack).not.toContain('motdepasse123');
  });

  it('accepte une valeur qui n’est pas une erreur', () => {
    expect(redactedError('boum').message).toBe('boum');
  });
});
