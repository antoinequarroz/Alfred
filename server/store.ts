import { createHash, randomUUID } from 'node:crypto';
import { uuidv7 } from './ids.js';
import type { CalendarInfo, CalendarSource, Occurrence } from '../shared/types.js';
import type { Db } from './db.js';
import { toInstant } from './instants.js';
import { saveAttendees } from './attendees.js';
import { ALL_SPACES } from './sql.js';
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

  /** Espace dont ce magasin lit et écrit les données. */
  get space(): string {
    return this.db.spaceId;
  }

  get version(): number {
    return this.changes;
  }

  /** Signale un changement fait hors de ce magasin (import de données) : ce qui en est déduit est recalculé. */
  markChanged(): void {
    this.changes++;
  }

  // --- calendriers -------------------------------------------------------

  listCalendars(): CalendarRow[] {
    return this.db.all<CalendarRow>('SELECT * FROM calendars WHERE space_id = ? ORDER BY sort, name', this.space);
  }

  getCalendar(id: string): CalendarRow | undefined {
    return this.db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ? AND space_id = ?', id, this.space);
  }

  upsertCalendar(cal: Omit<CalendarRow, 'visible' | 'ctag' | 'blocks_booking'> & { ctag?: string | null }): void {
    this.db.run(
      `INSERT INTO calendars (id, source, url, name, color, read_only, sort, space_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color,
         url = excluded.url, read_only = excluded.read_only, sort = excluded.sort
       WHERE calendars.space_id = excluded.space_id`,
      cal.id, cal.source, cal.url, cal.name, cal.color, cal.read_only, cal.sort, this.space);
  }

  setCalendarCtag(id: string, ctag: string | null): void {
    this.db.run('UPDATE calendars SET ctag = ? WHERE id = ? AND space_id = ?', ctag, id, this.space);
  }

  setCalendarVisible(id: string, visible: boolean): void {
    this.db.run('UPDATE calendars SET visible = ? WHERE id = ? AND space_id = ?', visible ? 1 : 0, id, this.space);
  }

  setCalendarBlocksBooking(id: string, blocks: boolean): void {
    this.db.run('UPDATE calendars SET blocks_booking = ? WHERE id = ? AND space_id = ?', blocks ? 1 : 0, id, this.space);
    this.changes++;
  }

  deleteCalendar(id: string): void {
    this.db.run('DELETE FROM calendars WHERE id = ? AND space_id = ?', id, this.space);
    this.changes++;
  }

  ensureLocalCalendar(): void {
    const any = this.db.get('SELECT 1 AS ok FROM calendars WHERE space_id = ? LIMIT 1', this.space);
    if (any) return;
    this.upsertCalendar({ id: `local:${uuidv7()}`, source: 'local', url: null, name: 'Personnel', color: DEFAULT_COLORS[0], read_only: 0, sort: 0 });
  }

  // --- événements --------------------------------------------------------

  getEvent(id: string): EventRow | undefined {
    return this.db.get<EventRow>('SELECT id, calendar_id, href, etag, uid, ics FROM events WHERE id = ? AND space_id = ?', id, this.space);
  }

  /** Paires href → etag d'un calendrier, pour comparer avec le serveur. */
  etagsForCalendar(calendarId: string): Map<string, { id: string; etag: string | null }> {
    const rows = this.db.all<{ id: string; href: string; etag: string | null }>(
      'SELECT id, href, etag FROM events WHERE calendar_id = ? AND href IS NOT NULL AND space_id = ?', calendarId, this.space);
    return new Map(rows.map((r) => [r.href, { id: r.id, etag: r.etag }]));
  }

  /** Enregistre (ou remplace) une ressource. Lève une erreur si l'iCalendar est illisible. */
  saveEvent(ev: { id?: string; calendarId: string; href: string | null; etag: string | null; ics: string }): string {
    const s = summarize(ev.ics);
    const id = ev.id ?? (ev.href ? eventIdForHref(ev.href) : uuidv7());
    const now = Date.now();
    // Les colonnes en millisecondes (start_ms…) ne sont plus lues ; elles restent écrites pour
    // l'image précédente d'Alfred (voir server/instants.ts).
    this.db.run(
      `INSERT INTO events (id, calendar_id, href, etag, uid, ics, summary, start_at, end_at, recurring, recur_end_at, tzid, busy, modified_at,
         start_ms, end_ms, recur_end_ms, updated_at, space_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, href = excluded.href, etag = excluded.etag,
         uid = excluded.uid, ics = excluded.ics, summary = excluded.summary, start_at = excluded.start_at,
         end_at = excluded.end_at, recurring = excluded.recurring, recur_end_at = excluded.recur_end_at, tzid = excluded.tzid,
         busy = excluded.busy, modified_at = excluded.modified_at, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
         recur_end_ms = excluded.recur_end_ms, updated_at = excluded.updated_at
       WHERE events.space_id = excluded.space_id`,
      id, ev.calendarId, ev.href, ev.etag, s.uid, ev.ics, s.summary, toInstant(s.startMs), toInstant(s.endMs), s.recurring ? 1 : 0,
      s.recurEndMs === null ? null : toInstant(s.recurEndMs), s.tzid, s.busy ? packBusy(s.busy) : null, toInstant(now),
      s.startMs, s.endMs, s.recurEndMs, now, this.space);
    // Invités, reconnus comme Personnes par leur e-mail (server/attendees.ts).
    saveAttendees(this.db, this.space, id, ev.ics, toInstant(now));
    this.changes++;
    return id;
  }

  deleteEvent(id: string): void {
    this.db.run('DELETE FROM events WHERE id = ? AND space_id = ?', id, this.space);
    this.db.run('DELETE FROM event_attendees WHERE event_id = ? AND space_id = ?', id, this.space);
    this.changes++;
  }

  /** Occurrences visibles sur une période. */
  occurrences(from: Date, to: Date, calendarIds?: string[]): Occurrence[] {
    const margin = 86_400_000; // journées entières indexées en heure locale
    const rows = this.db.all<{ id: string; calendar_id: string; ics: string }>(
      `SELECT e.id, e.calendar_id, e.ics FROM events e JOIN calendars c ON c.id = e.calendar_id AND c.space_id = e.space_id
       WHERE e.space_id = ? AND c.visible = 1
         AND e.start_at < ?
         AND ((e.recurring = 0 AND e.end_at > ?)
           OR (e.recurring = 1 AND (e.recur_end_at IS NULL OR e.recur_end_at > ?)))
       ORDER BY e.start_at, e.id`,
      this.space, toInstant(to.getTime() + margin), toInstant(from.getTime() - margin), toInstant(from.getTime() - margin));
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
    const rows = this.db.all<{ id: string; calendar_id: string; summary: string; recurring: number; busy: string | null; ics: string | null }>(
      `SELECT e.id, e.calendar_id, e.summary, e.recurring, e.busy, CASE WHEN e.busy IS NULL THEN e.ics END AS ics
       FROM events e JOIN calendars c ON c.id = e.calendar_id AND c.space_id = e.space_id
       WHERE e.space_id = ? AND c.blocks_booking = 1
         AND e.start_at < ?
         AND ((e.recurring = 0 AND e.end_at > ?)
           OR (e.recurring = 1 AND (e.recur_end_at IS NULL OR e.recur_end_at > ?)))
       ORDER BY e.start_at, e.id`,
      this.space, toInstant(to.getTime() + margin), toInstant(from.getTime() - margin), toInstant(from.getTime() - margin));
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
          this.db.run('UPDATE events SET busy = ? WHERE id = ? AND space_id = ?', packBusy(list), row.id, this.space);
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
    type Row = { id: string; calendar_id: string; uid: string; start_at: string; end_at: string };
    const columns = 'id, calendar_id, uid, start_at, end_at';
    let row = id ? this.db.get<Row>(`SELECT ${columns} FROM events WHERE id = ? AND space_id = ?`, id, this.space) : undefined;
    if (!row && uid) row = this.db.get<Row>(`SELECT ${columns} FROM events WHERE uid = ? AND space_id = ? ORDER BY modified_at DESC, id LIMIT 1`, uid, this.space);
    return row && { id: row.id, calendarId: row.calendar_id, uid: row.uid, startMs: Date.parse(row.start_at), endMs: Date.parse(row.end_at) };
  }

  /** Événements d'un calendrier qui portent cet UID. */
  eventIdsByUid(calendarId: string, uid: string): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND space_id = ? ORDER BY id', calendarId, uid, this.space).map((r) => r.id);
  }

  // --- sessions ----------------------------------------------------------
  // Une session de connexion appartient à la personne, pas à un espace : elle ouvre tous les siens.

  createSession(days: number): { id: string; expires: Date } {
    const id = randomUUID() + randomUUID();
    const expires = new Date(Date.now() + days * 86_400_000);
    this.db.run(`INSERT INTO sessions (id, expires_at, expires_ms) VALUES (?, ?, ?) ${ALL_SPACES}`, hashToken(id), toInstant(expires), expires.getTime());
    return { id, expires };
  }

  isSessionValid(id: string): boolean {
    const row = this.db.get<{ expires_at: string }>(`SELECT expires_at FROM sessions WHERE id = ? ${ALL_SPACES}`, hashToken(id));
    return Boolean(row && row.expires_at > toInstant(Date.now()));
  }

  deleteSession(id: string): void {
    this.db.run(`DELETE FROM sessions WHERE id = ? ${ALL_SPACES}`, hashToken(id));
  }

  purgeSessions(): void {
    this.db.run(`DELETE FROM sessions WHERE expires_at < ? ${ALL_SPACES}`, toInstant(Date.now()));
  }
}

/** On ne stocke que l'empreinte du jeton de session. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
