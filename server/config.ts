import { isSupportedTimezone } from './timezone.js';

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const production = process.env.NODE_ENV === 'production';
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
};

export const caldavConfigured = Boolean(config.caldav.username && config.caldav.password);
