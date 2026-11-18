import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiToken, ApiTokenCreated, ApiTokenKind } from '../shared/types.js';
import { uuidv7 } from './ids.js';
import type { Sql } from './sql.js';

// Jetons d'accès à l'API v1 (phase 4, ALFRED-303).
//
//   api_tokens (id, space_id, name, kind, calendar_id, token_hash, created_at, last_used_at)
//
// Deux sortes de jetons :
//   - 'api'  : lecture de l'API v1 (en-tête « Authorization: Bearer alf_… »), pour la suite
//              PostMelo en attendant la connexion unique ;
//   - 'feed' : abonnement au flux iCalendar d'un seul calendrier (le jeton est dans l'adresse,
//              qu'Apple Calendrier ne sait pas accompagner d'un en-tête).
// Le jeton n'est montré qu'une fois, à sa création ; seule son empreinte SHA-256 est gardée.
// Le retirer coupe l'accès tout de suite.

export class TokenError extends Error {
  constructor(readonly status: 400 | 404, readonly code: string, message: string, readonly fields?: Record<string, string>) {
    super(message);
  }
}

interface TokenRow {
  id: string;
  name: string;
  kind: ApiTokenKind;
  calendar_id: string | null;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
}

const PREFIX: Record<ApiTokenKind, string> = { api: 'alf_', feed: 'alfcal_' };
const MAX_TOKENS = 50;
/** La date de dernière utilisation n'est réécrite qu'une fois par minute au plus. */
const TOUCH_MS = 60_000;

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export class ApiTokens {
  constructor(private readonly db: Sql, private readonly now: () => Date = () => new Date()) {}

  private toToken(r: TokenRow): ApiToken {
    return { id: r.id, name: r.name, kind: r.kind, calendarId: r.calendar_id, createdAt: r.created_at, lastUsedAt: r.last_used_at };
  }

  list(): ApiToken[] {
    return this.db.all<TokenRow>('SELECT * FROM api_tokens WHERE space_id = ? ORDER BY created_at, id', this.db.spaceId).map((r) => this.toToken(r));
  }

  /** Crée un jeton ; la valeur en clair n'est renvoyée qu'ici. */
  create(body: unknown): ApiTokenCreated {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const kind = b.kind === 'feed' ? 'feed' : b.kind === 'api' || b.kind === undefined ? 'api' : null;
    if (!kind) throw new TokenError(400, 'invalid', 'Sorte de jeton inconnue', { kind: 'api ou feed' });
    const name = typeof b.name === 'string' ? b.name.trim().replace(/[\u0000-\u001f\u007f]/g, '') : '';
    if (!name || name.length > 80) throw new TokenError(400, 'invalid', 'Donne un nom au jeton (80 caractères au plus)', { name: 'Donne un nom au jeton (80 caractères au plus)' });
    let calendarId: string | null = null;
    if (kind === 'feed') {
      calendarId = typeof b.calendarId === 'string' ? b.calendarId : '';
      if (!calendarId || !this.db.get('SELECT 1 AS ok FROM calendars WHERE id = ? AND space_id = ?', calendarId, this.db.spaceId)) {
        throw new TokenError(400, 'invalid', 'Choisis le calendrier à partager', { calendarId: 'Calendrier introuvable' });
      }
    }
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_tokens WHERE space_id = ?', this.db.spaceId)?.n ?? 0;
    if (Number(count) >= MAX_TOKENS) throw new TokenError(400, 'too_many', `${MAX_TOKENS} jetons au plus : retire ceux qui ne servent plus.`);
    const token = PREFIX[kind] + randomBytes(32).toString('base64url');
    const now = this.now();
    const row: TokenRow = {
      id: uuidv7(now.getTime()), name, kind, calendar_id: calendarId, token_hash: hashOf(token), created_at: now.toISOString(), last_used_at: null,
    };
    this.db.run(
      'INSERT INTO api_tokens (id, space_id, name, kind, calendar_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      row.id, this.db.spaceId, row.name, row.kind, row.calendar_id, row.token_hash, row.created_at);
    return { ...this.toToken(row), token, feedPath: kind === 'feed' ? `/api/v1/feeds/${token}.ics` : null };
  }

  remove(id: string): void {
    const r = this.db.run('DELETE FROM api_tokens WHERE id = ? AND space_id = ?', id, this.db.spaceId);
    if (r.changes === 0) throw new TokenError(404, 'not_found', 'Jeton introuvable');
  }

  /** Le jeton présenté, s'il existe et est de la bonne sorte ; note sa dernière utilisation. */
  check(token: string, kind: ApiTokenKind): ApiToken | null {
    if (!token.startsWith(PREFIX[kind]) || token.length > 200) return null;
    const hash = hashOf(token);
    const row = this.db.get<TokenRow>('SELECT * FROM api_tokens WHERE token_hash = ? AND space_id = ?', hash, this.db.spaceId);
    if (!row || row.kind !== kind) return null;
    // Recherche par empreinte, puis comparaison à temps constant (ceinture et bretelles).
    if (!timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;
    const now = this.now();
    if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) >= TOUCH_MS) {
      row.last_used_at = now.toISOString();
      this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND space_id = ?', row.last_used_at, row.id, this.db.spaceId);
    }
    return this.toToken(row);
  }
}
