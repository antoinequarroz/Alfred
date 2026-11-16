import { randomBytes, randomUUID } from 'node:crypto';
import type {
  PublicVideoRoom, VideoAdminState, VideoJoinInfo, VideoQuality, VideoRoom, VideoRoomKind, VideoRoomStatus,
  VideoServerStatus, VideoSettings,
} from '../../shared/types.js';
import type { Db } from '../db.js';
import { LivekitClient, LivekitError } from './livekit.js';
import { signAccessToken } from './token.js';

/** Erreur de la visio : statut HTTP, code stable, message affichable. */
export class VideoError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 429 | 503,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Ce dont Alfred a besoin pour parler au serveur de visio (LiveKit). */
export interface VideoServerConfig {
  apiKey?: string;
  apiSecret?: string;
  /** Adresse interne de l'API (réseau Docker), par exemple http://alfred-livekit:7880. */
  internalUrl: string;
  /** Adresse WebSocket publique donnée aux navigateurs, par exemple wss://alfred.antoinequarroz.ch. */
  publicUrl: string;
}

/** Sous-ensemble du client LiveKit utilisé ici (remplaçable dans les tests). */
export type VideoBackend = Pick<LivekitClient, 'health' | 'createRoom' | 'listRooms' | 'listParticipants' | 'deleteRoom'>;

export interface BookingLink {
  status: 'confirmed' | 'cancelled';
  start: string;
  end: string;
}

export interface VideoOptions {
  db: Db;
  server: VideoServerConfig;
  /** Adresse publique d'Alfred, sans barre finale : les liens des salles en partent. */
  publicUrl: string;
  timezone: string;
  /** Nom de l'hôte affiché aux invités. */
  hostName?: () => string;
  /** État et horaire actuels d'une réservation (une salle de rendez-vous suit son rendez-vous). */
  bookingLink?: (bookingId: string) => BookingLink | null;
  /** Un invité reçoit son jeton d'entrée (notification à l'hôte). Ne doit pas lever. */
  onGuestJoin?: (room: { slug: string; title: string }, guestName: string, waiting?: boolean) => void;
  backend?: VideoBackend;
  now?: () => Date;
}

interface RoomRow {
  id: string;
  slug: string;
  title: string;
  kind: VideoRoomKind;
  booking_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  closed_at: string | null;
}

/** Une salle reste ouverte jusqu'à 6 heures après la fin prévue (réunion qui déborde, retard). */
const GRACE_MS = 6 * 3_600_000;
/** Une réunion instantanée est prévue pour 12 heures. */
const INSTANT_MS = 12 * 3_600_000;
/**
 * Validité d'un jeton d'entrée : le temps de se connecter, pas plus. Une fois connecté, le serveur
 * de visio renouvelle lui-même le jeton ; un jeton copié ne sert donc plus à rien deux minutes après.
 */
const TOKEN_TTL_SEC = 120;
/** Un jeton d'invité délivré compte comme une place prise pendant ce délai, le temps que l'invité se connecte. */
const PENDING_MS = 60_000;
/** Une salle vide est fermée côté serveur de visio après 5 minutes (elle se recrée à la prochaine entrée). */
const EMPTY_TIMEOUT_SEC = 300;
const DEFAULTS: VideoSettings = { enabled: true, maxParticipants: 4, quality: 'standard' };
export const MAX_PARTICIPANTS = 8;
/** Lettres et chiffres sans ambiguïté à l'écrit (ni l, ni 1, ni 0, ni o). */
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SLUG_RE = /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Slug de salle : 12 caractères aléatoires (≈ 60 bits), en trois groupes lisibles. */
export function newRoomSlug(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) out += '-';
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

export function isRoomSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/** Nom affiché d'un invité : 1 à 50 caractères, sans caractère de contrôle ni chevron. */
export function cleanGuestName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 50 || CONTROL_RE.test(name) || /[<>]/.test(name)) return null;
  return name;
}

