import { DEFAULT_SPACE_ID } from './migrations.js';
import { isInstant, toInstant } from './instants.js';
import { ALL_SPACES, type Sql } from './sql.js';

// Réglages d'Alfred (phase 4, ALFRED-298) : une seule table `settings`, par espace et par module.
//
//   settings (space_id, module, key, value, secret, updated_at)   clé : (space_id, module, key)
//
// Modules : 'booking' (prise de rendez-vous), 'video' (visio), 'connections' (SMTP, iCloud,
// Stripe, états des essais), 'push' (notifications). secret = 1 marque une valeur secrète, jamais
// exportée ni renvoyée au navigateur : mots de passe et clés des connexions, déjà chiffrés par
// server/secrets.ts, et clés VAPID des notifications (propres à l'installation).
//
// Anciennes tables (booking_settings, video_settings, connection_settings, push_settings) : le
// code ne les lit plus, mais chaque écriture y est recopiée, pour que l'image précédente d'Alfred
// retrouve ses réglages après un retour arrière. Si cette image a tourné, ses changements sont
// repris au démarrage suivant (syncLegacySettings). Leur clé reste unique dans toute la base :
// seul l'espace qui possède une clé l'y recopie.

export type SettingsModule = 'booking' | 'video' | 'connections' | 'push';

/** Ancienne table de chaque module. */
export const LEGACY_SETTINGS_TABLES: Record<SettingsModule, string> = {
  booking: 'booking_settings',
  video: 'video_settings',
  connections: 'connection_settings',
  push: 'push_settings',
};

export interface SettingRow {
  key: string;
  value: string;
  secret: number;
}

/** Réglages d'un module, dans l'espace de db. */
export class Settings {
  constructor(private readonly db: Sql, readonly module: SettingsModule) {}

  private get legacy(): string {
    return LEGACY_SETTINGS_TABLES[this.module];
  }

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE space_id = ? AND module = ? AND key = ?', this.db.spaceId, this.module, key)?.value;
  }

  /** Tous les réglages du module, par clé. */
  all(): Map<string, string> {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings WHERE space_id = ? AND module = ? ORDER BY key', this.db.spaceId, this.module);
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  /** Vrai si au moins un réglage commence par prefix (« smtp. »). */
  hasPrefix(prefix: string): boolean {
    return Boolean(this.db.get('SELECT 1 AS ok FROM settings WHERE space_id = ? AND module = ? AND key LIKE ? LIMIT 1', this.db.spaceId, this.module, `${prefix}%`));
  }

  set(key: string, value: string, secret = false): void {
    const now = toInstant(Date.now());
    this.db.run(
      `INSERT INTO settings (space_id, module, key, value, secret, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (space_id, module, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
      this.db.spaceId, this.module, key, value, secret ? 1 : 0, now);
    // Copie pour l'image précédente (clé unique dans toute la base : on n'écrase pas un autre espace).
    if (this.module === 'connections') {
      this.db.run(
        `INSERT INTO connection_settings (key, value, secret, updated_at, space_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at
         WHERE connection_settings.space_id = excluded.space_id`,
        key, value, secret ? 1 : 0, now, this.db.spaceId);
    } else {
      this.db.run(
        `INSERT INTO ${this.legacy} (key, value, space_id) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE ${this.legacy}.space_id = excluded.space_id`,
        key, value, this.db.spaceId);
    }
  }

  delete(key: string): void {
    this.db.run('DELETE FROM settings WHERE space_id = ? AND module = ? AND key = ?', this.db.spaceId, this.module, key);
    this.db.run(`DELETE FROM ${this.legacy} WHERE key = ? AND space_id = ?`, key, this.db.spaceId);
  }

  /** Retire tous les réglages qui commencent par prefix (« caldav. »). */
  deletePrefix(prefix: string): void {
    this.db.run('DELETE FROM settings WHERE space_id = ? AND module = ? AND key LIKE ?', this.db.spaceId, this.module, `${prefix}%`);
    this.db.run(`DELETE FROM ${this.legacy} WHERE key LIKE ? AND space_id = ?`, `${prefix}%`, this.db.spaceId);
  }
}

/** Lignes d'une ancienne table, au format de settings (secret = 0 et date du jour si la table ne les a pas). */
function legacyRows(db: Sql, module: SettingsModule): { space_id: string; key: string; value: string; secret: number; updated_at: string }[] {
  const table = LEGACY_SETTINGS_TABLES[module];
  const cols = db.columns(table);
  if (cols.length === 0) return [];
  const extra = module === 'connections' ? ', secret, updated_at' : '';
  const rows = db.all<{ space_id?: string; key: string; value: string; secret?: number; updated_at?: string }>(
    `SELECT key, value${cols.includes('space_id') ? ', space_id' : ''}${extra} FROM ${table} ORDER BY key ${ALL_SPACES}`);
  const now = toInstant(Date.now());
  return rows.map((r) => ({
    space_id: r.space_id ?? DEFAULT_SPACE_ID,
    key: r.key,
    value: r.value,
    secret: Number(r.secret ?? 0),
    updated_at: isInstant(r.updated_at) ? r.updated_at : now,
  }));
}

/** Copie les anciennes tables dans settings (migration 7). */
export function copyLegacySettings(db: Sql): number {
  let n = 0;
  for (const module of Object.keys(LEGACY_SETTINGS_TABLES) as SettingsModule[]) {
    for (const r of legacyRows(db, module)) {
      db.run(
        `INSERT INTO settings (space_id, module, key, value, secret, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (space_id, module, key) DO NOTHING ${ALL_SPACES}`,
        r.space_id, module, r.key, r.value, r.secret, r.updated_at);
      n++;
    }
  }
  return n;
}

/**
 * Reprend dans settings ce que l'image précédente d'Alfred a changé dans les anciennes tables
 * (après un retour arrière). Tant que le code actuel tourne, chaque écriture est recopiée : toute
 * différence vient donc de l'image précédente, et l'ancienne table l'emporte. Seul l'espace par
 * défaut est concerné (l'image précédente ne connaît que lui). Renvoie le nombre de corrections.
 */
export function syncLegacySettings(db: Sql): number {
  if (!db.tables().includes('settings')) return 0;
  let fixed = 0;
  for (const module of Object.keys(LEGACY_SETTINGS_TABLES) as SettingsModule[]) {
    const legacy = legacyRows(db, module).filter((r) => r.space_id === DEFAULT_SPACE_ID);
    const current = new Map(db.all<SettingRow>(
      `SELECT key, value, secret FROM settings WHERE space_id = ? AND module = ? ${ALL_SPACES}`, DEFAULT_SPACE_ID, module).map((r) => [r.key, r]));
    for (const r of legacy) {
      const c = current.get(r.key);
      current.delete(r.key);
      if (c && c.value === r.value && Number(c.secret) === r.secret) continue;
      db.run(
        `INSERT INTO settings (space_id, module, key, value, secret, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (space_id, module, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at ${ALL_SPACES}`,
        DEFAULT_SPACE_ID, module, r.key, r.value, r.secret, r.updated_at);
      fixed++;
    }
    // Réglages retirés par l'image précédente.
    for (const key of current.keys()) {
      db.run(`DELETE FROM settings WHERE space_id = ? AND module = ? AND key = ? ${ALL_SPACES}`, DEFAULT_SPACE_ID, module, key);
      fixed++;
    }
  }
  return fixed;
}
