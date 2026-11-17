// Garde-fou réseau (SSRF) et diagnostics sans détail sensible.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeCaldavError, describeSmtpError, logLine, redact } from '../server/diagnostics.js';
import { checkHostSyntax, guardedFetch, HostRefusedError, isInternalAddress, resolveGuarded } from '../server/netguard.js';

describe('adresses internes', () => {
  it('reconnaît le bouclage, le lien-local, les réseaux privés et réservés', () => {
    for (const ip of [
      '127.0.0.1', '127.8.9.10', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '[::1]',
      // La même adresse sous d'autres écritures : IPv4 « compatible », IPv4 traduite (SIIT), NAT64 non abrégé, mappée en long.
      '::127.0.0.1', '::7f00:1', '::10.0.0.1', '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '64:ff9b:0:0:0:0:7f00:1', '64:ff9b:0::a00:1', '64:FF9B::127.0.0.1',
      '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:ffff:c0a8:0001', '::8.8.8.8', 'fe80::1%eth0', '2001:db8::1', 'pas-une-adresse', '',
    ]) expect(isInternalAddress(ip), ip).toBe(true);
  });

  it('laisse passer les adresses publiques', () => {
    for (const ip of ['83.166.143.44', '17.253.144.10', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2a00:1450:400a:800::200e', '2620:149:af0::10', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:808:808', '64:ff9b::8.8.8.8', '64:ff9b:0:0:0:0:808:808']) {
      expect(isInternalAddress(ip), ip).toBe(false);
    }
  });
});

describe('forme d’un hôte saisi', () => {
  it('accepte un nom de domaine complet ou une adresse publique', () => {
    for (const host of ['mail.infomaniak.com', 'smtp.gmail.com', 'caldav.icloud.com', 'p42-caldav.icloud.com', 'xn--bcher-kva.ch', '83.166.143.44', '[2a00:1450:400a:800::200e]']) {
      expect(checkHostSyntax(host, false), host).toBeNull();
    }
  });

  it('refuse les adresses et les noms internes', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '169.254.169.254', '[::1]', '::1', 'fd00::5', '::127.0.0.1', '[::7f00:1]', '::ffff:0:7f00:1', '64:ff9b:0:0:0:0:7f00:1', 'serveur.local', 'db.internal', 'app.localhost', 'nas.lan']) {
      expect(checkHostSyntax(host, false), host).toBe('internal');
    }
  });

  it('refuse ce qui n’est pas un nom de domaine : nom court, écriture numérique exotique, caractères parasites', () => {
    for (const host of [
      'localhost', 'postgres', 'redis', '127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', 'mail..exemple.ch', '-mail.exemple.ch', 'mail.exemple.ch:25',
      'user@mail.exemple.ch', 'mail.exemple.ch/chemin', 'mail exemple.ch', 'mail.exemple.ch\r\nRCPT', 'mail.exemple.123', '', 'a'.repeat(254),
    ]) expect(checkHostSyntax(host, false), JSON.stringify(host)).toBe('syntax');
  });

  it('en développement (variable explicite), accepte le bouclage et les noms courts', () => {
    for (const host of ['127.0.0.1', 'localhost', 'radicale', '10.0.0.5', '[::1]']) expect(checkHostSyntax(host, true), host).toBeNull();
    expect(checkHostSyntax('mail exemple.ch', true)).toBe('syntax');
    expect(checkHostSyntax('a/b', true)).toBe('syntax');
  });
});

describe('résolution vérifiée', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    if (!(host in map)) throw Object.assign(new Error('introuvable'), { code: 'ENOTFOUND' });
    return map[host];
  };

  it('refuse un nom public qui résout vers le réseau interne, même en partie', async () => {
    const r = resolver({ 'piege.exemple.ch': ['172.18.0.5'], 'mixte.exemple.ch': ['83.166.143.44', '10.0.0.1'], 'ok.exemple.ch': ['2a00:1450::1', '83.166.143.44'] });
    await expect(resolveGuarded('piege.exemple.ch', false, r)).rejects.toMatchObject({ reason: 'internal' });
    await expect(resolveGuarded('mixte.exemple.ch', false, r)).rejects.toBeInstanceOf(HostRefusedError);
    await expect(resolveGuarded('absent.exemple.ch', false, r)).rejects.toMatchObject({ reason: 'unresolved' });
    await expect(resolveGuarded('127.0.0.1', false, r)).rejects.toMatchObject({ reason: 'internal' });
    // L'adresse renvoyée est celle qui a été vérifiée (IPv4 de préférence) : c'est à elle qu'on se connecte.
    expect(await resolveGuarded('ok.exemple.ch', false, r)).toBe('83.166.143.44');
    expect(await resolveGuarded('piege.exemple.ch', true, r)).toBe('172.18.0.5');
  });
});

