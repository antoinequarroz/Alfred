import { Settings } from '../settings.js';
import { randomBytes } from 'node:crypto';
import { ALL_SPACES } from '../sql.js';
import { recordFact } from '../outbox.js';
import { uuidv7 } from '../ids.js';
import type {
  PublicVideoRoom, VideoAdminState, VideoJoinInfo, VideoJoinResult, VideoQuality, VideoRoom, VideoRoomKind,
  VideoRoomStatus, VideoServerStatus, VideoSettings, VideoWaiter, VideoWaitStatus,
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
  /** Adresse WebSocket publique donnée aux navigateurs, par exemple wss://alfred.postmelo.ch. */
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
  /**
   * Un invité arrive (notification à l'hôte) : il reçoit son jeton d'entrée ou, avec la salle
   * d'attente, il demande à entrer (waiting vrai). Ne doit pas lever.
   */
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
/**
 * Salle d'attente : un invité qui n'a plus donné signe de vie depuis ce délai est retiré de la file.
 * Large, parce qu'un onglet en arrière-plan n'interroge plus Alfred qu'une fois par minute.
 */
const WAIT_STALE_MS = 90_000;
/** Une fois admis, l'invité a ce délai pour venir chercher son jeton ; sa place est gardée d'ici là. */
const ADMITTED_MS = 120_000;
/** Un refus reste lisible ce délai, le temps que l'invité l'apprenne (même si sa page était en veille). */
const DENIED_MS = 600_000;
/** Personnes en attente au plus, par salle et en tout (mémoire bornée, file lisible pour l'hôte). */
const WAIT_MAX_PER_ROOM = 12;
const WAIT_MAX_TOTAL = 300;
/** Demandes en attente au plus par adresse IP et par salle : la plus ancienne cède la place. */
const WAIT_MAX_PER_IP = 3;
/** La présence de l'hôte dans une salle est relue au plus toutes les 5 secondes. */
const HOST_CACHE_MS = 5_000;
const DEFAULTS: VideoSettings = { enabled: true, maxParticipants: 4, quality: 'standard', waitingRoom: true };

/** Un invité qui patiente : il n'est pas connecté au serveur de visio tant que l'hôte ne l'a pas fait entrer. */
interface Waiter {
  /** Secret de l'invité : lui seul peut suivre sa demande. */
  ticket: string;
  /** Identité qu'il aura dans la salle ; c'est aussi la référence utilisée par l'hôte. */
  identity: string;
  name: string;
  /** Salle visée (identifiant Alfred). */
  roomId: string;
  /** Adresse d'où vient la demande (une même adresse ne peut pas remplir la file). */
  ip: string;
  since: number;
  seen: number;
  state: 'waiting' | 'admitted' | 'denied';
  /** Échéance de l'admission ou du refus (ms). */
  until: number;
  /** Le jeton d'entrée a déjà été remis une fois. */
  picked?: boolean;
}
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
  /** Salle d'attente, en mémoire : ticket → invité. Un redémarrage d'Alfred la vide (l'invité redemande à entrer). */
  private readonly waiters = new Map<string, Waiter>();
  private readonly hostCache = new Map<string, { at: number; present: boolean | null }>();

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
    const out: VideoSettings = { ...DEFAULTS };
    for (const [key, value] of new Settings(this.db, 'video').all()) {
      const r = { key, value };
      try {
        const v = JSON.parse(r.value) as unknown;
        if (r.key === 'enabled' && typeof v === 'boolean') out.enabled = v;
        if (r.key === 'maxParticipants' && typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= MAX_PARTICIPANTS) out.maxParticipants = v;
        if (r.key === 'quality' && (v === 'standard' || v === 'eco')) out.quality = v;
        if (r.key === 'waitingRoom' && typeof v === 'boolean') out.waitingRoom = v;
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
    if ('waitingRoom' in b) {
      if (typeof b.waitingRoom === 'boolean') patch.waitingRoom = b.waitingRoom;
      else fields.waitingRoom = 'Valeur invalide';
    }
    if (Object.keys(fields).length > 0) throw new VideoError(400, 'invalid', Object.values(fields)[0], fields);
    const settings = new Settings(this.db, 'video');
    this.db.tx(() => {
      for (const [key, value] of Object.entries(patch)) settings.set(key, JSON.stringify(value));
    });
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
    return this.db.get<RoomRow>('SELECT * FROM video_rooms WHERE slug = ? AND space_id = ?', slug, this.db.spaceId);
  }

  private byId(id: string): RoomRow | undefined {
    return this.db.get<RoomRow>('SELECT * FROM video_rooms WHERE id = ? AND space_id = ?', id, this.db.spaceId);
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
      waiting: this.waitersOf(row.id).length,
    };
  }

  private insert(row: RoomRow): void {
    this.db.run(
      `INSERT INTO video_rooms (id, slug, title, kind, booking_id, starts_at, ends_at, created_at, closed_at, space_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.slug, row.title, row.kind, row.booking_id, row.starts_at, row.ends_at, row.created_at, row.closed_at, this.db.spaceId);
  }

  private newRow(kind: VideoRoomKind, title: string, start: string | null, end: string | null, bookingId: string | null = null): RoomRow {
    let slug = newRoomSlug();
    // Le lien d'une salle est unique dans toute la base, tous espaces confondus.
    while (this.db.get(`SELECT 1 AS ok FROM video_rooms WHERE slug = ? ${ALL_SPACES}`, slug)) slug = newRoomSlug();
    return {
      id: uuidv7(), slug, title, kind, booking_id: bookingId, starts_at: start, ends_at: end,
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
    const personal = this.db.get<RoomRow>("SELECT * FROM video_rooms WHERE space_id = ? AND kind = 'permanent' AND closed_at IS NULL ORDER BY created_at, id", this.db.spaceId) ?? null;
    // Les horaires des réservations sont d'abord rapprochés de l'agenda (un rendez-vous a pu être déplacé).
    this.bookingLink('');
    // Les salles passées sont écartées en SQL, avant la limite : elles ne sont jamais purgées.
    const cutoff = new Date(this.now().getTime() - GRACE_MS).toISOString();
    const rows = this.db.all<RoomRow>(
      `SELECT r.* FROM video_rooms r LEFT JOIN bookings b ON b.id = r.booking_id AND b.space_id = r.space_id
       WHERE r.space_id = ? AND r.closed_at IS NULL AND r.kind != 'permanent'
         AND COALESCE(b.status, 'confirmed') = 'confirmed'
         AND COALESCE(b.end_utc, r.ends_at) > ?
       ORDER BY COALESCE(b.start_utc, r.starts_at, r.created_at), r.id LIMIT 500`,
      this.db.spaceId, cutoff);
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
    const current = this.db.get<RoomRow>("SELECT * FROM video_rooms WHERE space_id = ? AND kind = 'permanent' AND closed_at IS NULL ORDER BY created_at, id", this.db.spaceId);
    if (current && !renew) return this.toRoom(current, null);
    if (current) this.close(current);
    const row = this.newRow('permanent', 'Ma salle', null, null);
    this.insert(row);
    return this.toRoom(row, null);
  }

  private close(row: RoomRow): void {
    this.db.run('UPDATE video_rooms SET closed_at = ? WHERE id = ? AND space_id = ? AND closed_at IS NULL', this.now().toISOString(), row.id, this.db.spaceId);
    for (const [ticket, w] of this.waiters) if (w.roomId === row.id) this.waiters.delete(ticket);
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
    const row = this.db.get<{ slug: string }>('SELECT slug FROM video_rooms WHERE booking_id = ? AND space_id = ? AND closed_at IS NULL ORDER BY created_at, id', bookingId, this.db.spaceId);
    return row ? this.roomUrl(row.slug) : null;
  }

  /** Réservation annulée : sa salle ferme. */
  closeForBooking(bookingId: string): void {
    const rows = this.db.all<RoomRow>('SELECT * FROM video_rooms WHERE booking_id = ? AND space_id = ? AND closed_at IS NULL ORDER BY created_at, id', bookingId, this.db.spaceId);
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
      waitingRoom: !isHost && this.getSettings().waitingRoom,
    };
  }

  /** Salle ouverte désignée par son lien, ou l'erreur à montrer au visiteur. */
  private openRoom(slug: string): RoomRow {
    const row = isRoomSlug(slug) ? this.bySlug(slug) : undefined;
    if (!row) throw new VideoError(404, 'not_found', 'Ce lien de visio n’existe pas.');
    const status = this.status(row);
    if (status === 'unavailable') throw new VideoError(503, 'unavailable', 'La visio n’est pas disponible pour le moment.');
    if (status === 'closed') throw new VideoError(410, 'closed', 'Cette visio a été annulée ou fermée.');
    if (status === 'ended') throw new VideoError(410, 'ended', 'Cette visio est terminée.');
    return row;
  }

  /**
   * Entrée dans une salle. L'hôte (session Alfred) reçoit tout de suite un jeton, avec les droits
   * d'administration de la salle. Un invité reçoit un jeton, ou, si la salle d'attente est active,
   * un ticket d'attente : il n'entrera que lorsque l'hôte l'aura admis.
   */
  async join(slug: string, body: unknown, isHost: boolean, ip = ''): Promise<VideoJoinResult> {
    const row = this.openRoom(slug);
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
    // L'hôte garde la même identité : s'il rejoint depuis un autre appareil, l'ancienne connexion est remplacée.
    const identity = isHost ? 'host' : `invite-${randomBytes(6).toString('hex')}`;
    if (!isHost && settings.waitingRoom) {
      const nowMs = this.now().getTime();
      this.pruneWaiters(nowMs);
      const mine = this.waitersOf(row.id).filter((w) => w.ip === ip);
      for (const old of mine.slice(0, Math.max(0, mine.length - WAIT_MAX_PER_IP + 1))) this.waiters.delete(old.ticket);
      if (this.waitersOf(row.id).length >= WAIT_MAX_PER_ROOM || this.waiters.size >= WAIT_MAX_TOTAL) {
        throw new VideoError(429, 'wait_full', 'Trop de personnes attendent déjà d’entrer. Réessayez dans un instant.');
      }
      const ticket = randomBytes(18).toString('base64url');
      this.waiters.set(ticket, { ticket, identity, name, roomId: row.id, ip, since: nowMs, seen: nowMs, state: 'waiting', until: 0 });
      const hostPresent = await this.hostPresent(row);
      this.guestArrived(row, name, true);
      return { waiting: true, ticket, hostPresent };
    }
    const room = this.livekitName(row);
    try {
      // Côté serveur de visio, la salle a le plafond dur : c'est Alfred qui applique le réglage (il peut
      // changer en cours de réunion, et une salle existante n'est pas modifiée par CreateRoom).
      await this.backend!.createRoom(room, MAX_PARTICIPANTS, EMPTY_TIMEOUT_SEC);
      if (!isHost) await this.takeSeat(room, identity, settings.maxParticipants, PENDING_MS);
    } catch (err) {
      if (err instanceof VideoError) throw err;
      throw new VideoError(503, 'server_unavailable', 'Le serveur de visio ne répond pas. Réessayez dans un instant.');
    }
    if (!isHost) this.guestArrived(row, name, false);
    return this.issue(room, identity, name, isHost, settings.quality);
  }

  private guestArrived(row: RoomRow, name: string, waiting: boolean): void {
    try {
      // Fait du journal : les notifications le lisent (server/push/service.ts).
      recordFact(this.db, waiting ? 'video.guest_waiting' : 'video.guest_joined', row.id, {
        roomId: row.id, slug: row.slug, title: row.title, kind: row.kind, bookingId: row.booking_id, guestName: name,
      }, this.now());
      this.onGuestJoin?.({ slug: row.slug, title: row.title }, name, waiting);
    } catch (err) {
      console.error('[alfred] visio : avis d’arrivée d’un invité impossible :', err);
    }
  }

  /**
   * Réserve une place d'invité, ou refuse si la salle est complète. Une place reste toujours libre
   * pour l'hôte : on compte les invités connectés et ceux qui ont reçu un jeton (ou une admission)
   * sans être encore connectés (deux entrées simultanées, jetons accumulés).
   */
  private async takeSeat(room: string, identity: string, max: number, holdMs: number): Promise<void> {
    const connected = new Set((await this.backend!.listParticipants(room)).map((p) => p.identity).filter((id) => id !== 'host'));
    const nowMs = this.now().getTime();
    const held = this.pending.get(room) ?? new Map<string, number>();
    for (const [id, until] of held) if (until <= nowMs || connected.has(id)) held.delete(id);
    if (connected.size + held.size >= max - 1) {
      throw new VideoError(409, 'full', `Cette visio est complète (${max} participants au plus).`);
    }
    held.set(identity, nowMs + holdMs);
    this.pending.set(room, held);
    // Mémoire bornée : les salles sans entrée récente sont oubliées.
    if (this.pending.size > 200) {
      for (const [name, map] of this.pending) if ([...map.values()].every((until) => until <= nowMs)) this.pending.delete(name);
    }
  }

  private issue(room: string, identity: string, name: string, isHost: boolean, quality: VideoQuality): VideoJoinInfo {
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
    return { url: this.server.publicUrl, token, identity, isHost, quality };
  }

  // --- salle d'attente -----------------------------------------------------

  /** Retire les invités partis sans prévenir et les admissions ou refus arrivés à échéance. */
  private pruneWaiters(nowMs: number): void {
    for (const [ticket, w] of this.waiters) {
      if (w.state === 'waiting' ? nowMs - w.seen > WAIT_STALE_MS : nowMs > w.until) this.waiters.delete(ticket);
    }
  }

  /** Invités qui patientent pour une salle, du plus ancien au plus récent. */
  private waitersOf(roomId: string): Waiter[] {
    const nowMs = this.now().getTime();
    const out: Waiter[] = [];
    for (const w of this.waiters.values()) {
      if (w.roomId === roomId && w.state === 'waiting' && nowMs - w.seen <= WAIT_STALE_MS) out.push(w);
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** L'hôte est connecté à la salle ; null si le serveur de visio ne le dit pas. */
  private async hostPresent(row: RoomRow): Promise<boolean | null> {
    const nowMs = Date.now();
    const cached = this.hostCache.get(row.id);
    if (cached && nowMs - cached.at < HOST_CACHE_MS) return cached.present;
    let present: boolean | null = null;
    try {
      present = (await this.backend!.listParticipants(this.livekitName(row))).some((p) => p.identity === 'host');
    } catch {
      present = null;
    }
    if (this.hostCache.size > 200) this.hostCache.clear();
    this.hostCache.set(row.id, { at: nowMs, present });
    return present;
  }

  private waiter(row: RoomRow, ticket: unknown): Waiter | undefined {
    if (typeof ticket !== 'string' || ticket.length > 64) return undefined;
    this.pruneWaiters(this.now().getTime());
    const w = this.waiters.get(ticket);
    return w && w.roomId === row.id ? w : undefined;
  }

  /**
   * Où en est la demande d'un invité. Admis : il reçoit son jeton d'entrée ; si la réponse se perd,
   * il peut le redemander pendant une minute (même identité, donc une seule place).
   */
  async waitStatus(slug: string, body: unknown): Promise<VideoWaitStatus> {
    const row = this.openRoom(slug);
    const w = this.waiter(row, (body as { ticket?: unknown } | null)?.ticket);
    if (!w) throw new VideoError(404, 'wait_expired', 'Votre demande a expiré. Demandez à nouveau à entrer.');
    w.seen = this.now().getTime();
    if (w.state === 'denied') return { state: 'denied' };
    if (w.state === 'waiting') return { state: 'waiting', hostPresent: await this.hostPresent(row) };
    const room = this.livekitName(row);
    try {
      await this.backend!.createRoom(room, MAX_PARTICIPANTS, EMPTY_TIMEOUT_SEC);
    } catch {
      throw new VideoError(503, 'server_unavailable', 'Le serveur de visio ne répond pas. Réessayez dans un instant.');
    }
    // La demande et la place restent gardées le temps que l'invité se connecte.
    if (!w.picked) {
      w.picked = true;
      w.until = this.now().getTime() + PENDING_MS;
      const held = this.pending.get(room);
      if (held?.has(w.identity)) held.set(w.identity, w.until);
    }
    return { state: 'admitted', join: this.issue(room, w.identity, w.name, false, this.getSettings().quality) };
  }

  /** L'invité renonce (bouton Annuler, page fermée) : il sort de la file tout de suite. */
  leaveWait(slug: string, body: unknown): void {
    const row = isRoomSlug(slug) ? this.bySlug(slug) : undefined;
    if (!row) return;
    const w = this.waiter(row, (body as { ticket?: unknown } | null)?.ticket);
    if (!w) return;
    // Un refus n'est pas effacé par l'invité : il reste lisible jusqu'à son échéance.
    if (w.state === 'denied') return;
    this.waiters.delete(w.ticket);
    if (w.state === 'admitted') this.pending.get(this.livekitName(row))?.delete(w.identity);
  }

  private rowForHost(slug: string): RoomRow {
    const row = isRoomSlug(slug) ? this.bySlug(slug) : undefined;
    if (!row) throw new VideoError(404, 'not_found', 'Salle introuvable');
    return row;
  }

  /** File d'attente d'une salle, pour l'hôte. */
  waitingList(slug: string): VideoWaiter[] {
    const row = this.rowForHost(slug);
    return this.waitersOf(row.id).map((w) => ({ id: w.identity, name: w.name, since: new Date(w.since).toISOString() }));
  }

  /** L'hôte fait entrer un invité : sa place est réservée, il recevra son jeton à sa prochaine demande. */
  async admit(slug: string, body: unknown): Promise<VideoWaiter[]> {
    const row = this.rowForHost(slug);
    this.openRoom(slug);
    const id = (body as { id?: unknown } | null)?.id;
    const w = this.waitersOf(row.id).find((x) => x.identity === id);
    if (!w) throw new VideoError(404, 'wait_gone', 'Cette personne n’attend plus.');
    const room = this.livekitName(row);
    try {
      await this.takeSeat(room, w.identity, this.getSettings().maxParticipants, ADMITTED_MS);
    } catch (err) {
      if (err instanceof VideoError) throw err;
      throw new VideoError(503, 'server_unavailable', 'Le serveur de visio ne répond pas. Réessayez dans un instant.');
    }
    // L'invité a pu renoncer pendant l'appel au serveur de visio : sa place est rendue.
    if (this.waiters.get(w.ticket) !== w || w.state !== 'waiting') {
      this.pending.get(room)?.delete(w.identity);
      throw new VideoError(404, 'wait_gone', 'Cette personne n’attend plus.');
    }
    w.state = 'admitted';
    w.until = this.now().getTime() + ADMITTED_MS;
    return this.waitingList(slug);
  }

  /** L'hôte refuse un invité : celui-ci l'apprend à sa prochaine demande. */
  deny(slug: string, body: unknown): VideoWaiter[] {
    const row = this.rowForHost(slug);
    const id = (body as { id?: unknown } | null)?.id;
    const w = this.waitersOf(row.id).find((x) => x.identity === id);
    if (!w) throw new VideoError(404, 'wait_gone', 'Cette personne n’attend plus.');
    w.state = 'denied';
    w.until = this.now().getTime() + DENIED_MS;
    return this.waitingList(slug);
  }
}
