import { createHash, randomUUID } from 'node:crypto';
import type { CalendarInfo, CalendarSource, Occurrence } from '../shared/types.js';
import type { Db } from './db.js';
import { expand, expandBusy, summarize, type BusyOccurrence } from './ics.js';

export interface CalendarRow {
  id: string;
  source: CalendarSource;
  url: string | null;
  name: string;
  color: string;
  ctag: string | null;
  visible: number;
  read_only: number;
  sort: number;
  /** 1 = les événements de ce calendrier occupent l'agenda pour la prise de rendez-vous. */
  blocks_booking: number;
}

export interface EventRow {
  id: string;
  calendar_id: string;
  href: string | null;
  etag: string | null;
  uid: string;
  ics: string;
}

export const DEFAULT_COLORS = ['#2f7cf6', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#a18072'];

export function eventIdForHref(href: string): string {
  return createHash('sha256').update(href).digest('base64url').slice(0, 22);
}

export function toCalendarInfo(row: CalendarRow): CalendarInfo {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    source: row.source,
    visible: row.visible === 1,
    readOnly: row.read_only === 1,
    blocksBooking: row.blocks_booking === 1,
  };
}

/** Occupation compacte stockée en base : [début, fin, journée entière, disponible, annulé]. */
type BusyTuple = [string, string, 0 | 1, 0 | 1, 0 | 1];

function packBusy(list: BusyOccurrence[]): string {
  return JSON.stringify(list.map((o): BusyTuple => [o.start, o.end, o.allDay ? 1 : 0, o.transparent ? 1 : 0, o.cancelled ? 1 : 0]));
}

function unpackBusy(json: string): BusyOccurrence[] {
  return (JSON.parse(json) as BusyTuple[]).map(([start, end, allDay, transparent, cancelled]) => ({
    start, end, allDay: allDay === 1, transparent: transparent === 1, cancelled: cancelled === 1,
  }));
}

export class Store {
  /**
   * Compteur des écritures qui changent l'occupation de l'agenda (événements, calendriers).
   * Sert à invalider ce qui en est déduit, comme le cache des créneaux.
   */
  private changes = 0;

  constructor(readonly db: Db) {}

  get version(): number {
    return this.changes;
  }

  // --- calendriers -------------------------------------------------------

  listCalendars(): CalendarRow[] {
    return this.db.prepare('SELECT * FROM calendars ORDER BY sort, name').all() as unknown as CalendarRow[];
  }

  getCalendar(id: string): CalendarRow | undefined {
    return this.db.prepare('SELECT * FROM calendars WHERE id = ?').get(id) as unknown as CalendarRow | undefined;
  }