describe('fetch vérifié (CalDAV saisi dans l’app)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
    server = null;
  });

  it('refuse http, les hôtes internes et les identifiants dans l’URL, sans émettre de requête', async () => {
    let hits = 0;
    server = createServer((_req, res) => { hits++; res.end('ok'); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const strict = guardedFetch(false);
    await expect(strict(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(HostRefusedError);
    await expect(strict(`https://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(HostRefusedError);
    await expect(strict('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(HostRefusedError);
    await expect(guardedFetch(false, async () => ['10.0.0.9'])('https://voisin.exemple.ch/')).rejects.toBeInstanceOf(HostRefusedError);
    await expect(guardedFetch(true)(`http://u:p@127.0.0.1:${port}/`)).rejects.toBeInstanceOf(HostRefusedError);
    expect(hits).toBe(0);
    expect((await guardedFetch(true)(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect(hits).toBe(1);
  });

  it('vérifie aussi chaque redirection : une réponse 302 vers le réseau interne n’est pas suivie', async () => {
    const calls: string[] = [];
    const resolver = async (host: string) => (host === 'interne.exemple.ch' ? ['172.18.0.7'] : ['83.166.143.44']);
    const redirecting = (location: string) => async (url: URL, address: string) => {
      calls.push(`${url.href} -> ${address}`);
      return new Response(null, { status: 302, headers: { location } });
    };
    await expect(guardedFetch(false, resolver, redirecting('https://interne.exemple.ch/secret'))('https://public.exemple.ch/dav/')).rejects.toMatchObject({ reason: 'internal' });
    expect(calls).toEqual(['https://public.exemple.ch/dav/ -> 83.166.143.44']);
    // Redirection vers http : refusée aussi.
    await expect(guardedFetch(false, resolver, redirecting('http://public.exemple.ch/dav/'))('https://public.exemple.ch/dav/')).rejects.toBeInstanceOf(HostRefusedError);
    expect(calls).toHaveLength(2);
  });

  it('se connecte à l’adresse vérifiée, pas à une seconde résolution du nom (DNS changeant)', async () => {
    let hits = 0;
    const hosts: (string | undefined)[] = [];
    server = createServer((req, res) => { hits++; hosts.push(req.headers.host); res.end('ici'); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // Le nom n'existe dans aucun DNS : seule l'adresse rendue par la vérification permet d'arriver.
    const res = await guardedFetch(true, async () => ['127.0.0.1'])(`http://calendrier.exemple.invalid:${port}/dav/`, { method: 'PROPFIND', body: '<x/>', headers: { depth: '0' } });
    expect(await res.text()).toBe('ici');
    expect(hosts).toEqual([`calendrier.exemple.invalid:${port}`]);
    // À l'inverse : le nom désigne cette machine pour le système, mais la vérification a rendu une
    // adresse publique. La requête ne doit pas arriver ici (elle part vers l'adresse vérifiée, injoignable).
    const strict = guardedFetch(true, async () => ['192.0.2.55']);
    await expect(strict(`http://localhost:${port}/`, { signal: AbortSignal.timeout(400) })).rejects.toBeDefined();
    expect(hits).toBe(1);
  });

  it('ne fait pas suivre les identifiants vers un autre hôte lors d’une redirection', async () => {
    const seen: (string | undefined)[] = [];
    const other = createServer((req, res) => { seen.push(req.headers.authorization); res.end('autre'); });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    server = createServer((req, res) => {
      if (req.url === '/vers-autre') res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/` }).end();
      else if (req.url === '/meme-hote') res.writeHead(307, { location: '/arrivee' }).end();
      else res.end(req.headers.authorization ?? 'sans');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const headers = { authorization: 'Basic abcdefgh' };
      const res = await guardedFetch(true)(`http://127.0.0.1:${port}/vers-autre`, { headers });
      expect(await res.text()).toBe('autre');
      expect(seen).toEqual([undefined]);
      expect(await (await guardedFetch(true)(`http://127.0.0.1:${port}/meme-hote`, { headers })).text()).toBe('Basic abcdefgh');
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
});

describe('diagnostics', () => {
  const SECRET = ['mot', 'secret', 'jamais', 'affiché'].join('-');

  it('traduit les pannes SMTP sans reprendre le texte du serveur', () => {
    const auth = Object.assign(new Error(`Invalid login: 535 5.7.8 refusé pour info@exemple.ch avec ${SECRET}`), { code: 'EAUTH', responseCode: 535, response: `535 ${SECRET}` });
    const d = describeSmtpError(auth);
    expect(d.code).toBe('auth');
    expect(d.message).toContain('Identifiants refusés');
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(logLine(d, auth)).not.toContain(SECRET);
    expect(logLine(d, auth)).toContain('EAUTH');

    expect(describeSmtpError(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.exemple.ch'), { code: 'EDNS' })).code).toBe('host_not_found');
    expect(describeSmtpError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:587'), { code: 'ESOCKET', cause: { code: 'ECONNREFUSED' } })).code).toBe('connection_refused');
    expect(describeSmtpError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:587'), { code: 'ECONNREFUSED' })).code).toBe('connection_refused');
    expect(describeSmtpError(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })).code).toBe('timeout');
    expect(describeSmtpError(Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' })).message).toContain('Délai dépassé');
    expect(describeSmtpError(Object.assign(new Error('self-signed certificate'), { code: 'ESOCKET' })).code).toBe('tls');
    expect(describeSmtpError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).code).toBe('tls');
    expect(describeSmtpError(Object.assign(new Error('x'), { code: 'ETLS' })).message).toContain('TLS');
    expect(describeSmtpError(Object.assign(new Error('Mail command failed'), { code: 'EENVELOPE', responseCode: 550 })).code).toBe('rejected');
    expect(describeSmtpError(new HostRefusedError('internal')).code).toBe('host_refused');
    expect(describeSmtpError(new Error(`n'importe quoi ${SECRET}`))).toEqual({ code: 'unknown', message: expect.not.stringContaining(SECRET) as string });
    expect(describeSmtpError(null).code).toBe('unknown');
  });

  it('traduit les pannes CalDAV', () => {
    expect(describeCaldavError(new Error('Invalid credentials')).code).toBe('auth');
    expect(describeCaldavError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code).toBe('host_not_found');
    expect(describeCaldavError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).code).toBe('connection_refused');
    expect(describeCaldavError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })).code).toBe('tls');
    expect(describeCaldavError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).code).toBe('timeout');
    expect(describeCaldavError(new Error('cannot find homeUrl')).code).toBe('not_caldav');
    expect(describeCaldavError(new HostRefusedError('internal')).code).toBe('host_refused');
    const odd = describeCaldavError(new Error(`https://moi:${SECRET}@exemple.ch a répondu bizarrement`));
    expect(odd.code).toBe('unknown');
    expect(odd.message).not.toContain(SECRET);
  });

  it('retire les secrets d’un texte destiné au journal', () => {
    const b64 = Buffer.from(SECRET).toString('base64');
    const line = `échec ${SECRET} / ${encodeURIComponent(SECRET)} / ${b64} sur https://moi:autre-chose@exemple.ch/x, Authorization: Basic ${Buffer.from(`moi:${SECRET}`).toString('base64')}`;
    const out = redact(line, [SECRET, '']);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(encodeURIComponent(SECRET));
    expect(out).not.toContain(b64);
    expect(out).not.toContain('autre-chose');
    expect(out).not.toContain(Buffer.from(`moi:${SECRET}`).toString('base64'));
    expect(out).toContain('https://•••@exemple.ch/x');
  });
});
