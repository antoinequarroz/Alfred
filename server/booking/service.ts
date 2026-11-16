import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  Booking, BookingAdminState, BookingConfirmation, BookingHoursRange, BookingMode, BookingSettings, BookingType,
  PublicBooking, PublicBookingInfo, PublicBookingType, PublicSlots,
} from '../../shared/types.js';
import { ConflictError, type CaldavSync } from '../caldav.js';
import { ForbiddenError, NotFoundError, type CalendarService } from '../service.js';
import type { Store } from '../store.js';
import {
  cancelUrlFor, clientCancellation, clientConfirmation, createDisabledMailer, ownerCancellation, ownerNotification,
  testMessage, type BookingMailData, type Mailer, type MailContext, type MailMessage,
} from './mail.js';
import { addDays, computeSlotDays, isDateString, localDateOf, startOfLocalDay, type BusyEvent, type SlotDay } from './slots.js';
import { BookingStore, type BookingRow } from './store.js';

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

export interface BookingOptions {
  store: Store;
  calendar: CalendarService;
  caldav: CaldavSync | null;
  timezone: string;
  mailer?: Mailer;
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
  /** Nombre maximal de rendez-vous à venir pour une même adresse e-mail. */
  maxUpcomingPerEmail?: number;
}

const DAY_MS = 86_400_000;
/** Étendue maximale d'une demande de créneaux, en jours. */
export const MAX_RANGE_DAYS = 62;
const MAX_WAITING = 20;
const MODES: BookingMode[] = ['cabinet', 'telephone', 'visio', 'autre'];
const MODE_LABELS: Record<BookingMode, string> = { cabinet: 'Au cabinet', telephone: 'Par téléphone', visio: 'En visio', autre: '' };
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
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
  private readonly publicUrl: string;
  private readonly defaultPublicName: string;
  private readonly now: () => Date;
  private readonly syncTimeoutMs: number;
  private readonly calendarTimeoutMs: number;
  private readonly maxUpcomingPerEmail: number;
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(opts: BookingOptions) {
    this.store = opts.store;
    this.data = new BookingStore(opts.store.db);
    this.calendar = opts.calendar;
    this.caldav = opts.caldav;
    this.timezone = opts.timezone;
    this.mailer = opts.mailer ?? createDisabledMailer();
    this.publicUrl = (opts.publicUrl ?? 'http://localhost:3200').replace(/\/+$/, '');
    this.defaultPublicName = opts.defaultPublicName ?? '';
    this.now = opts.now ?? (() => new Date());
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 4000;
    this.calendarTimeoutMs = opts.calendarTimeoutMs ?? 20_000;
    this.maxUpcomingPerEmail = opts.maxUpcomingPerEmail ?? 5;
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
    if (Object.keys(fields).length > 0) throw invalid(fields);
    this.data.saveSettings(next);
    return next;
  }

  /** Calendrier où créer les rendez-vous : celui des réglages s'il est utilisable, sinon le premier modifiable. */
  private targetCalendarId(settings = this.getSettings()): string | null {
    const usable = (id: string | null) => {
      const cal = id ? this.store.getCalendar(id) : undefined;
      return cal && !cal.read_only && (cal.source === 'local' || (this.caldav !== null && cal.url)) ? cal.id : null;
    };
    return usable(settings.calendarId) ?? this.store.listCalendars().map((c) => usable(c.id)).find((id) => id !== null) ?? null;
  }

  adminState(): BookingAdminState {
    const settings = this.getSettings();
    const effectiveCalendarId = this.targetCalendarId(settings);
    const warnings: string[] = [];
    if (!this.mailer.configured) {
      warnings.push('L’envoi d’e-mails n’est pas configuré (SMTP_USER et SMTP_PASSWORD) : les réservations fonctionnent, mais aucun e-mail ne part.');
    }
    if (!effectiveCalendarId) warnings.push('Aucun calendrier modifiable : les rendez-vous ne peuvent pas être créés.');
    else if (settings.calendarId && settings.calendarId !== effectiveCalendarId) {
      warnings.push('Le calendrier choisi pour les rendez-vous n’est plus utilisable : un autre calendrier est utilisé à la place.');
    }
    if (!this.data.listTypes().some((t) => t.active)) warnings.push('Aucun type de rendez-vous actif.');
    if (this.data.getHours().length === 0) warnings.push('Aucun horaire d’ouverture : aucun créneau n’est proposé.');
    const sync = this.caldav?.getStatus();
    if (sync?.lastError) warnings.push('La synchro iCloud est en échec : les créneaux sont calculés sur la dernière copie connue.');
    if (!settings.enabled) warnings.push('La prise de rendez-vous est fermée : la page publique n’accepte aucune réservation.');
    return {
      settings,
      effectiveCalendarId,
      timezone: this.timezone,
      publicPageUrl: `${this.publicUrl}/rdv`,
      mail: { configured: this.mailer.configured, from: this.mailer.from, notifyTo: this.mailer.notifyTo },
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
      bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeHours: 12, horizonDays: 60, active: true, sort: this.data.nextTypeSort(),
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
      if (weekday === null || startMin === null || endMin === null || endMin <= startMin) {
        throw invalid({ hours: 'Chaque plage a un jour (1 = lundi … 7 = dimanche), un début et une fin (minutes depuis minuit), la fin après le début' });
      }
      hours.push({ weekday, startMin, endMin });
    }
    hours.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
    for (let i = 1; i < hours.length; i++) {
      if (hours[i].weekday === hours[i - 1].weekday && hours[i].startMin < hours[i - 1].endMin) {
        throw invalid({ hours: 'Deux plages du même jour se chevauchent' });
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

  /** Créneaux libres d'un type entre deux jours locaux inclus. Ne lit que des horaires, jamais de détail d'événement. */
  slotDays(type: BookingType, from: string, to: string): SlotDay[] {
    const now = this.now();
    const today = localDateOf(now.getTime(), this.timezone);
    // Inutile de développer l'agenda hors de ce qui est réservable.
    const first = from < today ? today : from;
    const horizon = addDays(today, type.horizonDays);
    const last = to > horizon ? horizon : to;
    if (last < first) return [];
    const fromMs = startOfLocalDay(first, this.timezone) - DAY_MS;
    const toMs = startOfLocalDay(addDays(last, 1), this.timezone) + DAY_MS;
    const busy: BusyEvent[] = this.store.busyOccurrences(new Date(fromMs), new Date(toMs));
    // Les réservations bloquent même si l'événement n'est pas (encore) dans la copie locale.
    for (const b of this.data.confirmedBetween(new Date(fromMs).toISOString(), new Date(toMs).toISOString())) {
      busy.push({ start: b.start_utc, end: b.end_utc, bufferBeforeMin: b.buffer_before_min, bufferAfterMin: b.buffer_after_min });
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
    };
  }

  publicInfo(): PublicBookingInfo {
    const s = this.getSettings();
    if (!s.enabled) return { enabled: false, publicName: s.publicName, welcomeText: '', timezone: this.timezone, types: [] };
    return {
      enabled: true, publicName: s.publicName, welcomeText: s.welcomeText, timezone: this.timezone,
      types: this.data.listTypes().filter((t) => t.active).map((t) => this.toPublicType(t)),
    };
  }

  private requireOpen(): void {
    if (!this.getSettings().enabled) throw new BookingError(403, 'closed', 'La prise de rendez-vous n’est pas ouverte.');
  }

  private publicType(slug: unknown): BookingType {
    const type = typeof slug === 'string' && slug.length <= 64 ? this.data.getTypeBySlug(slug) : undefined;
    if (!type || !type.active) throw new BookingError(404, 'unknown_type', 'Ce type de rendez-vous n’existe pas ou n’est plus proposé.');
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
      name: b.name, status: b.status,
      cancellable: b.status === 'confirmed' && Date.parse(b.start_utc) > this.now().getTime(),
    };
  }

  private isFree(type: BookingType, startMs: number): boolean {
    const day = localDateOf(startMs, this.timezone);
    const iso = new Date(startMs).toISOString();
    return this.slotDays(type, day, day).some((d) => d.slots.includes(iso));
  }

  /** Synchro fraîche avant de confirmer, au mieux : on n'attend pas iCloud au-delà du délai. */
  private async freshSync(): Promise<void> {
    if (!this.caldav) return;
    // sync() ne rejette jamais : elle journalise ses erreurs et les expose dans son état.
    await withTimeout(this.caldav.sync(), this.syncTimeoutMs);
  }

  /** Réservation publique. Lève BookingError avec un code stable en cas de refus. */
  async book(body: unknown): Promise<BookingConfirmation> {
    if (!isObject(body)) throw invalid({ _: 'Corps de requête invalide' });
    // Champ piège : un humain ne le voit pas, un robot le remplit.
    if (body.website !== undefined && body.website !== '' && body.website !== null) {
      throw new BookingError(400, 'rejected', 'Demande refusée.');
    }
    this.requireOpen();
    const type = this.publicType(body.typeSlug);

    const fields: Record<string, string> = {};
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 80 || CONTROL_RE.test(name) || /[<>@]|:\/\/|www\./i.test(name)) {
      fields.name = 'Indiquez votre nom (2 à 80 caractères, sans adresse ni lien)';
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email.length > 254 || email.indexOf('@') > 64 || !EMAIL_RE.test(email)) fields.email = 'Adresse e-mail invalide';
    let phone = '';
    if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
      phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      if (!PHONE_RE.test(phone)) fields.phone = 'Numéro de téléphone invalide';
    } else if (type.mode === 'telephone') {
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
    if (!this.isFree(type, startMs)) throw taken();
    if (this.data.countUpcomingForEmail(email, this.now().toISOString()) >= this.maxUpcomingPerEmail) {
      throw new BookingError(409, 'too_many_bookings', 'Vous avez déjà plusieurs rendez-vous à venir. Annulez-en un ou contactez-nous directement.');
    }

    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + type.durationMin * 60_000).toISOString();
    const location = locationLabel(type.mode, type.location);
    const token = randomBytes(32).toString('base64url');

    // La synchro est commune à toutes les demandes en cours : on l'attend hors du verrou.
    await this.freshSync();
    const row = await this.locked(async (): Promise<BookingRow> => {
      // Après la synchro et sous verrou : l'agenda a pu changer, un autre client a pu passer devant.
      if (!this.getSettings().enabled) throw new BookingError(403, 'closed', 'La prise de rendez-vous n’est pas ouverte.');
      if (!this.isFree(type, startMs)) throw taken();
      const calendarId = this.targetCalendarId();
      if (!calendarId) throw new BookingError(503, 'calendar_unavailable', 'La réservation est momentanément impossible. Réessayez plus tard.');
      const description = [
        'Rendez-vous pris en ligne.',
        `Nom : ${name}`,
        `E-mail : ${email}`,
        phone ? `Téléphone : ${phone}` : '',
        message ? `Message : ${message}` : '',
      ].filter(Boolean).join('\n');
      const unavailable = () => new BookingError(502, 'calendar_unavailable', 'La réservation est momentanément impossible. Réessayez plus tard.');
      const creating = this.calendar.create({ calendarId, title: `${type.name} : ${name}`, start, end, allDay: false, location, description });
      let eventId: string | typeof TIMED_OUT;
      try {
        eventId = await withTimeout(creating, this.calendarTimeoutMs);
      } catch (err) {
        console.error('[alfred] réservation : création de l’événement en échec :', err);
        throw unavailable();
      }
      if (eventId === TIMED_OUT) {
        // Le serveur de calendrier ne répond pas : on libère le verrou. Si la création finit
        // par aboutir, l'événement est retiré pour ne pas rester sans réservation.
        console.error('[alfred] réservation : le calendrier ne répond pas, demande abandonnée');
        creating.then((late) => this.calendar.remove(late, 'all', null)).catch(() => undefined);
        throw unavailable();
      }
      const booking: BookingRow = {
        id: randomUUID(), type_id: type.id, type_name: type.name, location,
        buffer_before_min: type.bufferBeforeMin, buffer_after_min: type.bufferAfterMin,
        event_id: eventId, calendar_id: calendarId, start_utc: start, end_utc: end,
        name, email, phone, message, status: 'confirmed', token_hash: hashToken(token),
        created_at: this.now().toISOString(), cancelled_at: null, cancelled_by: null, mail_error: null,
      };
      try {
        this.data.insertBooking(booking);
      } catch (err) {
        // Pas de réservation enregistrée : on ne laisse pas d'événement orphelin.
        await this.calendar.remove(eventId, 'all', null).catch(() => undefined);
        throw err;
      }
      return booking;
    });

    const ctx = this.mailContext();
    const cancelUrl = cancelUrlFor(this.publicUrl, token);
    const data = this.mailData(row);
    const [clientSent] = await this.sendMails(row.id, [
      ['Confirmation au client', clientConfirmation(data, ctx, cancelUrl)],
      ['Avis de nouveau rendez-vous', ownerNotification(data, ctx, this.mailer.notifyTo)],
    ]);
    return { booking: this.toPublicBooking(row), cancelUrl, emailSent: clientSent };
  }

  private mailData(b: BookingRow): BookingMailData {
    return {
      id: b.id, typeName: b.type_name, location: b.location, start: b.start_utc, end: b.end_utc,
      name: b.name, email: b.email, phone: b.phone, message: b.message,
    };
  }

  /**
   * Envoie des e-mails liés à une réservation. Un échec ne remet jamais en cause la
   * réservation : il est journalisé et noté sur la réservation (visible dans l'admin).
   */
  private async sendMails(bookingId: string, messages: [label: string, message: MailMessage][]): Promise<boolean[]> {
    if (messages.length === 0) return [];
    if (!this.mailer.configured) {
      this.data.setMailError(bookingId, 'E-mails non configurés : aucun message envoyé');
      return messages.map(() => false);
    }
    const results = await Promise.allSettled(messages.map(([, m]) => this.mailer.send(m)));
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`[alfred] e-mail en échec (${messages[i][0]}, réservation ${bookingId}) : ${reason}`);
        errors.push(`${messages[i][0]} : envoi en échec (${reason})`.slice(0, 300));
      }
    });
    this.data.setMailError(bookingId, errors.length > 0 ? errors.join(' ; ') : null);
    return results.map((r) => r.status === 'fulfilled');
  }

  private byToken(token: string): BookingRow {
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

  /** Annulation par le client, depuis le lien reçu par e-mail. */
  async cancelByToken(token: string): Promise<PublicBooking> {
    const row = this.byToken(token);
    if (Date.parse(row.start_utc) <= this.now().getTime()) {
      throw new BookingError(409, 'too_late', 'Ce rendez-vous a déjà commencé ou est passé : il ne peut plus être annulé en ligne.');
    }
    const cancelled = await this.cancel(row.id, 'client', true);
    if (!cancelled) throw new BookingError(404, 'not_found', 'Ce lien n’est plus valable : rendez-vous introuvable ou déjà annulé.');
    return this.toPublicBooking(cancelled);
  }

  /**
   * Annule une réservation : retire l'événement du calendrier (en tolérant qu'il ait
   * déjà disparu), marque la réservation, puis prévient par e-mail.
   * Renvoie null si elle était déjà annulée.
   */
  private async cancel(id: string, by: 'client' | 'admin', notifyClient: boolean): Promise<BookingRow | null> {
    const row = await this.locked(async () => {
      const current = this.data.getBooking(id);
      if (!current || current.status !== 'confirmed') return null;
      if (current.event_id) await this.removeEvent(current.event_id);
      this.data.markCancelled(id, by, this.now().toISOString());
      return this.data.getBooking(id)!;
    });
    if (!row) return null;
    const ctx = this.mailContext();
    const data = this.mailData(row);
    const messages: [string, MailMessage][] = [];
    if (notifyClient) messages.push(['Avis d’annulation au client', clientCancellation(data, ctx, by)]);
    // Antoine n'a pas besoin d'un avis pour ce qu'il vient d'annuler lui-même.
    if (by === 'client') messages.push(['Avis d’annulation', ownerCancellation(data, ctx, this.mailer.notifyTo)]);
    await this.sendMails(row.id, messages);
    return this.data.getBooking(id)!;
  }

  private async removeEvent(eventId: string): Promise<void> {
    const unavailable = () => new BookingError(502, 'calendar_unavailable', 'L’annulation est momentanément impossible. Réessayez plus tard.');
    for (let attempt = 0; attempt < 2; attempt++) {
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
        // Déjà supprimé (par exemple dans Apple Calendar) : rien à faire.
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
    if (b.status === 'confirmed') {
      const times = b.event_id ? this.store.eventTimes(b.event_id) : undefined;
      if (!times) eventState = 'missing';
      else if (times.startMs !== Date.parse(b.start_utc) || times.endMs !== Date.parse(b.end_utc)) {
        eventState = 'moved';
        eventStart = new Date(times.startMs).toISOString();
        eventEnd = new Date(times.endMs).toISOString();
      } else eventState = 'ok';
    }
    return {
      id: b.id, typeId: b.type_id, typeName: b.type_name, location: b.location, start: b.start_utc, end: b.end_utc,
      name: b.name, email: b.email, phone: b.phone, message: b.message, status: b.status, createdAt: b.created_at,
      cancelledAt: b.cancelled_at, cancelledBy: b.cancelled_by, eventId: b.event_id, calendarId: b.calendar_id,
      eventState, eventStart, eventEnd, mailError: b.mail_error,
    };
  }

  /** upcoming : confirmées à venir, par date croissante. past : passées ou annulées, les plus récentes d'abord. */
  listBookings(scope: 'upcoming' | 'past', limit = 100, offset = 0): Booking[] {
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
  async cancelByAdmin(id: string, notifyClient = true): Promise<Booking> {
    const row = this.requireBooking(id);
    if (row.status !== 'confirmed') throw new BookingError(409, 'already_cancelled', 'Cette réservation est déjà annulée');
    const cancelled = await this.cancel(id, 'admin', notifyClient);
    return this.toBooking(cancelled ?? this.requireBooking(id));
  }

  /**
   * Renvoie la confirmation au client. Le jeton n'étant jamais conservé en clair,
   * un nouveau lien d'annulation est créé : l'ancien cesse de fonctionner.
   */
  async resendConfirmation(id: string): Promise<Booking> {
    const row = this.requireBooking(id);
    if (row.status !== 'confirmed') throw new BookingError(409, 'already_cancelled', 'Cette réservation est annulée');
    if (!this.mailer.configured) throw new BookingError(400, 'mail_not_configured', 'L’envoi d’e-mails n’est pas configuré');
    const token = randomBytes(32).toString('base64url');
    this.data.setTokenHash(id, hashToken(token));
    await this.sendMails(id, [['Confirmation au client', clientConfirmation(this.mailData(row), this.mailContext(), cancelUrlFor(this.publicUrl, token))]]);
    return this.toBooking(this.requireBooking(id));
  }

  /** Envoie un message d'essai à l'adresse d'avis, pour vérifier la configuration SMTP. */
  async sendTestMail(): Promise<{ ok: true; to: string }> {
    if (!this.mailer.configured) throw new BookingError(400, 'mail_not_configured', 'L’envoi d’e-mails n’est pas configuré');
    try {
      await this.mailer.send(testMessage(this.mailContext(), this.mailer.notifyTo));
    } catch (err) {
      throw new BookingError(502, 'mail_failed', `L’envoi a échoué : ${(err as Error).message}`.slice(0, 300));
    }
    return { ok: true, to: this.mailer.notifyTo };
  }
}
