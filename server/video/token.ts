import { createHmac } from 'node:crypto';

/** Droits d'un jeton LiveKit (sous-ensemble utile à Alfred). */
export interface VideoGrant {
  room?: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomCreate?: boolean;
  roomList?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: string[];
  canUpdateOwnMetadata?: boolean;
}

export interface TokenOptions {
  /** Identité du participant (unique dans la salle). Absente pour un jeton d'administration. */
  identity?: string;
  /** Nom affiché. */
  name?: string;
  metadata?: string;
  ttlSec: number;
  video: VideoGrant;
  /** Horloge injectable (tests), en millisecondes. */
  now?: number;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * Jeton d'accès LiveKit : un JWT HS256 signé avec le secret partagé entre Alfred et le
 * serveur de visio. Écrit à la main (node:crypto) pour ne dépendre d'aucun paquet serveur.
 */
export function signAccessToken(apiKey: string, apiSecret: string, opts: TokenOptions): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload: Record<string, unknown> = {
    iss: apiKey,
    // Une légère avance tolère une horloge du serveur de visio un peu en retard.
    nbf: now - 10,
    exp: now + opts.ttlSec,
    video: opts.video,
  };
  if (opts.identity) {
    payload.sub = opts.identity;
    payload.jti = opts.identity;
  }
  if (opts.name) payload.name = opts.name;
  if (opts.metadata) payload.metadata = opts.metadata;
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/** Lecture d'un jeton (tests et diagnostic) : vérifie la signature, renvoie la charge ou null. */
export function verifyAccessToken(token: string, apiSecret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', apiSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (expected !== parts[2]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
