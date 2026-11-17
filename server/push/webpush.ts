import { createCipheriv, createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Notifications push standard du web (Web Push), sans dépendance :
 * - chiffrement du message pour un appareil abonné (RFC 8291, encodage aes128gcm de la RFC 8188) ;
 * - identification d'Alfred auprès des services de push (VAPID, RFC 8292 : JWT signé en ES256).
 *
 * C'est le même mécanisme pour Safari sur iPhone et Mac (service de push d'Apple), Chrome (Google)
 * et Firefox (Mozilla) : aucun compte développeur n'est nécessaire, la paire de clés VAPID suffit.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export interface PushKeys {
  /** Clé publique ECDH P-256 de l'appareil, non compressée (65 octets), en base64url. */
  p256dh: string;
  /** Secret d'authentification de l'appareil (16 octets), en base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Clé publique non compressée (65 octets) en base64url : c'est l'applicationServerKey du navigateur. */
  publicKey: string;
  /** Scalaire privé (32 octets) en base64url. */
  privateKey: string;
}

/** Valide des clés d'abonnement envoyées par un navigateur. */
export function validPushKeys(keys: PushKeys): boolean {
  try {
    const pub = unb64u(keys.p256dh);
    const auth = unb64u(keys.auth);
    if (pub.length !== 65 || pub[0] !== 4 || auth.length !== 16) return false;
    // Le point doit être sur la courbe : sinon le chiffrement échouerait à chaque envoi.
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub);
    return true;
  } catch {
    return false;
  }
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const d = privateKey.export({ format: 'jwk' }).d!;
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)])),
    privateKey: d,
  };
}

function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const pub = unb64u(keys.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** Clé publique VAPID sous forme de KeyObject (pour vérifier une signature, en test). */
export function vapidPublicKey(publicKey: string): KeyObject {
  const pub = unb64u(publicKey);
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/**
 * En-tête Authorization VAPID pour un service de push. aud : origine du service ; sub : un contact
 * (URL https ou mailto), exigé par Apple. Le jeton vaut 12 h (24 h au plus selon la RFC).
 */
export function vapidAuthorization(keys: VapidKeys, audience: string, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: vapidPrivateKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * Chiffre un message pour un appareil (RFC 8291). Les paramètres « ephemeral » et « salt » ne servent
 * qu'aux tests (vecteur de la RFC) : par défaut, une clé et un sel neufs à chaque message.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  keys: PushKeys,
  fixed?: { ephemeralPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  // Un seul enregistrement : le texte suivi du délimiteur de dernier enregistrement (0x02).
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Services de push acceptés. Un abonnement ne peut viser qu'eux : Alfred n'envoie jamais de requête
 * vers une adresse arbitraire, même si elle vient de l'app.
 */
const PUSH_HOSTS = [/^([a-z0-9-]+\.)*push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function allowedEndpoint(endpoint: string): boolean {
  if (endpoint.length > 1024) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export type PushOutcome =
  | { ok: true }
  /** gone : l'abonnement n'existe plus (appareil désinscrit, app supprimée) et doit être oublié. */
  | { ok: false; gone: boolean; error: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface SendOptions {
  vapid: VapidKeys;
  subject: string;
  /** Durée de conservation par le service si l'appareil est éteint, en secondes. */
  ttl: number;
  urgency?: 'normal' | 'high';
  /** Un message plus récent avec le même sujet remplace l'ancien en attente (32 caractères base64url au plus). */
  topic?: string;
  fetch?: FetchLike;
}

export async function sendPush(sub: { endpoint: string; keys: PushKeys }, payload: object, opts: SendOptions): Promise<PushOutcome> {
  if (!allowedEndpoint(sub.endpoint)) return { ok: false, gone: true, error: 'Service de push non reconnu' };
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), sub.keys);
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(Math.max(0, Math.floor(opts.ttl))),
    Urgency: opts.urgency ?? 'normal',
    Authorization: vapidAuthorization(opts.vapid, new URL(sub.endpoint).origin, opts.subject),
  };
  if (opts.topic) headers.Topic = opts.topic;
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  try {
    const res = await doFetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const detail = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
    const gone = res.status === 404 || res.status === 410;
    return { ok: false, gone, error: `Le service de push a répondu ${res.status}${detail ? ` (${detail})` : ''}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return { ok: false, gone: false, error: name === 'TimeoutError' ? 'Le service de push ne répond pas' : 'Service de push injoignable' };
  }
}
