import { uuidv7 } from './ids.js';
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
];

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
