import { signAccessToken } from './token.js';

export interface LivekitRoomInfo {
  name: string;
  numParticipants: number;
}

export interface LivekitParticipant {
  identity: string;
  name: string;
}

/** Erreur d'appel au serveur de visio, avec un message en français sans détail technique. */
export class LivekitError extends Error {}

/**
 * Client minimal de l'API serveur de LiveKit (Twirp, JSON), sur le réseau Docker interne.
 * Seules quelques routes servent : santé, création, liste et fermeture des salles.
 */
export class LivekitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly timeoutMs = 4000,
  ) {}

  /** Vrai si le serveur de visio répond. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl.replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async call<T>(method: string, body: Record<string, unknown>, room?: string): Promise<T> {
    const token = signAccessToken(this.apiKey, this.apiSecret, {
      ttlSec: 60,
      video: { roomCreate: true, roomList: true, roomAdmin: true, ...(room ? { room } : {}) },
    });
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/twirp/livekit.RoomService/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LivekitError('Le serveur de visio ne répond pas.');
    }
    if (res.status === 401) throw new LivekitError('Le serveur de visio refuse la clé d’Alfred (clés différentes).');
    if (!res.ok) {
      // Twirp : { code: 'not_found', msg: '…' }
      const err = (await res.json().catch(() => ({}))) as { code?: string };
      if (err.code === 'not_found') throw new LivekitError('not_found');
      throw new LivekitError(`Le serveur de visio a répondu ${res.status}.`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  /** Crée la salle si elle n'existe pas (sinon renvoie l'existante, sans la modifier). */
  async createRoom(name: string, maxParticipants: number, emptyTimeoutSec: number): Promise<void> {
    await this.call('CreateRoom', { name, max_participants: maxParticipants, empty_timeout: emptyTimeoutSec, departure_timeout: 60 });
  }

  async listRooms(names?: string[]): Promise<LivekitRoomInfo[]> {
    const out = await this.call<{ rooms?: Record<string, unknown>[] }>('ListRooms', names ? { names } : {});
    return (out.rooms ?? []).map((r) => ({
      name: String(r.name ?? ''),
      numParticipants: Number(r.num_participants ?? r.numParticipants ?? 0) || 0,
    }));
  }

  async listParticipants(room: string): Promise<LivekitParticipant[]> {
    try {
      const out = await this.call<{ participants?: Record<string, unknown>[] }>('ListParticipants', { room }, room);
      return (out.participants ?? []).map((p) => ({ identity: String(p.identity ?? ''), name: String(p.name ?? '') }));
    } catch (err) {
      // Salle pas encore créée : personne dedans.
      if (err instanceof LivekitError && err.message === 'not_found') return [];
      throw err;
    }
  }

  /** Ferme la salle : tout le monde est déconnecté. Sans effet si elle n'existe pas. */
  async deleteRoom(room: string): Promise<void> {
    try {
      await this.call('DeleteRoom', { room }, room);
    } catch (err) {
      if (err instanceof LivekitError && err.message === 'not_found') return;
      throw err;
    }
  }
}
