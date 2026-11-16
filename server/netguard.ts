import { lookup } from 'node:dns/promises';
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * Garde-fou contre les requêtes vers le réseau interne (SSRF).
 *
 * Un hôte saisi dans l'app (serveur SMTP, serveur CalDAV) est contacté par le serveur
 * d'Alfred, qui voit le réseau Docker du VPS. Même pour le propriétaire connecté, on refuse
 * donc les adresses de bouclage, lien-local, privées et réservées, ainsi que les noms qui
 * y résolvent : une session volée ne doit pas servir à sonder les conteneurs voisins.
 * Les valeurs du fichier .env, posées par l'administrateur du serveur, ne sont pas concernées.
 */

const internal = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as [string, number][]) internal.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], // :: et ::1
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as [string, number][]) internal.addSubnet(net, bits, 'ipv6');

/** Adresse IPv4 portée par une IPv6 (« ::ffff:a.b.c.d », NAT64 « 64:ff9b::a.b.c.d »), sinon null. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Vrai pour toute adresse qui n'est pas une adresse publique ordinaire (ou qui n'est pas une adresse). */
export function isInternalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (isIPv4(ip)) return internal.check(ip, 'ipv4');
  if (!isIPv6(ip)) return true;
  const v4 = embeddedV4(ip);
  if (v4) return !isIPv4(v4) || internal.check(v4, 'ipv4');
  return internal.check(ip, 'ipv6');
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`, 'i');
/** Noms qui désignent la machine ou le réseau local, quel que soit le DNS. */
const LOCAL_NAME_RE = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|onion)$/i;

export type HostProblem = 'syntax' | 'internal';

/**
 * Contrôle de forme d'un hôte saisi : nom de domaine complet ou adresse IP publique.
 * allowInternal (développement) : accepte aussi « localhost », les noms courts et les adresses internes.
 */
export function checkHostSyntax(host: string, allowInternal: boolean): HostProblem | null {
  if (host.length === 0 || host.length > 253 || /[\s\u0000-\u001f\u007f/@\\?#]/.test(host)) return 'syntax';
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare)) return !allowInternal && isInternalAddress(bare) ? 'internal' : null;
  // Une écriture numérique exotique (« 127.1 », « 0x7f.0.0.1 », « 2130706433 ») n'est pas un nom de domaine.
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host) || host.includes(':')) return 'syntax';
  if (allowInternal) return new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`, 'i').test(host) ? null : 'syntax';
  if (!DOMAIN_RE.test(host)) return 'syntax';
  return LOCAL_NAME_RE.test(host) ? 'internal' : null;
}

/** L'hôte désigne le réseau interne (ou ne résout pas) : la connexion est refusée. */
export class HostRefusedError extends Error {
  constructor(readonly reason: 'internal' | 'unresolved') {
    super(reason === 'internal' ? 'hôte interne refusé' : 'hôte introuvable');
  }
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Résout un hôte et renvoie une adresse à contacter. Sans allowInternal, toutes les adresses
 * doivent être publiques : un nom qui résout, même en partie, vers le réseau interne est refusé.
 * L'appelant se connecte à l'adresse renvoyée, pas au nom : la vérification et la connexion
 * portent ainsi sur la même adresse.
 */
export async function resolveGuarded(host: string, allowInternal: boolean, resolver: Resolver = systemResolver): Promise<string> {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  let addresses: string[];
  if (isIP(bare)) addresses = [bare];
  else {
    try {
      addresses = await resolver(bare);
    } catch {
      throw new HostRefusedError('unresolved');
    }
  }
  if (addresses.length === 0) throw new HostRefusedError('unresolved');
  if (!allowInternal && addresses.some(isInternalAddress)) throw new HostRefusedError('internal');
  return addresses.find((a) => isIPv4(a)) ?? addresses[0];
}

const MAX_REDIRECTS = 5;

/**
 * fetch pour un serveur CalDAV saisi dans l'app : chaque requête, redirections comprises,
 * est vérifiée (https, hôte public). Le contrôle se fait juste avant la connexion ; fetch
 * résout ensuite le nom lui-même, d'où une courte fenêtre théorique (DNS changeant entre
 * les deux) documentée dans ARCHITECTURE.md.
 */
export function guardedFetch(allowInternal: boolean, resolver: Resolver = systemResolver): typeof fetch {
  const check = async (url: URL): Promise<void> => {
    if (url.protocol !== 'https:' && !(allowInternal && url.protocol === 'http:')) throw new HostRefusedError('internal');
    if (url.username || url.password) throw new HostRefusedError('internal');
    await resolveGuarded(url.hostname, allowInternal, resolver);
  };
  return async (input, init) => {
    let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let options: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      await check(url);
      const res = await fetch(url, options);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location || init?.redirect === 'manual') return res;
      if (hop >= MAX_REDIRECTS) throw new Error('trop de redirections');
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      const headers = new Headers(options.headers);
      // Les identifiants ne suivent pas une redirection vers un autre hôte.
      if (next.host !== url.host) headers.delete('authorization');
      // 303, ou 301/302 après un POST : la suite se fait en GET, sans corps (comme un navigateur).
      const method = (options.method ?? 'GET').toUpperCase();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        headers.delete('content-type');
        options = { ...options, method: 'GET', body: undefined, headers };
      } else options = { ...options, headers };
      url = next;
    }
  };
}
