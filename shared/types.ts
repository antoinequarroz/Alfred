// Types partagés entre le serveur et l'app web.

export type CalendarSource = 'local' | 'caldav';

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  source: CalendarSource;
  visible: boolean;
  readOnly: boolean;
}

/** Une occurrence affichable d'un événement (un événement récurrent en produit plusieurs). */
export interface Occurrence {
  /** Identifiant de l'événement (la ressource iCalendar). */
  eventId: string;
  /**
   * Pour un événement récurrent : début d'origine de l'occurrence
   * (instant ISO UTC, ou date AAAA-MM-JJ pour une journée entière).
   */
  occurrenceId: string | null;
  calendarId: string;
  title: string;
  /** Instant ISO UTC, ou date AAAA-MM-JJ si allDay. */
  start: string;
  /** Instant ISO UTC, ou date AAAA-MM-JJ exclusive si allDay. */
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  recurring: boolean;
  /** Règle de répétition simple reconnue, sinon 'custom'. */
  repeat: RepeatRule;
}

export type RepeatRule = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export interface EventInput {
  calendarId: string;
  title: string;
  /** Instant ISO, ou date AAAA-MM-JJ si allDay. */
  start: string;
  /** Instant ISO, ou date AAAA-MM-JJ exclusive si allDay. */
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  /** 'custom' = conserver la règle existante telle quelle. */
  repeat?: RepeatRule;
}

/** Portée d'une modification sur un événement récurrent. */
export type EditScope = 'this' | 'all';

export interface SyncStatus {
  configured: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}
