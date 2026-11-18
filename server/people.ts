import type { LinkInfo, PersonDetail, PersonSummary, ResolvedAddress } from '../shared/types.js';
import type { BookingService } from './booking/service.js';
import type { Db } from './db.js';
import { addressOf, MODULE, parseAddress, uuidv7 } from './ids.js';
import type { Store } from './store.js';

// Annuaire des personnes et liens vers les objets des autres modules (phase 4, E4.2).
//
// Les fiches naissent des réservations (une par e-mail normalisé, voir upsertPerson). Les liens
// relient une adresse d'Alfred (personne, réservation, événement) à une autre adresse media://
// (une note Cairn, plus tard une tâche ou un fichier) ou à une page web. Toutes les requêtes
// filtrent sur l'espace : une donnée d'un autre espace n'est jamais visible.

export class PeopleError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string, readonly fields?: Record<string, string>) {
    super(message);
  }
}

interface PersonRow {
  id: string;
  email: string;
  name: string;
  phone: string;
  created_at: string;
  booking_count: number;
  next_at: string | null;
  last_at: string | null;
}

interface LinkRow {
  id: string;
  from_ref: string;
  to_ref: string;
  kind: string;
  title: string;
  url: string | null;
  created_at: string;
}

export interface PeopleOptions {
  db: Db;
  store: Store;
  booking: BookingService;
  /** Adresse de Cairn (sans barre finale) : ses liens de notes deviennent des adresses media://cairn/note/<id>. */
  cairnUrl: string;
  now?: () => Date;
  spaceId?: string;
}

const MAX_LINKS_PER_OBJECT = 50;

export class PeopleService {
  private readonly db: Db;
  private readonly spaceId: string;
  private readonly now: () => Date;

  constructor(private readonly opts: PeopleOptions) {
    this.db = opts.db;
    this.spaceId = opts.spaceId ?? opts.db.spaceId;
    this.now = opts.now ?? (() => new Date());
  }

  // --- personnes -----------------------------------------------------------

  /** Requête des fiches ; ses trois premiers paramètres sont : maintenant, maintenant, espace. */
  private summaryQuery(where: string): string {
    return `SELECT p.id, p.email, p.name, p.phone, p.created_at,
        (SELECT COUNT(*) FROM bookings b WHERE b.person_id = p.id AND b.space_id = p.space_id) AS booking_count,
        (SELECT MIN(b.start_utc) FROM bookings b WHERE b.person_id = p.id AND b.space_id = p.space_id
           AND b.status = 'confirmed' AND b.end_utc > ?) AS next_at,
        (SELECT MAX(b.start_utc) FROM bookings b WHERE b.person_id = p.id AND b.space_id = p.space_id
           AND b.status = 'confirmed' AND b.end_utc <= ?) AS last_at
      FROM people p WHERE p.space_id = ? ${where}`;
  }

  private toSummary(r: PersonRow): PersonSummary {
    return {
      id: r.id, address: addressOf('person', r.id), name: r.name, email: r.email, phone: r.phone,
      bookingCount: r.booking_count, nextAt: r.next_at, lastAt: r.last_at, createdAt: r.created_at,
    };
  }

  /** Fiches de l'espace, filtrées par nom, e-mail ou téléphone. Les plus récemment actives d'abord. */
  list(query = '', limit = 500): PersonSummary[] {
    const q = query.trim().toLowerCase().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const where = q ? "AND (lower(p.name) LIKE ? ESCAPE '\\' OR lower(p.email) LIKE ? ESCAPE '\\' OR lower(p.phone) LIKE ? ESCAPE '\\')" : '';
    const now = this.now().toISOString();
    const rows = this.db.all<PersonRow>(
      `SELECT * FROM (${this.summaryQuery(where)}) s ORDER BY COALESCE(s.next_at, s.last_at, s.created_at) DESC, s.id LIMIT ?`,
      now, now, this.spaceId, ...(q ? [like, like, like] : []), limit);
    // Prochain RDV d'abord (le plus proche en tête), puis les autres par activité récente.
    const upcoming = rows.filter((r) => r.next_at).sort((a, b) => a.next_at!.localeCompare(b.next_at!));
    return [...upcoming, ...rows.filter((r) => !r.next_at)].map((r) => this.toSummary(r));
  }

  private findRow(id: string): PersonRow | undefined {
    const now = this.now().toISOString();
    return this.db.get<PersonRow>(this.summaryQuery('AND p.id = ?'), now, now, this.spaceId, id);
  }

  get(id: string): PersonDetail {
    const row = this.findRow(id);
    if (!row) throw new PeopleError(404, 'not_found', 'Personne introuvable');
    const { upcoming, past } = this.opts.booking.bookingsForPerson(id);
    return { ...this.toSummary(row), upcoming, past, links: this.listLinks(addressOf('person', id)) };
  }

  // --- adresses ------------------------------------------------------------

  /** Adresse d'un événement : son UID iCalendar, qui ne change ni avec iCloud ni en changeant de calendrier. */
  eventAddress(eventId: string): string {
    const ev = this.opts.store.getEvent(eventId);
    if (!ev) throw new PeopleError(404, 'not_found', 'Événement introuvable');
    return addressOf('event', ev.uid);
  }

