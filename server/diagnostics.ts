import { HostRefusedError } from './netguard.js';

/**
 * Diagnostics lisibles pour les échecs SMTP et CalDAV.
 *
 * Les erreurs de nodemailer et de tsdav peuvent reprendre la réponse du serveur, une URL
 * ou un identifiant. Rien de cela ne sort d'ici : on ne garde que la nature de la panne
 * (un code stable) et un message en français écrit à la main.
 */

export interface Diagnostic {
  /** Code stable (voir docs/API-RDV.md). */
  code: string;
  /** Message affichable, sans détail sensible. */
  message: string;
}

/** Erreur dont le message est déjà un diagnostic affichable. */
export class DiagnosedError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  responseCode?: unknown;
  command?: unknown;
  cause?: unknown;
  status?: unknown;
}

/** Codes d'erreur (chaînes courtes en majuscules) de l'erreur et de ses causes, du plus proche au plus profond. */
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const e = current as ErrorLike & { errors?: unknown };
    if (typeof e.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code)) codes.push(e.code);
    // AggregateError (connexion essayée en IPv4 puis IPv6) : les codes des essais.
    if (Array.isArray(e.errors)) {
      for (const inner of e.errors) {
        const code = (inner as ErrorLike | null)?.code;
        if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) codes.push(code);
      }
    }
    current = e.cause;
  }
  return codes;
}

const text = (err: unknown): string => (err && typeof err === 'object' && typeof (err as ErrorLike).message === 'string' ? ((err as ErrorLike).message as string) : '');

const TLS_CODES = /^(?:CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_|ERR_TLS_|ERR_SSL_|EPROTO$|ETLS$|EREQUIRETLS$|HOSTNAME_MISMATCH)/;