  upsertCalendar(cal: Omit<CalendarRow, 'visible' | 'ctag' | 'blocks_booking'> & { ctag?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO calendars (id, source, url, name, color, read_only, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color,
           url = excluded.url, read_only = excluded.read_only, sort = excluded.sort`,
      )
      .run(cal.id, cal.source, cal.url, cal.name, cal.color, cal.read_only, cal.sort);
  }

  setCalendarCtag(id: string, ctag: string | null): void {
    this.db.prepare('UPDATE calendars SET ctag = ? WHERE id = ?').run(ctag, id);
  }

  setCalendarVisible(id: string, visible: boolean): void {
    this.db.prepare('UPDATE calendars SET visible = ? WHERE id = ?').run(visible ? 1 : 0, id);
  }

  setCalendarBlocksBooking(id: string, blocks: boolean): void {
    this.db.prepare('UPDATE calendars SET blocks_booking = ? WHERE id = ?').run(blocks ? 1 : 0, id);
    this.changes++;
  }

  deleteCalendar(id: string): void {
    this.db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
    this.changes++;
  }

  ensureLocalCalendar(): void {
    const any = this.db.prepare('SELECT 1 FROM calendars LIMIT 1').get();
    if (any) return;
    this.upsertCalendar({ id: `local:${randomUUID()}`, source: 'local', url: null, name: 'Personnel', color: DEFAULT_COLORS[0], read_only: 0, sort: 0 });
  }

  // --- événements --------------------------------------------------------

  getEvent(id: string): EventRow | undefined {
    return this.db.prepare('SELECT id, calendar_id, href, etag, uid, ics FROM events WHERE id = ?').get(id) as unknown as EventRow | undefined;
  }

  /** Paires href → etag d'un calendrier, pour comparer avec le serveur. */
  etagsForCalendar(calendarId: string): Map<string, { id: string; etag: string | null }> {
    const rows = this.db
      .prepare('SELECT id, href, etag FROM events WHERE calendar_id = ? AND href IS NOT NULL')
      .all(calendarId) as unknown as { id: string; href: string; etag: string | null }[];
    return new Map(rows.map((r) => [r.href, { id: r.id, etag: r.etag }]));
  }

  /** Enregistre (ou remplace) une ressource. Lève une erreur si l'iCalendar est illisible. */
  saveEvent(ev: { id?: string; calendarId: string; href: string | null; etag: string | null; ics: string }): string {
    const s = summarize(ev.ics);
    const id = ev.id ?? (ev.href ? eventIdForHref(ev.href) : randomUUID());
    this.db
      .prepare(
        `INSERT INTO events (id, calendar_id, href, etag, uid, ics, summary, start_ms, end_ms, recurring, recur_end_ms, busy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, href = excluded.href, etag = excluded.etag,
           uid = excluded.uid, ics = excluded.ics, summary = excluded.summary, start_ms = excluded.start_ms,
           end_ms = excluded.end_ms, recurring = excluded.recurring, recur_end_ms = excluded.recur_end_ms,
           busy = excluded.busy, updated_at = excluded.updated_at`,
      )
      .run(id, ev.calendarId, ev.href, ev.etag, s.uid, ev.ics, s.summary, s.startMs, s.endMs, s.recurring ? 1 : 0, s.recurEndMs,
        s.busy ? packBusy(s.busy) : null, Date.now());
    this.changes++;
    return id;
  }

  deleteEvent(id: string): void {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    this.changes++;
  }

  /** Occurrences visibles sur une période. */
  occurrences(from: Date, to: Date, calendarIds?: string[]): Occurrence[] {
    const margin = 86_400_000; // journées entières indexées en heure locale
    const rows = this.db
      .prepare(
        `SELECT e.id, e.calendar_id, e.ics FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE c.visible = 1
           AND e.start_ms < ?
           AND ((e.recurring = 0 AND e.end_ms > ?)
             OR (e.recurring = 1 AND (e.recur_end_ms IS NULL OR e.recur_end_ms > ?)))`,
      )
      .all(to.getTime() + margin, from.getTime() - margin, from.getTime() - margin) as unknown as { id: string; calendar_id: string; ics: string }[];
    const allowed = calendarIds ? new Set(calendarIds) : null;
    const out: Occurrence[] = [];
    for (const row of rows) {
      if (allowed && !allowed.has(row.calendar_id)) continue;
      try {
        for (const o of expand(row.ics, from, to)) {
          out.push({ eventId: row.id, calendarId: row.calendar_id, ...o });
        }
      } catch (err) {
        console.warn(`[alfred] événement ${row.id} ignoré : ${(err as Error).message}`);
      }
    }
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return out;
  }

  /**
   * Occupation de l'agenda sur une période, pour la prise de rendez-vous : toutes les
   * occurrences des calendriers « bloquants », qu'ils soient affichés ou non.
   * Ne renvoie que des horaires et des drapeaux, jamais de titre ni de détail.
   * skipAllDay : journées entières à écarter d'après le titre de leur événement (mots-clés des réglages).
   */
  busyOccurrences(from: Date, to: Date, skipAllDay?: (title: string) => unknown): BusyOccurrence[] {
    const out: BusyOccurrence[] = [];
    this.eachBusy(from, to, (o, title) => {
      if (o.allDay && skipAllDay?.(title)) return;
      out.push(o);
    });
    return out;
  }

  /** Journées entières des calendriers bloquants sur une période, avec leur titre : pour l'aperçu des réglages. */
  allDayBusy(from: Date, to: Date): (BusyOccurrence & { eventId: string; calendarId: string; title: string })[] {
    const out: (BusyOccurrence & { eventId: string; calendarId: string; title: string })[] = [];
    this.eachBusy(from, to, (o, title, eventId, calendarId) => {
      if (o.allDay) out.push({ ...o, eventId, calendarId, title });
    });
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return out;
  }

  private eachBusy(from: Date, to: Date, visit: (o: BusyOccurrence, title: string, eventId: string, calendarId: string) => void): void {
    const margin = 86_400_000;
    const rows = this.db
      .prepare(
        `SELECT e.id, e.calendar_id, e.summary, e.recurring, e.busy, CASE WHEN e.busy IS NULL THEN e.ics END AS ics
         FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE c.blocks_booking = 1
           AND e.start_ms < ?
           AND ((e.recurring = 0 AND e.end_ms > ?)
             OR (e.recurring = 1 AND (e.recur_end_ms IS NULL OR e.recur_end_ms > ?)))`,
      )
      .all(to.getTime() + margin, from.getTime() - margin, from.getTime() - margin) as unknown as
        { id: string; calendar_id: string; summary: string; recurring: number; busy: string | null; ics: string | null }[];
    for (const row of rows) {
      try {
        let list: BusyOccurrence[];
        if (row.busy !== null) {
          // Événement simple : son occupation est déjà en base, sans relire l'iCalendar.
          list = unpackBusy(row.busy);
        } else if (row.recurring === 1) {
          list = expandBusy(row.ics!, from, to);
        } else {
          // Ligne antérieure à la colonne « busy » : calculée une fois, puis mémorisée.
          list = summarize(row.ics!).busy ?? [];
          this.db.prepare('UPDATE events SET busy = ? WHERE id = ?').run(packBusy(list), row.id);
        }
        for (const o of list) visit(o, row.summary ?? '', row.id, row.calendar_id);
      } catch (err) {
        console.warn(`[alfred] événement ${row.id} ignoré : ${(err as Error).message}`);
      }
    }
  }

  /**
   * Événement lié à une réservation : par identifiant local, sinon par UID iCalendar
   * (l'identifiant change quand l'événement change de calendrier, pas l'UID).
   */
  findEvent(id: string | null, uid: string | null): { id: string; calendarId: string; uid: string; startMs: number; endMs: number } | undefined {
    type Row = { id: string; calendar_id: string; uid: string; start_ms: number; end_ms: number };
    const columns = 'id, calendar_id, uid, start_ms, end_ms';
    let row = id ? (this.db.prepare(`SELECT ${columns} FROM events WHERE id = ?`).get(id) as Row | undefined) : undefined;
    if (!row && uid) row = this.db.prepare(`SELECT ${columns} FROM events WHERE uid = ? ORDER BY updated_at DESC LIMIT 1`).get(uid) as Row | undefined;
    return row && { id: row.id, calendarId: row.calendar_id, uid: row.uid, startMs: row.start_ms, endMs: row.end_ms };
  }

  /** Événements d'un calendrier qui portent cet UID. */
  eventIdsByUid(calendarId: string, uid: string): string[] {
    return (this.db.prepare('SELECT id FROM events WHERE calendar_id = ? AND uid = ?').all(calendarId, uid) as { id: string }[]).map((r) => r.id);
  }

  // --- sessions ----------------------------------------------------------

  createSession(days: number): { id: string; expires: Date } {
    const id = randomUUID() + randomUUID();
    const expires = new Date(Date.now() + days * 86_400_000);
    this.db.prepare('INSERT INTO sessions (id, expires_ms) VALUES (?, ?)').run(hashToken(id), expires.getTime());
    return { id, expires };
  }

  isSessionValid(id: string): boolean {
    const row = this.db.prepare('SELECT expires_ms FROM sessions WHERE id = ?').get(hashToken(id)) as { expires_ms: number } | undefined;
    return Boolean(row && row.expires_ms > Date.now());
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(id));
  }

  purgeSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_ms < ?').run(Date.now());
  }
}

/** On ne stocke que l'empreinte du jeton de session. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
