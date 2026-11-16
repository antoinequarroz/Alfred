// Faux serveur SMTP local pour les tests : accepte tout, garde les messages reçus.
import { createServer, type Server, type Socket } from 'node:net';

export interface ReceivedMail {
  from: string;
  to: string[];
  /** Message brut (en-têtes et corps). */
  raw: string;
}

export interface FakeSmtp {
  port: number;
  mails: ReceivedMail[];
  /** Identifiants reçus par AUTH PLAIN (utilisateur, mot de passe). */
  logins: [string, string][];
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  /** Refuse les destinataires qui contiennent ce texte (réponse 550). */
  rejectRecipient?: string;
}

export async function startFakeSmtp(opts: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const mails: ReceivedMail[] = [];
  const logins: [string, string][] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let current: ReceivedMail = { from: '', to: [], raw: '' };
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 localhost ESMTP faux serveur');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          mails.push(current);
          current = { from: '', to: [], raw: '' };
          inData = false;
          say('250 OK message accepté');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 10485760\r\n');
        else if (cmd.startsWith('HELO')) say('250 localhost');
        else if (cmd.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          logins.push([user, pass]);
          say('235 OK');
        } else if (cmd.startsWith('MAIL FROM:')) {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          say('250 OK');
        } else if (cmd.startsWith('RCPT TO:')) {
          const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (opts.rejectRecipient && to.includes(opts.rejectRecipient)) say('550 Boîte inconnue');
          else {
            current.to.push(to);
            say('250 OK');
          }
        } else if (cmd === 'DATA') {
          inData = true;
          say('354 Envoyez le message');
        } else if (cmd === 'RSET') {
          current = { from: '', to: [], raw: '' };
          say('250 OK');
        } else if (cmd === 'QUIT') {
          say('221 Au revoir');
          socket.end();
        } else say('250 OK');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    mails,
    logins,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Lecture d'un message MIME (juste ce qu'il faut pour vérifier le contenu)

export interface MimePart {
  headers: Record<string, string>;
  /** Corps décodé (texte). */
  body: string;
  parts: MimePart[];
}

function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BQ]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_m, _charset: string, enc: string, text: string) =>
      enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(Number.parseInt(h, 16))), 'latin1').toString('utf8'),
    );
}

function decodeQuotedPrintable(text: string): string {
  const bytes = text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

export function parseMime(raw: string): MimePart {
  const split = raw.indexOf('\r\n\r\n');
  const head = split < 0 ? raw : raw.slice(0, split);
  let body = split < 0 ? '' : raw.slice(split + 4);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = decodeWords(line.slice(i + 1).trim());
  }
  const type = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  const parts: MimePart[] = [];
  if (boundary) {
    const chunks = body.split(`--${boundary}`);
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith('--')) break;
      parts.push(parseMime(chunk.replace(/^\r\n/, '').replace(/\r\n$/, '')));
    }
    body = '';
  } else {
    const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
    if (encoding === 'base64') body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    else if (encoding === 'quoted-printable') body = decodeQuotedPrintable(body);
  }
  return { headers, body, parts };
}

/** Première partie (en profondeur) dont le type commence par le préfixe donné. */
export function findPart(part: MimePart, typePrefix: string): MimePart | undefined {
  if ((part.headers['content-type'] ?? 'text/plain').toLowerCase().startsWith(typePrefix) && part.parts.length === 0) return part;
  for (const p of part.parts) {
    const found = findPart(p, typePrefix);
    if (found) return found;
  }
  return undefined;
}
