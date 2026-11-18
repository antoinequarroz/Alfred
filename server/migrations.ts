import { summarize } from './ics.js';
import { uuidv7 } from './ids.js';
import { INSTANT_COLUMNS, isInstant, toInstant } from './instants.js';
import { copyLegacySettings } from './settings.js';
import { syncEventAttendees } from './attendees.js';
import { ALL_SPACES, SPACELESS_TABLES, type Sql } from './sql.js';

// Migrations numérotées (phase 4 : données prêtes pour la suite Media).
//
// Le schéma de départ (CREATE TABLE IF NOT EXISTS de server/db.ts, puis les colonnes ajoutées
// au fil des versions) forme la base. À partir de là, chaque changement est une migration
// numérotée, appliquée une seule fois, dans une transaction, et enregistrée dans
// schema_migrations. Chacune a son retour arrière (down), testé dans test/migrations.test.ts.
//
// Règle de compatibilité : une migration n'enlève ni ne renomme rien de ce que lit le code
// précédent. On peut donc remettre l'image précédente d'Alfred sans restaurer la base : elle
// ignore les colonnes et tables nouvelles, et les valeurs par défaut remplissent space_id.

/** L'espace personnel d'Antoine : la seule valeur de space_id tant que la suite n'a pas d'espaces. */
export const DEFAULT_SPACE_ID = '01930000-0000-7000-8000-000000000001';

export interface Migration {
  version: number;
  name: string;
  up(db: Sql): void;
  down(db: Sql): void;
}

/** Tables qui ne portent pas de space_id : la mécanique interne et la liste des espaces. */
const SPACELESS = SPACELESS_TABLES;

function tables(db: Sql): string[] {
  return db.tables();
}

function hasColumn(db: Sql, table: string, column: string): boolean {
  return db.columns(table).includes(column);
}

/**
 * Ajoute space_id aux tables qui n'en ont pas encore, rempli avec l'espace par défaut.
 * Rejoué à chaque démarrage : une table créée plus tard (par une autre branche du code, par
 * exemple) reçoit aussi sa colonne, sans nouvelle migration.
 */
export function ensureSpaceColumns(db: Sql): void {
  if (!applied(db).has(1)) return;
  for (const table of tables(db)) {
    if (SPACELESS.has(table) || hasColumn(db, table, 'space_id')) continue;
    db.exec(`ALTER TABLE "${table}" ADD COLUMN space_id TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}'`);
  }
}

