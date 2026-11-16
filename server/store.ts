import { createHash, randomUUID } from 'node:crypto';
import type { CalendarInfo, CalendarSource, Occurrence } from '../shared/types.js';
import type { Db } from './db.js';
import { expand, summarize } from './ics.js';

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
  };
}

export class Store {
  constructor(readonly db: Db) {}

  // --- calendriers -------------------------------------------------------

  listCalendars(): CalendarRow[] {
    return this.db.prepare('SELECT * FROM calendars ORDER BY sort, name').all() as unknown as CalendarRow[];
  }

  getCalendar(id: string): CalendarRow | undefined {
    return this.db.prepare('SELECT * FROM calendars WHERE id = ?').get(id) as unknown as CalendarRow | undefined;
  }

  upsertCalendar(cal: Omit<CalendarRow, 'visible' | 'ctag'> & { ctag?: string | null }): void {
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

  deleteCalendar(id: string): void {
    this.db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
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
        `INSERT INTO events (id, calendar_id, href, etag, uid, ics, summary, start_ms, end_ms, recurring, recur_end_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, href = excluded.href, etag = excluded.etag,
           uid = excluded.uid, ics = excluded.ics, summary = excluded.summary, start_ms = excluded.start_ms,
           end_ms = excluded.end_ms, recurring = excluded.recurring, recur_end_ms = excluded.recur_end_ms,
           updated_at = excluded.updated_at`,
      )
      .run(id, ev.calendarId, ev.href, ev.etag, s.uid, ev.ics, s.summary, s.startMs, s.endMs, s.recurring ? 1 : 0, s.recurEndMs, Date.now());
    return id;
  }

  deleteEvent(id: string): void {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
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
