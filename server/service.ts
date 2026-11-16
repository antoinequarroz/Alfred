import type { EditScope, EventInput } from '../shared/types.js';
import { ConflictError, type CaldavSync } from './caldav.js';
import { applyEdit, buildNewEvent, IcsError, removeOccurrence } from './ics.js';
import type { CalendarRow, Store } from './store.js';

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

/** Opérations sur les événements, quel que soit le calendrier (local ou CalDAV). */
export class CalendarService {
  constructor(
    private readonly store: Store,
    private readonly caldav: CaldavSync | null,
    private readonly tzid: string,
  ) {}

  private writableCalendar(id: string): CalendarRow {
    const cal = this.store.getCalendar(id);
    if (!cal) throw new NotFoundError('Calendrier introuvable');
    if (cal.read_only) throw new ForbiddenError('Ce calendrier est en lecture seule');
    if (cal.source === 'caldav' && (!this.caldav || !cal.url)) throw new ForbiddenError('Synchronisation CalDAV non configurée');
    return cal;
  }

  async create(input: EventInput): Promise<string> {
    const cal = this.writableCalendar(input.calendarId);
    const { uid, ics } = buildNewEvent(input, this.tzid);
    if (cal.source === 'caldav') {
      const { href, etag } = await this.caldav!.create(cal.url!, uid, ics);
      return this.store.saveEvent({ calendarId: cal.id, href, etag, ics });
    }
    return this.store.saveEvent({ calendarId: cal.id, href: null, etag: null, ics });
  }

  async update(eventId: string, input: EventInput, scope: EditScope, occurrenceId: string | null): Promise<string> {
    const ev = this.store.getEvent(eventId);
    if (!ev) throw new NotFoundError('Événement introuvable');
    const from = this.writableCalendar(ev.calendar_id);
    const ics = applyEdit(ev.ics, input, { scope, occurrenceId, tzid: this.tzid });

    if (input.calendarId !== ev.calendar_id) {
      // Changement de calendrier : on crée dans le nouveau puis on supprime l'ancien.
      if (scope === 'this' && occurrenceId) throw new IcsError('Une seule occurrence ne peut pas changer de calendrier');
      const to = this.writableCalendar(input.calendarId);
      let newId: string;
      if (to.source === 'caldav') {
        const { href, etag } = await this.caldav!.create(to.url!, ev.uid, ics);
        newId = this.store.saveEvent({ calendarId: to.id, href, etag, ics });
      } else {
        newId = this.store.saveEvent({ calendarId: to.id, href: null, etag: null, ics });
      }
      await this.deleteResource(ev, from);
      return newId;
    }

    if (from.source === 'caldav') {
      const etag = await this.withConflict(ev, from, () => this.caldav!.update(from.url!, ev.href!, ics, ev.etag));
      return this.store.saveEvent({ id: ev.id, calendarId: from.id, href: ev.href, etag, ics });
    }
    return this.store.saveEvent({ id: ev.id, calendarId: from.id, href: null, etag: null, ics });
  }

  async remove(eventId: string, scope: EditScope, occurrenceId: string | null): Promise<void> {
    const ev = this.store.getEvent(eventId);
    if (!ev) throw new NotFoundError('Événement introuvable');
    const cal = this.writableCalendar(ev.calendar_id);
    const remaining = scope === 'this' && occurrenceId ? removeOccurrence(ev.ics, occurrenceId) : null;
    if (remaining === null) {
      await this.deleteResource(ev, cal);
      return;
    }
    if (cal.source === 'caldav') {
      const etag = await this.withConflict(ev, cal, () => this.caldav!.update(cal.url!, ev.href!, remaining, ev.etag));
      this.store.saveEvent({ id: ev.id, calendarId: cal.id, href: ev.href, etag, ics: remaining });
    } else {
      this.store.saveEvent({ id: ev.id, calendarId: cal.id, href: null, etag: null, ics: remaining });
    }
  }

  private async deleteResource(ev: { id: string; href: string | null; etag: string | null }, cal: CalendarRow): Promise<void> {
    if (cal.source === 'caldav' && ev.href) {
      await this.withConflict(ev, cal, () => this.caldav!.remove(ev.href!, ev.etag));
    }
    this.store.deleteEvent(ev.id);
  }

  /** En cas de conflit, on recharge la version du serveur avant de signaler l'erreur. */
  private async withConflict<T>(ev: { id: string; href: string | null }, cal: CalendarRow, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConflictError && ev.href && cal.url) {
        await this.caldav!.refresh(ev.id, cal.id, cal.url, ev.href).catch(() => undefined);
      }
      throw err;
    }
  }
}
