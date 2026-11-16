import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { newUid, type BusyOccurrence } from '../ics.js';
import type {
  Booking, BookingAdminState, BookingConfirmation, BookingHoursRange, BookingMode, BookingSettings, BookingType,
  PublicBooking, PublicBookingInfo, PublicBookingType, PublicDeposit, PublicPaymentStatus, PublicSlots,
} from '../../shared/types.js';
import { formatAmount } from '../../shared/money.js';
import { StripeError, type StripeClient } from '../payments/stripe.js';
import { ConflictError, type CaldavSync } from '../caldav.js';
import { ForbiddenError, NotFoundError, type CalendarService } from '../service.js';
import type { Store } from '../store.js';
import {
  cancelUrlFor, clientCancellation, clientConfirmation, createDisabledMailer, formatWhen, ownerCancellation, ownerNotification,
  type BookingMailData, type Mailer, type MailContext, type MailMessage,
} from './mail.js';
import { addDays, computeSlotDays, isDateString, localDateOf, startOfLocalDay, type BusyEvent, type SlotDay } from './slots.js';
import { BookingStore, type BookingRow, type HoldRow } from './store.js';

/** Erreur métier de la prise de rendez-vous : statut HTTP, code stable, message affichable. */
export class BookingError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 415 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Ce que la prise de rendez-vous attend de la visio (voir server/video/service.ts). */
export interface BookingVideo {
  /** Salle préparée pour un rendez-vous « En visio », ou null si la visio Alfred n'est pas disponible. */
  reserveForBooking(title: string, start: string, end: string): { url: string; commit: (bookingId: string) => void } | null;
  urlForBooking(bookingId: string): string | null;
  closeForBooking(bookingId: string): void;
}

/** Ce que la prise de rendez-vous attend du paiement en ligne (voir server/payments/service.ts). */
export interface BookingPayments {
  readonly configured: boolean;
  /** Le client qui annule au moins tant d'heures avant est remboursé ; null : jamais automatiquement. */
  readonly refundHours: number | null;
  readonly paymentMethods: string[];
  client(): StripeClient | null;
  state(): { mode: 'test' | 'live' | null };
}

export interface BookingOptions {
  /** Visio : les rendez-vous « En visio » reçoivent le lien d'une salle Alfred. */
  video?: BookingVideo;
  /** Paiement des acomptes (Stripe). Sans lui, aucun type avec acompte n'est réservable. */
  payments?: BookingPayments;
  /** Durée de validité de la page de paiement, en minutes (Stripe : 30 au moins). */
  paymentMinutes?: number;
  store: Store;
  calendar: CalendarService;
  caldav: CaldavSync | null;
  timezone: string;
  mailer?: Mailer;
  /** Diagnostic du dernier essai d'envoi s'il a échoué alors que l'envoi est configuré, sinon null. */
  mailProblem?: () => string | null;
  /** Adresse publique d'Alfred, sans barre finale. */
  publicUrl?: string;
  /** Nom public proposé tant qu'Antoine n'en a pas choisi un. */
  defaultPublicName?: string;
  /** Horloge injectable (tests). */
  now?: () => Date;
  /** Attente maximale de la synchro fraîche avant de confirmer une réservation. */
  syncTimeoutMs?: number;
  /** Attente maximale d'une écriture dans le calendrier (création ou suppression de l'événement). */
  calendarTimeoutMs?: number;
  /** Nombre maximal de réservations créées en 24 heures pour une même adresse e-mail (annulées comprises). */
  maxPerEmailPerDay?: number;
  /** Attente maximale des envois d'e-mails avant de répondre ; ils se poursuivent ensuite en arrière-plan. */
  mailWaitMs?: number;
  /** Durée totale maximale d'un envoi d'e-mail : au-delà, il est compté comme un échec. */
  mailTimeoutMs?: number;
  /** Plafond d'e-mails sortants sur 24 heures glissantes, tous destinataires confondus. */
  mailDailyLimit?: number;
  /** Une annulation par le client dans ce délai après la réservation n'envoie pas d'e-mail au client. */
  quietCancelMinutes?: number;
}

interface Contact {
  name: string;
  email: string;
  phone: string;
  message: string;
}

/** Ce qu'une réservation reprend de son type (copié dans la retenue pendant le paiement). */
interface TypeSnapshot {
  id: string | null;
  name: string;
  mode: BookingMode;
  location: string;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

const DAY_MS = 86_400_000;
/** Étendue maximale d'une demande de créneaux, en jours (un mois affiché, semaines entières comprises). */
export const MAX_RANGE_DAYS = 42;
const WEEKDAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
/** Nom d'une personne : lettres (toutes écritures), espaces, apostrophes, tirets, point d'abréviation. */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u;
const MAX_WAITING = 20;
const MODES: BookingMode[] = ['cabinet', 'telephone', 'visio', 'autre'];
const MODE_LABELS: Record<BookingMode, string> = { cabinet: 'Au cabinet', telephone: 'Par téléphone', visio: 'En visio', autre: '' };
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Plus petit acompte accepté par Stripe en francs suisses : 0.50. */
const MIN_DEPOSIT_CENTS = 50;
const MAX_DEPOSIT_CENTS = 100_000;
const CURRENCY = 'CHF';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const PHONE_RE = /^\+?[0-9][0-9 ().\/-]{5,28}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
/** Pour un message : tout caractère de contrôle sauf le retour à la ligne et la tabulation. */
const CONTROL_MULTILINE_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Lieu ou mode en clair, tel qu'annoncé au client et écrit dans l'événement. */
export function locationLabel(mode: BookingMode, location: string): string {
  const detail = location.trim();
  if (mode === 'autre') return detail;
  if (mode === 'cabinet') return detail || MODE_LABELS.cabinet;
  return detail ? `${MODE_LABELS[mode]} (${detail})` : MODE_LABELS[mode];
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'rendez-vous';
}

const TIMED_OUT = Symbol('délai dépassé');

/** Attend une promesse au plus ms millisecondes ; renvoie TIMED_OUT si elle n'a pas abouti à temps. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(fields: Record<string, string>): BookingError {
  return new BookingError(400, 'invalid', Object.values(fields)[0] ?? 'Données invalides', fields);
}

/** Entier borné, ou message d'erreur. */
function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/**
 * Moteur de la prise de rendez-vous : réglages, types, horaires, créneaux,
 * réservation et annulation. Un seul processus : la section critique est en mémoire.
 */
export class BookingService {
  readonly data: BookingStore;
  private readonly store: Store;
  private readonly calendar: CalendarService;
  private readonly caldav: CaldavSync | null;
  readonly timezone: string;
  private readonly mailer: Mailer;
  private readonly mailProblem: () => string | null;
  private readonly publicUrl: string;
  private readonly defaultPublicName: string;
  private readonly now: () => Date;
  private readonly syncTimeoutMs: number;
  private readonly calendarTimeoutMs: number;
  private readonly maxPerEmailPerDay: number;
  private readonly mailWaitMs: number;
  private readonly mailTimeoutMs: number;
  private readonly mailDailyLimit: number;
  private readonly quietCancelMs: number;
  private readonly video: BookingVideo | null;
  private readonly payments: BookingPayments | null;
  private readonly paymentMs: number;
  /** Retenues en cours de vérification auprès de Stripe : une seule vérification à la fois par retenue. */
  private settling = new Map<string, Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /** Occupation de l'agenda sur toute la période réservable, recalculée seulement quand l'agenda change. */
  private busyCache: { key: string; fromMs: number; toMs: number; list: BusyOccurrence[] } | null = null;
  /** Version de l'agenda pour laquelle les réservations ont été rapprochées de leurs événements. */
  private reconciledVersion = -1;
  /** Instants (ms) des e-mails partis sur les dernières 24 heures. */
  private mailTimes: number[] = [];

  constructor(opts: BookingOptions) {
    this.store = opts.store;
    this.data = new BookingStore(opts.store.db);
    this.video = opts.video ?? null;
    this.payments = opts.payments ?? null;
    this.paymentMs = Math.max(30, opts.paymentMinutes ?? 31) * 60_000;
    this.calendar = opts.calendar;
    this.caldav = opts.caldav;
    this.timezone = opts.timezone;
    this.mailer = opts.mailer ?? createDisabledMailer();
    this.mailProblem = opts.mailProblem ?? (() => null);
    this.publicUrl = (opts.publicUrl ?? 'http://localhost:3200').replace(/\/+$/, '');
    this.defaultPublicName = opts.defaultPublicName ?? '';
    this.now = opts.now ?? (() => new Date());
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 4000;
    this.calendarTimeoutMs = opts.calendarTimeoutMs ?? 20_000;
    this.maxPerEmailPerDay = opts.maxPerEmailPerDay ?? 3;
    this.mailWaitMs = opts.mailWaitMs ?? 8000;
    this.mailTimeoutMs = opts.mailTimeoutMs ?? 60_000;
    this.mailDailyLimit = opts.mailDailyLimit ?? 200;
    this.quietCancelMs = (opts.quietCancelMinutes ?? 15) * 60_000;
  }

