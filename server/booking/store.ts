import type { BookingHoursRange, BookingMode, BookingSettings, BookingStatus, BookingStep, BookingType } from '../../shared/types.js';
import { tx, type Db } from '../db.js';

export interface BookingRow {
  id: string;
  type_id: string | null;
  type_name: string;
  location: string;
  buffer_before_min: number;
  buffer_after_min: number;
  event_id: string | null;
  calendar_id: string | null;
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
           buffer_after_min, min_notice_hours, horizon_days, active, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, duration_min = excluded.duration_min,
           description = excluded.description, mode = excluded.mode, location = excluded.location,
           buffer_before_min = excluded.buffer_before_min, buffer_after_min = excluded.buffer_after_min,
           min_notice_hours = excluded.min_notice_hours, horizon_days = excluded.horizon_days,
           active = excluded.active, sort = excluded.sort`,
      )
      .run(t.id, t.slug, t.name, t.durationMin, t.description, t.mode, t.location, t.bufferBeforeMin, t.bufferAfterMin,
        t.minNoticeHours, t.horizonDays, t.active ? 1 : 0, t.sort);
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
        `INSERT INTO bookings (id, type_id, type_name, location, buffer_before_min, buffer_after_min, event_id, calendar_id,
           start_utc, end_utc, name, email, phone, message, status, token_hash, created_at, cancelled_at, cancelled_by, mail_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.type_id, b.type_name, b.location, b.buffer_before_min, b.buffer_after_min, b.event_id, b.calendar_id,
        b.start_utc, b.end_utc, b.name, b.email, b.phone, b.message, b.status, b.token_hash, b.created_at, b.cancelled_at,
        b.cancelled_by, b.mail_error);
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

  /** Nombre de rendez-vous confirmés à venir pour une adresse e-mail. */
  countUpcomingForEmail(email: string, nowIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND end_utc > ? AND email = ? COLLATE NOCASE")
      .get(nowIso, email) as { n: number };
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

  setTokenHash(id: string, hash: string): void {
    this.db.prepare('UPDATE bookings SET token_hash = ? WHERE id = ?').run(hash, id);
  }
}
