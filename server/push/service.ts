import { createHash } from 'node:crypto';
import { uuidv7 } from '../ids.js';
import { onFacts, OutboxReader } from '../outbox.js';
import type { PushPrefs, PushReminderMode, PushState, PushDevice, PushTestResult } from '../../shared/types.js';
import type { Db } from '../db.js';
import type { Store } from '../store.js';
import { allowedEndpoint, generateVapidKeys, sendPush, validPushKeys, type FetchLike, type PushKeys, type VapidKeys } from './webpush.js';

/**
 * Notifications d'Alfred sur les appareils d'Antoine (iPhone, Mac, navigateur) :
 * nouveau rendez-vous, annulation par un client, rappel avant un rendez-vous, invité arrivé en visio.
 *
 * Les rendez-vous et les invités ne sont pas signalés par la prise de RDV ou la visio elles-mêmes :
 * les notifications lisent le journal d'événements (server/outbox.ts), en retenant leur position.
 * Une notification n'est donc jamais perdue si l'envoi échoue au moment du fait, et la prise de RDV
 * ne dépend pas des services de push. Les rappels, eux, dépendent de l'heure : ils sont calculés à
 * chaque passe depuis l'agenda et les réservations.
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
/** Arrivée d'un invité encore signalée si elle date de moins de 5 minutes. */
const GUEST_FRESH_MS = 5 * 60_000;

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
  private again = false;
  private readonly reader: OutboxReader;

  constructor(opts: PushOptions) {
    this.db = opts.db;
    this.store = opts.store;
    this.publicUrl = opts.publicUrl.replace(/\/+$/, '');
    this.timezone = opts.timezone;
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch;
    this.bookingVideoUrl = opts.bookingVideoUrl ?? (() => null);
    // Paire de clés VAPID créée une fois pour toutes : la changer désabonnerait tous les appareils.
    // Elle n'est pas chiffrée : qui lit la base y trouve aussi les abonnements et leurs clés.
    const stored = this.setting<VapidKeys>('vapid');
    this.vapid = stored ?? generateVapidKeys();
    if (!stored) this.saveSetting('vapid', this.vapid);
    // Les rendez-vous antérieurs à l'activation des notifications ne sont jamais signalés.
    if (!this.setting<string>('since')) this.saveSetting('since', this.now().toISOString());
    this.reader = new OutboxReader(this.db, 'push');
    // Un invité qui arrive en visio est signalé tout de suite, sans attendre la passe régulière.
    onFacts(this.db, (types) => {
      if (types.some((t) => t === 'video.guest_waiting' || t === 'video.guest_joined')) {
        void this.tick().catch((err) => console.error('[alfred] notifications :', err));
      }
    });
  }

  private get space(): string {
    return this.db.spaceId;
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  // --- réglages --------------------------------------------------------------

  private setting<T>(key: string): T | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM push_settings WHERE key = ? AND space_id = ?', key, this.space);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private saveSetting(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO push_settings (key, value, space_id) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE push_settings.space_id = excluded.space_id`,
      key, JSON.stringify(value), this.space);
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
    return this.db.all<SubRow>('SELECT * FROM push_subscriptions WHERE space_id = ? ORDER BY created_at, id', this.space);
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
    const previous = replaces ? this.db.get<{ label: string }>('SELECT label FROM push_subscriptions WHERE endpoint = ? AND space_id = ?', replaces, this.space) : undefined;
    const label = (rawLabel || previous?.label || 'Appareil').slice(0, 60);

    const existing = this.db.get<SubRow>('SELECT * FROM push_subscriptions WHERE endpoint = ? AND space_id = ?', endpoint, this.space);
    if (existing) {
      this.db.run('UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ? WHERE id = ? AND space_id = ?', keys.p256dh, keys.auth, label, existing.id, this.space);
    } else {
      if (replaces) this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND space_id = ?', replaces, this.space);
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE space_id = ?', this.space)!.n;
      if (count >= MAX_DEVICES) throw new PushError(409, 'too_many', `${MAX_DEVICES} appareils au plus : retire d’abord un appareil que tu n’utilises plus.`);
      this.db.run('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at, space_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        uuidv7(this.now().getTime()), endpoint, keys.p256dh, keys.auth, label, this.now().toISOString(), this.space);
    }
    return this.toDevice(this.db.get<SubRow>('SELECT * FROM push_subscriptions WHERE endpoint = ? AND space_id = ?', endpoint, this.space)!);
  }

  remove(id: string): void {
    const r = this.db.run('DELETE FROM push_subscriptions WHERE id = ? AND space_id = ?', id, this.space);
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
        this.db.run('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ? AND space_id = ?', at, r.id, this.space);
        return { id: r.id, label: r.label, ok: true, removed: false, error: null };
      }
      if (outcome.gone) {
        // L'appareil s'est désabonné (ou l'app a été supprimée) : il est oublié.
        this.db.run('DELETE FROM push_subscriptions WHERE id = ? AND space_id = ?', r.id, this.space);
      } else {
        this.db.run('UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ? AND space_id = ?', outcome.error, at, r.id, this.space);
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
    const r = this.db.run('INSERT INTO push_sent (key, sent_at, space_id) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING', key, this.now().toISOString(), this.space);
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

  /** Un invité vient d'entrer dans une salle de visio, ou attend d'y être admis (waiting). */
  async guestArrived(room: { slug: string; title: string }, guestName: string, waiting = false): Promise<void> {
    const prefs = this.getPrefs();
    if (!prefs.guestArrived || this.rows().length === 0) return;
    const nowMs = this.now().getTime();
    const key = `${room.slug}\u0000${guestName.toLowerCase()}`;
    if ((this.guestSeen.get(key) ?? 0) > nowMs - GUEST_QUIET_MS) return;
    this.guestSeen.set(key, nowMs);
    if (this.guestSeen.size > 500) for (const [k, t] of this.guestSeen) if (t <= nowMs - GUEST_QUIET_MS) this.guestSeen.delete(k);
    await this.deliver(prefs.details
      ? { title: waiting ? `${guestName} attend d’entrer dans la visio` : `${guestName} est dans la visio`, body: `« ${room.title} » · touche pour ${waiting ? 'le faire entrer' : 'rejoindre'}`, url: `/v/${room.slug}`, tag: `visio-${room.slug}` }
      : { title: waiting ? 'Un invité attend dans la visio' : 'Un invité est dans la visio', body: waiting ? 'Touche pour le faire entrer' : 'Touche pour rejoindre', url: `/v/${room.slug}`, tag: `visio-${room.slug}` },
    { ttl: 300, urgency: 'high' });
  }

  /** Une passe : nouveaux rendez-vous, annulations, rappels. Jamais deux passes en même temps. */
  tick(): Promise<void> {
    if (this.ticking) {
      // Demandée pendant une passe : une autre suit, pour ne pas attendre la passe régulière.
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.runTick();
      } while (this.again);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private booking(id: string): BookingRow | undefined {
    return this.db.get<BookingRow>('SELECT * FROM bookings WHERE id = ? AND space_id = ?', id, this.space);
  }

  private async runTick(): Promise<void> {
    const prefs = this.getPrefs();
    const now = this.now();
    const nowMs = now.getTime();
    const since = new Date(Math.max(Date.parse(this.setting<string>('since') ?? now.toISOString()), nowMs - DAY_MS)).toISOString();
    const jobs: Promise<unknown>[] = [];
    // Nouveaux rendez-vous, annulations et invités en visio : lus dans le journal d'événements.
    const facts = this.reader.pending(500);
    for (const fact of facts) {
      if (fact.occurredAt < since) continue;
      const d = fact.data as { bookingId?: string; name?: string; typeName?: string; start?: string; by?: string; slug?: string; title?: string; guestName?: string };
      if (fact.type === 'booking.created' && d.bookingId) {
        if (!this.claim(`new:${d.bookingId}`)) continue;
        // Horaire et statut actuels : la réservation a pu être déplacée ou annulée depuis.
        const b = this.booking(d.bookingId);
        // Réservé puis annulé avant même d'avoir été signalé : rien à dire.
        if (!b || b.status !== 'confirmed') {
          this.claim(`cancel:${d.bookingId}`);
          continue;
        }
        if (!prefs.newBooking) continue;
        jobs.push(this.deliver(prefs.details
          ? { title: 'Nouveau rendez-vous', body: `${b.name} · ${b.type_name}, ${this.when(b.start_utc)}`, url: '/#rendez-vous', tag: `rdv-${b.id}` }
          : { title: 'Nouveau rendez-vous', body: `Un rendez-vous a été pris pour ${this.when(b.start_utc)}.`, url: '/#rendez-vous', tag: `rdv-${b.id}` },
        { ttl: DAY_MS / 1000 }));
      } else if (fact.type === 'booking.cancelled' && d.bookingId && d.by === 'client') {
        if (!this.claim(`cancel:${d.bookingId}`) || !prefs.cancellation) continue;
        const b = this.booking(d.bookingId);
        const name = b?.name ?? d.name ?? '';
        const typeName = b?.type_name ?? d.typeName ?? '';
        const start = b?.start_utc ?? d.start ?? fact.occurredAt;
        jobs.push(this.deliver(prefs.details
          ? { title: 'Rendez-vous annulé', body: `${name} a annulé : ${typeName}, ${this.when(start)}`, url: '/#rendez-vous', tag: `rdv-${d.bookingId}` }
          : { title: 'Rendez-vous annulé', body: `Le rendez-vous du ${this.when(start)} a été annulé.`, url: '/#rendez-vous', tag: `rdv-${d.bookingId}` },
        { ttl: DAY_MS / 1000 }));
      } else if ((fact.type === 'video.guest_waiting' || fact.type === 'video.guest_joined') && d.slug && d.guestName) {
        // Un invité arrivé il y a plus de 5 minutes (Alfred arrêté entre-temps) n'est plus signalé.
        if (Date.parse(fact.occurredAt) < nowMs - GUEST_FRESH_MS) continue;
        jobs.push(this.guestArrived({ slug: d.slug, title: d.title ?? '' }, d.guestName, fact.type === 'video.guest_waiting'));
      }
    }
    if (facts.length > 0) this.reader.ack(facts[facts.length - 1].seq);

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

      if (prefs.reminders === 'bookings') {
        const rows = this.db.all<BookingRow>("SELECT * FROM bookings WHERE space_id = ? AND status = 'confirmed' AND start_utc > ? AND start_utc <= ? ORDER BY start_utc, id",
          this.space, new Date(nowMs - 60_000).toISOString(), new Date(nowMs + windowMs).toISOString());
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

    this.db.run('DELETE FROM push_sent WHERE sent_at < ? AND space_id = ?', new Date(nowMs - 3 * DAY_MS).toISOString(), this.space);
    await Promise.all(jobs);
  }

  /** Passe régulière (toutes les 30 s par défaut). */
  start(intervalMs = 30_000): void {
    const run = () => void this.tick().catch((err) => console.error('[alfred] notifications :', err));
    run();
    setInterval(run, intervalMs).unref();
  }
}