  /** Section critique : une seule réservation ou annulation à la fois. */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.waiting >= MAX_WAITING) {
      throw new BookingError(503, 'busy', 'Trop de demandes en même temps. Réessayez dans un instant.');
    }
    this.waiting++;
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.waiting--;
    }
  }

  private mailContext(): MailContext {
    return { publicName: this.getSettings().publicName, timezone: this.timezone, publicUrl: this.publicUrl };
  }

  // --- réglages ------------------------------------------------------------

  getSettings(): BookingSettings {
    return this.data.getSettings({ publicName: this.defaultPublicName });
  }

  updateSettings(body: unknown): BookingSettings {
    if (!isObject(body)) throw invalid({ _: 'Corps de requête invalide' });
    const next = { ...this.getSettings() };
    const fields: Record<string, string> = {};
    if ('enabled' in body) {
      if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
      else fields.enabled = 'Valeur attendue : vrai ou faux';
    }
    if ('publicName' in body) {
      if (typeof body.publicName === 'string' && body.publicName.trim().length <= 100 && !CONTROL_RE.test(body.publicName)) next.publicName = body.publicName.trim();
      else fields.publicName = 'Nom public : 100 caractères au plus, sur une ligne';
    }
    if ('welcomeText' in body) {
      if (typeof body.welcomeText === 'string' && body.welcomeText.length <= 2000) next.welcomeText = body.welcomeText.replace(/\r/g, '').trim();
      else fields.welcomeText = 'Texte d’accueil : 2000 caractères au plus';
    }
    if ('calendarId' in body) {
      if (body.calendarId === null || body.calendarId === '') next.calendarId = null;
      else {
        const cal = typeof body.calendarId === 'string' ? this.store.getCalendar(body.calendarId) : undefined;
        if (!cal) fields.calendarId = 'Calendrier introuvable';
        else if (cal.read_only) fields.calendarId = 'Ce calendrier est en lecture seule';
        else next.calendarId = cal.id;
      }
    }
    if ('slotStepMin' in body) {
      if (body.slotStepMin === 15 || body.slotStepMin === 30 || body.slotStepMin === 60) next.slotStepMin = body.slotStepMin;
      else fields.slotStepMin = 'Pas des créneaux : 15, 30 ou 60 minutes';
    }
    if ('allDayBlocks' in body) {
      if (typeof body.allDayBlocks === 'boolean') next.allDayBlocks = body.allDayBlocks;
      else fields.allDayBlocks = 'Valeur attendue : vrai ou faux';
    }
    if (Object.keys(fields).length > 0) throw invalid(fields);
    this.data.saveSettings(next);
    return next;
  }

  /** Calendrier où créer les rendez-vous : celui des réglages s'il est utilisable, sinon le premier modifiable. */
  private targetCalendarId(settings = this.getSettings()): string | null {
    const usable = (id: string | null) => {
      const cal = id ? this.store.getCalendar(id) : undefined;
      return cal && !cal.read_only && (cal.source === 'local' || (this.caldav?.configured && cal.url)) ? cal.id : null;
    };
    return usable(settings.calendarId) ?? this.store.listCalendars().map((c) => usable(c.id)).find((id) => id !== null) ?? null;
  }

  adminState(): BookingAdminState {
    const settings = this.getSettings();
    const effectiveCalendarId = this.targetCalendarId(settings);
    const warnings: string[] = [];
    if (!this.mailer.configured) {
      warnings.push('L’envoi d’e-mails n’est pas configuré : les réservations fonctionnent, mais aucun e-mail ne part. Il se règle dans Rendez-vous > Réglages.');
    } else {
      const problem = this.mailProblem();
      if (problem) warnings.push(`Le dernier essai d’envoi d’e-mails a échoué : les confirmations risquent de ne pas partir. ${problem}`);
    }
    if (!effectiveCalendarId) warnings.push('Aucun calendrier modifiable : les rendez-vous ne peuvent pas être créés.');
    else if (settings.calendarId && settings.calendarId !== effectiveCalendarId) {
      warnings.push('Le calendrier choisi pour les rendez-vous n’est plus utilisable : un autre calendrier est utilisé à la place.');
    }
    if (!this.data.listTypes().some((t) => t.active)) warnings.push('Aucun type de rendez-vous actif.');
    const unpaid = this.data.listTypes().filter((t) => t.active && t.depositCents > 0);
    if (unpaid.length > 0 && !this.payments?.configured) {
      warnings.push(`Le paiement en ligne n’est pas configuré : ${unpaid.map((t) => `« ${t.name} »`).join(', ')} ${unpaid.length > 1 ? 'ne sont pas proposés' : 'n’est pas proposé'} sur la page publique tant qu’aucune clé Stripe n’est enregistrée (Rendez-vous > Réglages).`);
    }
    if (this.data.getHours().length === 0) warnings.push('Aucun horaire d’ouverture : aucun créneau n’est proposé.');
    const sync = this.caldav?.configured ? this.caldav.getStatus() : undefined;
    if (sync?.lastError) warnings.push('La synchro iCloud est en échec : les créneaux sont calculés sur la dernière copie connue.');
    if (!settings.enabled) warnings.push('La prise de rendez-vous est fermée : la page publique n’accepte aucune réservation.');
    const sentLast24h = this.mailsSentLast24h();
    if (this.mailer.configured && sentLast24h >= this.mailDailyLimit) {
      warnings.push(`Le plafond de ${this.mailDailyLimit} e-mails par 24 heures est atteint : plus aucun e-mail ne part pour l’instant. Vérifie qu’il ne s’agit pas d’un abus du formulaire.`);
    }
    return {
      settings,
      effectiveCalendarId,
      timezone: this.timezone,
      publicPageUrl: `${this.publicUrl}/rdv`,
      mail: {
        configured: this.mailer.configured, from: this.mailer.from, notifyTo: this.mailer.notifyTo,
        sentLast24h, dailyLimit: this.mailDailyLimit,
      },
      warnings,
    };
  }

  // --- types ---------------------------------------------------------------

  listTypes(): BookingType[] {
    return this.data.listTypes();
  }

  private requireType(id: string): BookingType {
    const type = this.data.getType(id);
    if (!type) throw new BookingError(404, 'not_found', 'Type de rendez-vous introuvable');
    return type;
  }

  private uniqueSlug(base: string): string {
    for (let i = 1; i < 1000; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      if (!this.data.getTypeBySlug(slug)) return slug;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }

  private parseType(body: unknown, base: BookingType | null): BookingType {
    if (!isObject(body)) throw invalid({ _: 'Corps de requête invalide' });
    const fields: Record<string, string> = {};
    const t: BookingType = base ? { ...base } : {
      id: randomUUID(), slug: '', name: '', durationMin: 0, description: '', mode: 'cabinet', location: '',
      bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeHours: 12, horizonDays: 60, depositCents: 0, active: true, sort: this.data.nextTypeSort(),
    };
    const text = (key: 'name' | 'description' | 'location', max: number, label: string, multiline = false) => {
      if (!(key in body)) return;
      const v = body[key];
      if (typeof v !== 'string' || v.trim().length > max || (multiline ? CONTROL_MULTILINE_RE : CONTROL_RE).test(v)) {
        fields[key] = `${label} : ${max} caractères au plus${multiline ? '' : ', sur une ligne'}`;
      } else t[key] = v.replace(/\r/g, '').trim();
    };
    const int = (key: 'durationMin' | 'bufferBeforeMin' | 'bufferAfterMin' | 'minNoticeHours' | 'horizonDays' | 'sort', min: number, max: number, label: string) => {
      if (!(key in body)) return;
      const v = intIn(body[key], min, max);
      if (v === null) fields[key] = `${label} : nombre entier entre ${min} et ${max}`;
      else t[key] = v;
    };
    text('name', 100, 'Nom');
    text('description', 2000, 'Description', true);
    text('location', 300, 'Lieu');
    int('durationMin', 5, 480, 'Durée (minutes)');
    int('bufferBeforeMin', 0, 240, 'Tampon avant (minutes)');
    int('bufferAfterMin', 0, 240, 'Tampon après (minutes)');
    int('minNoticeHours', 0, 720, 'Préavis (heures)');
    int('horizonDays', 1, 365, 'Horizon (jours)');
    int('sort', 0, 10_000, 'Ordre');
    if ('depositCents' in body) {
      const v = intIn(body.depositCents, 0, MAX_DEPOSIT_CENTS);
      if (v === null || (v > 0 && v < MIN_DEPOSIT_CENTS) || v % 5 !== 0) {
        fields.depositCents = `Acompte : 0 (aucun) ou un montant entre ${formatAmount(MIN_DEPOSIT_CENTS, CURRENCY)} et ${formatAmount(MAX_DEPOSIT_CENTS, CURRENCY)}, arrondi à 5 centimes`;
      } else {
        if (v > 0 && v !== base?.depositCents && !this.payments?.configured) {
          fields.depositCents = 'Enregistre d’abord ta clé Stripe dans Rendez-vous > Réglages > Paiement en ligne';
        } else t.depositCents = v;
      }
    }
    if ('mode' in body) {
      if (MODES.includes(body.mode as BookingMode)) t.mode = body.mode as BookingMode;
      else fields.mode = 'Mode : cabinet, telephone, visio ou autre';
    }
    if ('active' in body) {
      if (typeof body.active === 'boolean') t.active = body.active;
      else fields.active = 'Valeur attendue : vrai ou faux';
    }
    if (!fields.name && !t.name) fields.name = 'Le nom est obligatoire';
    if (!fields.durationMin && !t.durationMin) fields.durationMin = 'La durée est obligatoire';
    if (!fields.location && t.mode === 'autre' && !t.location) fields.location = 'Précise le lieu pour le mode « autre »';
    let slugTaken = false;
    if ('slug' in body && body.slug !== '' && body.slug !== null) {
      if (typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)) {
        fields.slug = 'Identifiant : minuscules, chiffres et tirets, 50 caractères au plus';
      } else {
        const other = this.data.getTypeBySlug(body.slug);
        if (other && other.id !== t.id) slugTaken = true;
        else t.slug = body.slug;
      }
    }
    if (Object.keys(fields).length > 0) throw invalid(fields);
    if (slugTaken) throw new BookingError(409, 'slug_taken', 'Cet identifiant est déjà utilisé par un autre type', { slug: 'Identifiant déjà utilisé' });
    if (!t.slug) t.slug = this.uniqueSlug(slugify(t.name));
    return t;
  }

  createType(body: unknown): BookingType {
    const type = this.parseType(body, null);
    this.data.saveType(type);
    return type;
  }

  updateType(id: string, body: unknown): BookingType {
    const type = this.parseType(body, this.requireType(id));
    this.data.saveType(type);
    return type;
  }

  /** Supprime un type. Les réservations existantes sont conservées (elles gardent le nom du type). */
  deleteType(id: string): void {
    this.requireType(id);
    this.data.deleteType(id);
  }

  reorderTypes(body: unknown): BookingType[] {
    const ids = isObject(body) ? body.ids : undefined;
    const known = new Set(this.data.listTypes().map((t) => t.id));
    if (!Array.isArray(ids) || ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => typeof id === 'string' && known.has(id))) {
      throw invalid({ ids: 'La liste doit contenir chaque type exactement une fois' });
    }
    this.data.setTypeOrder(ids as string[]);
    return this.data.listTypes();
  }

  // --- horaires ------------------------------------------------------------

  getHours(): BookingHoursRange[] {
    return this.data.getHours();
  }

  /** Remplace tous les horaires hebdomadaires. */
  setHours(body: unknown): BookingHoursRange[] {
    const list = Array.isArray(body) ? body : isObject(body) ? body.hours : undefined;
    if (!Array.isArray(list) || list.length > 70) throw invalid({ hours: 'Liste d’horaires invalide' });
    const hours: BookingHoursRange[] = [];
    for (const item of list) {
      const weekday = isObject(item) ? intIn(item.weekday, 1, 7) : null;
      const startMin = isObject(item) ? intIn(item.startMin, 0, 1439) : null;
      const endMin = isObject(item) ? intIn(item.endMin, 1, 1440) : null;
      if (weekday !== null && startMin !== null && endMin !== null && endMin <= startMin) {
        throw invalid({ hours: `${WEEKDAY_NAMES[weekday - 1]} : la fin d’une plage doit être après son début` });
      }
      if (weekday === null || startMin === null || endMin === null) {
        throw invalid({ hours: 'Horaires illisibles : chaque plage a un jour, une heure de début et une heure de fin' });
      }
      hours.push({ weekday, startMin, endMin });
    }
    hours.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
    for (let i = 1; i < hours.length; i++) {
      if (hours[i].weekday === hours[i - 1].weekday && hours[i].startMin < hours[i - 1].endMin) {
        throw invalid({ hours: `${WEEKDAY_NAMES[hours[i].weekday - 1]} : deux plages se chevauchent` });
      }
    }
    this.data.setHours(hours);
    return hours;
  }

  // --- calendriers ---------------------------------------------------------

  setCalendarBlocks(id: string, body: unknown): void {
    if (!this.store.getCalendar(id)) throw new BookingError(404, 'not_found', 'Calendrier introuvable');
    if (!isObject(body) || typeof body.blocksBooking !== 'boolean') throw invalid({ blocksBooking: 'Valeur attendue : vrai ou faux' });
    this.store.setCalendarBlocksBooking(id, body.blocksBooking);
  }

  // --- créneaux ------------------------------------------------------------

  /**
   * Rapproche les réservations confirmées de leurs événements, quand l'agenda a changé :
   * - l'événement a changé de calendrier (nouvel identifiant local) : il est retrouvé par son UID ;
   * - l'événement a été déplacé dans le temps : la réservation prend le nouvel horaire (l'ancien
   *   créneau est libéré, le nouveau est protégé avec ses tampons) et retient l'horaire que le
   *   client connaît, pour le signaler dans l'admin.
   */
  private reconcile(): void {
    if (this.reconciledVersion === this.store.version) return;
    const since = new Date(this.now().getTime() - 60 * DAY_MS).toISOString();
    for (const b of this.data.confirmedEndingAfter(since)) {
      const ev = this.linkedEvent(b);
      if (!ev || ev.endMs <= ev.startMs) continue;
      if (ev.startMs === Date.parse(b.start_utc) && ev.endMs === Date.parse(b.end_utc)) continue;
      const start = new Date(ev.startMs).toISOString();
      const known = b.notified_start ?? b.start_utc;
      this.data.reschedule(b.id, start, new Date(ev.endMs).toISOString(), Date.parse(known) === ev.startMs ? null : known);
    }
    this.reconciledVersion = this.store.version;
  }

  /** Événement lié à une réservation, retrouvé au besoin par son UID ; la réservation est alors rattachée. */
  private linkedEvent(b: BookingRow): { id: string; startMs: number; endMs: number } | undefined {
    const ev = this.store.findEvent(b.event_id, b.event_uid);
    if (ev && (ev.id !== b.event_id || ev.calendarId !== b.calendar_id || b.event_uid !== ev.uid)) {
      this.data.setEvent(b.id, ev.id, ev.calendarId, ev.uid);
      b.event_id = ev.id;
      b.calendar_id = ev.calendarId;
      b.event_uid = ev.uid;
    }
    return ev;
  }

  /**
   * Occupation de l'agenda entre deux instants. Toute la période réservable est développée
   * une seule fois, puis réutilisée tant que l'agenda ne change pas : une demande de créneaux
   * ne relit ni ne redéveloppe aucun événement.
   */
  private agendaBusy(fromMs: number, toMs: number): BusyOccurrence[] {
    const today = localDateOf(this.now().getTime(), this.timezone);
    const horizon = this.data.listTypes().reduce((max, t) => Math.max(max, t.horizonDays), 0);
    const allDayBlocks = this.getSettings().allDayBlocks;
    const key = `${this.store.version}|${today}|${horizon}|${allDayBlocks ? 1 : 0}`;
    if (this.busyCache?.key !== key) {
      const start = startOfLocalDay(today, this.timezone) - DAY_MS;
      const end = startOfLocalDay(addDays(today, horizon + 1), this.timezone) + DAY_MS;
      this.busyCache = { key, fromMs: start, toMs: end, list: this.readBusy(start, end, allDayBlocks) };
    }
    if (fromMs >= this.busyCache.fromMs && toMs <= this.busyCache.toMs) return this.busyCache.list;
    return this.readBusy(fromMs, toMs, allDayBlocks);
  }

  private readBusy(fromMs: number, toMs: number, allDayBlocks: boolean): BusyOccurrence[] {
    const list = this.store.busyOccurrences(new Date(fromMs), new Date(toMs));
    // Apple Calendar marque « disponible » les journées entières qu'il crée (congés compris) :
    // selon le réglage, une journée entière bloque quelle que soit cette marque.
    return allDayBlocks ? list.map((o) => (o.allDay && o.transparent ? { ...o, transparent: false } : o)) : list;
  }

  /** Créneaux libres d'un type entre deux jours locaux inclus. Ne lit que des horaires, jamais de détail d'événement. */
  slotDays(type: BookingType, from: string, to: string): SlotDay[] {
    const now = this.now();
    const today = localDateOf(now.getTime(), this.timezone);
    // Inutile de développer l'agenda hors de ce qui est réservable.
    const first = from < today ? today : from;
    const horizon = addDays(today, type.horizonDays);
    const last = to > horizon ? horizon : to;
    if (last < first) return [];
    this.reconcile();
    const fromMs = startOfLocalDay(first, this.timezone) - DAY_MS;
    const toMs = startOfLocalDay(addDays(last, 1), this.timezone) + DAY_MS;
    const busy: BusyEvent[] = [...this.agendaBusy(fromMs, toMs)];
    // Les réservations bloquent même si l'événement n'est pas (encore) dans la copie locale.
    for (const b of this.data.confirmedBetween(new Date(fromMs).toISOString(), new Date(toMs).toISOString())) {
      busy.push({ start: b.start_utc, end: b.end_utc, bufferBeforeMin: b.buffer_before_min, bufferAfterMin: b.buffer_after_min });
    }
    // Un créneau en cours de paiement est retenu, comme s'il était déjà réservé.
    for (const h of this.data.activeHoldsBetween(new Date(fromMs).toISOString(), new Date(toMs).toISOString())) {
      busy.push({ start: h.start_utc, end: h.end_utc, bufferBeforeMin: h.buffer_before_min, bufferAfterMin: h.buffer_after_min });
    }
    return computeSlotDays({
      type, hours: this.data.getHours(), stepMin: this.getSettings().slotStepMin,
      timezone: this.timezone, from: first, to: last, now, busy,
    });
  }

  private parseRange(from: unknown, to: unknown): [string, string] {
    if (!isDateString(from) || !isDateString(to) || to < from) {
      throw new BookingError(400, 'invalid_range', 'Période invalide : from et to au format AAAA-MM-JJ, to après from');
    }
    if (to > addDays(from, MAX_RANGE_DAYS - 1)) {
      throw new BookingError(400, 'invalid_range', `Période trop longue (${MAX_RANGE_DAYS} jours au plus)`);
    }
    return [from, to];
  }

  /** Aperçu des créneaux d'un type pour l'admin (même si la prise de rendez-vous est fermée). */
  adminSlots(typeId: string, from: unknown, to: unknown): PublicSlots {
    const type = this.requireType(typeId);
    const [a, b] = this.parseRange(from, to);
    return { timezone: this.timezone, durationMin: type.durationMin, days: this.slotDays(type, a, b) };
  }

  // --- partie publique -----------------------------------------------------

  private toPublicType(t: BookingType): PublicBookingType {
    return {
      slug: t.slug, name: t.name, durationMin: t.durationMin, description: t.description, mode: t.mode,
      locationLabel: locationLabel(t.mode, t.location), phoneRequired: t.mode === 'telephone',
      horizonDays: t.horizonDays,
      depositCents: t.depositCents, currency: CURRENCY,
    };
  }

  /** Un type avec acompte n'est proposé que si le paiement en ligne est en place. */
  private bookable(t: BookingType): boolean {
    return t.active && (t.depositCents === 0 || Boolean(this.payments?.configured));
  }

  publicInfo(): PublicBookingInfo {
    const s = this.getSettings();
    if (!s.enabled) return { enabled: false, publicName: s.publicName, welcomeText: '', timezone: this.timezone, types: [] };
    return {
      enabled: true, publicName: s.publicName, welcomeText: s.welcomeText, timezone: this.timezone,
      types: this.data.listTypes().filter((t) => this.bookable(t)).map((t) => this.toPublicType(t)),
    };
  }

  private requireOpen(): void {
    if (!this.getSettings().enabled) throw new BookingError(403, 'closed', 'La prise de rendez-vous n’est pas ouverte.');
  }

  private publicType(slug: unknown): BookingType {
    const type = typeof slug === 'string' && slug.length <= 64 ? this.data.getTypeBySlug(slug) : undefined;
    if (!type || !this.bookable(type)) throw new BookingError(404, 'unknown_type', 'Ce type de rendez-vous n’existe pas ou n’est plus proposé.');
    return type;
  }

  publicSlots(slug: string, from: unknown, to: unknown): PublicSlots {
    this.requireOpen();
    const type = this.publicType(slug);
    const [a, b] = this.parseRange(from, to);
    return { timezone: this.timezone, durationMin: type.durationMin, days: this.slotDays(type, a, b) };
  }

  private toPublicBooking(b: BookingRow): PublicBooking {
    return {
      typeName: b.type_name, start: b.start_utc, end: b.end_utc, timezone: this.timezone, locationLabel: b.location,
      name: b.name, status: b.status, videoUrl: b.status === 'confirmed' ? (this.video?.urlForBooking(b.id) ?? null) : null,
      cancellable: b.status === 'confirmed' && Date.parse(b.start_utc) > this.now().getTime(),
      deposit: this.publicDeposit(b),
    };
  }

  /** Remboursement automatique si le client annule maintenant (règle des Réglages). */
  private refundsOnClientCancel(b: BookingRow): boolean {
    const hours = this.payments?.refundHours ?? null;
    return b.payment_status === 'paid' && hours !== null && Date.parse(b.start_utc) - this.now().getTime() >= hours * 3_600_000;
  }

  private publicDeposit(b: BookingRow): PublicDeposit | null {
    if (!b.payment_amount_cents) return null;
    return {
      amountCents: b.payment_amount_cents, currency: b.payment_currency ?? CURRENCY,
      refundOnCancel: this.refundsOnClientCancel(b), refundHours: this.payments?.refundHours ?? null,
      refunded: b.payment_status === 'refunded',
    };
  }

  private isFree(type: BookingType, startMs: number): boolean {
    const day = localDateOf(startMs, this.timezone);
    const iso = new Date(startMs).toISOString();
    return this.slotDays(type, day, day).some((d) => d.slots.includes(iso));
  }

  /** Synchro fraîche avant de confirmer, au mieux : on n'attend pas iCloud au-delà du délai. */
  private async freshSync(): Promise<void> {
    if (!this.caldav?.configured) return;
    // sync() ne rejette jamais : elle journalise ses erreurs et les expose dans son état.
    await withTimeout(this.caldav.sync(), this.syncTimeoutMs);
  }

  /**
   * Réservation publique. Lève BookingError avec un code stable en cas de refus.
   * admit : dernier contrôle appelé dans la section critique, juste avant de créer l'événement
   * (plafonds de débit comptés sans course entre demandes simultanées) ; il lève pour refuser.
   */
  async book(body: unknown, admit?: () => void): Promise<BookingConfirmation> {
    if (!isObject(body)) throw invalid({ _: 'Corps de requête invalide' });
    // Champ piège : un humain ne le voit pas, un robot le remplit.
    if (body.website !== undefined && body.website !== '' && body.website !== null) {
      throw new BookingError(400, 'rejected', 'Demande refusée.');
    }
    this.requireOpen();
    const requested = this.publicType(body.typeSlug);

    const fields: Record<string, string> = {};
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    // Le nom ouvre l'e-mail envoyé à une adresse non vérifiée : il ne doit pouvoir porter ni lien
    // ni domaine (« exemple.ch/x » devient cliquable dans les messageries), ni caractère invisible.
    if (name.length < 2 || name.length > 60 || !NAME_RE.test(name) || /\.[^ -]/.test(name)) {
      fields.name = 'Indiquez votre nom et votre prénom (lettres, espaces, tirets et apostrophes, 60 caractères au plus)';
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email.length > 254 || email.indexOf('@') > 64 || !EMAIL_RE.test(email)) fields.email = 'Adresse e-mail invalide';
    let phone = '';
    if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
      phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      if (!PHONE_RE.test(phone)) fields.phone = 'Numéro de téléphone invalide';
    } else if (requested.mode === 'telephone') {
      fields.phone = 'Le téléphone est nécessaire pour ce rendez-vous';
    }
    let message = '';
    if (body.message !== undefined && body.message !== null) {
      message = typeof body.message === 'string' ? body.message.replace(/\r\n?/g, '\n').trim() : '\u0000';
      if (message.length > 2000 || CONTROL_MULTILINE_RE.test(message)) fields.message = 'Message : 2000 caractères au plus';
    }
    const startMs = typeof body.start === 'string' && body.start.length <= 40 && ISO_RE.test(body.start) ? Date.parse(body.start) : NaN;
    if (Number.isNaN(startMs)) fields.start = 'Créneau invalide';
    if (Object.keys(fields).length > 0) throw invalid(fields);

    const taken = () => new BookingError(409, 'slot_unavailable', 'Ce créneau n’est plus disponible. Choisissez-en un autre.');
    // Premier contrôle sans attendre : le créneau doit être exactement un créneau proposé.
    if (!this.isFree(requested, startMs)) throw taken();

    const start = new Date(startMs).toISOString();
    const token = randomBytes(32).toString('base64url');

    // La synchro est commune à toutes les demandes en cours : on l'attend hors du verrou.
    await this.freshSync();
    const contact: Contact = { name, email, phone, message };
    const result = await this.locked(async (): Promise<{ row: BookingRow } | { hold: HoldRow; ref: string }> => {
      // Après la synchro et l'attente du verrou, tout a pu changer : réglages, type, agenda,
      // réservations des autres clients. Tout est donc relu ici.
      if (!this.getSettings().enabled) throw new BookingError(403, 'closed', 'La prise de rendez-vous n’est pas ouverte.');
      const type = this.data.getType(requested.id);
      if (!type || !this.bookable(type)) throw new BookingError(404, 'unknown_type', 'Ce type de rendez-vous n’existe pas ou n’est plus proposé.');
      if (type.mode === 'telephone' && !phone) throw invalid({ phone: 'Le téléphone est nécessaire pour ce rendez-vous' });
      if (!this.isFree(type, startMs)) throw taken();
      // Plafond par adresse destinataire, annulations comprises : le formulaire ne doit pas servir à
      // inonder une adresse d'e-mails. Même refus que la limite de débit : rien n'est révélé sur l'adresse.
      const since = new Date(this.now().getTime() - DAY_MS).toISOString();
      if (this.data.countCreatedForEmailSince(email, since) + this.data.countHoldsForEmailSince(email, since) >= this.maxPerEmailPerDay) {
        throw new BookingError(429, 'rate_limited', 'Trop de demandes. Réessayez un peu plus tard.');
      }
      admit?.();
      if (!this.targetCalendarId()) throw new BookingError(503, 'calendar_unavailable', 'La réservation est momentanément impossible. Réessayez plus tard.');
      const end = new Date(startMs + type.durationMin * 60_000).toISOString();
      if (type.depositCents > 0) {
        // Acompte : le créneau est retenu le temps du paiement ; rien n'est écrit dans le calendrier
        // et aucun e-mail ne part avant que le paiement ait abouti.
        const ref = randomBytes(32).toString('base64url');
        const now = this.now();
        const hold: HoldRow = {
          id: randomUUID(), ref_hash: hashToken(ref), status: 'pending', type_id: type.id, type_name: type.name, mode: type.mode,
          location: type.location, buffer_before_min: type.bufferBeforeMin, buffer_after_min: type.bufferAfterMin,
          start_utc: start, end_utc: end, name, email, phone, message, token_hash: hashToken(token), cancel_token: token,
          amount_cents: type.depositCents, currency: CURRENCY, checkout_id: null, payment_intent: null, booking_id: null,
          created_at: now.toISOString(), expires_at: new Date(now.getTime() + this.paymentMs).toISOString(), last_error: null,
        };
        this.data.insertHold(hold);
        return { hold, ref };
      }
      return { row: await this.createBookingLocked(this.snapshot(type), start, end, contact, hashToken(token), null) };
    });

    const cancelUrl = cancelUrlFor(this.publicUrl, token);
    if ('hold' in result) return this.startCheckout(result.hold, result.ref, cancelUrl);

    const row = result.row;
    const ctx = this.mailContext();
    const data = this.mailData(row);
    const [clientSent] = await this.sendMails(row.id, [
      ['Confirmation au client', clientConfirmation(data, ctx, cancelUrl)],
      ['Avis de nouveau rendez-vous', ownerNotification(data, ctx, this.mailer.notifyTo)],
    ]);
    return { booking: this.toPublicBooking(row), cancelUrl, emailSent: clientSent };
  }

  private snapshot(type: BookingType): TypeSnapshot {
    return {
      id: type.id, name: type.name, mode: type.mode, location: type.location,
      bufferBeforeMin: type.bufferBeforeMin, bufferAfterMin: type.bufferAfterMin,
    };
  }

  /**
   * Crée l'événement dans le calendrier puis enregistre la réservation. À appeler dans la
   * section critique, une fois le créneau vérifié (ou payé).
   */
  private async createBookingLocked(
    type: TypeSnapshot, start: string, end: string, contact: Contact, tokenHash: string,
    payment: { amountCents: number; currency: string; intent: string | null } | null,
  ): Promise<BookingRow> {
    const { name, email, phone, message } = contact;
    const calendarId = this.targetCalendarId();
    if (!calendarId) throw new BookingError(503, 'calendar_unavailable', 'La réservation est momentanément impossible. Réessayez plus tard.');
    const location = locationLabel(type.mode, type.location);
    // Rendez-vous « En visio » : une salle Alfred, dont le lien va dans l'événement (lieu cliquable dans Apple Calendar).
    // Sauf si le type porte déjà un lien (Zoom, Meet…) : c'est alors ce lien qui vaut, sans second lien concurrent.
    const ownLink = /https?:\/\//i.test(type.location);
    const room = type.mode === 'visio' && !ownLink ? this.video?.reserveForBooking(`${type.name} : ${name}`, start, end) ?? null : null;
    const description = [
      'Rendez-vous pris en ligne.',
      room ? `Visio : ${room.url}` : '',
      room && type.location.trim() ? `Lieu : ${location}` : '',
      `Nom : ${name}`,
      `E-mail : ${email}`,
      phone ? `Téléphone : ${phone}` : '',
      payment ? `Acompte payé en ligne : ${formatAmount(payment.amountCents, payment.currency)}` : '',
      message ? `Message : ${message}` : '',
    ].filter(Boolean).join('\n');
    const unavailable = () => new BookingError(502, 'calendar_unavailable', 'La réservation est momentanément impossible. Réessayez plus tard.');
    const uid = newUid();
    // Le serveur de calendrier a pu enregistrer l'événement sans que la réponse nous parvienne :
    // on le retire au mieux (il se retrouve par son UID), pour ne pas laisser de rendez-vous fantôme.
    const discard = () => this.calendar.discardCreated(calendarId, uid).catch((err) => {
      console.error('[alfred] réservation : l’événement abandonné n’a pas pu être retiré :', err);
    });
    const creating = this.calendar.create({ calendarId, title: `${type.name} : ${name}`, start, end, allDay: false, location: room ? room.url : location, description }, uid);
    let eventId: string | typeof TIMED_OUT;
    try {
      eventId = await withTimeout(creating, this.calendarTimeoutMs);
    } catch (err) {
      console.error('[alfred] réservation : création de l’événement en échec :', err);
      void discard();
      throw unavailable();
    }
    if (eventId === TIMED_OUT) {
      // Le serveur de calendrier ne répond pas : on libère le verrou. Que la création finisse
      // par aboutir ou par échouer, l'événement est retiré pour ne pas rester sans réservation.
      console.error('[alfred] réservation : le calendrier ne répond pas, demande abandonnée');
      creating.then((late) => this.calendar.remove(late, 'all', null), discard).catch(() => undefined);
      throw unavailable();
    }
    const booking: BookingRow = {
      // Le type a pu être supprimé pendant le paiement : la réservation garde son nom, sans lien.
      id: randomUUID(), type_id: type.id && this.data.getType(type.id) ? type.id : null, type_name: type.name, location,
      buffer_before_min: type.bufferBeforeMin, buffer_after_min: type.bufferAfterMin,
      event_id: eventId, event_uid: uid, calendar_id: calendarId, start_utc: start, end_utc: end,
      name, email, phone, message, status: 'confirmed', token_hash: tokenHash,
      created_at: this.now().toISOString(), cancelled_at: null, cancelled_by: null, mail_error: null, notified_start: null,
      payment_amount_cents: payment?.amountCents ?? null, payment_currency: payment?.currency ?? null,
      payment_intent: payment?.intent ?? null, payment_status: payment ? 'paid' : null, payment_error: null,
    };
    try {
      this.data.insertBooking(booking);
    } catch (err) {
      // Pas de réservation enregistrée : on ne laisse pas d'événement orphelin.
      await this.calendar.remove(eventId, 'all', null).catch(() => undefined);
      throw err;
    }
    if (room) {
      try {
        room.commit(booking.id);
      } catch (err) {
        console.error('[alfred] réservation : la salle de visio n’a pas pu être enregistrée :', err);
      }
    }
    return booking;
  }

  // --- acomptes : paiement, suivi, remboursement ----------------------------

  private stripe(): StripeClient {
    const client = this.payments?.client();
    if (!client) throw new BookingError(503, 'payment_unavailable', 'Le paiement en ligne est momentanément indisponible. Réessayez plus tard.');
    return client;
  }

  /** Ouvre la page de paiement Stripe d'une retenue. En cas d'échec, la retenue est levée. */
  private async startCheckout(hold: HoldRow, ref: string, cancelUrl: string): Promise<BookingConfirmation> {
    const back = `${this.publicUrl}/rdv/paiement/${ref}`;
    try {
      const session = await this.stripe().createCheckout({
        amountCents: hold.amount_cents, currency: hold.currency,
        productName: `Acompte : ${hold.type_name}`,
        description: formatWhen(hold.start_utc, hold.end_utc, this.timezone),
        customerEmail: hold.email, successUrl: back, cancelUrl: `${back}?abandon=1`,
        expiresAt: Math.floor(Date.parse(hold.expires_at) / 1000),
        paymentMethods: this.payments!.paymentMethods, reference: hold.id,
      });
      if (!session.url) throw new StripeError('invalid', 'Stripe n’a pas renvoyé de page de paiement');
      this.data.updateHold(hold.id, { checkout_id: session.id });
      return {
        booking: this.holdToPublic(hold), cancelUrl, emailSent: false,
        payment: { url: session.url, ref, amountCents: hold.amount_cents, currency: hold.currency, expiresAt: hold.expires_at },
      };
    } catch (err) {
      const detail = err instanceof StripeError ? err.message : String(err);
      console.error(`[alfred] paiement : la page de paiement n’a pas pu être ouverte (${detail})`);
      // Rien n'a pu être payé : le créneau est libéré tout de suite.
      this.data.updateHold(hold.id, { status: 'expired', cancel_token: null, last_error: detail.slice(0, 300) });
      if (err instanceof BookingError) throw err;
      throw new BookingError(502, 'payment_unavailable', 'Le paiement en ligne est momentanément indisponible. Rien n’a été enregistré : réessayez plus tard.');
    }
  }

  private holdToPublic(h: HoldRow): PublicBooking {
    return {
      typeName: h.type_name, start: h.start_utc, end: h.end_utc, timezone: this.timezone,
      locationLabel: locationLabel(MODES.includes(h.mode as BookingMode) ? (h.mode as BookingMode) : 'autre', h.location),
      name: h.name, status: 'confirmed', cancellable: false, videoUrl: null,
      deposit: { amountCents: h.amount_cents, currency: h.currency, refundOnCancel: false, refundHours: this.payments?.refundHours ?? null },
    };
  }

  /**
   * Fait avancer une retenue d'après Stripe : payée → réservation créée ; page de paiement
   * expirée → créneau libéré. Sans réponse de Stripe, rien ne change (le créneau reste retenu).
   * Une seule vérification à la fois par retenue.
   */
  private settle(holdId: string): Promise<void> {
    const running = this.settling.get(holdId);
    if (running) return running;
    const run = this.settleOnce(holdId).catch((err) => {
      console.error(`[alfred] paiement : suivi de la retenue ${holdId} en échec :`, err);
    }).finally(() => this.settling.delete(holdId));
    this.settling.set(holdId, run);
    return run;
  }

  private async settleOnce(holdId: string): Promise<void> {
    let hold = this.data.getHold(holdId);
    if (!hold) return;
    if (hold.status === 'pending') {
      const client = this.payments?.client();
      if (!client || !hold.checkout_id) return;
      let session;
      try {
        session = await client.getCheckout(hold.checkout_id);
      } catch (err) {
        this.data.updateHold(hold.id, { last_error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
        return;
      }
      if (session.status === 'complete' && session.payment_status === 'paid') {
        this.data.updateHold(hold.id, { status: 'paid', payment_intent: session.payment_intent, last_error: null });
      } else if (session.status === 'expired') {
        this.data.updateHold(hold.id, { status: 'expired', cancel_token: null });
        return;
      } else {
        // Page encore ouverte après son échéance (horloges décalées) : on la ferme nous-mêmes.
        if (session.status === 'open' && this.now().getTime() > Date.parse(hold.expires_at) + 5 * 60_000) {
          try {
            const closed = await client.expireCheckout(hold.checkout_id);
            if (closed.status === 'expired') this.data.updateHold(hold.id, { status: 'expired', cancel_token: null });
          } catch {
            // payée entre-temps, ou Stripe injoignable : la prochaine vérification tranchera
          }
        }
        return;
      }
      hold = this.data.getHold(holdId)!;
    }
    if (hold.status === 'paid') await this.completeHold(hold.id);
  }

  /** Paiement reçu : crée la réservation (événement, salle de visio) et envoie les confirmations. */
  private async completeHold(holdId: string): Promise<void> {
    let token: string | null = null;
    const row = await this.locked(async () => {
      const hold = this.data.getHold(holdId);
      if (!hold || hold.status !== 'paid') return null;
      const type: TypeSnapshot = {
        id: hold.type_id, name: hold.type_name, mode: MODES.includes(hold.mode as BookingMode) ? (hold.mode as BookingMode) : 'autre',
        location: hold.location, bufferBeforeMin: hold.buffer_before_min, bufferAfterMin: hold.buffer_after_min,
      };
      // Le créneau est payé : la réservation est créée même si l'agenda s'est rempli entre-temps
      // (le créneau était retenu dans Alfred, seul un ajout direct dans le calendrier peut le recouper).
      let created: BookingRow;
      try {
        created = await this.createBookingLocked(type, hold.start_utc, hold.end_utc, hold, hold.token_hash,
          { amountCents: hold.amount_cents, currency: hold.currency, intent: hold.payment_intent });
      } catch (err) {
        // Calendrier indisponible : la retenue reste payée, la prochaine vérification réessaie.
        this.data.updateHold(hold.id, { last_error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
        throw err;
      }
      token = hold.cancel_token;
      this.data.updateHold(hold.id, { status: 'completed', booking_id: created.id, cancel_token: null, last_error: null });
      return created;
    });
    if (!row) return;
    let cancelToken: string = token ?? '';
    if (!cancelToken) {
      // Jeton perdu (ne devrait pas arriver) : un nouveau lien d'annulation remplace l'ancien.
      cancelToken = randomBytes(32).toString('base64url');
      this.data.setTokenHash(row.id, hashToken(cancelToken));
    }
    const ctx = this.mailContext();
    const data = this.mailData(row);
    await this.sendMails(row.id, [
      ['Confirmation au client', clientConfirmation(data, ctx, cancelUrlFor(this.publicUrl, cancelToken))],
      ['Avis de nouveau rendez-vous', ownerNotification(data, ctx, this.mailer.notifyTo)],
    ]);
  }

  private holdByRef(ref: string): HoldRow {
    const hold = TOKEN_RE.test(ref) ? this.data.getHoldByRefHash(hashToken(ref)) : undefined;
    if (!hold) throw new BookingError(404, 'not_found', 'Paiement introuvable.');
    return hold;
  }

  private paymentView(holdId: string): PublicPaymentStatus {
    const hold = this.data.getHold(holdId)!;
    const base = { amountCents: hold.amount_cents, currency: hold.currency };
    if (hold.status === 'completed' && hold.booking_id) {
      this.reconcile();
      const row = this.data.getBooking(hold.booking_id);
      if (row) return { ...base, status: 'confirmed', booking: this.toPublicBooking(row), emailSent: row.mail_error === null };
    }
    const status = hold.status === 'paid' ? 'processing' : hold.status === 'expired' ? 'expired' : 'pending';
    return { ...base, status, booking: this.holdToPublic(hold), emailSent: false };
  }

  /** Suivi d'un paiement, pour la page de retour : vérifie auprès de Stripe s'il est encore en cours. */
  async paymentStatus(ref: string): Promise<PublicPaymentStatus> {
    const hold = this.holdByRef(ref);
    if (hold.status === 'pending' || hold.status === 'paid') await this.settle(hold.id);
    return this.paymentView(hold.id);
  }

  /** Le client a quitté la page de paiement sans payer : elle est fermée et le créneau libéré. */
  async abandonPayment(ref: string): Promise<PublicPaymentStatus> {
    const hold = this.holdByRef(ref);
    if (hold.status === 'pending' && hold.checkout_id) {
      const client = this.payments?.client();
      if (client) {
        try {
          const session = await client.expireCheckout(hold.checkout_id);
          if (session.status === 'expired') this.data.updateHold(hold.id, { status: 'expired', cancel_token: null });
        } catch {
          // Déjà payée, ou Stripe injoignable : la vérification ci-dessous tranche.
        }
      }
    }
    return this.paymentStatus(ref);
  }

  /** Suivi régulier des paiements en cours (le client a pu fermer la page de paiement sans revenir). */
  async sweepPayments(): Promise<void> {
    for (const hold of this.data.activeHolds()) await this.settle(hold.id);
  }

  /** Nombre de paiements commencés, pas encore aboutis. */
  pendingPayments(): number {
    return this.data.activeHolds().length;
  }

  /** Rembourse l'acompte d'une réservation. Ne lève pas : le résultat est noté sur la réservation. */
  private async refundRow(row: BookingRow): Promise<boolean> {
    if (row.payment_status !== 'paid' && row.payment_status !== 'refund_failed') return row.payment_status === 'refunded';
    const client = this.payments?.client();
    if (!client || !row.payment_intent) {
      this.data.setPaymentStatus(row.id, 'refund_failed', 'Paiement en ligne non configuré : rembourse depuis le tableau de bord Stripe.');
      return false;
    }
    try {
      // Clé d'idempotence propre à chaque essai : un refus passager n'est pas rejoué tel quel. Un
      // paiement déjà remboursé est refusé par Stripe (charge_already_refunded) : jamais deux remboursements.
      await client.refund(row.payment_intent, `alfred-refund-${row.id}-${randomUUID()}`);
    } catch (err) {
      if (err instanceof StripeError && err.code === 'charge_already_refunded') {
        this.data.setPaymentStatus(row.id, 'refunded', null);
        return true;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[alfred] remboursement de la réservation ${row.id} en échec : ${detail}`);
      this.data.setPaymentStatus(row.id, 'refund_failed', `Remboursement en échec : ${detail}`.slice(0, 300));
      return false;
    }
    this.data.setPaymentStatus(row.id, 'refunded', null);
    return true;
  }

  /** Remboursement demandé depuis l'admin (réservation annulée sans remboursement, ou remboursement en échec). */
  async refundBooking(id: string): Promise<Booking> {
    const row = this.requireBooking(id);
    if (!row.payment_amount_cents) throw new BookingError(409, 'no_payment', 'Cette réservation n’a pas d’acompte payé en ligne.');
    if (row.payment_status === 'refunded') throw new BookingError(409, 'already_refunded', 'L’acompte est déjà remboursé.');
    const ok = await this.refundRow(row);
    if (!ok) throw new BookingError(502, 'refund_failed', this.data.getBooking(id)?.payment_error ?? 'Le remboursement a échoué.');
    return this.toBooking(this.requireBooking(id));
  }

  private mailData(b: BookingRow): BookingMailData {
    return {
      id: b.id, typeName: b.type_name, location: b.location, start: b.start_utc, end: b.end_utc,
      name: b.name, email: b.email, phone: b.phone, message: b.message,
      videoUrl: b.status === 'confirmed' ? (this.video?.urlForBooking(b.id) ?? null) : null,
      deposit: b.payment_amount_cents ? formatAmount(b.payment_amount_cents, b.payment_currency ?? CURRENCY) : undefined,
      depositStatus: b.payment_amount_cents ? (b.payment_status ?? 'paid') : undefined,
    };
  }

  /** État et horaire actuels d'une réservation, pour la salle de visio qui lui est liée. */
  videoLink(id: string): { status: 'confirmed' | 'cancelled'; start: string; end: string } | null {
    // L'horaire suit l'événement déplacé dans l'agenda : rapprochement avant lecture (immédiat si rien n'a changé).
    this.reconcile();
    const b = id ? this.data.getBooking(id) : undefined;
    return b ? { status: b.status, start: b.start_utc, end: b.end_utc } : null;
  }

  private mailsSentLast24h(): number {
    const since = this.now().getTime() - DAY_MS;
    this.mailTimes = this.mailTimes.filter((t) => t > since);
    return this.mailTimes.length;
  }

  /**
   * Envoie des e-mails liés à une réservation et attend la fin de tous les envois. Un échec ne
   * remet jamais en cause la réservation : il est journalisé et noté sur la réservation (visible
   * dans l'admin). Ne rejette jamais ; renvoie, pour chaque message, s'il est parti.
   */
  private async dispatch(bookingId: string, messages: [label: string, message: MailMessage][]): Promise<boolean[]> {
    if (messages.length === 0) return [];
    if (!this.mailer.configured) {
      this.data.setMailError(bookingId, 'E-mails non configurés : aucun message envoyé');
      return messages.map(() => false);
    }
    const failures = await Promise.all(messages.map(async ([label, message]): Promise<string | null> => {
      // Plafond global : même détourné, le formulaire ne peut pas faire partir un flot d'e-mails.
      if (this.mailsSentLast24h() >= this.mailDailyLimit) return `${label} : non envoyé (plafond de ${this.mailDailyLimit} e-mails par 24 heures atteint)`;
      this.mailTimes.push(this.now().getTime());
      const sending = this.mailer.send(message).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
      const reason = await withTimeout(sending, this.mailTimeoutMs);
      if (reason === null) return null;
      return `${label} : envoi en échec (${reason === TIMED_OUT ? 'délai dépassé' : reason})`.slice(0, 300);
    }));
    const errors = failures.filter((f): f is string => f !== null);
    for (const error of errors) console.error(`[alfred] e-mail, réservation ${bookingId} : ${error}`);
    this.data.setMailError(bookingId, errors.length > 0 ? errors.join(' ; ') : null);
    return failures.map((f) => f === null);
  }

  /**
   * Envoie des e-mails sans retenir la réponse HTTP plus de mailWaitMs : la réservation est déjà
   * enregistrée, le client doit voir son récapitulatif même si le serveur d'envoi est lent ou en
   * panne. Au-delà, l'envoi se poursuit en arrière-plan et son résultat est noté sur la réservation.
   */
  private async sendMails(bookingId: string, messages: [label: string, message: MailMessage][], sending = this.dispatch(bookingId, messages)): Promise<boolean[]> {
    const done = await withTimeout(sending, this.mailWaitMs);
    if (done !== TIMED_OUT) return done;
    this.data.setMailError(bookingId, 'Envoi des e-mails en cours : le serveur d’envoi répond lentement');
    return messages.map(() => false);
  }

  private byToken(token: string): BookingRow {
    this.reconcile();
    const row = TOKEN_RE.test(token) ? this.data.getBookingByTokenHash(hashToken(token)) : undefined;
    // Même réponse pour un jeton inconnu et pour un rendez-vous déjà annulé.
    if (!row || row.status !== 'confirmed') {
      throw new BookingError(404, 'not_found', 'Ce lien n’est plus valable : rendez-vous introuvable ou déjà annulé.');
    }
    return row;
  }

  /** Récapitulatif pour la page d'annulation. */
  getByToken(token: string): PublicBooking {
    return this.toPublicBooking(this.byToken(token));
  }

  /** Annulation par le client, depuis le lien reçu par e-mail. emailSent : un e-mail lui confirme l'annulation. */
  async cancelByToken(token: string): Promise<PublicBooking> {
    const row = this.byToken(token);
    if (Date.parse(row.start_utc) <= this.now().getTime()) {
      throw new BookingError(409, 'too_late', 'Ce rendez-vous a déjà commencé ou est passé : il ne peut plus être annulé en ligne.');
    }
    // Annulation aussitôt après la réservation : le client a le résultat sous les yeux, et un
    // aller-retour réserver/annuler ne doit pas doubler les e-mails envoyés à une adresse non vérifiée.
    const quiet = this.now().getTime() - Date.parse(row.created_at) < this.quietCancelMs;
    // Acompte : remboursé si l'annulation respecte le délai des Réglages (décidé avant d'annuler).
    const cancelled = await this.cancel(row.id, 'client', !quiet, this.refundsOnClientCancel(row));
    if (!cancelled) throw new BookingError(404, 'not_found', 'Ce lien n’est plus valable : rendez-vous introuvable ou déjà annulé.');
    return { ...this.toPublicBooking(cancelled.row), emailSent: cancelled.clientSent };
  }

  /**
   * Annule une réservation : retire l'événement du calendrier (en tolérant qu'il ait
   * déjà disparu), marque la réservation, puis prévient par e-mail.
   * Renvoie null si elle était déjà annulée.
   */
  private async cancel(id: string, by: 'client' | 'admin', notifyClient: boolean, refund = false): Promise<{ row: BookingRow; clientSent: boolean } | null> {
    const row = await this.locked(async () => {
      this.reconcile();
      const current = this.data.getBooking(id);
      if (!current || current.status !== 'confirmed') return null;
      await this.removeEvent(current);
      this.data.markCancelled(id, by, this.now().toISOString());
      return this.data.getBooking(id)!;
    });
    if (!row) return null;
    // Rendez-vous annulé : sa salle de visio ferme (le lien ne s'ouvre plus).
    try {
      this.video?.closeForBooking(row.id);
    } catch (err) {
      console.error('[alfred] annulation : la salle de visio n’a pas pu être fermée :', err);
    }
    // Remboursement avant les e-mails : ils disent au client ce qu'il en est.
    if (refund && row.payment_status === 'paid') await this.refundRow(row);
    const ctx = this.mailContext();
    const data = this.mailData(this.data.getBooking(id)!);
    const messages: [string, MailMessage][] = [];
    if (notifyClient) messages.push(['Avis d’annulation au client', clientCancellation(data, ctx, by)]);
    // Antoine n'a pas besoin d'un avis pour ce qu'il vient d'annuler lui-même.
    if (by === 'client') messages.push(['Avis d’annulation', ownerCancellation(data, ctx, this.mailer.notifyTo)]);
    const sent = await this.sendMails(row.id, messages);
    return { row: this.data.getBooking(id)!, clientSent: notifyClient && sent[0] === true };
  }

  /** Retire l'événement d'une réservation, où qu'il soit : il est retrouvé par son UID s'il a changé de calendrier. */
  private async removeEvent(booking: BookingRow): Promise<void> {
    const unavailable = () => new BookingError(502, 'calendar_unavailable', 'L’annulation est momentanément impossible. Réessayez plus tard.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const eventId = this.linkedEvent(booking)?.id;
      // Déjà supprimé (par exemple dans Apple Calendar) : rien à faire.
      if (!eventId) return;
      try {
        const removing = this.calendar.remove(eventId, 'all', null);
        if ((await withTimeout(removing, this.calendarTimeoutMs)) === TIMED_OUT) {
          console.error('[alfred] annulation : le calendrier ne répond pas, demande abandonnée');
          removing.catch(() => undefined);
          throw unavailable();
        }
        return;
      } catch (err) {
        if (err instanceof BookingError) throw err;
        if (err instanceof NotFoundError) return;
        // Modifié ailleurs : la version du serveur vient d'être rechargée, on réessaie une fois.
        if (err instanceof ConflictError && attempt === 0) continue;
        if (err instanceof ForbiddenError) {
          console.warn(`[alfred] annulation : l’événement ${eventId} n’a pas pu être retiré (${err.message})`);
          return;
        }
        console.error('[alfred] annulation : suppression de l’événement en échec :', err);
        throw unavailable();
      }
    }
  }

  // --- admin : réservations ------------------------------------------------

  private toBooking(b: BookingRow): Booking {
    let eventState: Booking['eventState'] = null;
    let eventStart: string | null = null;
    let eventEnd: string | null = null;
    let notifiedStart: string | null = null;
    if (b.status === 'confirmed') {
      // « Supprimé » seulement si l'événement a disparu de tous les calendriers (recherche par UID comprise).
      if (!this.linkedEvent(b)) eventState = 'missing';
      else if (b.notified_start && b.notified_start !== b.start_utc) {
        eventState = 'moved';
        eventStart = b.start_utc;
        eventEnd = b.end_utc;
        notifiedStart = b.notified_start;
      } else eventState = 'ok';
    }
    return {
      id: b.id, typeId: b.type_id, typeName: b.type_name, location: b.location, start: b.start_utc, end: b.end_utc,
      name: b.name, email: b.email, phone: b.phone, message: b.message, status: b.status, createdAt: b.created_at,
      cancelledAt: b.cancelled_at, cancelledBy: b.cancelled_by, eventId: b.event_id, calendarId: b.calendar_id,
      eventState, eventStart, eventEnd, notifiedStart, mailError: b.mail_error,
      payment: b.payment_amount_cents ? {
        amountCents: b.payment_amount_cents, currency: b.payment_currency ?? CURRENCY, status: b.payment_status ?? 'paid',
        error: b.payment_error ?? null,
        dashboardUrl: b.payment_intent
          ? `https://dashboard.stripe.com/${this.payments?.state().mode === 'test' ? 'test/' : ''}payments/${encodeURIComponent(b.payment_intent)}`
          : null,
      } : null,
      videoUrl: b.status === 'confirmed' ? (this.video?.urlForBooking(b.id) ?? null) : null,
    };
  }

  /** upcoming : confirmées à venir, par date croissante. past : passées ou annulées, les plus récentes d'abord. */
  listBookings(scope: 'upcoming' | 'past', limit = 100, offset = 0): Booking[] {
    this.reconcile();
    const nowIso = this.now().toISOString();
    const rows = scope === 'upcoming' ? this.data.listUpcoming(nowIso, limit) : this.data.listPast(nowIso, limit, offset);
    return rows.map((r) => this.toBooking(r));
  }

  private requireBooking(id: string): BookingRow {
    const row = this.data.getBooking(id);
    if (!row) throw new BookingError(404, 'not_found', 'Réservation introuvable');
    return row;
  }

  /** Annulation par Antoine. notifyClient faux : aucun e-mail au client. */
  async cancelByAdmin(id: string, notifyClient = true, refund = true): Promise<Booking> {
    const row = this.requireBooking(id);
    if (row.status !== 'confirmed') throw new BookingError(409, 'already_cancelled', 'Cette réservation est déjà annulée');
    const cancelled = await this.cancel(id, 'admin', notifyClient, refund);
    return this.toBooking(cancelled?.row ?? this.requireBooking(id));
  }

  /**
   * Renvoie la confirmation au client (avec l'horaire actuel si l'événement a été déplacé).
   * Le jeton n'étant jamais conservé en clair, un nouveau lien d'annulation est créé ; il ne
   * remplace l'ancien qu'une fois l'e-mail réellement parti : si l'envoi échoue, le lien que
   * le client possède déjà continue de fonctionner.
   */
  async resendConfirmation(id: string): Promise<Booking> {
    this.reconcile();
    const row = this.requireBooking(id);
    if (row.status !== 'confirmed') throw new BookingError(409, 'already_cancelled', 'Cette réservation est annulée');
    if (!this.mailer.configured) throw new BookingError(400, 'mail_not_configured', 'L’envoi d’e-mails n’est pas configuré');
    const token = randomBytes(32).toString('base64url');
    const messages: [string, MailMessage][] = [
      ['Confirmation au client', clientConfirmation(this.mailData(row), this.mailContext(), cancelUrlFor(this.publicUrl, token))],
    ];
    const sending = this.dispatch(id, messages).then((sent) => {
      const current = this.data.getBooking(id);
      if (sent[0] && current?.status === 'confirmed') {
        this.data.setTokenHash(id, hashToken(token));
        // Le client connaît maintenant l'horaire que portait ce message.
        if (current.start_utc === row.start_utc) this.data.setNotifiedStart(id, null);
      }
      return sent;
    });
    await this.sendMails(id, messages, sending);
    return this.toBooking(this.requireBooking(id));
  }
}