/** E-mail tel qu'il sert de clé dans l'annuaire : sans espaces autour, en minuscules. */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'espaces',
    up(db) {
      db.exec(`CREATE TABLE spaces (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.run('INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)', DEFAULT_SPACE_ID, 'Personnel', new Date().toISOString());
      for (const table of tables(db)) {
        if (SPACELESS.has(table) || hasColumn(db, table, 'space_id')) continue;
        db.exec(`ALTER TABLE "${table}" ADD COLUMN space_id TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}'`);
      }
    },
    down(db) {
      for (const table of tables(db)) {
        if (!SPACELESS.has(table) && hasColumn(db, table, 'space_id')) db.exec(`ALTER TABLE "${table}" DROP COLUMN space_id`);
      }
      db.exec('DROP TABLE spaces');
    },
  },
  {
    version: 2,
    name: 'personnes',
    up(db) {
      // Annuaire des personnes, au format de l'annuaire commun de la suite : une fiche par
      // e-mail normalisé et par espace. Les réservations gardent la copie figée du nom, de
      // l'e-mail et du téléphone donnés ce jour-là.
      db.exec(`CREATE TABLE people (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        email      TEXT NOT NULL,
        name       TEXT NOT NULL DEFAULT '',
        phone      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (space_id, email)
      )`);
      db.exec('ALTER TABLE bookings ADD COLUMN person_id TEXT');
      db.exec('CREATE INDEX bookings_person ON bookings(person_id)');
      // Réservations existantes : la plus ancienne crée la fiche, les suivantes la mettent à jour.
      const rows = db.all<{ id: string; email: string; name: string; phone: string; created_at: string; space_id: string }>(
        `SELECT id, email, name, phone, created_at, space_id FROM bookings ORDER BY created_at, id ${ALL_SPACES}`);
      for (const b of rows) {
        const personId = upsertPerson(db, { spaceId: b.space_id, email: b.email, name: b.name, phone: b.phone, at: b.created_at });
        if (personId) db.run('UPDATE bookings SET person_id = ? WHERE id = ? AND space_id = ?', personId, b.id, b.space_id);
      }
    },
    down(db) {
      db.exec('DROP INDEX bookings_person');
      db.exec('ALTER TABLE bookings DROP COLUMN person_id');
      db.exec('DROP TABLE people');
    },
  },
  {
    version: 3,
    name: 'liens',
    up(db) {
      // Liens entre deux adresses media:// (ou une adresse et une page web), au format de la
      // table de liens commune du socle : note Cairn ↔ événement, personne ↔ note…
      db.exec(`CREATE TABLE links (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        from_ref   TEXT NOT NULL,
        to_ref     TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'related',
        title      TEXT NOT NULL DEFAULT '',
        url        TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (space_id, from_ref, to_ref, kind)
      )`);
      db.exec('CREATE INDEX links_from ON links(space_id, from_ref)');
      db.exec('CREATE INDEX links_to ON links(space_id, to_ref)');
    },
    down(db) {
      db.exec('DROP TABLE links');
    },
  },
  {
    version: 4,
    name: 'acomptes',
    up(db) {
      // Paiement des acomptes (Stripe Checkout). Une réservation avec acompte commence par une
      // retenue : le créneau est bloqué pendant le paiement, la réservation n'est créée qu'une
      // fois le paiement abouti.
      db.exec(`CREATE TABLE payment_holds (
          id                TEXT PRIMARY KEY,
          space_id          TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
          ref_hash          TEXT NOT NULL UNIQUE,   -- SHA-256 de la référence de retour (/rdv/paiement/<ref>)
          status            TEXT NOT NULL,          -- 'pending' | 'paid' | 'completed' | 'expired'
          type_id           TEXT,
          type_name         TEXT NOT NULL,
          mode              TEXT NOT NULL,
          location          TEXT NOT NULL DEFAULT '',  -- précision du type (brute), comme booking_types.location
          buffer_before_min INTEGER NOT NULL DEFAULT 0,
          buffer_after_min  INTEGER NOT NULL DEFAULT 0,
          start_utc         TEXT NOT NULL,
          end_utc           TEXT NOT NULL,
          name              TEXT NOT NULL,
          email             TEXT NOT NULL,
          phone             TEXT NOT NULL DEFAULT '',
          message           TEXT NOT NULL DEFAULT '',
          token_hash        TEXT NOT NULL,          -- empreinte du jeton d'annulation de la future réservation
          cancel_token      TEXT,                   -- jeton en clair, le temps d'envoyer la confirmation ; effacé ensuite
          amount_cents      INTEGER NOT NULL,
          currency          TEXT NOT NULL,
          checkout_id       TEXT,                   -- session Stripe Checkout
          payment_intent    TEXT,
          booking_id        TEXT,
          created_at        TEXT NOT NULL,
          expires_at        TEXT NOT NULL,          -- fin de validité de la page de paiement
          last_error        TEXT
      )`);
      db.exec('CREATE INDEX payment_holds_status ON payment_holds(status)');
      // Montant par type, et paiement de chaque réservation (NULL : pas d'acompte).
      db.exec('ALTER TABLE booking_types ADD COLUMN deposit_cents INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE bookings ADD COLUMN payment_amount_cents INTEGER');
      db.exec('ALTER TABLE bookings ADD COLUMN payment_currency TEXT');
      db.exec('ALTER TABLE bookings ADD COLUMN payment_intent TEXT');
      db.exec("ALTER TABLE bookings ADD COLUMN payment_status TEXT"); // 'paid' | 'refunded' | 'refund_failed'
      db.exec('ALTER TABLE bookings ADD COLUMN payment_error TEXT');
    },
    down(db) {
      for (const c of ['payment_error', 'payment_status', 'payment_intent', 'payment_currency', 'payment_amount_cents']) db.exec(`ALTER TABLE bookings DROP COLUMN ${c}`);
      db.exec('ALTER TABLE booking_types DROP COLUMN deposit_cents');
      db.exec('DROP TABLE payment_holds');
    },
  },
  {
    version: 5,
    name: 'journal',
    up(db) {
      // Journal d'événements (boîte d'envoi) : les faits d'Alfred au format commun de la suite,
      // écrits dans la même transaction que le changement qu'ils décrivent. Voir server/outbox.ts
      // et docs/JOURNAL.md. seq donne l'ordre d'écriture ; chaque lecteur garde sa position.
      db.exec(`CREATE TABLE outbox (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,      -- UUID v7 du fait
        space_id     TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        source       TEXT NOT NULL,             -- module qui écrit : 'alfred'
        type         TEXT NOT NULL,             -- 'booking.created', 'payment.received'…
        subject      TEXT NOT NULL,             -- adresse media:// de l'objet concerné
        occurred_at  TEXT NOT NULL,             -- instant ISO UTC du fait
        data         TEXT NOT NULL,             -- détails, JSON
        data_version INTEGER NOT NULL DEFAULT 1
      )`);
      db.exec('CREATE INDEX outbox_space_seq ON outbox(space_id, seq)');
      db.exec(`CREATE TABLE outbox_readers (
        space_id   TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        reader     TEXT NOT NULL,              -- 'push'…
        seq        INTEGER NOT NULL,           -- dernier fait traité
        updated_at TEXT NOT NULL,
        PRIMARY KEY (space_id, reader)
      )`);
    },
    down(db) {
      db.exec('DROP TABLE outbox_readers');
      db.exec('DROP TABLE outbox');
    },
  },
  {
    version: 6,
    name: 'instants',
    up(db) {
      // Un seul format d'instant (texte ISO UTC, voir server/instants.ts) et le fuseau à côté de
      // chaque heure locale. Les colonnes en millisecondes restent, écrites mais plus lues, pour
      // que l'image précédente d'Alfred fonctionne encore sans restaurer la base.
      for (const c of ['start_at', 'end_at', 'recur_end_at', 'modified_at', 'tzid']) db.exec(`ALTER TABLE events ADD COLUMN ${c} TEXT`);
      const events = db.all<{ id: string; ics: string; start_ms: number; end_ms: number; recur_end_ms: number | null; updated_at: number }>(
        `SELECT id, ics, start_ms, end_ms, recur_end_ms, updated_at FROM events ORDER BY id ${ALL_SPACES}`);
      for (const e of events) {
        let tzid: string | null = null;
        try {
          tzid = summarize(e.ics).tzid;
        } catch {
          // iCalendar illisible : l'événement est déjà ignoré à l'affichage, il garde un fuseau vide.
        }
        db.run(`UPDATE events SET start_at = ?, end_at = ?, recur_end_at = ?, modified_at = ?, tzid = ? WHERE id = ? ${ALL_SPACES}`,
          toInstant(Number(e.start_ms)), toInstant(Number(e.end_ms)), e.recur_end_ms === null ? null : toInstant(Number(e.recur_end_ms)),
          toInstant(Number(e.updated_at)), tzid, e.id);
      }
      db.exec('CREATE INDEX events_span ON events(space_id, start_at, end_at)');

      db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT');
      for (const s of db.all<{ id: string; expires_ms: number }>(`SELECT id, expires_ms FROM sessions ${ALL_SPACES}`)) {
        db.run(`UPDATE sessions SET expires_at = ? WHERE id = ? ${ALL_SPACES}`, toInstant(Number(s.expires_ms)), s.id);
      }

      // Horaires d'ouverture : minutes depuis minuit dans ce fuseau.
      db.exec(`ALTER TABLE booking_hours ADD COLUMN tzid TEXT NOT NULL DEFAULT '${defaultTimezone()}'`);

      // Les colonnes déjà en texte ISO : toutes mises au format exact (millisecondes, Z).
      normalizeInstants(db);
    },
    down(db) {
      db.exec('ALTER TABLE booking_hours DROP COLUMN tzid');
      db.exec('ALTER TABLE sessions DROP COLUMN expires_at');
      db.exec('DROP INDEX events_span');
      for (const c of ['tzid', 'modified_at', 'recur_end_at', 'end_at', 'start_at']) db.exec(`ALTER TABLE events DROP COLUMN ${c}`);
    },
  },
  {
    version: 7,
    name: 'reglages',
    up(db) {
      // Une seule table de réglages, par espace et par module (voir server/settings.ts). Les
      // anciennes tables restent, recopiées à chaque écriture, pour l'image précédente d'Alfred.
      db.exec(`CREATE TABLE settings (
        space_id   TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        module     TEXT NOT NULL,             -- 'booking' | 'video' | 'connections' | 'push'
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        secret     INTEGER NOT NULL DEFAULT 0, -- 1 : valeur chiffrée (server/secrets.ts)
        updated_at TEXT NOT NULL,
        PRIMARY KEY (space_id, module, key)
      )`);
      copyLegacySettings(db);
    },
    down(db) {
      db.exec('DROP TABLE settings');
    },
  },
  {
    version: 8,
    name: 'participations',
    up(db) {
      // Qui a rejoint quelle salle de visio, et quand (server/video/service.ts). L'arrivée est
      // notée quand Alfred remet le jeton d'entrée ; le passage régulier auprès du serveur de
      // visio note la dernière présence vue (seen_at), puis le départ (left_at).
      db.exec(`CREATE TABLE video_participations (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        room_id    TEXT NOT NULL,
        identity   TEXT NOT NULL,             -- 'host' ou 'invite-…' (identité dans la salle)
        role       TEXT NOT NULL,             -- 'host' (le compte d'Alfred) | 'guest'
        name       TEXT NOT NULL DEFAULT '',
        person_id  TEXT,                      -- fiche de l'invité, quand la salle est celle d'un rendez-vous
        joined_at  TEXT NOT NULL,
        seen_at    TEXT,
        left_at    TEXT
      )`);
      db.exec('CREATE INDEX video_participations_room ON video_participations(space_id, room_id)');
      db.exec('CREATE INDEX video_participations_person ON video_participations(space_id, person_id)');
      // Invités des événements (server/attendees.ts), reconnus comme Personnes par leur e-mail.
      db.exec(`CREATE TABLE event_attendees (
        space_id   TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}',
        event_id   TEXT NOT NULL,
        email      TEXT NOT NULL,
        name       TEXT NOT NULL DEFAULT '',
        partstat   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (space_id, event_id, email)
      )`);
      db.exec('CREATE INDEX event_attendees_email ON event_attendees(space_id, email)');
      db.exec('ALTER TABLE events ADD COLUMN attendees_at TEXT');
      syncEventAttendees(db);
    },
    down(db) {
      db.exec('ALTER TABLE events DROP COLUMN attendees_at');
      db.exec('DROP TABLE event_attendees');
      db.exec('DROP TABLE video_participations');
    },
  },
];

