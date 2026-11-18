import { createRequire } from 'node:module';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { ddlForPostgres, numberedParams, type Driver, type Param } from './sql.js';

// Moteur PostgreSQL de la couche d'accès (server/sql.ts).
//
// Le code d'Alfred est synchrone (node:sqlite) ; le client PostgreSQL (pg) est asynchrone. Le
// client tourne donc dans un fil d'exécution à part, et chaque requête attend sa réponse avec
// Atomics.wait. C'est fait pour les tests et pour préparer le passage à PostgreSQL : le jour où
// Alfred tournera sur PostgreSQL en production, les services passeront en asynchrone et ce
// pont disparaîtra, le SQL restant le même.
//
// Une connexion par processus, partagée : chaque base ouverte est un schéma PostgreSQL à part
// (search_path), ce qui isole les tests les uns des autres.

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const { Client, types } = require(workerData.pgPath);
types.setTypeParser(20, (v) => Number(v));    // int8 : COUNT(*), BIGINT
types.setTypeParser(1700, (v) => Number(v));  // numeric
const { port, flag, url } = workerData;
const client = new Client({ connectionString: url });
const ready = client.connect();
let current = null;
port.on('message', async (msg) => {
  let reply;
  try {
    await ready;
    if (msg.schema && msg.schema !== current) {
      await client.query('CREATE SCHEMA IF NOT EXISTS "' + msg.schema + '"');
      await client.query('SET search_path TO "' + msg.schema + '"');
      current = msg.schema;
    }
    if (msg.op === 'close') {
      await client.end();
      reply = { ok: true };
    } else {
      const res = await client.query(msg.params ? { text: msg.sql, values: msg.params } : msg.sql);
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      reply = { ok: true, rows: last && last.rows ? last.rows.map((r) => ({ ...r })) : [], changes: last && typeof last.rowCount === 'number' ? last.rowCount : 0 };
    }
  } catch (err) {
    reply = { ok: false, message: err.message, code: err.code };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

interface Reply {
  ok: boolean;
  rows?: Record<string, unknown>[];
  changes?: number;
  message?: string;
  code?: string;
}

class Connection {
  private readonly flag = new Int32Array(new SharedArrayBuffer(4));
  private readonly port;
  private readonly worker: Worker;

  constructor(url: string) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const pgPath = createRequire(import.meta.url).resolve('pg');
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { port: port2, flag: this.flag, url, pgPath }, transferList: [port2] });
    this.worker.unref();
    this.port.unref();
  }

  call(msg: { schema: string; op?: 'close'; sql?: string; params?: Param[] }): Reply {
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(msg);
    if (Atomics.wait(this.flag, 0, 0, 60_000) === 'timed-out') throw new Error('PostgreSQL ne répond pas');
    const received = receiveMessageOnPort(this.port);
    if (!received) throw new Error('PostgreSQL : réponse perdue');
    const reply = received.message as Reply;
    if (!reply.ok) throw Object.assign(new Error(reply.message ?? 'Erreur PostgreSQL'), { code: reply.code });
    return reply;
  }
}

const connections = new Map<string, Connection>();

function normalize(params: Param[]): unknown[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'bigint' ? p.toString() : p instanceof Uint8Array ? Buffer.from(p) : p));
}

/** Base PostgreSQL vue comme un schéma (créé au besoin) d'une base existante. */
export class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const;
  private readonly conn: Connection;

  constructor(url: string, readonly schema: string) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Nom de schéma invalide : ${schema}`);
    let conn = connections.get(url);
    if (!conn) {
      conn = new Connection(url);
      connections.set(url, conn);
    }
    this.conn = conn;
  }

  private query(sql: string, params: Param[]): Reply {
    return this.conn.call({ schema: this.schema, sql: numberedParams(sql), params: normalize(params) as Param[] });
  }

  get(sql: string, params: Param[]) {
    return this.query(sql, params).rows![0];
  }

  all(sql: string, params: Param[]) {
    return this.query(sql, params).rows!;
  }

  run(sql: string, params: Param[]) {
    return { changes: this.query(sql, params).changes ?? 0 };
  }

  exec(sql: string): void {
    this.conn.call({ schema: this.schema, sql: ddlForPostgres(sql) });
  }

  tables(): string[] {
    return (this.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name", []) as { name: string }[]).map((r) => r.name);
  }

  columns(table: string): string[] {
    return (this.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position', [table]) as { name: string }[]).map((r) => r.name);
  }

  /** Supprime le schéma (bases de test). La connexion, partagée, reste ouverte. */
  drop(): void {
    this.conn.call({ schema: this.schema, sql: `DROP SCHEMA IF EXISTS "${this.schema}" CASCADE` });
  }

  close(): void {
    // Connexion partagée entre les bases du processus : rien à fermer ici.
  }
}
