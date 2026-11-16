import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, isIPv4, isIPv6, type LookupFunction } from 'node:net';

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
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as [string, number][]) internal.addSubnet(net, bits, 'ipv6');

/**
 * Les huit groupes de 16 bits d'une adresse IPv6, quelle que soit son écriture (abrégée ou
 * non, fin en notation pointée) ; null si ce n'est pas une adresse IPv6. On raisonne sur les
 * bits, jamais sur le texte : deux écritures de la même adresse donnent le même verdict.
 */
function v6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip.toLowerCase();
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** Vrai pour toute adresse qui n'est pas une adresse publique ordinaire (ou qui n'est pas une adresse). */
export function isInternalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (isIPv4(ip)) return internal.check(ip, 'ipv4');
  const g = v6Groups(ip);
  if (!g) return true;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
    // IPv4 mappée (::ffff:a.b.c.d) : c'est l'adresse IPv4 qui compte.
    if (g[4] === 0 && g[5] === 0xffff) return internal.check(v4Of(g[6], g[7]), 'ipv4');
    // ::/96 (::, ::1, IPv4 « compatible », obsolète) et ::ffff:0:0:0/96 (IPv4 traduite, SIIT) :
    // aucun serveur saisi à la main n'a ce genre d'adresse.
    if ((g[4] === 0 && g[5] === 0) || (g[4] === 0xffff && g[5] === 0)) return true;
  }
  // NAT64 (64:ff9b::/96) : la cible réelle est l'adresse IPv4 portée par les 32 derniers bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return internal.check(v4Of(g[6], g[7]), 'ipv4');
  return internal.check(g.map((n) => n.toString(16)).join(':'), 'ipv6');
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
/** Taille maximale d'une réponse lue par le fetch vérifié (une collection de calendrier reste très en dessous). */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Une requête HTTP(S) vers `url`, connectée à `address` et à aucune autre adresse : le nom
 * n'est pas résolu une seconde fois (un DNS qui change de réponse entre la vérification et la
 * connexion n'y gagne rien). Le certificat reste contrôlé pour le nom de l'URL.
 */
function pinnedRequest(url: URL, address: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const body = init.body === undefined || init.body === null ? null : typeof init.body === 'string' ? Buffer.from(init.body) : init.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
    if (body === undefined) {
      reject(new TypeError('corps de requête non pris en charge'));
      return;
    }
    if (body) headers['content-length'] = String(body.length);
    const family = isIPv4(address) ? 4 : 6;
    const lookup = ((_host: string, options: { all?: boolean }, callback: (err: Error | null, address: unknown, family?: number) => void) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }) as unknown as LookupFunction;
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: (init.method ?? 'GET').toUpperCase(), headers, lookup, signal: init.signal ?? undefined, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('réponse trop volumineuse'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) out.append(name, v);
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 205 || status === 304 || status < 200;
        try {
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status, statusText: res.statusMessage, headers: out }));
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.setTimeout(30_000, () => req.destroy(Object.assign(new Error('délai dépassé'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

/**
 * fetch pour un serveur CalDAV saisi dans l'app : chaque requête, redirections comprises,
 * est vérifiée (https, hôte public), puis connectée à l'adresse qui vient d'être vérifiée.
 * La vérification et la connexion portent ainsi sur la même adresse, comme pour le SMTP.
 */
export function guardedFetch(
  allowInternal: boolean, resolver: Resolver = systemResolver,
  /** Émission de la requête vers l'adresse vérifiée (remplaçable dans les tests). */
  transport: (url: URL, address: string, init: RequestInit) => Promise<Response> = pinnedRequest,
): typeof fetch {
  const check = async (url: URL): Promise<string> => {
    if (url.protocol !== 'https:' && !(allowInternal && url.protocol === 'http:')) throw new HostRefusedError('internal');
    if (url.username || url.password) throw new HostRefusedError('internal');
    return resolveGuarded(url.hostname, allowInternal, resolver);
  };
  return async (input, init) => {
    const request = typeof input === 'string' || input instanceof URL ? null : input;
    let url = new URL(request ? request.url : typeof input === 'string' ? input : (input as URL).href);
    let options: RequestInit = { ...init, redirect: 'manual' };
    if (request) {
      options = { method: request.method, headers: request.headers, signal: request.signal, body: request.body ? await request.text() : undefined, ...init, redirect: 'manual' };
    }
    for (let hop = 0; ; hop++) {
      const address = await check(url);
      const res = await transport(url, address, options);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location || init?.redirect === 'manual') return res;
      if (hop >= MAX_REDIRECTS) throw new Error('trop de redirections');
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
