import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import type { EditScope, EventInput, RepeatRule } from '../shared/types.js';
import { registerCalendarTimezones, timeInZone, vtimezoneComponent } from './timezone.js';

const PRODID = '-//Alfred//Calendrier//FR';
/** Garde-fou contre les règles de répétition infinies très denses. */
const MAX_ITERATIONS = 50_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ResourceSummary {
  uid: string;
  summary: string;
  startMs: number;
  endMs: number;
  recurring: boolean;
  /** Fin de la dernière occurrence, null si la répétition est infinie. */
  recurEndMs: number | null;
}

export interface ExpandedOccurrence {
  occurrenceId: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  recurring: boolean;
  repeat: RepeatRule;
}

export class IcsError extends Error {}

export function parseCalendar(ics: string): ICAL.Component {
  let vcal: ICAL.Component;
  try {
    vcal = new ICAL.Component(ICAL.parse(ics) as unknown[]);
  } catch (err) {
    throw new IcsError(`iCalendar illisible : ${(err as Error).message}`);
  }
  registerCalendarTimezones(vcal);
  return vcal;
}

function vevents(vcal: ICAL.Component): ICAL.Component[] {
  return vcal.getAllSubcomponents('vevent');
}

/** Le VEVENT principal (sans RECURRENCE-ID), ou le premier s'il n'y a que des exceptions. */
function masterOf(vcal: ICAL.Component): ICAL.Component {
  const all = vevents(vcal);
  if (all.length === 0) throw new IcsError('Aucun VEVENT dans la ressource');
  return all.find((c) => !c.hasProperty('recurrence-id')) ?? all[0];
}

function exceptionsOf(vcal: ICAL.Component): ICAL.Component[] {
  const master = masterOf(vcal);
  return vevents(vcal).filter((c) => c !== master && c.hasProperty('recurrence-id'));
}

function buildEvent(vcal: ICAL.Component): ICAL.Event {
  const master = masterOf(vcal);
  const event = new ICAL.Event(master);
  if (!master.hasProperty('recurrence-id')) {
    for (const exc of exceptionsOf(vcal)) {
      try {
        event.relateException(new ICAL.Event(exc));
      } catch {
        // exception incohérente : ignorée plutôt que de casser l'affichage
      }
    }
  }
  return event;
}

function endOf(start: ICAL.Time, end: ICAL.Time | null): ICAL.Time {
  if (end && end.compare(start) >= 0) return end;
  const e = start.clone();
  if (start.isDate) e.adjust(1, 0, 0, 0);
  return e;
}

