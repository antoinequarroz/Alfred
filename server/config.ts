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
const smtpPort = int('SMTP_PORT', 587);
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
  caldav: {
    url: process.env.CALDAV_URL || 'https://caldav.icloud.com',
    username: process.env.CALDAV_USERNAME || '',
    password: process.env.CALDAV_PASSWORD || '',
    syncIntervalSeconds: int('CALDAV_SYNC_INTERVAL', 120),
  },
  /** Envoi des e-mails de la prise de rendez-vous (SMTP Infomaniak par défaut). */
  mail: {
    host: process.env.SMTP_HOST || 'mail.infomaniak.com',
    port: smtpPort,
    /** 465 = TLS implicite ; sinon STARTTLS obligatoire (sauf SMTP_REQUIRE_TLS=0, pour un serveur de test local). */
    secure: smtpPort === 465,
    requireTls: process.env.SMTP_REQUIRE_TLS !== '0',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: mailFrom,
    notifyTo: (process.env.MAIL_NOTIFY_TO || '').replace(/[\r\n]+/g, ' ').trim() || mailFrom.address,
  },
  /** Adresse publique d'Alfred, pour les liens dans les e-mails (sans barre finale). */
  publicUrl: (process.env.ALFRED_PUBLIC_URL || 'https://alfred.antoinequarroz.ch').replace(/\/+$/, ''),
};

export const mailConfigured = Boolean(config.mail.user && config.mail.password);

export const caldavConfigured = Boolean(config.caldav.username && config.caldav.password);
