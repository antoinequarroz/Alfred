import type { BookingHoursRange, BookingMode, BookingSettings, BookingStatus, BookingStep, BookingType, PaymentStatus } from '../../shared/types.js';
import { tx, type Db } from '../db.js';

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

  // --- réglages ------------------------------------------------------------

  getSettings(defaults: { publicName: string }): BookingSettings {
    const rows = this.db.prepare('SELECT key, value FROM booking_settings').all() as unknown as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const step = Number(map.get('slot_step_min'));
    return {
      enabled: map.get('enabled') === '1',
      publicName: map.get('public_name') ?? defaults.publicName,
      welcomeText: map.get('welcome_text') ?? '',
      calendarId: map.get('calendar_id') || null,
      slotStepMin: step === 15 || step === 60 ? step : (30 as BookingStep),
      allDayBlocks: map.get('all_day_blocks') !== '0',
    };
  }

  saveSettings(s: BookingSettings): void {
    const set = this.db.prepare('INSERT INTO booking_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    tx(this.db, () => {
      set.run('enabled', s.enabled ? '1' : '0');
      set.run('public_name', s.publicName);
      set.run('welcome_text', s.welcomeText);
      set.run('calendar_id', s.calendarId ?? '');
      set.run('slot_step_min', String(s.slotStepMin));
      set.run('all_day_blocks', s.allDayBlocks ? '1' : '0');
    });
  }

  // --- types ---------------------------------------------------------------

  listTypes(): BookingType[] {
    return (this.db.prepare('SELECT * FROM booking_types ORDER BY sort, name').all() as unknown as TypeRow[]).map(toType);
  }

  getType(id: string): BookingType | undefined {
    const row = this.db.prepare('SELECT * FROM booking_types WHERE id = ?').get(id) as unknown as TypeRow | undefined;
    return row && toType(row);
  }

  getTypeBySlug(slug: string): BookingType | undefined {
    const row = this.db.prepare('SELECT * FROM booking_types WHERE slug = ?').get(slug) as unknown as TypeRow | undefined;
    return row && toType(row);
  }

  nextTypeSort(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM booking_types').get() as { n: number };
    return row.n;
  }

  saveType(t: BookingType): void {
    this.db
      .prepare(
        `INSERT INTO booking_types (id, slug, name, duration_min, description, mode, location, buffer_before_min,
           buffer_after_min, min_notice_hours, horizon_days, deposit_cents, active, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, duration_min = excluded.duration_min,
           description = excluded.description, mode = excluded.mode, location = excluded.location,
           buffer_before_min = excluded.buffer_before_min, buffer_after_min = excluded.buffer_after_min,
           min_notice_hours = excluded.min_notice_hours, horizon_days = excluded.horizon_days,
           deposit_cents = excluded.deposit_cents, active = excluded.active, sort = excluded.sort`,
      )
      .run(t.id, t.slug, t.name, t.durationMin, t.description, t.mode, t.location, t.bufferBeforeMin, t.bufferAfterMin,
        t.minNoticeHours, t.horizonDays, t.depositCents, t.active ? 1 : 0, t.sort);
  }

  deleteType(id: string): void {
    this.db.prepare('DELETE FROM booking_types WHERE id = ?').run(id);
  }

  setTypeOrder(ids: string[]): void {
    const set = this.db.prepare('UPDATE booking_types SET sort = ? WHERE id = ?');
    tx(this.db, () => ids.forEach((id, index) => set.run(index, id)));
  }

  // --- horaires ------------------------------------------------------------

  getHours(): BookingHoursRange[] {
    const rows = this.db.prepare('SELECT weekday, start_min, end_min FROM booking_hours ORDER BY weekday, start_min').all() as unknown as
      { weekday: number; start_min: number; end_min: number }[];
    return rows.map((r) => ({ weekday: r.weekday, startMin: r.start_min, endMin: r.end_min }));
  }

  setHours(hours: BookingHoursRange[]): void {
    const insert = this.db.prepare('INSERT INTO booking_hours (weekday, start_min, end_min) VALUES (?, ?, ?)');
    tx(this.db, () => {
      this.db.exec('DELETE FROM booking_hours');
      for (const h of hours) insert.run(h.weekday, h.startMin, h.endMin);
    });
  }

  // --- réservations --------------------------------------------------------

  insertBooking(b: BookingRow): void {
    this.db
      .prepare(
        `INSERT INTO bookings (id, type_id, type_name, location, buffer_before_min, buffer_after_min, event_id, event_uid, calendar_id,
           start_utc, end_utc, name, email, phone, message, status, token_hash, created_at, cancelled_at, cancelled_by, mail_error,
           notified_start, payment_amount_cents, payment_currency, payment_intent, payment_status, payment_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.type_id, b.type_name, b.location, b.buffer_before_min, b.buffer_after_min, b.event_id, b.event_uid, b.calendar_id,
        b.start_utc, b.end_utc, b.name, b.email, b.phone, b.message, b.status, b.token_hash, b.created_at, b.cancelled_at,
        b.cancelled_by, b.mail_error, b.notified_start, b.payment_amount_cents ?? null, b.payment_currency ?? null,
        b.payment_intent ?? null, b.payment_status ?? null, b.payment_error ?? null);
  }

  getBooking(id: string): BookingRow | undefined {
    return this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as unknown as BookingRow | undefined;
  }

  getBookingByTokenHash(hash: string): BookingRow | undefined {
    return this.db.prepare('SELECT * FROM bookings WHERE token_hash = ?').get(hash) as unknown as BookingRow | undefined;
  }

  /** Réservations confirmées qui recoupent [from, to) (instants ISO UTC). */
  confirmedBetween(fromIso: string, toIso: string): BookingRow[] {
    return this.db
      .prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND start_utc < ? AND end_utc > ? ORDER BY start_utc")
      .all(toIso, fromIso) as unknown as BookingRow[];
  }

  /** Réservations confirmées qui se terminent après un instant donné (ISO UTC). */
  confirmedEndingAfter(iso: string): BookingRow[] {
    return this.db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND end_utc > ? ORDER BY start_utc").all(iso) as unknown as BookingRow[];
  }

  /**
   * Nombre de réservations créées pour une adresse e-mail depuis un instant donné,
   * annulées comprises : annuler ne redonne pas le droit d'en créer.
   */
  countCreatedForEmailSince(email: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM bookings WHERE created_at > ? AND email = ? COLLATE NOCASE')
      .get(sinceIso, email) as { n: number };
    return row.n;
  }

  /** À venir : confirmées non terminées, de la plus proche à la plus lointaine. */
  listUpcoming(nowIso: string, limit: number): BookingRow[] {
    return this.db
      .prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND end_utc > ? ORDER BY start_utc LIMIT ?")
      .all(nowIso, limit) as unknown as BookingRow[];
  }

  /** Passées ou annulées, de la plus récente à la plus ancienne. */
  listPast(nowIso: string, limit: number, offset: number): BookingRow[] {
    return this.db
      .prepare("SELECT * FROM bookings WHERE status = 'cancelled' OR end_utc <= ? ORDER BY start_utc DESC LIMIT ? OFFSET ?")
      .all(nowIso, limit, offset) as unknown as BookingRow[];
  }

  markCancelled(id: string, by: 'client' | 'admin', atIso: string): void {
    this.db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(atIso, by, id);
  }

  setMailError(id: string, error: string | null): void {
    this.db.prepare('UPDATE bookings SET mail_error = ? WHERE id = ?').run(error, id);
  }

  /** Rattache la réservation à l'événement retrouvé (nouvel identifiant après un changement de calendrier). */
  setEvent(id: string, eventId: string, calendarId: string, uid: string): void {
    this.db.prepare('UPDATE bookings SET event_id = ?, calendar_id = ?, event_uid = ? WHERE id = ?').run(eventId, calendarId, uid, id);
  }

  /** L'événement a été déplacé : la réservation suit, et garde l'horaire que le client connaît. */
  reschedule(id: string, startIso: string, endIso: string, notifiedStart: string | null): void {
    this.db.prepare('UPDATE bookings SET start_utc = ?, end_utc = ?, notified_start = ? WHERE id = ?').run(startIso, endIso, notifiedStart, id);
  }

  setNotifiedStart(id: string, notifiedStart: string | null): void {
    this.db.prepare('UPDATE bookings SET notified_start = ? WHERE id = ?').run(notifiedStart, id);
  }

  setTokenHash(id: string, hash: string): void {
    this.db.prepare('UPDATE bookings SET token_hash = ? WHERE id = ?').run(hash, id);
  }

  setPaymentStatus(id: string, status: PaymentStatus, error: string | null): void {
    this.db.prepare('UPDATE bookings SET payment_status = ?, payment_error = ? WHERE id = ?').run(status, error, id);
  }

  // --- retenues pendant le paiement ------------------------------------------

  insertHold(h: HoldRow): void {
    const cols = Object.keys(h) as (keyof HoldRow)[];
    this.db
      .prepare(`INSERT INTO payment_holds (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => h[c]));
  }

  getHold(id: string): HoldRow | undefined {
    return this.db.prepare('SELECT * FROM payment_holds WHERE id = ?').get(id) as unknown as HoldRow | undefined;
  }

  getHoldByRefHash(hash: string): HoldRow | undefined {
    return this.db.prepare('SELECT * FROM payment_holds WHERE ref_hash = ?').get(hash) as unknown as HoldRow | undefined;
  }

  /** Retenues encore actives (paiement en cours, ou payé mais réservation pas encore enregistrée). */
  activeHolds(): HoldRow[] {
    return this.db.prepare("SELECT * FROM payment_holds WHERE status IN ('pending', 'paid') ORDER BY created_at").all() as unknown as HoldRow[];
  }

  /** Retenues actives qui recoupent [from, to) : elles bloquent le créneau comme une réservation. */
  activeHoldsBetween(fromIso: string, toIso: string): HoldRow[] {
    return this.db
      .prepare("SELECT * FROM payment_holds WHERE status IN ('pending', 'paid') AND start_utc < ? AND end_utc > ?")
      .all(toIso, fromIso) as unknown as HoldRow[];
  }

  /** Retenues sans réservation créées pour une adresse depuis un instant donné (plafond par adresse). */
  countHoldsForEmailSince(email: string, sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM payment_holds WHERE status <> 'completed' AND created_at > ? AND email = ? COLLATE NOCASE")
      .get(sinceIso, email) as { n: number };
    return row.n;
  }

  updateHold(id: string, patch: Partial<Omit<HoldRow, 'id'>>): void {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    if (cols.length === 0) return;
    this.db.prepare(`UPDATE payment_holds SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c] ?? null), id);
  }
}
