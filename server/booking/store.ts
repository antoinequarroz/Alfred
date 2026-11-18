import {
  CHANGE_NOTICE_CHOICES, REMINDER_HOURS_CHOICES,
  type BookingHoursRange, type BookingMode, type BookingSettings, type BookingStatus, type BookingStep, type BookingType,
  type PaymentStatus,
} from '../../shared/types.js';
import { tx, type Db } from '../db.js';
import { upsertPerson } from '../migrations.js';
import type { Param } from '../sql.js';
import { Settings } from '../settings.js';
import { recordFact } from '../outbox.js';

/** Détails d'une réservation repris dans les faits du journal (jamais l'e-mail ni le téléphone). */
function bookingFact(b: Pick<BookingRow, 'id' | 'type_name' | 'start_utc' | 'end_utc' | 'name' | 'status'> & { person_id?: string | null }): Record<string, unknown> {
  return { bookingId: b.id, typeName: b.type_name, start: b.start_utc, end: b.end_utc, name: b.name, personId: b.person_id ?? null, status: b.status };
}

export interface BookingRow {
  id: string;
  type_id: string | null;
  type_name: string;
  location: string;
  buffer_before_min: number;
  buffer_after_min: number;
  event_id: string | null;
  /** UID iCalendar de l'événement : il survit à un changement de calendrier. */
  event_uid: string | null;
  calendar_id: string | null;
  /** Horaire actuel : il suit l'événement quand il est déplacé dans l'agenda. */
  start_utc: string;
  end_utc: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  status: BookingStatus;
  token_hash: string;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by: 'client' | 'admin' | null;
  mail_error: string | null;
  /** Début annoncé au client s'il diffère de start_utc (événement déplacé depuis), sinon null. */
  notified_start: string | null;
  /** Acompte payé en ligne (centimes), null sans acompte. */
  payment_amount_cents?: number | null;
  payment_currency?: string | null;
  payment_intent?: string | null;
  payment_status?: PaymentStatus | null;
  payment_error?: string | null;
  /** Rappels partis pour l'horaire actuel, en heures, séparés par des virgules (« 24,1 »). Absent avant la migration. */
  reminders_sent?: string;
  /** Instant à partir duquel le client connaît l'horaire actuel ; null : created_at. */
  reminder_ref?: string | null;
  /** Déplacements faits par le client lui-même. */
  client_reschedules?: number;
  /** Fiche de la personne dans l'annuaire (people). Absent avant la migration 2. */
  person_id?: string | null;
}

