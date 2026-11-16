/**
 * Calcul des créneaux libres de la prise de rendez-vous.
 *
 * Module pur : aucune base, aucune horloge implicite. Tout se raisonne en
 * « heure murale » du fuseau donné (Europe/Zurich), jour par jour, puis chaque
 * créneau est converti en instant UTC. On ne fait donc jamais d'arithmétique
 * en millisecondes à travers un changement d'heure pour placer un créneau.
 */

export interface SlotType {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeHours: number;
  horizonDays: number;
}

/** Plage horaire hebdomadaire. weekday : 1 = lundi … 7 = dimanche (ISO). Minutes depuis minuit, heure locale. */
export interface HoursRange {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** Ce qui peut occuper l'agenda : une occurrence d'événement ou une réservation. */
export interface BusyEvent {
  /** Instant ISO, ou date AAAA-MM-JJ si allDay. */
  start: string;
  /** Instant ISO, ou date AAAA-MM-JJ exclusive si allDay. */
  end: string;
  allDay?: boolean;
  /** TRANSP:TRANSPARENT (« disponible ») : ne bloque pas. */
  transparent?: boolean;
  /** STATUS:CANCELLED : ne bloque pas. */
  cancelled?: boolean;
  /**
   * Tampons propres à cet élément (une réservation existante garde ceux de son type) :
   * aucun nouveau rendez-vous ne peut empiéter dessus.
   */
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}

export interface SlotQuery {
  type: SlotType;
  hours: HoursRange[];
  /** Pas des créneaux en minutes (15, 30 ou 60). */
  stepMin: number;
  timezone: string;
  /** Premier jour (AAAA-MM-JJ, heure locale), inclus. */
  from: string;
  /** Dernier jour (AAAA-MM-JJ, heure locale), inclus. */
  to: string;
  now: Date;
  busy: BusyEvent[];
}

export interface SlotDay {
  /** Jour local AAAA-MM-JJ. */
  date: string;
  /** Débuts des créneaux libres, instants ISO UTC, triés. */
  slots: string[];
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Garde-fou : nombre maximal de jours parcourus en un appel. */
export const MAX_SLOT_DAYS = 100;

// ---------------------------------------------------------------------------
// Fuseau : conversions heure murale <-> instant, via Intl (données IANA de Node)

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Heure murale d'un instant, exprimée comme un « faux UTC » (ms). */
function wallOf(utcMs: number, timezone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(utcMs)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Décalage du fuseau à un instant donné (ms, positif à l'est de Greenwich). */
export function offsetAt(utcMs: number, timezone: string): number {
  return wallOf(Math.floor(utcMs / 1000) * 1000, timezone) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Instant UTC (ms) d'une heure murale. Renvoie null si cette heure n'existe pas
 * (saut du passage à l'heure d'été). Si elle existe deux fois (retour à l'heure
 * d'hiver), c'est la première qui est renvoyée.
 */
export function wallToUtc(timezone: string, year: number, month: number, day: number, minutes = 0): number | null {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  const a = offsetAt(naive - DAY_MS, timezone);
  const b = offsetAt(naive + DAY_MS, timezone);
  // Le plus grand décalage donne l'instant le plus tôt.
  for (const off of a === b ? [a] : [Math.max(a, b), Math.min(a, b)]) {
    const t = naive - off;
    if (offsetAt(t, timezone) === off) return t;
  }
  return null;
}

/** Jour local (AAAA-MM-JJ) d'un instant. */
export function localDateOf(utcMs: number, timezone: string): string {
  return new Date(wallOf(utcMs, timezone)).toISOString().slice(0, 10);
}

/** Minutes écoulées depuis minuit, heure locale, pour un instant. */
export function localMinutesOf(utcMs: number, timezone: string): number {
  const w = new Date(wallOf(utcMs, timezone));
  return w.getUTCHours() * 60 + w.getUTCMinutes();
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Numéro de jour (jours depuis l'époque) d'une date AAAA-MM-JJ : sert à compter en jours calendaires. */
function dayNumber(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Date invalide : ${date}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

function dateOfDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Ajoute des jours calendaires à une date AAAA-MM-JJ. */
export function addDays(date: string, days: number): string {
  return dateOfDayNumber(dayNumber(date) + days);
}

/** Minuit local d'une date (ms UTC). Si minuit n'existe pas ce jour-là, première heure valide. */
export function startOfLocalDay(date: string, timezone: string): number {
  const d = new Date(dayNumber(date) * DAY_MS);
  const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  for (let min = 0; min < 180; min += 15) {
    const t = wallToUtc(timezone, y, m, dd, min);
    if (t !== null) return t;
  }
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Occupation

interface Interval {
  start: number;
  end: number;
}

/**
 * Convertit les événements bloquants en intervalles (ms UTC) triés et fusionnés.
 * Avec padded, chaque intervalle est élargi des tampons propres à l'élément.
 */
export function busyIntervals(busy: BusyEvent[], timezone: string, padded = false): Interval[] {
  const list: Interval[] = [];
  for (const b of busy) {
    if (b.transparent || b.cancelled) continue;
    let start: number;
    let end: number;
    if (b.allDay) {
      if (!isDateString(b.start)) continue;
      // Une journée entière opaque bloque de minuit à minuit, heure locale.
      const last = isDateString(b.end) && b.end > b.start ? b.end : addDays(b.start, 1);
      start = startOfLocalDay(b.start, timezone);
      end = startOfLocalDay(last, timezone);
    } else {
      start = Date.parse(b.start);
      end = Date.parse(b.end);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      if (end < start) end = start;
    }
    if (padded) {
      start -= Math.max(0, b.bufferBeforeMin ?? 0) * 60_000;
      end += Math.max(0, b.bufferAfterMin ?? 0) * 60_000;
    }
    list.push({ start, end });
  }
  list.sort((x, y) => x.start - y.start);
  const merged: Interval[] = [];
  for (const iv of list) {
    const last = merged[merged.length - 1];
    // On ne fusionne que les intervalles qui se recouvrent vraiment : un événement
    // ponctuel (durée nulle) reste distinct et bloque le créneau qui le contient.
    if (last && iv.start < last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

/** Vrai si [start, end) recoupe un intervalle occupé. Se toucher aux bornes n'est pas un chevauchement. */
function overlaps(intervals: Interval[], start: number, end: number): boolean {
  // Recherche du premier intervalle qui finit après le début demandé.
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid].end > start) hi = mid;
    else lo = mid + 1;
  }
  for (let i = lo; i < intervals.length && intervals[i].start < end; i++) {
    const iv = intervals[i];
    if (iv.end > start) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Créneaux

/**
 * Créneaux libres, groupés par jour local (seuls les jours qui en ont sont renvoyés).
 *
 * - Candidats : dans chaque plage horaire du jour, début de plage + k × pas, tant
 *   que le rendez-vous entier (durée) tient dans la plage.
 * - Un candidat est retiré s'il chevauche, tampons compris, un événement bloquant,
 *   ou s'il empiète sur les tampons d'une réservation existante.
 * - Préavis : début ≥ maintenant + préavis. Horizon : jour local ≤ aujourd'hui + horizon.
 */
export function computeSlotDays(q: SlotQuery): SlotDay[] {
  const { type, timezone } = q;
  const step = q.stepMin;
  if (!isDateString(q.from) || !isDateString(q.to)) throw new RangeError('Plage de dates invalide');
  if (!Number.isInteger(step) || step <= 0) throw new RangeError('Pas invalide');
  if (!Number.isInteger(type.durationMin) || type.durationMin <= 0) throw new RangeError('Durée invalide');

  const nowMs = q.now.getTime();
  const earliest = nowMs + Math.max(0, type.minNoticeHours) * 3_600_000;
  const today = dayNumber(localDateOf(nowMs, timezone));
  const firstDay = Math.max(dayNumber(q.from), today);
  const lastDay = Math.min(dayNumber(q.to), today + Math.max(0, type.horizonDays), firstDay + MAX_SLOT_DAYS - 1);
  if (lastDay < firstDay) return [];

  const intervals = busyIntervals(q.busy, timezone);
  // Les réservations existantes protègent aussi leurs propres tampons.
  const withBuffers = q.busy.filter((b) => (b.bufferBeforeMin ?? 0) > 0 || (b.bufferAfterMin ?? 0) > 0);
  const paddedIntervals = withBuffers.length > 0 ? busyIntervals(withBuffers, timezone, true) : [];
  const before = Math.max(0, type.bufferBeforeMin) * 60_000;
  const after = Math.max(0, type.bufferAfterMin) * 60_000;
  const durationMs = type.durationMin * 60_000;

  const byWeekday = new Map<number, HoursRange[]>();
  for (const h of q.hours) {
    if (!(h.endMin > h.startMin)) continue;
    const list = byWeekday.get(h.weekday) ?? [];
    list.push(h);
    byWeekday.set(h.weekday, list);
  }

  const out: SlotDay[] = [];
  for (let n = firstDay; n <= lastDay; n++) {
    const noonUtc = new Date(n * DAY_MS);
    const weekday = noonUtc.getUTCDay() === 0 ? 7 : noonUtc.getUTCDay();
    const ranges = byWeekday.get(weekday);
    if (!ranges) continue;
    const [y, m, d] = [noonUtc.getUTCFullYear(), noonUtc.getUTCMonth() + 1, noonUtc.getUTCDate()];
    const naiveMidnight = n * DAY_MS;
    // Jour sans changement d'heure : un seul décalage, pas besoin d'interroger Intl à chaque créneau.
    const offA = offsetAt(naiveMidnight - DAY_MS, timezone);
    const offB = offsetAt(naiveMidnight + 2 * DAY_MS, timezone);
    const constant = offA === offB ? offA : null;

    const starts = new Set<number>();
    for (const r of ranges) {
      const lastStart = Math.min(r.endMin, 1440) - type.durationMin;
      for (let min = Math.max(0, r.startMin); min <= lastStart; min += step) {
        const start = constant !== null ? naiveMidnight + min * 60_000 - constant : wallToUtc(timezone, y, m, d, min);
        if (start === null) continue; // heure inexistante (passage à l'heure d'été)
        if (start < earliest) continue;
        const end = start + durationMs;
        if (overlaps(intervals, start - before, end + after)) continue;
        if (paddedIntervals.length > 0 && overlaps(paddedIntervals, start, end)) continue;
        starts.add(start);
      }
    }
    if (starts.size > 0) {
      out.push({ date: dateOfDayNumber(n), slots: [...starts].sort((a, b) => a - b).map((t) => new Date(t).toISOString()) });
    }
  }
  return out;
}

/** Débuts des créneaux libres (instants ISO UTC), à plat et triés. */
export function computeSlots(q: SlotQuery): string[] {
  return computeSlotDays(q).flatMap((d) => d.slots);
}
