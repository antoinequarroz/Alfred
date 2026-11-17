// Petites fonctions de dates en heure locale (semaine commençant le lundi).

export const LOCALE = 'fr-CH';

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000);
}

export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

export function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // lundi = 0
  return startOfDay(addDays(d, -day));
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function timeKey(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function combine(dateStr: string, timeStr: string): Date {
  const d = parseDateKey(dateStr);
  const [h, m] = timeStr.split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Arrondit au pas (en minutes) le plus proche. */
export function snapMinutes(min: number, step = 15): number {
  return Math.round(min / step) * step;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, opts);
    fmtCache.set(key, f);
  }
  return f.format(d);
}

export const fmtTime = (d: Date) => fmt(d, { hour: '2-digit', minute: '2-digit' });

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