/**
 * Visioconférence : réglages, salles (instantanées, d'un événement, d'un rendez-vous, permanente)
 * et jetons d'entrée. Le serveur de visio (LiveKit) transporte l'audio et la vidéo ; Alfred
 * décide seulement qui entre, dans quelle salle et avec quels droits.
 */
export class VideoService {
  private readonly db: Db;
  private readonly server: VideoServerConfig;
  private readonly backend: VideoBackend | null;
  private readonly publicUrl: string;
  readonly timezone: string;
  private readonly hostName: () => string;
  private readonly bookingLink: (bookingId: string) => BookingLink | null;
  private readonly onGuestJoin?: (room: { slug: string; title: string }, guestName: string, waiting?: boolean) => void;
  private readonly now: () => Date;
  private healthCache: { at: number; ok: boolean } | null = null;
  /** Jetons d'invités délivrés depuis peu, par salle : identité → échéance (ms). Ferme la course entre deux entrées simultanées. */
  private readonly pending = new Map<string, Map<string, number>>();

  constructor(opts: VideoOptions) {
    this.db = opts.db;
    this.server = opts.server;
    this.publicUrl = opts.publicUrl.replace(/\/+$/, '');
    this.timezone = opts.timezone;
    this.hostName = opts.hostName ?? (() => '');
    this.bookingLink = opts.bookingLink ?? (() => null);
    this.onGuestJoin = opts.onGuestJoin;
    this.now = opts.now ?? (() => new Date());
    this.backend = opts.backend ?? (this.configured
      ? new LivekitClient(opts.server.internalUrl, opts.server.apiKey!, opts.server.apiSecret!)
      : null);
  }

  /** Adresse WebSocket du serveur de visio donnée aux navigateurs. */
  get publicWsUrl(): string {
    return this.server.publicUrl;
  }

  /** Les clés du serveur de visio sont connues. */
  get configured(): boolean {
    return Boolean(this.server.apiKey && this.server.apiSecret && this.server.apiSecret.length >= 32);
  }

  /** La visio est utilisable : activée et configurée (le serveur peut être momentanément injoignable). */
  get available(): boolean {
    return this.configured && this.getSettings().enabled;
  }

  // --- réglages ------------------------------------------------------------

  getSettings(): VideoSettings {
    const rows = this.db.prepare('SELECT key, value FROM video_settings').all() as unknown as { key: string; value: string }[];
    const out: VideoSettings = { ...DEFAULTS };
    for (const r of rows) {
      try {
        const v = JSON.parse(r.value) as unknown;
        if (r.key === 'enabled' && typeof v === 'boolean') out.enabled = v;
        if (r.key === 'maxParticipants' && typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= MAX_PARTICIPANTS) out.maxParticipants = v;
        if (r.key === 'quality' && (v === 'standard' || v === 'eco')) out.quality = v;
      } catch {
        // valeur illisible : défaut
      }
    }
    return out;
  }