  /** Ce que désigne une adresse media://alfred/…, ou null si l'objet n'existe pas (ou pas dans cet espace). */
  resolve(address: string): ResolvedAddress | null {
    const a = parseAddress(address);
    if (!a || a.module !== MODULE) return null;
    const base = { address: addressOf(a.type, a.id), module: a.module, type: a.type, id: a.id };
    switch (a.type) {
      case 'person': {
        const row = this.findRow(a.id);
        return row ? { ...base, title: row.name || row.email, url: `/#personnes/${encodeURIComponent(a.id)}` } : null;
      }
      case 'booking': {
        const b = this.db.get('SELECT 1 AS ok FROM bookings WHERE id = ? AND space_id = ?', a.id, this.spaceId);
        const d = b ? this.opts.booking.describeBooking(a.id) : null;
        if (!d) return null;
        return { ...base, title: d.title, url: d.personId ? `/#personnes/${encodeURIComponent(d.personId)}` : '/#rendez-vous' };
      }
      case 'event': {
        const ev = this.db.get<{ id: string; summary: string; start_at: string }>(
          'SELECT id, summary, start_at FROM events WHERE uid = ? AND space_id = ? ORDER BY modified_at DESC, id LIMIT 1', a.id, this.spaceId);
        if (!ev) return null;
        return { ...base, title: ev.summary || 'Événement', url: '/' };
      }
      default:
        return null;
    }
  }

  // --- liens ---------------------------------------------------------------

  /** Cible d'un lien saisi par Antoine : une adresse media://, un lien de note Cairn, ou une page web. */
  parseTarget(input: string): { to: string; url: string | null; module: string } {
    const value = input.trim();
    if (!value || value.length > 2000) throw new PeopleError(400, 'invalid', 'Lien invalide', { target: 'Colle le lien d’une note Cairn ou d’une page web' });
    if (value.startsWith('media://')) {
      const a = parseAddress(value);
      if (!a) throw new PeopleError(400, 'invalid', 'Adresse invalide', { target: 'Adresse media:// mal formée' });
      const to = addressOf(a.type, a.id, a.module);
      return { to, url: this.urlFor(to), module: a.module };
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PeopleError(400, 'invalid', 'Lien invalide', { target: 'Colle le lien complet, qui commence par https://' });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PeopleError(400, 'invalid', 'Lien invalide', { target: 'Seuls les liens https:// sont acceptés' });
    }
    if (url.username || url.password) throw new PeopleError(400, 'invalid', 'Lien invalide', { target: 'Lien avec identifiants refusé' });
    const cairn = this.cairnNoteId(url);
    if (cairn) {
      const to = addressOf('note', cairn, 'cairn');
      return { to, url: this.urlFor(to), module: 'cairn' };
    }
    return { to: url.toString(), url: url.toString(), module: 'web' };
  }

  private cairnNoteId(url: URL): string | null {
    let cairn: URL;
    try {
      cairn = new URL(this.opts.cairnUrl);
    } catch {
      return null;
    }
    if (url.host !== cairn.host) return null;
    const m = /^\/notes\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
    return m ? m[1] : null;
  }

  /** Adresse web d'une cible : page de la note dans Cairn, page d'Alfred, ou la page elle-même. */
  private urlFor(to: string): string | null {
    const a = parseAddress(to);
    if (!a) return /^https?:\/\//.test(to) ? to : null;
    if (a.module === 'cairn' && a.type === 'note') return `${this.opts.cairnUrl}/notes/${encodeURIComponent(a.id)}`;
    if (a.module === MODULE) return this.resolve(to)?.url ?? null;
    return null;
  }

  private toLink(r: LinkRow, from: string): LinkInfo {
    const outgoing = r.from_ref === from;
    const to = outgoing ? r.to_ref : r.from_ref;
    const a = parseAddress(to);
    return {
      id: r.id, from, to, kind: r.kind, module: a ? a.module : 'web',
      title: r.title, url: outgoing ? (r.url ?? this.urlFor(to)) : this.urlFor(to), createdAt: r.created_at,
    };
  }

  /** Liens d'un objet, dans les deux sens (un lien posé depuis l'autre objet apparaît aussi). */
  listLinks(from: string): LinkInfo[] {
    const rows = this.db.all<LinkRow>('SELECT * FROM links WHERE space_id = ? AND (from_ref = ? OR to_ref = ?) ORDER BY created_at, id', this.spaceId, from, from);
    return rows.map((r) => this.toLink(r, from));
  }

  /** Relie un objet d'Alfred (qui doit exister) à une cible. Un lien déjà présent est renvoyé tel quel. */
  addLink(from: string, target: string, title = ''): LinkInfo {
    const source = this.resolve(from);
    if (!source) throw new PeopleError(404, 'not_found', 'Objet d’origine introuvable');
    const { to, url } = this.parseTarget(target);
    if (to === source.address) throw new PeopleError(400, 'invalid', 'Un objet ne peut pas être relié à lui-même', { target: 'Choisis un autre lien' });
    const cleanTitle = title.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const existing = this.db.get<LinkRow>("SELECT * FROM links WHERE space_id = ? AND from_ref = ? AND to_ref = ? AND kind = 'related'", this.spaceId, source.address, to);
    if (existing) return this.toLink(existing, source.address);
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE space_id = ? AND from_ref = ?', this.spaceId, source.address)!.n;
    if (count >= MAX_LINKS_PER_OBJECT) throw new PeopleError(409, 'too_many', `${MAX_LINKS_PER_OBJECT} liens au plus par objet`);
    const row: LinkRow = {
      id: uuidv7(), from_ref: source.address, to_ref: to, kind: 'related', title: cleanTitle,
      url: parseAddress(to) ? null : url, created_at: this.now().toISOString(),
    };
    this.db.run('INSERT INTO links (id, space_id, from_ref, to_ref, kind, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, this.spaceId, row.from_ref, row.to_ref, row.kind, row.title, row.url, row.created_at);
    return this.toLink(row, source.address);
  }

  removeLink(id: string): void {
    const res = this.db.run('DELETE FROM links WHERE id = ? AND space_id = ?', id, this.spaceId);
    if (res.changes === 0) throw new PeopleError(404, 'not_found', 'Lien introuvable');
  }
}
