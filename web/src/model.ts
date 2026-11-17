import type { CalendarInfo, EventInput, Occurrence, RepeatRule } from '../../shared/types';
import { addDays, combine, dateKey, parseDateKey, startOfDay, timeKey } from './dates';

/** Occurrence avec ses dates locales prêtes pour l'affichage. */
export interface Occ extends Occurrence {
  key: string;
  startDate: Date;
  /** Fin exclusive. */
  endDate: Date;
}

export function toOcc(o: Occurrence): Occ {
  const startDate = o.allDay ? parseDateKey(o.start) : new Date(o.start);
  let endDate = o.allDay ? parseDateKey(o.end) : new Date(o.end);
  if (endDate <= startDate) endDate = o.allDay ? addDays(startDate, 1) : new Date(startDate.getTime() + 1);
  return { ...o, key: `${o.eventId}|${o.occurrenceId ?? ''}|${o.start}`, startDate, endDate };
}

export function overlapsDay(o: Occ, day: Date): boolean {
  const dayStart = startOfDay(day);
  return o.startDate < addDays(dayStart, 1) && o.endDate > dayStart;
}

/** Brouillon édité dans la fenêtre d'événement. */
export interface Draft {
  occ: Occ | null;
  calendarId: string;
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** Date de fin incluse (pour une journée entière). */
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  repeat: RepeatRule;
}

export function draftFromOcc(o: Occ): Draft {
  const lastDay = o.allDay ? addDays(o.endDate, -1) : o.endDate;
  return {
    occ: o,
    calendarId: o.calendarId,
    title: o.title,
    allDay: o.allDay,
    startDate: dateKey(o.startDate),
    startTime: o.allDay ? '09:00' : timeKey(o.startDate),
    endDate: dateKey(lastDay),
    endTime: o.allDay ? '10:00' : timeKey(o.endDate),
    location: o.location,
    description: o.description,
    repeat: o.repeat,
  };
}

export function newDraft(calendarId: string, start: Date, end: Date, allDay: boolean): Draft {
  return {
    occ: null,
    calendarId,
    title: '',
    allDay,
    startDate: dateKey(start),
    startTime: allDay ? '09:00' : timeKey(start),
    endDate: dateKey(allDay ? addDays(end, -1) : end),
    endTime: allDay ? '10:00' : timeKey(end),
    location: '',
    description: '',
    repeat: 'none',
  };
}

export function draftToInput(d: Draft): EventInput {
  const base = {
    calendarId: d.calendarId,
    title: d.title.trim(),
    allDay: d.allDay,
    location: d.location.trim(),
    description: d.description.trim(),
    repeat: d.repeat,
  };
  if (d.allDay) {
    const start = parseDateKey(d.startDate);
    const last = parseDateKey(d.endDate);
    return { ...base, start: d.startDate, end: dateKey(addDays(last < start ? start : last, 1)) };
  }
  return { ...base, start: combine(d.startDate, d.startTime).toISOString(), end: combine(d.endDate, d.endTime).toISOString() };
}

export function draftError(d: Draft): string | null {
  if (!d.title.trim()) return 'Donne un titre à l’événement.';
  if (!d.startDate || !d.endDate) return 'Les dates sont obligatoires.';
  if (d.allDay) {
    if (parseDateKey(d.endDate) < parseDateKey(d.startDate)) return 'La fin est avant le début.';
  } else if (combine(d.endDate, d.endTime) < combine(d.startDate, d.startTime)) {
    return 'La fin est avant le début.';
  }
  return null;
}

/** Même événement, déplacé ou redimensionné à la souris. */
export function movedInput(o: Occ, start: Date, end: Date): EventInput {
  return {
    calendarId: o.calendarId,
    title: o.title,
    allDay: o.allDay,
    location: o.location,
    description: o.description,
    repeat: 'custom',
    start: o.allDay ? dateKey(start) : start.toISOString(),
    end: o.allDay ? dateKey(end) : end.toISOString(),
  };
}

export type CalendarMap = Map<string, CalendarInfo>;

export const REPEAT_LABELS: Record<RepeatRule, string> = {
  none: 'Jamais',
  daily: 'Tous les jours',
  weekly: 'Toutes les semaines',
  monthly: 'Tous les mois',
  yearly: 'Tous les ans',
  custom: 'Personnalisée (inchangée)',
};