  updateSettings(body: unknown): VideoSettings {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VideoError(400, 'invalid', 'Corps de requête invalide');
    const b = body as Record<string, unknown>;
    const fields: Record<string, string> = {};
    const patch: Partial<VideoSettings> = {};
    if ('enabled' in b) {
      if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
      else fields.enabled = 'Valeur invalide';
    }
    if ('maxParticipants' in b) {
      const v = b.maxParticipants;
      if (typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= MAX_PARTICIPANTS) patch.maxParticipants = v;
      else fields.maxParticipants = `Entre 2 et ${MAX_PARTICIPANTS} participants`;
    }
    if ('quality' in b) {
      if (b.quality === 'standard' || b.quality === 'eco') patch.quality = b.quality as VideoQuality;
      else fields.quality = 'Qualité : standard ou eco';
    }
    if (Object.keys(fields).length > 0) throw new VideoError(400, 'invalid', Object.values(fields)[0], fields);
    const put = this.db.prepare('INSERT INTO video_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(patch)) put.run(key, JSON.stringify(value));
    return this.getSettings();
  }

  // --- serveur -------------------------------------------------------------

  async serverStatus(): Promise<VideoServerStatus> {
    if (!this.configured || !this.backend) {
      return {
        configured: false,
        reachable: null,
        problem: 'Le serveur de visio n’est pas encore installé sur le VPS (clés LIVEKIT_API_KEY et LIVEKIT_API_SECRET absentes).',
      };
    }
    const now = Date.now();
    if (!this.healthCache || now - this.healthCache.at > 15_000) {
      this.healthCache = { at: now, ok: await this.backend.health() };
    }
    return {
      configured: true,
      reachable: this.healthCache.ok,
      problem: this.healthCache.ok ? null : 'Le serveur de visio ne répond pas. Les liens restent valables : ils fonctionneront dès qu’il sera revenu.',
    };
  }

  // --- salles --------------------------------------------------------------

  private roomUrl(slug: string): string {
    return `${this.publicUrl}/v/${slug}`;
  }

  /** Nom de la salle côté serveur de visio : l'identifiant, qui ne change jamais. */
  private livekitName(row: RoomRow): string {
    return `alfred-${row.id}`;
  }

  private bySlug(slug: string): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM video_rooms WHERE slug = ?').get(slug) as RoomRow | undefined;
  }

