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
  /**
   * Vrai (défaut) : une « journée entière » bloque toute la journée même si elle est marquée
   * « disponible » (Apple Calendar marque ainsi les journées entières qu'il crée, congés compris).
   * Faux : seules les journées entières marquées « occupé » bloquent.
   */
  allDayBlocks: boolean;
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
  mail: {
    configured: boolean;
    from: string;
    notifyTo: string;
    /** E-mails partis sur les dernières 24 heures, et plafond au-delà duquel plus rien ne part. */
    sentLast24h: number;
    dailyLimit: number;
  };
  /** Points à corriger, en français, à afficher dans l'admin. */
  warnings: string[];
}

export type BookingStatus = 'confirmed' | 'cancelled';
/**
 * État de l'événement lié : présent, déplacé dans le calendrier (le client n'a pas encore
 * reçu le nouvel horaire), ou supprimé (par exemple dans Apple Calendar).
 */
export type BookingEventState = 'ok' | 'moved' | 'missing';

/** Une réservation, vue de l'admin. */
export interface Booking {
  id: string;
  typeId: string | null;
  typeName: string;
  /** Lieu ou mode, tel qu'annoncé au client. */
  location: string;
  /** Instants ISO UTC. Horaire actuel : il suit l'événement quand Antoine le déplace dans son agenda. */
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
  /** Si l'événement a été déplacé : son horaire actuel dans le calendrier (égal à start et end). */
  eventStart: string | null;
  /** Lien de la visio Alfred, pour un rendez-vous « En visio » confirmé. */
  videoUrl?: string | null;
  eventEnd: string | null;
  /** Si l'événement a été déplacé : le début annoncé au client dans son dernier e-mail. */
  notifiedStart: string | null;
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
  /** Nombre de jours à l'avance jusqu'où des créneaux sont proposés (borne du calendrier de la page). */
  horizonDays: number;
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
  /** Lien de la visio Alfred du rendez-vous, s'il en a une. */
  videoUrl: string | null;
  /** Réponse à une annulation seulement : vrai si un e-mail de confirmation d'annulation est parti. */
  emailSent?: boolean;
}

export interface BookingConfirmation {
  booking: PublicBooking;
  /** Lien d'annulation (aussi envoyé par e-mail). */
  cancelUrl: string;
  /** Faux si l'e-mail de confirmation n'a pas pu partir : afficher le récapitulatif et le lien. */
  emailSent: boolean;
}

// ---------------------------------------------------------------------------
// Connexions (SMTP et CalDAV) réglables depuis l'app. Voir docs/API-RDV.md.

/** D'où vient un réglage : enregistré dans l'app, lu dans le fichier .env, valeur par défaut, ou absent. */
export type SettingSource = 'app' | 'env' | 'default' | 'none';

export interface ConnectionField {
  value: string;
  source: SettingSource;
}

/** État d'un mot de passe : jamais sa valeur, même en partie. */
export interface ConnectionSecret {
  configured: boolean;
  source: SettingSource;
  /** Enregistré dans l'app mais indéchiffrable (clé absente ou différente) : à ressaisir. */
  unreadable: boolean;
  /**
   * Un mot de passe existe, mais pour un autre serveur que celui réglé maintenant : il n'est
   * pas utilisé (un mot de passe ne part jamais vers un serveur pour lequel il n'a pas été saisi).
   */
  otherServer: boolean;
}

/** Résultat d'un essai de connexion, en clair et sans détail sensible. */
export interface ConnectionTest {
  ok: boolean;
  /** Code stable : « ok », « auth », « host_not_found », « timeout », « tls »… */
  code: string;
  message: string;
  /** Instant de l'essai (ISO UTC). */
  at: string;
}

export interface SmtpConnectionState {
  /** Vrai quand un identifiant et un mot de passe sont en place : les e-mails peuvent partir. */
  configured: boolean;
  host: ConnectionField;
  port: ConnectionField;
  user: ConnectionField;
  password: ConnectionSecret;
  /** « Nom <adresse> ». */
  from: ConnectionField;
  notifyTo: ConnectionField;
  /** Au moins un réglage est enregistré dans l'app (« Revenir au fichier .env » a un effet). */
  hasAppValues: boolean;
  /** Le fichier .env porte un identifiant et un mot de passe : retirer les réglages de l'app ne coupe pas l'envoi. */
  envConfigured: boolean;
  /** Dernier essai d'envoi (gardé d'un redémarrage à l'autre), ou null. */
  lastTest: ConnectionTest | null;
}