/** Heures de rappel lues dans la colonne reminders_sent. */
export function parseReminderHours(value: string | undefined | null): number[] {
  return (value ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export type HoldStatus = 'pending' | 'paid' | 'completed' | 'expired';

/** Retenue d'un créneau pendant le paiement de l'acompte (voir server/db.ts, payment_holds). */
export interface HoldRow {
  id: string;
  ref_hash: string;
  status: HoldStatus;
  type_id: string | null;
  type_name: string;
  mode: string;
  location: string;
  buffer_before_min: number;
  buffer_after_min: number;
  start_utc: string;
  end_utc: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  token_hash: string;
  cancel_token: string | null;
  amount_cents: number;
  currency: string;
  checkout_id: string | null;
  payment_intent: string | null;
  booking_id: string | null;
  created_at: string;
  expires_at: string;
  last_error: string | null;
}

interface TypeRow {
  id: string;
  slug: string;
  name: string;
  duration_min: number;
  description: string;
  mode: string;
  location: string;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_hours: number;
  horizon_days: number;
  deposit_cents: number | null;
  active: number;
  sort: number;
}

function parseKeywords(json: string): string[] {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

const MODES: BookingMode[] = ['cabinet', 'telephone', 'visio', 'autre'];

function toType(r: TypeRow): BookingType {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    durationMin: r.duration_min,
    description: r.description,
    mode: MODES.includes(r.mode as BookingMode) ? (r.mode as BookingMode) : 'autre',
    location: r.location,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    minNoticeHours: r.min_notice_hours,
    horizonDays: r.horizon_days,
    depositCents: r.deposit_cents ?? 0,
    active: r.active === 1,
    sort: r.sort,
  };
}

/** Accès SQLite de la prise de rendez-vous (réglages, types, horaires, réservations). */
export class BookingStore {
  constructor(private readonly db: Db) {}

  private get space(): string {
    return this.db.spaceId;
  }

  // --- réglages ------------------------------------------------------------

  getSettings(defaults: { publicName: string }): BookingSettings {
    const map = new Settings(this.db, 'booking').all();
    const step = Number(map.get('slot_step_min'));
    const reminders = map.has('reminder_hours') ? parseReminderHours(map.get('reminder_hours')) : [24, 1];
    const notice = Number(map.get('change_notice_hours') ?? 0);
    return {
      enabled: map.get('enabled') === '1',
      publicName: map.get('public_name') ?? defaults.publicName,
      welcomeText: map.get('welcome_text') ?? '',
      calendarId: map.get('calendar_id') || null,
      slotStepMin: step === 15 || step === 60 ? step : (30 as BookingStep),
      allDayBlocks: map.get('all_day_blocks') !== '0',
      allDayIgnore: map.has('all_day_ignore') ? parseKeywords(map.get('all_day_ignore')!) : ['anniversaire'],
      reminderHours: (REMINDER_HOURS_CHOICES as readonly number[]).filter((h) => reminders.includes(h)),
      allowReschedule: map.get('allow_reschedule') !== '0',
      changeNoticeHours: (CHANGE_NOTICE_CHOICES as readonly number[]).includes(notice) ? notice : 0,
    };
  }

  saveSettings(s: BookingSettings): void {
    const settings = new Settings(this.db, 'booking');
    const set = { run: (key: string, value: string) => settings.set(key, value) };
    tx(this.db, () => {
      set.run('enabled', s.enabled ? '1' : '0');
      set.run('public_name', s.publicName);
      set.run('welcome_text', s.welcomeText);
      set.run('calendar_id', s.calendarId ?? '');
      set.run('slot_step_min', String(s.slotStepMin));
      set.run('all_day_blocks', s.allDayBlocks ? '1' : '0');
      set.run('all_day_ignore', JSON.stringify(s.allDayIgnore));
      set.run('reminder_hours', s.reminderHours.join(','));
      set.run('allow_reschedule', s.allowReschedule ? '1' : '0');
      set.run('change_notice_hours', String(s.changeNoticeHours));
    });
  }

  // --- types ---------------------------------------------------------------

  listTypes(): BookingType[] {
    return this.db.all<TypeRow>('SELECT * FROM booking_types WHERE space_id = ? ORDER BY sort, name', this.space).map(toType);
  }

  getType(id: string): BookingType | undefined {
    const row = this.db.get<TypeRow>('SELECT * FROM booking_types WHERE id = ? AND space_id = ?', id, this.space);
    return row && toType(row);
  }

  getTypeBySlug(slug: string): BookingType | undefined {
    const row = this.db.get<TypeRow>('SELECT * FROM booking_types WHERE slug = ? AND space_id = ?', slug, this.space);
    return row && toType(row);
  }

  nextTypeSort(): number {
    const row = this.db.get<{ n: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM booking_types WHERE space_id = ?', this.space)!;
    return row.n;
  }

  saveType(t: BookingType): void {
    this.db.run(
      `INSERT INTO booking_types (id, slug, name, duration_min, description, mode, location, buffer_before_min,
         buffer_after_min, min_notice_hours, horizon_days, deposit_cents, active, sort, space_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, duration_min = excluded.duration_min,
         description = excluded.description, mode = excluded.mode, location = excluded.location,
         buffer_before_min = excluded.buffer_before_min, buffer_after_min = excluded.buffer_after_min,
         min_notice_hours = excluded.min_notice_hours, horizon_days = excluded.horizon_days,
         deposit_cents = excluded.deposit_cents, active = excluded.active, sort = excluded.sort
       WHERE booking_types.space_id = excluded.space_id`,
      t.id, t.slug, t.name, t.durationMin, t.description, t.mode, t.location, t.bufferBeforeMin, t.bufferAfterMin,
      t.minNoticeHours, t.horizonDays, t.depositCents, t.active ? 1 : 0, t.sort, this.space);
  }

  deleteType(id: string): void {
    this.db.run('DELETE FROM booking_types WHERE id = ? AND space_id = ?', id, this.space);
  }

  setTypeOrder(ids: string[]): void {
    tx(this.db, () => ids.forEach((id, index) => this.db.run('UPDATE booking_types SET sort = ? WHERE id = ? AND space_id = ?', index, id, this.space)));
  }

  // --- horaires ------------------------------------------------------------

  getHours(): BookingHoursRange[] {
    const rows = this.db.all<{ weekday: number; start_min: number; end_min: number }>(
      'SELECT weekday, start_min, end_min FROM booking_hours WHERE space_id = ? ORDER BY weekday, start_min', this.space);
    return rows.map((r) => ({ weekday: r.weekday, startMin: r.start_min, endMin: r.end_min }));
  }

  /** Remplace les horaires ; tzid : fuseau IANA dans lequel les minutes sont comptées. */
  setHours(hours: BookingHoursRange[], tzid: string): void {
    tx(this.db, () => {
      this.db.run('DELETE FROM booking_hours WHERE space_id = ?', this.space);
      for (const h of hours) {
        this.db.run('INSERT INTO booking_hours (weekday, start_min, end_min, tzid, space_id) VALUES (?, ?, ?, ?, ?)', h.weekday, h.startMin, h.endMin, tzid, this.space);
      }
    });
  }

  /** Fuseau des horaires d'ouverture (null : aucun horaire). Une seule valeur : setHours les écrit ensemble. */
  hoursTimezone(): string | null {
    return this.db.get<{ tzid: string }>('SELECT tzid FROM booking_hours WHERE space_id = ? ORDER BY weekday, start_min LIMIT 1', this.space)?.tzid ?? null;
  }

  // --- réservations --------------------------------------------------------

  /** Enregistre la réservation et la rattache à la fiche de la personne (créée au besoin, reconnue par son e-mail). */
  insertBooking(b: BookingRow): void {
    tx(this.db, () => {
      const personId = upsertPerson(this.db, { spaceId: this.space, email: b.email, name: b.name, phone: b.phone, at: b.created_at });
      b.person_id = personId;
      this.db.run(
        `INSERT INTO bookings (id, type_id, type_name, location, buffer_before_min, buffer_after_min, event_id, event_uid, calendar_id,
           start_utc, end_utc, name, email, phone, message, status, token_hash, created_at, cancelled_at, cancelled_by, mail_error,
           notified_start, person_id, payment_amount_cents, payment_currency, payment_intent, payment_status, payment_error, space_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        b.id, b.type_id, b.type_name, b.location, b.buffer_before_min, b.buffer_after_min, b.event_id, b.event_uid, b.calendar_id,
          b.start_utc, b.end_utc, b.name, b.email, b.phone, b.message, b.status, b.token_hash, b.created_at, b.cancelled_at,
          b.cancelled_by, b.mail_error, b.notified_start, personId, b.payment_amount_cents ?? null, b.payment_currency ?? null,
          b.payment_intent ?? null, b.payment_status ?? null, b.payment_error ?? null, this.space);
      recordFact(this.db, 'booking.created', b.id, { ...bookingFact(b), deposit: b.payment_amount_cents ? { amountCents: b.payment_amount_cents, currency: b.payment_currency } : null }, b.created_at);
    });
  }

  /** Réservations d'une personne (toutes, annulées comprises), les plus récentes d'abord. */
  listForPerson(personId: string): BookingRow[] {
    return this.db.all<BookingRow>('SELECT * FROM bookings WHERE person_id = ? AND space_id = ? ORDER BY start_utc DESC, id', personId, this.space);
  }

  getBooking(id: string): BookingRow | undefined {
    return this.db.get<BookingRow>('SELECT * FROM bookings WHERE id = ? AND space_id = ?', id, this.space);
  }

  /** Réservation d'un jeton : celui de la confirmation, ou l'un de ceux des e-mails suivants (rappels, déplacement). */
  getBookingByTokenHash(hash: string): BookingRow | undefined {
    const row = this.db.get<BookingRow>('SELECT * FROM bookings WHERE token_hash = ? AND space_id = ?', hash, this.space);
    if (row) return row;
    return this.db.get<BookingRow>(
      'SELECT b.* FROM booking_tokens t JOIN bookings b ON b.id = t.booking_id AND b.space_id = t.space_id WHERE t.token_hash = ? AND t.space_id = ?',
      hash, this.space);
  }

  /** Ajoute un lien vers la réservation, sans retirer les précédents. */
  addToken(bookingId: string, hash: string, atIso: string): void {
    this.db.run('INSERT INTO booking_tokens (token_hash, booking_id, created_at, space_id) VALUES (?, ?, ?, ?)', hash, bookingId, atIso, this.space);
  }

  /** Réservations confirmées dont le début tombe dans ]from, to] (instants ISO UTC), les plus proches d'abord. */
  confirmedStartingBetween(fromIso: string, toIso: string): BookingRow[] {
    return this.db.all<BookingRow>(
      "SELECT * FROM bookings WHERE space_id = ? AND status = 'confirmed' AND start_utc > ? AND start_utc <= ? ORDER BY start_utc, id",
      this.space, fromIso, toIso);
  }

  setRemindersSent(id: string, hours: number[]): void {
    this.db.run('UPDATE bookings SET reminders_sent = ? WHERE id = ? AND space_id = ?', hours.join(','), id, this.space);
  }

  /** Le client connaît un nouvel horaire depuis atIso : les rappels repartent de zéro pour cet horaire. */
  resetReminders(id: string, atIso: string): void {
    this.db.run("UPDATE bookings SET reminders_sent = '', reminder_ref = ? WHERE id = ? AND space_id = ?", atIso, id, this.space);
  }

  /** Déplacement par le client : nouvel horaire, connu de lui, et compteur augmenté. */
  rescheduleByClient(id: string, startIso: string, endIso: string, atIso: string): void {
    tx(this.db, () => {
      const before = this.getBooking(id);
      this.db.run(
        `UPDATE bookings SET start_utc = ?, end_utc = ?, notified_start = NULL, reminders_sent = '', reminder_ref = ?,
           client_reschedules = client_reschedules + 1 WHERE id = ? AND space_id = ?`,
        startIso, endIso, atIso, id, this.space);
      const b = this.getBooking(id);
      if (b) recordFact(this.db, 'booking.rescheduled', id, { ...bookingFact(b), by: 'client', previousStart: before?.start_utc ?? null }, atIso);
    });
  }

  /** Réservations confirmées qui recoupent [from, to) (instants ISO UTC). */
  confirmedBetween(fromIso: string, toIso: string): BookingRow[] {
    return this.db.all<BookingRow>(
      "SELECT * FROM bookings WHERE space_id = ? AND status = 'confirmed' AND start_utc < ? AND end_utc > ? ORDER BY start_utc, id",
      this.space, toIso, fromIso);
  }

  /** Réservations confirmées qui se terminent après un instant donné (ISO UTC). */
  confirmedEndingAfter(iso: string): BookingRow[] {
    return this.db.all<BookingRow>("SELECT * FROM bookings WHERE space_id = ? AND status = 'confirmed' AND end_utc > ? ORDER BY start_utc, id", this.space, iso);
  }

  /**
   * Nombre de réservations créées pour une adresse e-mail depuis un instant donné,
   * annulées comprises : annuler ne redonne pas le droit d'en créer.
   */
  countCreatedForEmailSince(email: string, sinceIso: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM bookings WHERE space_id = ? AND created_at > ? AND lower(email) = lower(?)', this.space, sinceIso, email)!;
    return row.n;
  }

  /** À venir : confirmées non terminées, de la plus proche à la plus lointaine. */
  listUpcoming(nowIso: string, limit: number): BookingRow[] {
    return this.db.all<BookingRow>(
      "SELECT * FROM bookings WHERE space_id = ? AND status = 'confirmed' AND end_utc > ? ORDER BY start_utc, id LIMIT ?", this.space, nowIso, limit);
  }

  /** Réservations (annulées comprises) qui chevauchent une période, par date croissante. */
  listBetween(fromIso: string, toIso: string, limit: number): BookingRow[] {
    return this.db.all<BookingRow>(
      'SELECT * FROM bookings WHERE space_id = ? AND start_utc < ? AND end_utc > ? ORDER BY start_utc, id LIMIT ?', this.space, toIso, fromIso, limit);
  }

  /** Passées ou annulées, de la plus récente à la plus ancienne. */
  listPast(nowIso: string, limit: number, offset: number): BookingRow[] {
    return this.db.all<BookingRow>(
      "SELECT * FROM bookings WHERE space_id = ? AND (status = 'cancelled' OR end_utc <= ?) ORDER BY start_utc DESC, id LIMIT ? OFFSET ?",
      this.space, nowIso, limit, offset);
  }

  markCancelled(id: string, by: 'client' | 'admin', atIso: string): void {
    tx(this.db, () => {
      const r = this.db.run("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND space_id = ? AND status <> 'cancelled'", atIso, by, id, this.space);
      const b = r.changes > 0 ? this.getBooking(id) : undefined;
      if (b) recordFact(this.db, 'booking.cancelled', id, { ...bookingFact(b), by }, atIso);
    });
  }

  setMailError(id: string, error: string | null): void {
    this.db.run('UPDATE bookings SET mail_error = ? WHERE id = ? AND space_id = ?', error, id, this.space);
  }

  /** Rattache la réservation à l'événement retrouvé (nouvel identifiant après un changement de calendrier). */
  setEvent(id: string, eventId: string, calendarId: string, uid: string): void {
    this.db.run('UPDATE bookings SET event_id = ?, calendar_id = ?, event_uid = ? WHERE id = ? AND space_id = ?', eventId, calendarId, uid, id, this.space);
  }

  /** L'événement a été déplacé : la réservation suit, et garde l'horaire que le client connaît. */
  reschedule(id: string, startIso: string, endIso: string, notifiedStart: string | null): void {
    tx(this.db, () => {
      const before = this.getBooking(id);
      this.db.run('UPDATE bookings SET start_utc = ?, end_utc = ?, notified_start = ? WHERE id = ? AND space_id = ?', startIso, endIso, notifiedStart, id, this.space);
      const b = this.getBooking(id);
      if (b && before && (before.start_utc !== startIso || before.end_utc !== endIso)) {
        recordFact(this.db, 'booking.rescheduled', id, { ...bookingFact(b), by: 'agenda', previousStart: before.start_utc });
      }
    });
  }

  setNotifiedStart(id: string, notifiedStart: string | null): void {
    this.db.run('UPDATE bookings SET notified_start = ? WHERE id = ? AND space_id = ?', notifiedStart, id, this.space);
  }

  setTokenHash(id: string, hash: string): void {
    this.db.run('UPDATE bookings SET token_hash = ? WHERE id = ? AND space_id = ?', hash, id, this.space);
  }

  setPaymentStatus(id: string, status: PaymentStatus, error: string | null): void {
    tx(this.db, () => {
      const before = this.getBooking(id);
      this.db.run('UPDATE bookings SET payment_status = ?, payment_error = ? WHERE id = ? AND space_id = ?', status, error, id, this.space);
      if (status === 'refunded' && before && before.payment_status !== 'refunded') {
        recordFact(this.db, 'payment.refunded', id, {
          ...bookingFact(before), amountCents: before.payment_amount_cents ?? null, currency: before.payment_currency ?? null,
        });
      }
    });
  }

  // --- retenues pendant le paiement ------------------------------------------

  insertHold(h: HoldRow): void {
    const cols = (Object.keys(h) as (keyof HoldRow)[]).filter((c) => (c as string) !== 'space_id');
    this.db.run(
      `INSERT INTO payment_holds (${cols.join(', ')}, space_id) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
      ...cols.map((c) => h[c] as Param), this.space);
  }

  getHold(id: string): HoldRow | undefined {
    return this.db.get<HoldRow>('SELECT * FROM payment_holds WHERE id = ? AND space_id = ?', id, this.space);
  }

  getHoldByRefHash(hash: string): HoldRow | undefined {
    return this.db.get<HoldRow>('SELECT * FROM payment_holds WHERE ref_hash = ? AND space_id = ?', hash, this.space);
  }

  /** Retenues encore actives (paiement en cours, ou payé mais réservation pas encore enregistrée). */
  activeHolds(): HoldRow[] {
    return this.db.all<HoldRow>("SELECT * FROM payment_holds WHERE space_id = ? AND status IN ('pending', 'paid') ORDER BY created_at, id", this.space);
  }

  /** Retenues actives qui recoupent [from, to) : elles bloquent le créneau comme une réservation. */
  activeHoldsBetween(fromIso: string, toIso: string): HoldRow[] {
    return this.db.all<HoldRow>(
      "SELECT * FROM payment_holds WHERE space_id = ? AND status IN ('pending', 'paid') AND start_utc < ? AND end_utc > ? ORDER BY start_utc, id",
      this.space, toIso, fromIso);
  }

  /** Retenues sans réservation créées pour une adresse depuis un instant donné (plafond par adresse). */
  countHoldsForEmailSince(email: string, sinceIso: string): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM payment_holds WHERE space_id = ? AND status <> 'completed' AND created_at > ? AND lower(email) = lower(?)",
      this.space, sinceIso, email)!;
    return row.n;
  }

  updateHold(id: string, patch: Partial<Omit<HoldRow, 'id'>>): void {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    if (cols.length === 0) return;
    tx(this.db, () => {
      const before = patch.status === 'paid' ? this.getHold(id) : undefined;
      this.db.run(`UPDATE payment_holds SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND space_id = ?`,
        ...cols.map((c) => (patch[c] ?? null) as Param), id, this.space);
      if (before && before.status === 'pending') {
        recordFact(this.db, 'payment.received', id, {
          holdId: id, amountCents: before.amount_cents, currency: before.currency, typeName: before.type_name,
          start: before.start_utc, end: before.end_utc, name: before.name,
        });
      }
    });
  }
}