  private byId(id: string): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM video_rooms WHERE id = ?').get(id) as RoomRow | undefined;
  }

  /** Horaire effectif : celui du rendez-vous pour une salle de rendez-vous (il a pu être déplacé). */
  private schedule(row: RoomRow): { start: string | null; end: string | null; cancelled: boolean } {
    if (row.kind === 'booking' && row.booking_id) {
      const link = this.bookingLink(row.booking_id);
      if (!link) return { start: row.starts_at, end: row.ends_at, cancelled: false };
      return { start: link.start, end: link.end, cancelled: link.status === 'cancelled' };
    }
    return { start: row.starts_at, end: row.ends_at, cancelled: false };
  }

  /** Passée : fin prévue dépassée de plus de GRACE_MS. */
  private isPast(end: string | null): boolean {
    return Boolean(end && this.now().getTime() > Date.parse(end) + GRACE_MS);
  }

  private status(row: RoomRow): VideoRoomStatus {
    if (!this.available) return 'unavailable';
    const s = this.schedule(row);
    if (row.closed_at || s.cancelled) return 'closed';
    // La visio d'un événement ne se périme pas : l'événement peut être déplacé ou se répéter, et son
    // lien, écrit dans l'agenda, doit continuer d'ouvrir la salle. Elle sort seulement de la liste.
    if (row.kind !== 'event' && this.isPast(s.end)) return 'ended';
    return 'open';
  }

  private toRoom(row: RoomRow, live: Map<string, number> | null): VideoRoom {
    const s = this.schedule(row);
    return {
      id: row.id, slug: row.slug, url: this.roomUrl(row.slug), title: row.title, kind: row.kind,
      startsAt: s.start, endsAt: s.end, createdAt: row.created_at, bookingId: row.booking_id,
      live: live ? (live.get(this.livekitName(row)) ?? 0) : null,
    };
  }

  private insert(row: RoomRow): void {
    this.db.prepare(
      `INSERT INTO video_rooms (id, slug, title, kind, booking_id, starts_at, ends_at, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.slug, row.title, row.kind, row.booking_id, row.starts_at, row.ends_at, row.created_at, row.closed_at);
  }

  private newRow(kind: VideoRoomKind, title: string, start: string | null, end: string | null, bookingId: string | null = null): RoomRow {
    let slug = newRoomSlug();
    while (this.bySlug(slug)) slug = newRoomSlug();
    return {
      id: randomUUID(), slug, title, kind, booking_id: bookingId, starts_at: start, ends_at: end,
      created_at: this.now().toISOString(), closed_at: null,
    };
  }

  private requireAvailable(): void {
    if (!this.configured) throw new VideoError(503, 'not_configured', 'Le serveur de visio n’est pas encore installé.');
    if (!this.getSettings().enabled) throw new VideoError(403, 'disabled', 'La visio est désactivée dans les réglages.');
  }

  /** Personnes connectées par salle, ou null si le serveur ne répond pas. */
  private async liveCounts(): Promise<Map<string, number> | null> {
    if (!this.backend) return null;
    try {
      const rooms = await this.backend.listRooms();
      return new Map(rooms.map((r) => [r.name, r.numParticipants]));
    } catch {
      return null;
    }
  }

  async adminState(): Promise<VideoAdminState> {
    const settings = this.getSettings();
    const server = await this.serverStatus();
    const live = server.reachable ? await this.liveCounts() : null;
    const personal = (this.db.prepare("SELECT * FROM video_rooms WHERE kind = 'permanent' AND closed_at IS NULL").get() as RoomRow | undefined) ?? null;
    // Les horaires des réservations sont d'abord rapprochés de l'agenda (un rendez-vous a pu être déplacé).
    this.bookingLink('');
    // Les salles passées sont écartées en SQL, avant la limite : elles ne sont jamais purgées.
    const cutoff = new Date(this.now().getTime() - GRACE_MS).toISOString();
    const rows = this.db.prepare(
      `SELECT r.* FROM video_rooms r LEFT JOIN bookings b ON b.id = r.booking_id
       WHERE r.closed_at IS NULL AND r.kind != 'permanent'
         AND COALESCE(b.status, 'confirmed') = 'confirmed'
         AND COALESCE(b.end_utc, r.ends_at) > ?
       ORDER BY COALESCE(b.start_utc, r.starts_at, r.created_at) LIMIT 500`,
    ).all(cutoff) as unknown as RoomRow[];
    const rooms = rows
      .filter((r) => {
        const s = this.schedule(r);
        return !s.cancelled && !this.isPast(s.end);
      })
      .map((r) => this.toRoom(r, live))
      .sort((a, b) => (a.startsAt ?? a.createdAt).localeCompare(b.startsAt ?? b.createdAt))
      .slice(0, 100);
    return {
      settings, server, available: this.configured && settings.enabled,
      personalRoom: personal ? this.toRoom(personal, live) : null,
      rooms,
    };
  }

  /** Nouvelle salle : réunion instantanée, ou visio d'un événement si un horaire est donné. */
  createRoom(body: unknown): VideoRoom {
    this.requireAvailable();
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    let title = 'Réunion';
    if (b.title !== undefined && b.title !== null && b.title !== '') {
      const t = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim() : '';
      if (!t || t.length > 120 || CONTROL_RE.test(t)) fields.title = 'Titre : 120 caractères au plus';
      else title = t;
    }
    let start: string | null = null;
    let end: string | null = null;
    if (b.start !== undefined || b.end !== undefined) {
      const s = typeof b.start === 'string' && ISO_RE.test(b.start) ? Date.parse(b.start) : NaN;
      const e = typeof b.end === 'string' && ISO_RE.test(b.end) ? Date.parse(b.end) : NaN;
      if (Number.isNaN(s) || Number.isNaN(e) || e <= s || e - s > 7 * 86_400_000) fields.start = 'Horaire invalide';
      else {
        start = new Date(s).toISOString();
        end = new Date(e).toISOString();
      }
    }
    if (Object.keys(fields).length > 0) throw new VideoError(400, 'invalid', Object.values(fields)[0], fields);
    const now = this.now().getTime();
    const row = start
      ? this.newRow('event', title, start, end)
      : this.newRow('instant', title, new Date(now).toISOString(), new Date(now + INSTANT_MS).toISOString());
    this.insert(row);
    return this.toRoom(row, null);
  }

  /** Salle permanente (ton lien fixe). renew : nouveau lien, l'ancien ne marche plus. */
  personalRoom(renew: boolean): VideoRoom {
    this.requireAvailable();
    const current = this.db.prepare("SELECT * FROM video_rooms WHERE kind = 'permanent' AND closed_at IS NULL").get() as RoomRow | undefined;
    if (current && !renew) return this.toRoom(current, null);
    if (current) this.close(current);
    const row = this.newRow('permanent', 'Ma salle', null, null);
    this.insert(row);
    return this.toRoom(row, null);
  }

  private close(row: RoomRow): void {
    this.db.prepare('UPDATE video_rooms SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(this.now().toISOString(), row.id);
    // Les personnes encore connectées sont déconnectées, au mieux.
    void this.backend?.deleteRoom(this.livekitName(row)).catch(() => undefined);
  }

  /** Supprime une salle : son lien ne marche plus. */
  deleteRoom(id: string): void {
    const row = this.byId(id);
    if (!row || row.closed_at) throw new VideoError(404, 'not_found', 'Salle introuvable');
    this.close(row);
  }

  /** Termine la réunion en cours pour tout le monde ; le lien reste valable. */
  async endMeeting(id: string): Promise<void> {
    const row = this.byId(id);
    if (!row) throw new VideoError(404, 'not_found', 'Salle introuvable');
    if (!this.backend) throw new VideoError(503, 'not_configured', 'Le serveur de visio n’est pas encore installé.');
    try {
      await this.backend.deleteRoom(this.livekitName(row));
    } catch (err) {
      throw new VideoError(503, 'server_unavailable', err instanceof LivekitError ? err.message : 'Le serveur de visio ne répond pas.');
    }
  }

  async endMeetingBySlug(slug: string): Promise<void> {
    const row = isRoomSlug(slug) ? this.bySlug(slug) : undefined;
    if (!row) throw new VideoError(404, 'not_found', 'Salle introuvable');
    await this.endMeeting(row.id);
  }

  // --- rendez-vous ---------------------------------------------------------

  /**
   * Salle préparée pour une réservation « En visio », avant la création de l'événement (son lien
   * va dans l'événement). Rien n'est enregistré tant que attachBooking n'est pas appelé.
   * null : la visio Alfred n'est pas disponible, le rendez-vous garde le lieu saisi dans le type.
   */
  reserveForBooking(title: string, start: string, end: string): { url: string; commit: (bookingId: string) => void } | null {
    if (!this.available) return null;
    const row = this.newRow('booking', title.slice(0, 120), start, end);
    return {
      url: this.roomUrl(row.slug),
      commit: (bookingId: string) => this.insert({ ...row, booking_id: bookingId }),
    };
  }

  /** Lien de la salle d'une réservation, s'il y en a une ouverte. */
  urlForBooking(bookingId: string): string | null {
    // Visio désactivée ou désinstallée après coup : pas de bouton qui mène à une salle indisponible.
    if (!this.available) return null;
    const row = this.db.prepare('SELECT slug FROM video_rooms WHERE booking_id = ? AND closed_at IS NULL').get(bookingId) as { slug: string } | undefined;
    return row ? this.roomUrl(row.slug) : null;
  }

  /** Réservation annulée : sa salle ferme. */
  closeForBooking(bookingId: string): void {
    const rows = this.db.prepare('SELECT * FROM video_rooms WHERE booking_id = ? AND closed_at IS NULL').all(bookingId) as unknown as RoomRow[];
    for (const row of rows) this.close(row);
  }

  // --- partie publique -----------------------------------------------------

  publicRoom(slug: string, isHost: boolean): PublicVideoRoom {
    const row = isRoomSlug(slug) ? this.bySlug(slug) : undefined;
    if (!row) throw new VideoError(404, 'not_found', 'Ce lien de visio n’existe pas.');
    const s = this.schedule(row);
    return {
      title: row.kind === 'permanent' ? 'Visio' : row.title,
      hostName: this.hostName(),
      status: this.status(row),
      startsAt: row.kind === 'instant' ? null : s.start,
      endsAt: row.kind === 'instant' ? null : s.end,
      timezone: this.timezone,
      isHost,
    };
  }

  /** Jeton d'entrée dans une salle. L'hôte (session Alfred) a les droits d'administration de la salle. */
  async join(slug: string, body: unknown, isHost: boolean): Promise<VideoJoinInfo> {
    const row = isRoomSlug(slug) ? this.bySlug(slug) : undefined;
    if (!row) throw new VideoError(404, 'not_found', 'Ce lien de visio n’existe pas.');
    const status = this.status(row);
    if (status === 'unavailable') throw new VideoError(503, 'unavailable', 'La visio n’est pas disponible pour le moment.');
    if (status === 'closed') throw new VideoError(410, 'closed', 'Cette visio a été annulée ou fermée.');
    if (status === 'ended') throw new VideoError(410, 'ended', 'Cette visio est terminée.');

    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    let name: string;
    if (isHost) {
      name = cleanGuestName(b.name) ?? (this.hostName() || 'Hôte');
    } else {
      const n = cleanGuestName(b.name);
      if (!n) throw new VideoError(400, 'invalid', 'Indiquez votre nom (50 caractères au plus)', { name: 'Indiquez votre nom (50 caractères au plus)' });
      // Un invité ne peut pas se présenter sous le nom de l'hôte (les messages n'affichent que le nom).
      const fold = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      const host = fold(this.hostName());
      if (host && fold(n) === host) {
        throw new VideoError(400, 'invalid', 'Ce nom est celui de votre hôte : indiquez le vôtre.', { name: 'Ce nom est celui de votre hôte : indiquez le vôtre.' });
      }
      name = n;
    }
    const settings = this.getSettings();
    const backend = this.backend!;
    const room = this.livekitName(row);
    // L'hôte garde la même identité : s'il rejoint depuis un autre appareil, l'ancienne connexion est remplacée.
    const identity = isHost ? 'host' : `invite-${randomBytes(6).toString('hex')}`;
    try {
      // Côté serveur de visio, la salle a le plafond dur : c'est Alfred qui applique le réglage (il peut
      // changer en cours de réunion, et une salle existante n'est pas modifiée par CreateRoom).
      await backend.createRoom(room, MAX_PARTICIPANTS, EMPTY_TIMEOUT_SEC);
      if (!isHost) {
        // Une place reste toujours libre pour l'hôte : on compte les invités connectés et ceux qui
        // viennent de recevoir un jeton sans être encore connectés (deux entrées simultanées, jetons accumulés).
        const connected = new Set((await backend.listParticipants(room)).map((p) => p.identity).filter((id) => id !== 'host'));
        const nowMs = this.now().getTime();
        const waiting = this.pending.get(room) ?? new Map<string, number>();
        for (const [id, until] of waiting) if (until <= nowMs || connected.has(id)) waiting.delete(id);
        if (connected.size + waiting.size >= settings.maxParticipants - 1) {
          throw new VideoError(409, 'full', `Cette visio est complète (${settings.maxParticipants} participants au plus).`);
        }
        waiting.set(identity, nowMs + PENDING_MS);
        this.pending.set(room, waiting);
        // Mémoire bornée : les salles sans entrée récente sont oubliées.
        if (this.pending.size > 200) {
          for (const [name, map] of this.pending) if ([...map.values()].every((until) => until <= nowMs)) this.pending.delete(name);
        }
      }
    } catch (err) {
      if (err instanceof VideoError) throw err;
      throw new VideoError(503, 'server_unavailable', 'Le serveur de visio ne répond pas. Réessayez dans un instant.');
    }
    const token = signAccessToken(this.server.apiKey!, this.server.apiSecret!, {
      identity,
      name,
      metadata: JSON.stringify({ role: isHost ? 'host' : 'guest' }),
      ttlSec: TOKEN_TTL_SEC,
      video: {
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'],
        ...(isHost ? { roomAdmin: true } : {}),
      },
    });
    if (!isHost) {
      try {
        this.onGuestJoin?.({ slug: row.slug, title: row.title }, name);
      } catch (err) {
        console.error('[alfred] visio : avis d’arrivée d’un invité impossible :', err);
      }
    }
    return { url: this.server.publicUrl, token, identity, isHost, quality: settings.quality };
  }
}
