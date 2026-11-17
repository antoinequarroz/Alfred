import { randomBytes } from 'node:crypto';

// Identifiants universels et adresses stables (contrat de données de la suite Media).
//
// Chaque nouvel objet reçoit un UUID v7 (RFC 9562) : 48 bits d'horodatage en millisecondes,
// puis de l'aléatoire. Ils se trient donc dans l'ordre de création, sur SQLite comme sur
// PostgreSQL. Les identifiants plus anciens (UUID v4, « local:… », identifiants dérivés d'une
// URL CalDAV) restent valables : rien n'est renuméroté.
//
// Chaque objet a aussi une adresse stable « media://<module>/<type>/<id> ». Les liens, les
// notifications, la recherche et les autres modules de la suite s'en servent pour désigner un
// objet sans lire la base d'Alfred.

/** Identifiant du module dans les adresses media:// et le journal d'événements. */
export const MODULE = 'alfred';

let lastMs = -1;
let seq = 0;

/** Nouvel UUID v7. Deux appels dans la même milliseconde restent ordonnés (compteur sur 12 bits). */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) ms += 1; // compteur épuisé : on avance d'une milliseconde
  } else {
    seq = bytes[6] & 0x07; // départ aléatoire bas, pour laisser de la marge au compteur
  }
  lastMs = ms;
  // 48 bits d'horodatage, poids fort d'abord.
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f); // version 7
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 9562
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Vrai pour un UUID v7 bien formé. */
export function isUuidv7(id: string): boolean {
  return UUID_RE.test(id) && id[14] === '7';
}

/** Types d'objets d'Alfred qui ont une adresse. */
export const ALFRED_TYPES = ['calendar', 'event', 'booking', 'booking-type', 'room', 'person', 'link'] as const;
export type AlfredType = (typeof ALFRED_TYPES)[number];

export interface MediaAddress {
  module: string;
  type: string;
  id: string;
}

// Module et type : minuscules, chiffres et tirets. Identifiant : tout caractère imprimable sauf
// « / », encodé dans l'adresse (les identifiants CalDAV contiennent « : » ou « @ »).
const SEGMENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_ID = 512;

/** Adresse stable d'un objet : media://<module>/<type>/<id>. */
export function addressOf(type: string, id: string, module: string = MODULE): string {
  if (!SEGMENT_RE.test(module) || !SEGMENT_RE.test(type)) throw new Error(`Adresse invalide : ${module}/${type}`);
  if (!id || id.length > MAX_ID) throw new Error('Identifiant d’objet invalide');
  return `media://${module}/${type}/${encodeURIComponent(id)}`;
}

/** Lit une adresse media://. Renvoie null si elle est mal formée. */
export function parseAddress(address: string): MediaAddress | null {
  if (typeof address !== 'string' || address.length > 700 || !address.startsWith('media://')) return null;
  const parts = address.slice('media://'.length).split('/');
  if (parts.length !== 3) return null;
  const [module, type, raw] = parts;
  if (!SEGMENT_RE.test(module) || !SEGMENT_RE.test(type) || !raw) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!id || id.length > MAX_ID || /[\u0000-\u001f]/.test(id)) return null;
  return { module, type, id };
}
