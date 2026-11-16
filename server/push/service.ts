import { createHash, randomUUID } from 'node:crypto';
import type { PushPrefs, PushReminderMode, PushState, PushDevice, PushTestResult } from '../../shared/types.js';
import type { Db } from '../db.js';
import type { Store } from '../store.js';
import { allowedEndpoint, generateVapidKeys, sendPush, validPushKeys, type FetchLike, type PushKeys, type VapidKeys } from './webpush.js';

/**
 * Notifications d'Alfred sur les appareils d'Antoine (iPhone, Mac, navigateur) :
 * nouveau rendez-vous, annulation par un client, rappel avant un rendez-vous, invité arrivé en visio.
 *
 * Les rendez-vous ne sont pas signalés par la prise de RDV elle-même : une tâche relit régulièrement
 * la table des réservations. Une notification n'est donc jamais perdue si l'envoi échoue au moment de
 * la réservation, et la prise de RDV ne dépend pas des services de push.
 */

export class PushError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_success_at TEXT,
  last_error      TEXT,
  last_error_at   TEXT
);
-- Notifications déjà traitées (envoyées, ou volontairement tues) : une clé par événement signalé.
CREATE TABLE IF NOT EXISTS push_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
`;

export const DEFAULT_PREFS: PushPrefs = {
  newBooking: true,
  cancellation: true,
  guestArrived: true,
  reminders: 'bookings',
  reminderMinutes: 10,
  details: true,
};
export const REMINDER_MINUTES = [5, 10, 15, 30, 60] as const;
const REMINDER_MODES: PushReminderMode[] = ['off', 'bookings', 'all'];
const MAX_DEVICES = 20;
const DAY_MS = 86_400_000;
/** Un invité qui recharge sa page ne déclenche pas une notification à chaque fois. */
const GUEST_QUIET_MS = 2 * 60_000;

export interface PushPayload {
  title: string;
  body: string;
  /** Chemin ouvert au toucher de la notification (dans l'app). */
  url: string;
  /** Une notification de même étiquette remplace la précédente sur l'appareil. */
  tag: string;
}

export interface PushOptions {
  db: Db;
  store: Store;
  /** Adresse publique d'Alfred (sert de contact VAPID et à reconnaître les liens de visio). */
  publicUrl: string;
  timezone: string;
  /** Lien de la salle de visio d'une réservation, s'il y en a une. */
  bookingVideoUrl?: (bookingId: string) => string | null;
  now?: () => Date;
  fetch?: FetchLike;
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

interface BookingRow {
  id: string;
  type_name: string;
  name: string;
  start_utc: string;
  end_utc: string;
  status: string;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
}

const endpointHost = (endpoint: string) => {
  const host = new URL(endpoint).hostname;
  if (host.endsWith('push.apple.com')) return 'Apple';
  if (host === 'fcm.googleapis.com') return 'Google';
  if (host.endsWith('mozilla.com')) return 'Mozilla';
  if (host.endsWith('windows.com')) return 'Microsoft';
  return host;
};

export class PushService {
  private readonly db: Db;
  private readonly store: Store;
  private readonly publicUrl: string;
  private readonly timezone: string;
  private readonly now: () => Date;
  private readonly fetchImpl?: FetchLike;
  private readonly bookingVideoUrl: (bookingId: string) => string | null;
  private readonly vapid: VapidKeys;
  private readonly guestSeen = new Map<string, number>();
  private ticking: Promise<void> | null = null;

  constructor(opts: PushOptions) {
    this.db = opts.db;
    this.store = opts.store;
    this.publicUrl = opts.publicUrl.replace(/\/+$/, '');
    this.timezone = opts.timezone;
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch;
    this.bookingVideoUrl = opts.bookingVideoUrl ?? (() => null);
    this.db.exec(SCHEMA);
    // Paire de clés VAPID créée une fois pour toutes : la changer désabonnerait tous les appareils.
    // Elle n'est pas chiffrée : qui lit la base y trouve aussi les abonnements et leurs clés.
    const stored = this.setting<VapidKeys>('vapid');
    this.vapid = stored ?? generateVapidKeys();
    if (!stored) this.saveSetting('vapid', this.vapid);
    // Les rendez-vous antérieurs à l'activation des notifications ne sont jamais signalés.
    if (!this.setting<string>('since')) this.saveSetting('since', this.now().toISOString());
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  // --- réglages --------------------------------------------------------------

  private setting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM push_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private saveSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO push_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  getPrefs(): PushPrefs {
    const saved = this.setting<Partial<PushPrefs>>('prefs') ?? {};
    const p = { ...DEFAULT_PREFS, ...saved };
    if (!REMINDER_MODES.includes(p.reminders)) p.reminders = DEFAULT_PREFS.reminders;
    if (!(REMINDER_MINUTES as readonly number[]).includes(p.reminderMinutes)) p.reminderMinutes = DEFAULT_PREFS.reminderMinutes;
    return p;
  }

  setPrefs(body: unknown): PushPrefs {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PushError(400, 'invalid', 'Réglages invalides');
    const b = body as Record<string, unknown>;
    const next = this.getPrefs();
    for (const key of ['newBooking', 'cancellation', 'guestArrived', 'details'] as const) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== 'boolean') throw new PushError(400, 'invalid', 'Réglages invalides');
      next[key] = b[key];
    }
    if (b.reminders !== undefined) {
      if (!REMINDER_MODES.includes(b.reminders as PushReminderMode)) throw new PushError(400, 'invalid', 'Choix de rappel invalide');
      next.reminders = b.reminders as PushReminderMode;
    }
    if (b.reminderMinutes !== undefined) {
      if (!(REMINDER_MINUTES as readonly unknown[]).includes(b.reminderMinutes)) throw new PushError(400, 'invalid', 'Délai de rappel invalide');
      next.reminderMinutes = b.reminderMinutes as number;
    }
    this.saveSetting('prefs', next);
    return next;
  }

  // --- appareils -------------------------------------------------------------

  private rows(): SubRow[] {
    return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as unknown as SubRow[];
  }

  private toDevice(r: SubRow): PushDevice {
    return {
      id: r.id, label: r.label, service: endpointHost(r.endpoint), ref: createHash('sha256').update(r.endpoint).digest('hex').slice(0, 16), createdAt: r.created_at,
      lastSuccessAt: r.last_success_at, lastError: r.last_error, lastErrorAt: r.last_error_at,
    };
  }

  state(): PushState {
    return { publicKey: this.vapid.publicKey, prefs: this.getPrefs(), devices: this.rows().map((r) => this.toDevice(r)) };
  }

  /** Enregistre (ou met à jour) l'abonnement d'un appareil. replaces : ancien abonnement du même appareil, renouvelé par le navigateur. */
  subscribe(body: unknown): PushDevice {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
    const k = (b.keys && typeof b.keys === 'object' ? b.keys : {}) as Record<string, unknown>;
    const keys: PushKeys = { p256dh: typeof k.p256dh === 'string' ? k.p256dh : '', auth: typeof k.auth === 'string' ? k.auth : '' };
    if (!allowedEndpoint(endpoint)) throw new PushError(400, 'invalid', 'Ce navigateur utilise un service de notifications non reconnu.');
    if (!validPushKeys(keys)) throw new PushError(400, 'invalid', 'Abonnement aux notifications invalide');
    const rawLabel = typeof b.label === 'string' ? b.label.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    const replaces = typeof b.replaces === 'string' ? b.replaces : null;
    // Un abonnement renouvelé par le navigateur garde le nom de l'appareil.
    const previous = replaces ? (this.db.prepare('SELECT label FROM push_subscriptions WHERE endpoint = ?').get(replaces) as { label: string } | undefined) : undefined;
    const label = (rawLabel || previous?.label || 'Appareil').slice(0, 60);

    const existing = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as SubRow | undefined;
    if (existing) {
      this.db.prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ? WHERE id = ?').run(keys.p256dh, keys.auth, label, existing.id);
    } else {
      if (replaces) this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(replaces);
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n;
      if (count >= MAX_DEVICES) throw new PushError(409, 'too_many', `${MAX_DEVICES} appareils au plus : retire d’abord un appareil que tu n’utilises plus.`);
      this.db.prepare('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), endpoint, keys.p256dh, keys.auth, label, this.now().toISOString());
    }
    return this.toDevice(this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as unknown as SubRow);
  }

  remove(id: string): void {
    const r = this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
    if (r.changes === 0) throw new PushError(404, 'not_found', 'Appareil introuvable');
  }

  // --- envoi -----------------------------------------------------------------

  private async deliver(payload: PushPayload, opts: { ttl: number; urgency?: 'normal' | 'high'; only?: string }): Promise<PushTestResult[]> {
    const subject = this.publicUrl.startsWith('https://') ? this.publicUrl : 'mailto:alfred@example.invalid';
    const targets = this.rows().filter((r) => !opts.only || r.id === opts.only);
    return Promise.all(targets.map(async (r): Promise<PushTestResult> => {
      const outcome = await sendPush({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, {
        vapid: this.vapid, subject, ttl: opts.ttl, urgency: opts.urgency, fetch: this.fetchImpl,
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
      });
      const at = this.now().toISOString();
      if (outcome.ok) {
        this.db.prepare('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?').run(at, r.id);
        return { id: r.id, label: r.label, ok: true, removed: false, error: null };
      }
      if (outcome.gone) {
        // L'appareil s'est désabonné (ou l'app a été supprimée) : il est oublié.
        this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id);
      } else {
        this.db.prepare('UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?').run(outcome.error, at, r.id);
        console.warn(`[alfred] notification non envoyée à « ${r.label} » : ${outcome.error}`);
      }
      return { id: r.id, label: r.label, ok: false, removed: outcome.gone, error: outcome.error };
    }));
  }

  /** Notification d'essai, vers un appareil ou tous. */
  async test(id?: string): Promise<PushTestResult[]> {
    if (id && !this.rows().some((r) => r.id === id)) throw new PushError(404, 'not_found', 'Appareil introuvable');
    if (this.rows().length === 0) throw new PushError(409, 'no_device', 'Aucun appareil n’est abonné aux notifications.');
    return this.deliver({ title: 'Alfred', body: 'Les notifications fonctionnent sur cet appareil.', url: '/#reglages', tag: 'essai' }, { ttl: 600, only: id });
  }

  /** Marque une clé comme traitée. false si elle l'était déjà. */
  private claim(key: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO push_sent (key, sent_at) VALUES (?, ?)').run(key, this.now().toISOString());
    return r.changes > 0;
  }

  private when(iso: string, withDay = true): string {
    const d = new Date(iso);
    const time = new Intl.DateTimeFormat('fr-CH', { timeZone: this.timezone, hour: '2-digit', minute: '2-digit' }).format(d);
    if (!withDay) return time;
    const day = new Intl.DateTimeFormat('fr-CH', { timeZone: this.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
    return `${day} à ${time}`;
  }

  /** Chemin dans l'app pour un lien absolu d'Alfred (salle de visio), sinon null. */
  private localPath(url: string | null): string | null {
    if (!url || !url.startsWith(`${this.publicUrl}/`)) return null;
    return url.slice(this.publicUrl.length);
  }

  /** Un invité vient d'entrer (ou demande à entrer) dans une salle de visio. */
  async guestArrived(room: { slug: string; title: string }, guestName: string): Promise<void> {
    const prefs = this.getPrefs();
    if (!prefs.guestArrived || this.rows().length === 0) return;
    const nowMs = this.now().getTime();
    const key = `${room.slug}\u0000${guestName.toLowerCase()}`;
    if ((this.guestSeen.get(key) ?? 0) > nowMs - GUEST_QUIET_MS) return;
    this.guestSeen.set(key, nowMs);
    if (this.guestSeen.size > 500) for (const [k, t] of this.guestSeen) if (t <= nowMs - GUEST_QUIET_MS) this.guestSeen.delete(k);
    await this.deliver(prefs.details
      ? { title: `${guestName} est dans la visio`, body: `« ${room.title} » · touche pour rejoindre`, url: `/v/${room.slug}`, tag: `visio-${room.slug}` }
      : { title: 'Un invité est dans la visio', body: 'Touche pour rejoindre', url: `/v/${room.slug}`, tag: `visio-${room.slug}` },
    { ttl: 300, urgency: 'high' });
  }

  /** Une passe : nouveaux rendez-vous, annulations, rappels. Jamais deux passes en même temps. */
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const prefs = this.getPrefs();
    const now = this.now();
    const nowMs = now.getTime();
    const since = new Date(Math.max(Date.parse(this.setting<string>('since') ?? now.toISOString()), nowMs - DAY_MS)).toISOString();
    const jobs: Promise<unknown>[] = [];
    const hasTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookings'").get();

    if (hasTable) {
      const created = this.db.prepare('SELECT * FROM bookings WHERE created_at >= ? ORDER BY created_at').all(since) as unknown as BookingRow[];
      for (const b of created) {
        if (!this.claim(`new:${b.id}`)) continue;
        // Réservé puis annulé avant même d'avoir été signalé : rien à dire.
        if (b.status !== 'confirmed') {
          this.claim(`cancel:${b.id}`);
          continue;
        }
        if (!prefs.newBooking) continue;
        jobs.push(this.deliver(prefs.details
          ? { title: 'Nouveau rendez-vous', body: `${b.name} · ${b.type_name}, ${this.when(b.start_utc)}`, url: '/#rendez-vous', tag: `rdv-${b.id}` }
          : { title: 'Nouveau rendez-vous', body: `Un rendez-vous a été pris pour ${this.when(b.start_utc)}.`, url: '/#rendez-vous', tag: `rdv-${b.id}` },
        { ttl: DAY_MS / 1000 }));
      }

      const cancelled = this.db.prepare("SELECT * FROM bookings WHERE status = 'cancelled' AND cancelled_by = 'client' AND cancelled_at >= ?").all(since) as unknown as BookingRow[];
      for (const b of cancelled) {
        if (!this.claim(`cancel:${b.id}`) || !prefs.cancellation) continue;
        jobs.push(this.deliver(prefs.details
          ? { title: 'Rendez-vous annulé', body: `${b.name} a annulé : ${b.type_name}, ${this.when(b.start_utc)}`, url: '/#rendez-vous', tag: `rdv-${b.id}` }
          : { title: 'Rendez-vous annulé', body: `Le rendez-vous du ${this.when(b.start_utc)} a été annulé.`, url: '/#rendez-vous', tag: `rdv-${b.id}` },
        { ttl: DAY_MS / 1000 }));
      }
    }

    if (prefs.reminders !== 'off') {
      const windowMs = prefs.reminderMinutes * 60_000;
      // Un rappel part dès que le début est dans le délai choisi ; s'il a été manqué (Alfred redémarré),
      // il part encore dans la première minute, jamais après.
      const due = (startMs: number) => startMs > nowMs - 60_000 && startMs <= nowMs + windowMs;
      const reminder = (key: string, title: string, startIso: string, endIso: string, place: string, url: string) => {
        if (!this.claim(key)) return;
        const mins = Math.max(0, Math.round((Date.parse(startIso) - nowMs) / 60_000));
        const lead = mins <= 0 ? 'Maintenant' : `Dans ${mins} min`;
        const time = `${this.when(startIso, false)} – ${this.when(endIso, false)}`;
        jobs.push(this.deliver({
          title: prefs.details ? `${lead} : ${title}` : `${lead} : rendez-vous`,
          body: prefs.details && place ? `${time} · ${place}` : time,
          url, tag: `rappel-${key}`,
        }, { ttl: Math.max(60, Math.round((Date.parse(startIso) - nowMs) / 1000) + 300), urgency: 'high' }));
      };

      if (prefs.reminders === 'bookings' && hasTable) {
        const rows = this.db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND start_utc > ? AND start_utc <= ?")
          .all(new Date(nowMs - 60_000).toISOString(), new Date(nowMs + windowMs).toISOString()) as unknown as BookingRow[];
        for (const b of rows) {
          if (!due(Date.parse(b.start_utc))) continue;
          const video = this.localPath(this.bookingVideoUrl(b.id));
          reminder(`rappel:${b.id}:${b.start_utc}`, `${b.type_name} avec ${b.name}`, b.start_utc, b.end_utc, video ? 'En visio' : '', video ?? '/#rendez-vous');
        }
      } else if (prefs.reminders === 'all') {
        for (const o of this.store.occurrences(new Date(nowMs - 60_000), new Date(nowMs + windowMs))) {
          if (o.allDay || !due(Date.parse(o.start))) continue;
          const video = this.localPath(o.location.trim());
          reminder(`rappel:${o.eventId}:${o.start}`, o.title || 'Sans titre', o.start, o.end, video ? 'En visio' : o.location.trim().slice(0, 80), video ?? '/');
        }
      }
    }

    this.db.prepare('DELETE FROM push_sent WHERE sent_at < ?').run(new Date(nowMs - 3 * DAY_MS).toISOString());
    await Promise.all(jobs);
  }

  /** Passe régulière (toutes les 30 s par défaut). */
  start(intervalMs = 30_000): void {
    const run = () => void this.tick().catch((err) => console.error('[alfred] notifications :', err));
    run();
    setInterval(run, intervalMs).unref();
  }
}
