import { DatabaseSync } from 'node:sqlite';

// Couche d'accès aux données d'Alfred (phase 4, ALFRED-297 et ALFRED-295).
//
// Tout le code métier passe par l'interface Sql : get, all, run, exec et tx, avec des paramètres
// positionnels « ? ». Deux moteurs la servent :
//   - SQLite (node:sqlite), en production aujourd'hui ;
//   - PostgreSQL (server/pg.ts), pour les tests et le passage à PostgreSQL de la suite.
//
// Règles d'écriture du SQL, pour qu'il tourne sur les deux :
//   - paramètres « ? » seulement (convertis en $1, $2… pour PostgreSQL) ;
//   - INSERT … ON CONFLICT (…) DO NOTHING / DO UPDATE, jamais INSERT OR IGNORE / OR REPLACE ;
//   - pas de PRAGMA, sqlite_master, COLLATE NOCASE, datetime() ni fonctions propres à un moteur :
//     lower(x) = lower(?) pour comparer sans la casse, dates en texte ISO calculées en JS ;
//   - les entiers sont des INTEGER dans le schéma (BIGINT sous PostgreSQL), les booléens des 0/1.
//
// Espaces : chaque vue Sql porte un espace (spaceId). Le code métier filtre toutes ses requêtes
// dessus (« AND space_id = ? ») et l'écrit dans toutes ses insertions. En test, la garde
// d'espace vérifie chaque requête : une requête qui lit ou écrit une table d'espace sans
// mentionner space_id lève une erreur. Une requête qui doit voir tous les espaces le dit avec
// le commentaire ALL_SPACES.

export type Dialect = 'sqlite' | 'postgres';
export type Param = string | number | bigint | null | Uint8Array;

/** Marque une requête qui travaille volontairement sur tous les espaces (maintenance, sessions). */
export const ALL_SPACES = '/* tous-espaces */';

/** Moteur sous-jacent : exécute du SQL déjà écrit pour lui. */
export interface Driver {
  readonly dialect: Dialect;
  get(sql: string, params: Param[]): Record<string, unknown> | undefined;
  all(sql: string, params: Param[]): Record<string, unknown>[];
  run(sql: string, params: Param[]): { changes: number };
  exec(sql: string): void;
  tables(): string[];
  columns(table: string): string[];
  close(): void;
}

export interface Statement {
  get<T = Record<string, unknown>>(...params: Param[]): T | undefined;
  all<T = Record<string, unknown>>(...params: Param[]): T[];
  run(...params: Param[]): { changes: number };
}

/** Tables sans space_id : la mécanique interne et la liste des espaces. */
export const SPACELESS_TABLES = new Set(['schema_migrations', 'spaces', 'sqlite_sequence']);

const DML_RE = /^\s*(?:\/\*.*?\*\/\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/is;
const TABLE_REF_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z0-9_]*)"?/gi;

class Shared {
  depth = 0;
  spaced: Set<string> | null = null;
  constructor(readonly driver: Driver, readonly guard: boolean) {}

  spacedTables(): Set<string> {
    if (!this.spaced) {
      this.spaced = new Set(this.driver.tables().filter((t) => !SPACELESS_TABLES.has(t) && this.driver.columns(t).includes('space_id')));
    }
    return this.spaced;
  }
}

/** Accès aux données dans un espace. */
export class Sql {
  private constructor(private readonly shared: Shared, readonly spaceId: string) {}

  static open(driver: Driver, spaceId: string, opts: { guard?: boolean } = {}): Sql {
    return new Sql(new Shared(driver, opts.guard ?? false), spaceId);
  }

  get dialect(): Dialect {
    return this.shared.driver.dialect;
  }

  /** La même base, vue depuis un autre espace (même connexion, mêmes transactions). */
  inSpace(spaceId: string): Sql {
    return new Sql(this.shared, spaceId);
  }

  private check(sql: string): void {
    if (!this.shared.guard || sql.includes(ALL_SPACES) || !DML_RE.test(sql)) return;
    const spaced = this.shared.spacedTables();
    let refs = 0;
    for (const m of sql.matchAll(TABLE_REF_RE)) if (spaced.has(m[1].toLowerCase())) refs++;
    if (refs === 0) return;
    const filters = sql.match(/\bspace_id\b/g)?.length ?? 0;
    if (filters < refs) throw new Error(`Requête sans filtre d'espace : ${sql.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    this.check(sql);
    return this.shared.driver.get(sql, params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    this.check(sql);
    return this.shared.driver.all(sql, params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    this.check(sql);
    return this.shared.driver.run(sql, params);
  }

  /** Instructions sans résultat ni paramètre (schéma, migrations). */
  exec(sql: string): void {
    this.shared.driver.exec(sql);
    if (/\b(CREATE|ALTER|DROP)\b/i.test(sql)) this.shared.spaced = null;
  }

  /**
   * Requête brute, sans garde d'espace : pour les tests et les scripts de maintenance.
   * Le code métier utilise get, all et run.
   */
  prepare(sql: string): Statement {
    const driver = this.shared.driver;
    return {
      get: <T>(...params: Param[]) => driver.get(sql, params) as T | undefined,
      all: <T>(...params: Param[]) => driver.all(sql, params) as T[],
      run: (...params: Param[]) => driver.run(sql, params),
    };
  }

  /** Exécute fn dans une transaction ; une transaction imbriquée devient un point de sauvegarde. */
  tx<T>(fn: () => T): T {
    const s = this.shared;
    const level = s.depth;
    s.driver.exec(level === 0 ? 'BEGIN' : `SAVEPOINT sp${level}`);
    s.depth++;
    try {
      const out = fn();
      s.depth--;
      s.driver.exec(level === 0 ? 'COMMIT' : `RELEASE SAVEPOINT sp${level}`);
      return out;
    } catch (err) {
      s.depth--;
      s.driver.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT sp${level}`);
      throw err;
    }
  }

  get inTransaction(): boolean {
    return this.shared.depth > 0;
  }

  tables(): string[] {
    return this.shared.driver.tables();
  }

  columns(table: string): string[] {
    return this.shared.driver.columns(table);
  }

  close(): void {
    this.shared.driver.close();
  }
}

/** Moteur SQLite (node:sqlite). */
export class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const;
  private readonly cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(readonly raw: DatabaseSync) {}

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql: string, params: Param[]) {
    return this.stmt(sql).get(...params) as Record<string, unknown> | undefined;
  }

  all(sql: string, params: Param[]) {
    return this.stmt(sql).all(...params) as Record<string, unknown>[];
  }

  run(sql: string, params: Param[]) {
    return { changes: Number(this.stmt(sql).run(...params).changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
    if (/\b(ALTER|DROP)\b/i.test(sql)) this.cache.clear();
  }

  tables(): string[] {
    return (this.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  }

  columns(table: string): string[] {
    return (this.raw.prepare(`PRAGMA table_info("${table.replace(/"/g, '')}")`).all() as { name: string }[]).map((c) => c.name);
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

/**
 * Traduit le schéma (écrit pour SQLite) pour PostgreSQL : entiers sur 64 bits, clé
 * auto-incrémentée en identité, PRAGMA retirés.
 */
export function ddlForPostgres(sql: string): string {
  return sql
    .replace(/^\s*PRAGMA[^;]*;\s*$/gim, '')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
    .replace(/\bINTEGER\b/g, 'BIGINT');
}

/** Remplace les « ? » (hors chaînes et commentaires) par $1, $2… */
export function numberedParams(sql: string): string {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === '?') {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}