export interface CaldavConnectionState {
  configured: boolean;
  url: ConnectionField;
  username: ConnectionField;
  password: ConnectionSecret;
  hasAppValues: boolean;
  /** Un compte est en place : seul son mot de passe peut changer (pas l'identifiant ni le serveur). */
  accountLocked: boolean;
  /** Le fichier .env porte des identifiants pour le même compte : « Revenir au fichier .env » est possible. */
  canRevertToEnv: boolean;
  sync: SyncStatus;
  /** Calendriers et événements synchronisés présents en base. */
  calendars: number;
  events: number;
  /** Dernier essai de la configuration en place depuis le démarrage (jamais celui d'identifiants seulement essayés), ou null. */
  lastTest: ConnectionTest | null;
}

export interface ConnectionsState {
  smtp: SmtpConnectionState;
  caldav: CaldavConnectionState;
  /** Clé de chiffrement des mots de passe : où elle vit, et un éventuel problème à corriger. */
  secretKey: { source: 'env' | 'file' | 'memory' | 'none'; problem: string | null };
  /** Messages à afficher en tête (secret à ressaisir, clé invalide…). */
  notices: string[];
}

export interface SmtpSettingsInput {
  host?: string;
  port?: number | string;
  user?: string;
  /** Vide ou absent : le mot de passe actuel est gardé. */
  password?: string;
  from?: string;
  notifyTo?: string;
  /** Envoyer un e-mail d'essai juste après l'enregistrement. */
  test?: boolean;
}

export interface SmtpSaveResult {
  state: ConnectionsState;
  /** Résultat de l'essai demandé, sinon null. */
  test: ConnectionTest | null;
}

export interface CaldavSettingsInput {
  url?: string;
  username?: string;
  password?: string;
}

export interface CaldavSaveResult {
  state: ConnectionsState;
  test: ConnectionTest;
  /** Remarque non bloquante (forme inattendue du mot de passe d'application Apple). */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Visioconférence (v2). Voir docs/API-VISIO.md.

/** Qualité d'envoi de la vidéo : « standard » jusqu'à 720p, « eco » jusqu'à 360p (petit serveur, petite connexion). */
export type VideoQuality = 'standard' | 'eco';

export type VideoRoomKind = 'instant' | 'event' | 'booking' | 'permanent';

export interface VideoSettings {
  /** Faux : aucune salle ne s'ouvre et les rendez-vous « En visio » ne reçoivent pas de lien Alfred. */
  enabled: boolean;
  /** Participants au plus dans une salle, toi compris (2 à 8). */
  maxParticipants: number;
  quality: VideoQuality;
}

export interface VideoServerStatus {
  /** Les clés du serveur de visio sont présentes dans la configuration d'Alfred. */
  configured: boolean;
  /** Le serveur de visio répond. null : pas vérifié (non configuré). */
  reachable: boolean | null;
  /** Message en français si quelque chose manque. */
  problem: string | null;
}

export interface VideoRoom {
  id: string;
  slug: string;
  /** Lien à partager (page publique de la salle). */
  url: string;
  title: string;
  kind: VideoRoomKind;
  /** Instants ISO UTC, null pour une salle permanente. */
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  /** Réservation liée (salle d'un rendez-vous). */
  bookingId: string | null;
  /** Personnes connectées en ce moment (null : serveur de visio injoignable). */
  live: number | null;
}

export interface VideoAdminState {
  settings: VideoSettings;
  server: VideoServerStatus;
  /** La visio est utilisable : activée et serveur configuré. */
  available: boolean;
  /** Salle permanente (ton lien fixe), null si elle n'a pas encore été créée. */
  personalRoom: VideoRoom | null;
  /** Salles ouvertes ou à venir, hors salle permanente, de la plus proche à la plus lointaine. */
  rooms: VideoRoom[];
}

export interface VideoRoomInput {
  title?: string;
  /** Pour une visio rattachée à un événement : son horaire (instants ISO). */
  start?: string;
  end?: string;
}

/** État public d'une salle, vu depuis son lien. */
export type VideoRoomStatus = 'open' | 'ended' | 'closed' | 'unavailable';

export interface PublicVideoRoom {
  title: string;
  /** Nom de l'hôte (nom public de la prise de rendez-vous). */
  hostName: string;
  status: VideoRoomStatus;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  /** Le visiteur est connecté à Alfred : il entre comme hôte. */
  isHost: boolean;
}

export interface VideoJoinInfo {
  /** Adresse WebSocket du serveur de visio. */
  url: string;
  token: string;
  identity: string;
  isHost: boolean;
  quality: VideoQuality;
}