function dateString(t: ICAL.Time): string {
  return `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function timeToMs(t: ICAL.Time): number {
  return t.toJSDate().getTime();
}

/** Identifiant stable d'une occurrence : instant ISO, ou date pour une journée entière. */
function occurrenceKey(t: ICAL.Time): string {
  return t.isDate ? dateString(t) : t.toJSDate().toISOString();
}

export function repeatOf(master: ICAL.Component): RepeatRule {
  const rrules = master.getAllProperties('rrule');
  if (rrules.length === 0) return master.hasProperty('rdate') ? 'custom' : 'none';
  if (rrules.length > 1) return 'custom';
  const recur = rrules[0].getFirstValue() as ICAL.Recur;
  const parts = recur.parts ?? {};
  const simple =
    Object.keys(parts).length === 0 &&
    (recur.interval ?? 1) === 1 &&
    !recur.until &&
    !recur.count;
  if (!simple) return 'custom';
  switch (recur.freq) {
    case 'DAILY': return 'daily';
    case 'WEEKLY': return 'weekly';
    case 'MONTHLY': return 'monthly';
    case 'YEARLY': return 'yearly';
    default: return 'custom';
  }
}

/** Résumé utilisé pour indexer la ressource en base (filtrage par période). */
export function summarize(ics: string): ResourceSummary {
  const vcal = parseCalendar(ics);
  const master = masterOf(vcal);
  const event = buildEvent(vcal);
  const start = event.startDate;
  if (!start) throw new IcsError('VEVENT sans DTSTART');
  const end = endOf(start, event.endDate);
  const recurring = event.isRecurring() && !master.hasProperty('recurrence-id');
  let recurEndMs: number | null = null;
  let minStart = timeToMs(start);
  let maxEnd = timeToMs(end);
  // Les exceptions peuvent déplacer une occurrence hors de la plage du maître.
  for (const exc of exceptionsOf(vcal)) {
    const e = new ICAL.Event(exc);
    if (!e.startDate) continue;
    minStart = Math.min(minStart, timeToMs(e.startDate));
    maxEnd = Math.max(maxEnd, timeToMs(endOf(e.startDate, e.endDate)));
  }
  if (recurring) {
    const durationMs = timeToMs(end) - timeToMs(start);
    const finite = master
      .getAllProperties('rrule')
      .every((p) => {
        const r = p.getFirstValue() as ICAL.Recur;
        return Boolean(r.until || r.count);
      });
    if (finite) {
      const it = event.iterator();
      let last: ICAL.Time | null = null;
      for (let i = 0, next = it.next(); next && i < MAX_ITERATIONS; i++, next = it.next()) last = next;
      recurEndMs = last ? Math.max(timeToMs(last) + durationMs, maxEnd) : maxEnd;
    }
  }
  return {
    uid: String(master.getFirstPropertyValue('uid') ?? ''),
    summary: String(master.getFirstPropertyValue('summary') ?? ''),
    startMs: minStart,
    endMs: maxEnd,
    recurring,
    recurEndMs,
  };
}

function text(comp: ICAL.Component, name: string): string {
  const v = comp.getFirstPropertyValue(name);
  return v == null ? '' : String(v);
}

/** Ce que la prise de rendez-vous a besoin de savoir d'une occurrence : quand, et si elle occupe l'agenda. */
export interface BusyOccurrence {
  start: string;
  end: string;
  allDay: boolean;
  /** TRANSP:TRANSPARENT : l'événement laisse le temps « disponible ». */
  transparent: boolean;
  /** STATUS:CANCELLED. */
  cancelled: boolean;
}

/** Développe la ressource en occurrences qui chevauchent [rangeStart, rangeEnd). */
export function expand(ics: string, rangeStart: Date, rangeEnd: Date): ExpandedOccurrence[] {
  return expandDetailed(ics, rangeStart, rangeEnd).map(({ transparent: _t, cancelled: _c, ...o }) => o);
}

/** Comme expand, réduit à l'occupation (aucun titre ni détail). */
export function expandBusy(ics: string, rangeStart: Date, rangeEnd: Date): BusyOccurrence[] {
  return expandDetailed(ics, rangeStart, rangeEnd).map((o) => ({
    start: o.start, end: o.end, allDay: o.allDay, transparent: o.transparent, cancelled: o.cancelled,
  }));
}

function expandDetailed(ics: string, rangeStart: Date, rangeEnd: Date): (ExpandedOccurrence & { transparent: boolean; cancelled: boolean })[] {
  const vcal = parseCalendar(ics);
  const master = masterOf(vcal);
  const event = buildEvent(vcal);
  const repeat = repeatOf(master);
  const fromMs = rangeStart.getTime();
  const toMs = rangeEnd.getTime();
  const out: (ExpandedOccurrence & { transparent: boolean; cancelled: boolean })[] = [];

  const push = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, occurrenceId: string | null, recurring: boolean) => {
    const s = timeToMs(start);
    const e = timeToMs(end);
    // Une journée entière est indexée sur minuit local du serveur : on garde une marge.
    const overlaps = start.isDate ? s < toMs + 86_400_000 && e > fromMs - 86_400_000 : s < toMs && e > fromMs;
    if (!overlaps) return;
    out.push({
      occurrenceId,
      title: item.summary ?? '',
      start: start.isDate ? dateString(start) : new Date(s).toISOString(),
      end: start.isDate ? dateString(end) : new Date(e).toISOString(),
      allDay: start.isDate,
      location: text(item.component, 'location'),
      description: text(item.component, 'description'),
      recurring,
      repeat,
      transparent: text(item.component, 'transp').trim().toUpperCase() === 'TRANSPARENT',
      cancelled: text(item.component, 'status').trim().toUpperCase() === 'CANCELLED',
    });
  };

  if (!event.startDate) return out;

  if (!event.isRecurring() || master.hasProperty('recurrence-id')) {
    // Événement simple, ou exceptions orphelines (invitations iCloud) : chaque VEVENT est affiché tel quel.
    for (const comp of vevents(vcal)) {
      const e = new ICAL.Event(comp);
      if (!e.startDate) continue;
      push(e, e.startDate, endOf(e.startDate, e.endDate), null, false);
    }
    return out;
  }

  if (!master.hasProperty('rrule')) {
    // Répétition par dates seules (RDATE) : ical.js n'émet pas l'occurrence du DTSTART.
    const first = event.startDate;
    const key = timeToMs(first);
    const listed = (name: string) =>
      master.getAllProperties(name).some((p) => (p.getValues() as ICAL.Time[]).some((v) => typeof v?.toJSDate === 'function' && timeToMs(v) === key));
    if (!listed('exdate') && !listed('rdate')) {
      const details = event.getOccurrenceDetails(first);
      push(details.item, details.startDate, endOf(details.startDate, details.endDate), occurrenceKey(details.recurrenceId), true);
    }
  }

  const it = event.iterator();
  for (let i = 0, next = it.next(); next && i < MAX_ITERATIONS; i++, next = it.next()) {
    const details = event.getOccurrenceDetails(next);
    const end = endOf(details.startDate, details.endDate);
    // Les exceptions peuvent avancer une occurrence : on s'arrête un peu après la plage.
    if (timeToMs(next) >= toMs + 7 * 86_400_000) break;
    push(details.item, details.startDate, end, occurrenceKey(details.recurrenceId), true);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Écriture

function parseInputTime(value: string, allDay: boolean, tzid: string): ICAL.Time {
  if (allDay) {
    if (!DATE_RE.test(value)) throw new IcsError(`Date invalide : ${value}`);
    return ICAL.Time.fromDateString(value);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new IcsError(`Date invalide : ${value}`);
  return timeInZone(d, tzid);
}

function ensureTimezone(vcal: ICAL.Component, tzid: string): void {
  const has = vcal
    .getAllSubcomponents('vtimezone')
    .some((tz) => tz.getFirstPropertyValue('tzid') === tzid);
  if (has) return;
  const comp = vtimezoneComponent(tzid);
  if (!comp) return;
  // Le VTIMEZONE doit précéder les VEVENT pour certains clients.
  const events = vevents(vcal);
  for (const e of events) vcal.removeSubcomponent(e);
  vcal.addSubcomponent(comp);
  for (const e of events) vcal.addSubcomponent(e);
}

function setText(comp: ICAL.Component, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.trim() === '') comp.removeAllProperties(name);
  else comp.updatePropertyWithValue(name, value);
}

function touch(comp: ICAL.Component): void {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  const seq = Number(comp.getFirstPropertyValue('sequence') ?? 0);
  comp.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);
}

function setRepeat(comp: ICAL.Component, repeat: RepeatRule | undefined): void {
  if (repeat === undefined || repeat === 'custom') return;
  comp.removeAllProperties('rrule');
  comp.removeAllProperties('rdate');
  comp.removeAllProperties('exdate');
  if (repeat === 'none') return;
  const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[repeat];
  comp.addPropertyWithValue('rrule', ICAL.Recur.fromString(`FREQ=${freq}`));
}

function applyTimes(comp: ICAL.Component, input: EventInput, tzid: string): void {
  const start = parseInputTime(input.start, input.allDay, tzid);
  const end = parseInputTime(input.end, input.allDay, tzid);
  if (end.compare(start) < 0) throw new IcsError('La fin est avant le début');
  const event = new ICAL.Event(comp);
  comp.removeAllProperties('duration');
  event.startDate = start;
  event.endDate = end.compare(start) === 0 && input.allDay ? (() => { const e = start.clone(); e.adjust(1, 0, 0, 0); return e; })() : end;
}

function validate(input: EventInput): void {
  if (!input.title?.trim()) throw new IcsError('Le titre est obligatoire');
}

/** Crée une nouvelle ressource iCalendar. */
export function buildNewEvent(input: EventInput, tzid: string): { uid: string; ics: string } {
  validate(input);
  const uid = `${randomUUID()}@alfred`;
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', PRODID);
  vcal.updatePropertyWithValue('version', '2.0');
  vcal.updatePropertyWithValue('calscale', 'GREGORIAN');
  if (!input.allDay) ensureTimezone(vcal, tzid);
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', uid);
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('created', now);
  vevent.updatePropertyWithValue('last-modified', now);
  vevent.updatePropertyWithValue('sequence', 0);
  vevent.updatePropertyWithValue('summary', input.title.trim());
  setText(vevent, 'location', input.location);
  setText(vevent, 'description', input.description);
  vcal.addSubcomponent(vevent);
  applyTimes(vevent, input, tzid);
  setRepeat(vevent, input.repeat);
  return { uid, ics: vcal.toString() };
}

/** Convertit un identifiant d'occurrence en ICAL.Time comparable au DTSTART du maître. */
function occurrenceTime(occurrenceId: string, masterStart: ICAL.Time): ICAL.Time {
  if (DATE_RE.test(occurrenceId)) return ICAL.Time.fromDateString(occurrenceId);
  const d = new Date(occurrenceId);
  if (Number.isNaN(d.getTime())) throw new IcsError('Occurrence invalide');
  const utc = ICAL.Time.fromJSDate(d, true);
  const zone = masterStart.zone;
  if (zone && zone.tzid !== 'UTC' && zone.tzid !== 'floating') return utc.convertToZone(zone);
  if (zone?.tzid === 'floating') {
    // Heure flottante : on reprend l'heure locale du serveur.
    return ICAL.Time.fromJSDate(d, false);
  }
  return utc;
}

function findException(vcal: ICAL.Component, recurrenceId: ICAL.Time): ICAL.Component | undefined {
  const target = timeToMs(recurrenceId);
  return exceptionsOf(vcal).find((c) => {
    const rid = c.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
    return rid != null && timeToMs(rid) === target;
  });
}

function setTimeProp(comp: ICAL.Component, name: string, time: ICAL.Time): void {
  comp.removeAllProperties(name);
  const prop = new ICAL.Property(name, comp);
  prop.setValue(time);
  const tzid = time.zone?.tzid;
  if (!time.isDate && tzid && tzid !== 'UTC' && tzid !== 'floating') prop.setParameter('tzid', tzid);
  comp.addProperty(prop);
}

export interface EditOptions {
  scope: EditScope;
  occurrenceId?: string | null;
  tzid: string;
}

/** Applique une modification et renvoie la nouvelle ressource. */
export function applyEdit(ics: string, input: EventInput, opts: EditOptions): string {
  validate(input);
  const vcal = parseCalendar(ics);
  const master = masterOf(vcal);
  const masterEvent = new ICAL.Event(master);
  const recurring = masterEvent.isRecurring() && !master.hasProperty('recurrence-id');
  if (!input.allDay) ensureTimezone(vcal, opts.tzid);

  if (recurring && opts.scope === 'this') {
    if (!opts.occurrenceId) throw new IcsError('Occurrence manquante');
    const rid = occurrenceTime(opts.occurrenceId, masterEvent.startDate);
    let exc = findException(vcal, rid);
    if (!exc) {
      exc = new ICAL.Component(ICAL.parse(master.toString()) as unknown[]);
      for (const p of ['rrule', 'rdate', 'exdate']) exc.removeAllProperties(p);
      setTimeProp(exc, 'recurrence-id', rid);
      vcal.addSubcomponent(exc);
    }
    exc.updatePropertyWithValue('summary', input.title.trim());
    setText(exc, 'location', input.location ?? '');
    setText(exc, 'description', input.description ?? '');
    applyTimes(exc, input, opts.tzid);
    touch(exc);
    return vcal.toString();
  }

  // Événement simple, ou toute la série.
  master.updatePropertyWithValue('summary', input.title.trim());
  setText(master, 'location', input.location ?? '');
  setText(master, 'description', input.description ?? '');

  if (recurring && opts.occurrenceId && input.repeat !== 'none') {
    editSeriesTimes(vcal, master, masterEvent, input, opts.occurrenceId, opts.tzid);
  } else if (!sameTimes(masterEvent, input)) {
    applyTimes(master, input, opts.tzid);
  }

  if (input.repeat !== undefined && input.repeat !== 'custom' && input.repeat !== repeatOf(master)) {
    setRepeat(master, input.repeat);
    if (input.repeat === 'none') for (const exc of exceptionsOf(vcal)) vcal.removeSubcomponent(exc);
  }
  touch(master);
  return vcal.toString();
}

/** Heure « murale » en millisecondes, sans fuseau : sert aux écarts en jours et heures locales. */
function naiveMs(t: ICAL.Time, dateOnly = t.isDate): number {
  return Date.UTC(t.year, t.month - 1, t.day, dateOnly ? 0 : t.hour, dateOnly ? 0 : t.minute, dateOnly ? 0 : t.second);
}

function fromNaive(ms: number, like: ICAL.Time, asDate: boolean): ICAL.Time {
  const d = new Date(ms);
  const data = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: asDate ? 0 : d.getUTCHours(),
      minute: asDate ? 0 : d.getUTCMinutes(),
      second: asDate ? 0 : d.getUTCSeconds(),
      isDate: asDate,
  };
  return asDate ? ICAL.Time.fromData(data) : ICAL.Time.fromData(data, like.zone);
}

/** Même instant, exprimé dans le fuseau de `like`. */
function inZoneOf(t: ICAL.Time, like: ICAL.Time): ICAL.Time {
  if (t.isDate) return t;
  const zone = like.zone;
  const d = t.toJSDate();
  if (!zone || zone.tzid === 'floating') return ICAL.Time.fromJSDate(d, false);
  const utc = ICAL.Time.fromJSDate(d, true);
  return zone.tzid === 'UTC' ? utc : utc.convertToZone(zone);
}

function spanOf(start: ICAL.Time, end: ICAL.Time): number {
  return start.isDate ? naiveMs(end) - naiveMs(start) : timeToMs(end) - timeToMs(start);
}

/** Les horaires demandés sont-ils ceux que l'événement a déjà ? */
function sameTimes(event: ICAL.Event, input: EventInput): boolean {
  const start = event.startDate;
  if (!start || start.isDate !== input.allDay) return false;
  const end = endOf(start, event.endDate);
  if (input.allDay) return dateString(start) === input.start && dateString(end) === input.end;
  return timeToMs(start) === new Date(input.start).getTime() && timeToMs(end) === new Date(input.end).getTime();
}

function hasByParts(master: ICAL.Component): boolean {
  return master.getAllProperties('rrule').some((p) => Object.keys((p.getFirstValue() as ICAL.Recur).parts ?? {}).length > 0);
}

/**
 * Modification des horaires de toute une série à partir d'une occurrence.
 * On raisonne en heure locale du fuseau de la série : le début de la série est
 * décalé du même écart que l'occurrence, et la série garde son fuseau d'origine.
 * Sans changement d'horaire, rien n'est touché (exceptions et exclusions comprises).
 */
function editSeriesTimes(
  vcal: ICAL.Component,
  master: ICAL.Component,
  masterEvent: ICAL.Event,
  input: EventInput,
  occurrenceId: string,
  tzid: string,
): void {
  const mStart = masterEvent.startDate;
  const masterSpan = spanOf(mStart, endOf(mStart, masterEvent.endDate));
  const occStart = occurrenceTime(occurrenceId, mStart);
  // Une occurrence déjà déplacée se compare à sa position actuelle, pas à sa case d'origine.
  const exc = findException(vcal, occStart);
  const excEvent = exc ? new ICAL.Event(exc) : null;
  const baseStart = excEvent?.startDate ?? occStart;
  const baseSpan = excEvent?.startDate ? spanOf(excEvent.startDate, endOf(excEvent.startDate, excEvent.endDate)) : masterSpan;

  const newStart = parseInputTime(input.start, input.allDay, tzid);
  const newEnd = parseInputTime(input.end, input.allDay, tzid);
  if (newEnd.compare(newStart) < 0) throw new IcsError('La fin est avant le début');
  let newSpan = spanOf(newStart, newEnd);
  if (input.allDay && newSpan <= 0) newSpan = 86_400_000;

  const kindChanged = input.allDay !== mStart.isDate;
  let nextStart: ICAL.Time;
  if (!kindChanged) {
    const shift = naiveMs(inZoneOf(newStart, mStart)) - naiveMs(inZoneOf(baseStart, mStart), mStart.isDate);
    if (shift === 0 && newSpan === baseSpan) return;
    if (shift === 0) {
      // Seule la durée change : le début, les exceptions et les exclusions restent en place.
      master.removeAllProperties('duration');
      setTimeProp(master, 'dtend', fromNaive(naiveMs(mStart) + newSpan, mStart, mStart.isDate));
      return;
    }
    nextStart = fromNaive(naiveMs(mStart) + shift, mStart, mStart.isDate);
  } else {
    // Passage journée entière <-> horaire : on garde l'écart en jours entre l'occurrence et le début de la série.
    const dayOffset = naiveMs(inZoneOf(baseStart, mStart), true) - naiveMs(mStart, true);
    const target = input.allDay ? newStart : timeInZone(new Date(input.start), tzid);
    nextStart = fromNaive(naiveMs(target) - dayOffset, target, input.allDay);
  }

  if (dateString(nextStart) !== dateString(mStart) && hasByParts(master)) {
    throw new IcsError(
      'Cette série suit une règle personnalisée : change de jour seulement cet événement, ou modifie la règle dans Apple Calendar.',
    );
  }
  master.removeAllProperties('duration');
  setTimeProp(master, 'dtstart', nextStart);
  setTimeProp(master, 'dtend', fromNaive(naiveMs(nextStart) + newSpan, nextStart, nextStart.isDate));
  // Les exceptions et exclusions ne correspondent plus aux nouvelles occurrences.
  for (const e of exceptionsOf(vcal)) vcal.removeSubcomponent(e);
  master.removeAllProperties('exdate');
}

/** Supprime une seule occurrence d'une série (EXDATE). Renvoie null s'il faut supprimer la ressource entière. */
export function removeOccurrence(ics: string, occurrenceId: string): string | null {
  const vcal = parseCalendar(ics);
  const master = masterOf(vcal);
  const masterEvent = new ICAL.Event(master);
  if (!masterEvent.isRecurring() || master.hasProperty('recurrence-id')) return null;
  const rid = occurrenceTime(occurrenceId, masterEvent.startDate);
  const exc = findException(vcal, rid);
  if (exc) vcal.removeSubcomponent(exc);
  const prop = new ICAL.Property('exdate', master);
  prop.setValue(rid);
  const tzid = rid.zone?.tzid;
  if (!rid.isDate && tzid && tzid !== 'UTC' && tzid !== 'floating') prop.setParameter('tzid', tzid);
  master.addProperty(prop);
  touch(master);
  return vcal.toString();
}

export function uidOf(ics: string): string {
  return String(masterOf(parseCalendar(ics)).getFirstPropertyValue('uid') ?? '');
}