function networkDiagnostic(codes: string[], what: string): Diagnostic | null {
  if (codes.some((c) => c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EDNS' || c === 'EAI_NONAME' || c === 'ENODATA')) {
    return { code: 'host_not_found', message: `Hôte introuvable : vérifie le nom du serveur ${what}.` };
  }
  if (codes.some((c) => TLS_CODES.test(c))) {
    return { code: 'tls', message: `La connexion sécurisée (TLS) avec le serveur ${what} a échoué : vérifie le nom du serveur et le port.` };
  }
  if (codes.includes('ECONNREFUSED')) {
    return { code: 'connection_refused', message: `Le serveur ${what} refuse la connexion : vérifie le nom du serveur et le port.` };
  }
  if (codes.some((c) => c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'UND_ERR_HEADERS_TIMEOUT' || c === 'ABORT_ERR')) {
    return { code: 'timeout', message: `Délai dépassé : le serveur ${what} ne répond pas (nom du serveur, port, ou pare-feu).` };
  }
  if (codes.some((c) => c === 'ECONNRESET' || c === 'EPIPE' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'UND_ERR_SOCKET' || c === 'ECONNECTION' || c === 'ESOCKET')) {
    return { code: 'connection_failed', message: `Connexion au serveur ${what} impossible ou interrompue : vérifie le nom du serveur et le port.` };
  }
  return null;
}

function refused(err: HostRefusedError, what: string): Diagnostic {
  return err.reason === 'internal'
    ? { code: 'host_refused', message: `Ce serveur ${what} désigne une adresse interne ou privée : Alfred ne s’y connecte pas.` }
    : { code: 'host_not_found', message: `Hôte introuvable : vérifie le nom du serveur ${what}.` };
}

/** Échec d'un envoi SMTP (erreur de nodemailer, délai, garde-fou réseau). */
export function describeSmtpError(err: unknown): Diagnostic {
  if (err instanceof DiagnosedError) return err.diagnostic;
  if (err instanceof HostRefusedError) return refused(err, 'd’envoi');
  // nodemailer range souvent la panne réseau sous ESOCKET et ne laisse son code (ECONNREFUSED…) que dans le texte.
  const codes = [...errorCodes(err), ...(text(err).match(/\bE[A-Z]{3,}(?:_[A-Z]+)*\b/g) ?? [])];
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const response = typeof e.responseCode === 'number' ? e.responseCode : 0;
  if (codes.includes('EAUTH') || codes.includes('ENOAUTH') || response === 535 || response === 534 || response === 530) {
    return { code: 'auth', message: 'Identifiants refusés par le serveur d’envoi : vérifie l’identifiant (l’adresse de la boîte) et le mot de passe.' };
  }
  if (codes.includes('EENVELOPE') || codes.includes('EMAXRECIPIENTS')) {
    return { code: 'rejected', message: 'Le serveur d’envoi a refusé l’expéditeur ou le destinataire : vérifie l’adresse d’expéditeur (elle doit appartenir à la boîte) et l’adresse de destination.' };
  }
  const network = networkDiagnostic(codes.filter((c) => c !== 'ECONNECTION' && c !== 'ESOCKET'), 'd’envoi');
  if (network) return network;
  // nodemailer range sous ESOCKET/ECONNECTION des pannes très différentes : le texte aide à trancher, sans être repris.
  const message = text(err);
  if (/timeout|timed out/i.test(message)) return networkDiagnostic(['ETIMEDOUT'], 'd’envoi')!;
  if (/certificate|self[- ]signed|SSL routines|wrong version number|STARTTLS|TLS/i.test(message)) return networkDiagnostic(['ETLS'], 'd’envoi')!;
  const generic = networkDiagnostic(codes, 'd’envoi');
  if (generic) return generic;
  if (codes.includes('EMESSAGE') || (response >= 500 && response < 600)) {
    return { code: 'rejected', message: `Le serveur d’envoi a refusé le message${response ? ` (code ${response})` : ''}.` };
  }
  if (response >= 400 && response < 500) {
    return { code: 'temporary', message: `Le serveur d’envoi est momentanément indisponible (code ${response}) : réessaie dans quelques minutes.` };
  }
  if (codes.includes('EPROTOCOL') || codes.includes('EHLO')) {
    return { code: 'protocol', message: 'Le serveur a répondu de façon inattendue : ce n’est peut-être pas un serveur d’envoi (SMTP), ou pas le bon port.' };
  }
  return { code: 'unknown', message: 'L’envoi a échoué pour une raison inconnue. Vérifie le serveur, le port et les identifiants.' };
}

/** Échec d'une connexion ou d'une synchro CalDAV (erreur de tsdav ou de fetch, délai, garde-fou réseau). */
export function describeCaldavError(err: unknown): Diagnostic {
  if (err instanceof DiagnosedError) return err.diagnostic;
  if (err instanceof HostRefusedError) return refused(err, 'de calendrier');
  const network = networkDiagnostic(errorCodes(err), 'de calendrier');
  if (network) return network;
  const message = text(err);
  if (/invalid credentials|\b401\b|unauthori[sz]ed/i.test(message)) {
    return { code: 'auth', message: 'Identifiants refusés par le serveur de calendrier : vérifie l’identifiant et le mot de passe d’application.' };
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return { code: 'forbidden', message: 'Le serveur de calendrier refuse l’accès à ce compte (erreur 403).' };
  }
  if (/\b429\b|too many/i.test(message)) {
    return { code: 'temporary', message: 'Le serveur de calendrier demande de patienter (trop de requêtes) : réessaie dans quelques minutes.' };
  }
  if (/\b50[0-4]\b/.test(message)) {
    return { code: 'temporary', message: 'Le serveur de calendrier est momentanément indisponible : réessaie dans quelques minutes.' };
  }
  if (/liste de calendriers vide/i.test(message)) {
    return { code: 'empty', message: 'Le serveur a renvoyé une liste de calendriers vide : rien n’a été modifié, la prochaine synchro réessaiera.' };
  }
  if (/redirections/i.test(message)) {
    return { code: 'not_caldav', message: 'Le serveur renvoie sans fin vers une autre adresse : vérifie l’adresse du serveur de calendrier.' };
  }
  if (/cannot find|homeUrl|principal|rootUrl|\b404\b|\b405\b|not found|must be a valid|invalid url|xml|collection/i.test(message)) {
    return { code: 'not_caldav', message: 'Aucun calendrier CalDAV trouvé à cette adresse : vérifie l’adresse du serveur.' };
  }
  if (/fetch failed|network|socket/i.test(message)) {
    return { code: 'connection_failed', message: 'Connexion au serveur de calendrier impossible : vérifie l’adresse du serveur.' };
  }
  return { code: 'unknown', message: 'La connexion au serveur de calendrier a échoué pour une raison inconnue.' };
}

/**
 * Ligne de journal pour un échec : le code du diagnostic et les codes techniques de l'erreur
 * (« EAUTH », « ENOTFOUND », code de réponse SMTP), jamais son texte.
 */
export function logLine(diagnostic: Diagnostic, err: unknown): string {
  const codes = [...new Set(errorCodes(err))];
  const response = err && typeof err === 'object' && typeof (err as ErrorLike).responseCode === 'number' ? ` réponse ${(err as ErrorLike).responseCode as number}` : '';
  return `${diagnostic.message} [${diagnostic.code}${codes.length ? ` ; ${codes.join(', ')}` : ''}${response}]`;
}

/**
 * Retire d'un texte toute trace des secrets donnés (en clair, encodés pour une URL ou en
 * base64) et les identifiants glissés dans une URL. Dernier filet avant un journal.
 */
export function redact(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (!secret) continue;
    const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret, 'utf8').toString('base64'), Buffer.from(secret, 'utf8').toString('base64url')]);
    for (const form of forms) if (form.length >= 3) out = out.split(form).join('•••');
  }
  return out
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, '$1•••@')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=_-]{8,}/gi, '$1 •••');
}
