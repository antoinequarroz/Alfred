import type { Db } from './db.js';
import { addressOf, MODULE, uuidv7 } from './ids.js';

// Journal d'événements d'Alfred (ALFRED-302) : une boîte d'envoi au format commun de la suite.
//
// Chaque fait (« un rendez-vous a été pris », « un acompte a été payé »…) est écrit dans la table
// outbox, dans la même transaction que le changement qu'il décrit : si le changement est annulé,
// le fait l'est aussi, et un fait écrit correspond toujours à un changement réel. Les lecteurs
// (les notifications aujourd'hui, la distribution vers les autres modules plus tard) lisent le
// journal dans l'ordre et retiennent leur position : un fait n'est jamais perdu si un lecteur
// est en panne, et jamais traité deux fois.
//
// Liste et contenu des types de faits : docs/JOURNAL.md (et FACT_TYPES ci-dessous).

/** Types de faits, avec ce que porte data. Tenir docs/JOURNAL.md à jour. */
export const FACT_TYPES = {
  /** Rendez-vous pris (par un client, après paiement de l'acompte s'il y en a un). */
  'booking.created': 'booking',
  /** Rendez-vous déplacé : par le client depuis son lien, ou dans l'agenda (by = 'client' | 'agenda'). */
  'booking.rescheduled': 'booking',
  /** Rendez-vous annulé (by = 'client' | 'admin'). */
  'booking.cancelled': 'booking',
  /** Acompte payé en ligne (Stripe) : le créneau est retenu, la réservation suit. */
  'payment.received': 'payment',
  /** Acompte remboursé (annulation). */
  'payment.refunded': 'booking',
  /** Un invité attend d'être admis dans une salle de visio. */
  'video.guest_waiting': 'room',
  /** Un invité est entré dans une salle de visio. */
  'video.guest_joined': 'room',
  /** Prévus, pas encore écrits : Alfred ne reçoit pas encore la fin des appels ni les enregistrements. */
  'video.call_ended': 'room',
  'video.recording_ready': 'recording',
  'video.transcript_ready': 'recording',
} as const;

export type FactType = keyof typeof FACT_TYPES;

export interface Fact<T = Record<string, unknown>> {
  seq: number;
  id: string;
  spaceId: string;
  source: string;
  type: FactType;
  subject: string;
  occurredAt: string;
  data: T;
}

interface Row {
  seq: number;
  id: string;
  space_id: string;
  source: string;
  type: string;
  subject: string;
  occurred_at: string;
  data: string;
}

type Listener = (types: FactType[]) => void;
const listeners = new WeakMap<object, Set<Listener>>();

function toFact(r: Row): Fact {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(r.data) as Record<string, unknown>;
  } catch {
    // détail illisible : le fait reste lisible sans lui
  }
  return { seq: Number(r.seq), id: r.id, spaceId: r.space_id, source: r.source, type: r.type as FactType, subject: r.subject, occurredAt: r.occurred_at, data };
}

/**
 * Écrit un fait dans le journal de l'espace de db. À appeler dans la transaction du changement
 * qu'il décrit (sinon il est écrit seul, tout de suite).
 */
export function recordFact(db: Db, type: FactType, objectId: string, data: Record<string, unknown>, at: Date | string = new Date()): string {
  const id = uuidv7();
  const occurredAt = typeof at === 'string' ? at : at.toISOString();
  db.run(
    'INSERT INTO outbox (id, space_id, source, type, subject, occurred_at, data, data_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    id, db.spaceId, MODULE, type, addressOf(FACT_TYPES[type], objectId), occurredAt, JSON.stringify(data),
  );
  const set = listeners.get(db.root);
  if (set?.size) db.afterCommit(() => { for (const l of set) l([type]); });
  return id;
}

/** Prévient listener après chaque écriture validée dans le journal de cette base. Renvoie de quoi se désabonner. */
export function onFacts(db: Db, listener: Listener): () => void {
  let set = listeners.get(db.root);
  if (!set) listeners.set(db.root, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

/** Faits de l'espace écrits après la position seq, dans l'ordre. */
export function factsAfter(db: Db, seq: number, limit = 200): Fact[] {
  return db.all<Row>('SELECT * FROM outbox WHERE space_id = ? AND seq > ? ORDER BY seq LIMIT ?', db.spaceId, seq, limit).map(toFact);
}

/** Lecteur du journal qui retient sa position (une ligne par lecteur et par espace). */
export class OutboxReader {
  constructor(private readonly db: Db, readonly name: string) {}

  get position(): number {
    const row = this.db.get<{ seq: number }>('SELECT seq FROM outbox_readers WHERE space_id = ? AND reader = ?', this.db.spaceId, this.name);
    return row ? Number(row.seq) : 0;
  }

  /** Faits pas encore traités. */
  pending(limit = 200): Fact[] {
    return factsAfter(this.db, this.position, limit);
  }

  /** Retient que tout est traité jusqu'au fait seq compris. */
  ack(seq: number): void {
    this.db.run(
      `INSERT INTO outbox_readers (space_id, reader, seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (space_id, reader) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
       WHERE outbox_readers.seq < excluded.seq`,
      this.db.spaceId, this.name, seq, new Date().toISOString(),
    );
  }
}
