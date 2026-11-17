// Dates de la prise de rendez-vous : tout s'affiche dans le fuseau annoncé par le serveur
// (Europe/Zurich), jamais dans celui du navigateur. Un jour est une clé AAAA-MM-JJ.

const LOCALE = 'fr-CH';
const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone });
    cache.set(key, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Heure « 09:30 » d'un instant, dans le fuseau donné. */
export function timeIn(timeZone: string, iso: string): string {
  return formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** Heure (0 à 23) d'un instant dans le fuseau donné. */
export function hourIn(timeZone: string, iso: string): number {
  return Number.parseInt(timeIn(timeZone, iso).slice(0, 2), 10);
}

/** « mardi 17 novembre 2026 » pour un instant, dans le fuseau donné. */
export function dayLongIn(timeZone: string, iso: string): string {
  // fr-CH écrit « jeudi, 19 novembre 2026 » : on retire la virgule, comme dans le reste de la page.
  return formatter(timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)).replace(',', '');
}

/** Date et heure courtes « lun. 16 nov. 2026, 09:00 », dans le fuseau donné. */
export function dateTimeShortIn(timeZone: string, iso: string): string {
  return formatter(timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** Clé AAAA-MM-JJ du jour d'un instant, dans le fuseau donné. */
export function dayKeyIn(timeZone: string, date: Date): string {
  const parts = formatter(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// --- arithmétique sur les clés de jour (sans fuseau : via UTC) ----------------

function keyToUtc(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function utcToKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDaysKey(key: string, n: number): string {
  const d = keyToUtc(key);
  d.setUTCDate(d.getUTCDate() + n);
  return utcToKey(d);
}

/** Mois « AAAA-MM » d'une clé de jour. */
export const monthOf = (key: string) => key.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const firstDayOf = (month: string) => `${month}-01`;
export const lastDayOf = (month: string) => addDaysKey(firstDayOf(addMonths(month, 1)), -1);

/** Semaines complètes (lundi à dimanche) couvrant le mois. */
export function monthWeeks(month: string): string[][] {
  const first = keyToUtc(firstDayOf(month));
  const offset = (first.getUTCDay() + 6) % 7; // lundi = 0
  let day = addDaysKey(firstDayOf(month), -offset);
  const last = lastDayOf(month);
  const weeks: string[][] = [];
  while (day <= last) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDaysKey(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** « Novembre 2026 ». */
export function monthLabel(month: string): string {
  return capitalize(formatter('UTC', { month: 'long', year: 'numeric' }).format(keyToUtc(firstDayOf(month))));
}

/** « mardi 17 novembre » pour une clé de jour. */
export function dayLabel(key: string, withYear = false): string {
  return formatter('UTC', { weekday: 'long', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) }).format(keyToUtc(key)).replace(',', '');
}

export const dayNumber = (key: string) => Number.parseInt(key.slice(8), 10);

export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${pad(m)}`;
}

/** Nom lisible du fuseau : « heure de Suisse (Europe/Zurich) ». */
export function timezoneLabel(timeZone: string): string {
  return timeZone === 'Europe/Zurich' ? 'heure de Suisse (Europe/Zurich)' : `fuseau ${timeZone}`;
}
