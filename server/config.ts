import { isSupportedTimezone } from './timezone.js';

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const production = process.env.NODE_ENV === 'production';

/** « Nom <adresse> » → nom et adresse. Les retours à la ligne sont refusés (en-têtes d'e-mail). */
export function parseMailbox(value: string): { name: string; address: string } {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  const m = /^(.*)<([^<>\s]+)>$/.exec(clean);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2] };
  return { name: '', address: clean };
}

const mailFrom = parseMailbox(process.env.MAIL_FROM || 'Antoine Quarroz <info@antoinequarroz.ch>');
const timezone = process.env.ALFRED_TIMEZONE || process.env.TZ || 'Europe/Zurich';

if (!isSupportedTimezone(timezone)) {
  throw new Error(`Fuseau non pris en charge : ${timezone} (fuseaux d'Europe centrale ou UTC)`);
}
// Les heures « flottantes » et les journées entières sont interprétées dans ce fuseau.
process.env.TZ = timezone;

export const config = {
  production,
  port: int('PORT', 3200),
  host: process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
  dataDir: process.env.ALFRED_DATA_DIR || './data',
  timezone,
  /** Empreinte scrypt du mot de passe (npm run hash-password). */
  passwordHash: process.env.ALFRED_PASSWORD_HASH || '',
  sessionDays: int('ALFRED_SESSION_DAYS', 30),
  // Les identifiants de connexion (CalDAV, SMTP) sont résolus dans server/connections.ts : app, puis .env, puis défaut.
  caldav: {
    syncIntervalSeconds: int('CALDAV_SYNC_INTERVAL', 120),
  },
  mail: {
    /** Hors port 465, STARTTLS est obligatoire (sauf SMTP_REQUIRE_TLS=0, pour un serveur de test local). */
    requireTls: process.env.SMTP_REQUIRE_TLS !== '0',
    /** Expéditeur du .env : son nom sert de nom public par défaut de la prise de rendez-vous. */
    from: mailFrom,
  },
  /** Adresse publique d'Alfred, pour les liens dans les e-mails (sans barre finale). */
  publicUrl: (process.env.ALFRED_PUBLIC_URL || 'https://alfred.antoinequarroz.ch').replace(/\/+$/, ''),
};

/**
 * Réglages de connexion tels qu'ils figurent dans l'environnement (fichier .env), sans les
 * valeurs par défaut : ils servent de repli aux réglages enregistrés dans l'app
 * (voir server/connections.ts). undefined : variable absente ou vide.
 */
const raw = (name: string): string | undefined => {
  const v = process.env[name]?.replace(/[\r\n]+/g, ' ').trim();
  return v ? v : undefined;
};

export const connectionEnv = {
  smtp: {
    host: raw('SMTP_HOST'),
    port: raw('SMTP_PORT'),
    user: raw('SMTP_USER'),
    password: process.env.SMTP_PASSWORD || undefined,
    from: raw('MAIL_FROM'),
    notifyTo: raw('MAIL_NOTIFY_TO'),
  },
  caldav: {
    url: raw('CALDAV_URL'),
    username: raw('CALDAV_USERNAME'),
    password: process.env.CALDAV_PASSWORD || undefined,
  },
};

/** Clé de chiffrement des secrets enregistrés dans l'app (facultative, voir server/secrets.ts). */
export const secretKeyEnv = process.env.ALFRED_SECRET_KEY || undefined;

/**
 * Développement seulement : autorise, pour les serveurs saisis dans l'app, les adresses
 * de bouclage et privées et un serveur CalDAV en http (tests locaux contre Radicale et un faux SMTP).
 */
export const allowPrivateHosts = process.env.ALFRED_ALLOW_PRIVATE_HOSTS === '1';