/** Fuseau d'Alfred tel que le lit server/config.ts, pour les lignes écrites avant ALFRED-296. */
function defaultTimezone(): string {
  const tz = process.env.ALFRED_TIMEZONE || process.env.TZ || 'Europe/Zurich';
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz) ? tz : 'Europe/Zurich';
}

/** Réécrit au format canonique tout instant texte qui ne l'est pas (sans millisecondes, avec décalage…). */
export function normalizeInstants(db: Sql): number {
  let fixed = 0;
  const present = new Set(db.tables());
  for (const [table, columns] of Object.entries(INSTANT_COLUMNS)) {
    if (!present.has(table)) continue;
    const have = db.columns(table);
    const key = have.includes('id') ? 'id' : have.includes('token_hash') ? 'token_hash' : have.includes('seq') ? 'seq' : have.includes('key') ? 'key' : have.includes('version') ? 'version' : null;
    for (const column of columns) {
      if (!have.includes(column) || !key) continue;
      const rows = db.all<Record<string, unknown>>(`SELECT ${key} AS k, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL ${ALL_SPACES}`);
      for (const r of rows) {
        if (isInstant(r.v)) continue;
        const ms = Date.parse(String(r.v));
        if (!Number.isFinite(ms)) continue; // illisible : laissé tel quel plutôt qu'inventé
        db.run(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ? ${ALL_SPACES}`, new Date(ms).toISOString(), r.k as string | number);
        fixed++;
      }
    }
  }
  return fixed;
}

/**
 * Crée ou met à jour la fiche d'une personne d'après ce qu'elle vient de donner (réservation).
 * Le nom et le téléphone suivent la dernière réservation ; un téléphone vide n'efface pas celui
 * déjà connu. Renvoie l'identifiant de la fiche, ou null si l'e-mail est vide.
 */
export function upsertPerson(db: Sql, p: { spaceId: string; email: string; name: string; phone: string; at: string }): string | null {
  const email = normalizeEmail(p.email);
  if (!email) return null;
  const existing = db.get<{ id: string }>('SELECT id FROM people WHERE space_id = ? AND email = ?', p.spaceId, email);
  if (existing) {
    db.run(
      `UPDATE people SET name = CASE WHEN ? <> '' THEN ? ELSE name END,
         phone = CASE WHEN ? <> '' THEN ? ELSE phone END, updated_at = ? WHERE id = ? AND space_id = ?`,
      p.name.trim(), p.name.trim(), p.phone.trim(), p.phone.trim(), p.at, existing.id, p.spaceId);
    return existing.id;
  }
  const id = uuidv7(Date.parse(p.at) || Date.now());
  db.run('INSERT INTO people (id, space_id, email, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, p.spaceId, email, p.name.trim(), p.phone.trim(), p.at, p.at);
  return id;
}

function ensureTable(db: Sql): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

export function applied(db: Sql): Set<number> {
  ensureTable(db);
  const rows = db.all<{ version: number }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

/** Version courante du schéma : la plus haute migration appliquée (0 : schéma de départ). */
export function schemaVersion(db: Sql): number {
  return Math.max(0, ...applied(db));
}

function inTransaction(db: Sql, fn: () => void): void {
  db.tx(fn);
}

/** Applique, dans l'ordre, les migrations qui ne l'ont pas encore été (jusqu'à target incluse). */
export function migrateUp(db: Sql, target = Infinity, list: Migration[] = MIGRATIONS): number[] {
  const done = applied(db);
  const ran: number[] = [];
  for (const m of [...list].sort((a, b) => a.version - b.version)) {
    if (m.version > target || done.has(m.version)) continue;
    inTransaction(db, () => {
      m.up(db);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, new Date().toISOString());
    });
    ran.push(m.version);
  }
  return ran;
}

/** Défait, de la plus récente à la plus ancienne, les migrations appliquées au-dessus de target. */
export function migrateDown(db: Sql, target: number, list: Migration[] = MIGRATIONS): number[] {
  const done = applied(db);
  const undone: number[] = [];
  for (const m of [...list].sort((a, b) => b.version - a.version)) {
    if (m.version <= target || !done.has(m.version)) continue;
    inTransaction(db, () => {
      m.down(db);
      db.run('DELETE FROM schema_migrations WHERE version = ?', m.version);
    });
    undone.push(m.version);
  }
  return undone;
}
