// Types partagés entre le serveur et l'app web.

export type CalendarSource = 'local' | 'caldav';

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  source: CalendarSource;
  visible: boolean;
  readOnly: boolean;
  /** Les événements de ce calendrier occupent l'agenda pour la prise de rendez-vous. */
  blocksBooking: boolean;
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

// ---------------------------------------------------------------------------
// Prise de rendez-vous (v1.1). Voir docs/API-RDV.md.

/** Forme de toutes les réponses d'erreur de l'API. */
export interface ApiErrorBody {
  /** Message en français, affichable tel quel. */
  error: string;
  /** Code stable, pour réagir dans l'interface (voir docs/API-RDV.md). */
  code?: string;
  /** Erreurs de validation par champ (code 'invalid'). */
  fields?: Record<string, string>;
}

export type BookingMode = 'cabinet' | 'telephone' | 'visio' | 'autre';
export type BookingStep = 15 | 30 | 60;

export interface BookingSettings {
  /** Faux par défaut : rien n'est réservable tant que ce n'est pas activé. */
  enabled: boolean;
  /** Nom affiché sur la page publique et dans les e-mails. */
  publicName: string;
  welcomeText: string;
  /** Calendrier où sont créés les rendez-vous ; null = premier calendrier modifiable. */
  calendarId: string | null;
  /** Pas des créneaux proposés, en minutes. */
  slotStepMin: BookingStep;
}

export interface BookingType {
  id: string;
  /** Identifiant lisible et unique, utilisé dans l'API publique et les liens. */
  slug: string;
  name: string;
  durationMin: number;
  description: string;
  mode: BookingMode;
  /** Précision libre : adresse du cabinet, lien de visio, consigne. */
  location: string;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeHours: number;
  horizonDays: number;
  active: boolean;
  sort: number;
}

/** Création : name et durationMin obligatoires. Modification : tous les champs sont facultatifs. */
export type BookingTypeInput = Partial<Omit<BookingType, 'id'>>;

/** Plage horaire hebdomadaire. weekday : 1 = lundi … 7 = dimanche. Minutes depuis minuit, heure locale. */
export interface BookingHoursRange {
  weekday: number;
  startMin: number;
  endMin: number;
}

export interface BookingAdminState {
  settings: BookingSettings;
  /** Calendrier réellement utilisé pour créer les rendez-vous (null : aucun calendrier modifiable). */
  effectiveCalendarId: string | null;
  timezone: string;
  /** Adresse publique de la page de réservation. */
  publicPageUrl: string;
  mail: { configured: boolean; from: string; notifyTo: string };
  /** Points à corriger, en français, à afficher dans l'admin. */
  warnings: string[];
}

export type BookingStatus = 'confirmed' | 'cancelled';
/** État de l'événement lié : présent, déplacé dans le calendrier, ou supprimé (par exemple dans Apple Calendar). */
export type BookingEventState = 'ok' | 'moved' | 'missing';

/** Une réservation, vue de l'admin. */
export interface Booking {
  id: string;
  typeId: string | null;
  typeName: string;
  /** Lieu ou mode, tel qu'annoncé au client. */
  location: string;
  /** Instants ISO UTC. */
  start: string;
  end: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  status: BookingStatus;
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: 'client' | 'admin' | null;
  eventId: string | null;
  calendarId: string | null;
  /** null pour une réservation annulée. */
  eventState: BookingEventState | null;
  /** Si l'événement a été déplacé : son horaire actuel dans le calendrier. */
  eventStart: string | null;
  eventEnd: string | null;
  /** Dernier échec d'envoi d'e-mail, null si tout est parti. */
  mailError: string | null;
}

// --- partie publique --------------------------------------------------------

export interface PublicBookingType {
  slug: string;
  name: string;
  durationMin: number;
  description: string;
  mode: BookingMode;
  /** Lieu ou mode en clair (« Par téléphone », adresse…). */
  locationLabel: string;
  /** Le téléphone est obligatoire pour ce type (rendez-vous par téléphone). */
  phoneRequired: boolean;
}

export interface PublicBookingInfo {
  /** Faux : la prise de rendez-vous n'est pas ouverte (types vide). */
  enabled: boolean;
  publicName: string;
  welcomeText: string;
  /** Fuseau dans lequel afficher les créneaux (Europe/Zurich). */
  timezone: string;
  types: PublicBookingType[];
}

export interface PublicSlotDay {
  /** Jour local AAAA-MM-JJ (dans le fuseau annoncé). */
  date: string;
  /** Débuts des créneaux libres, instants ISO UTC. */
  slots: string[];
}

export interface PublicSlots {
  timezone: string;
  durationMin: number;
  /** Seuls les jours qui ont au moins un créneau libre. */
  days: PublicSlotDay[];
}

export interface BookingRequest {
  typeSlug: string;
  /** Début du créneau : exactement une valeur renvoyée par la liste des créneaux. */
  start: string;
  name: string;
  email: string;
  phone?: string;
  message?: string;
  /** Champ piège anti-robot : doit rester vide (champ caché dans le formulaire). */
  website?: string;
}

/** Récapitulatif d'un rendez-vous, vu du client. */
export interface PublicBooking {
  typeName: string;
  start: string;
  end: string;
  timezone: string;
  locationLabel: string;
  name: string;
  status: BookingStatus;
  /** Faux si le rendez-vous est déjà commencé ou passé. */
  cancellable: boolean;
}

export interface BookingConfirmation {
  booking: PublicBooking;
  /** Lien d'annulation (aussi envoyé par e-mail). */
  cancelUrl: string;
  /** Faux si l'e-mail de confirmation n'a pas pu partir : afficher le récapitulatif et le lien. */
  emailSent: boolean;
}
