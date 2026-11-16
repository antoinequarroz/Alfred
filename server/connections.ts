import type {
  CaldavConnectionState, CaldavSaveResult, ConnectionField, ConnectionSecret, ConnectionsState, ConnectionTest,
  SettingSource, SmtpConnectionState, SmtpSaveResult,
} from '../shared/types.js';
import { createDisabledMailer, createDynamicMailer, createSmtpMailer, testMessage, type Mailer, type MailContext, type SmtpOptions } from './booking/mail.js';
import { probeCaldav, type CaldavOptions, type CaldavSync, type ProbeResult } from './caldav.js';
import { tx, type Db } from './db.js';
import { describeSmtpError, redact } from './diagnostics.js';
import { checkHostSyntax, guardedFetch, HostRefusedError, resolveGuarded, type Resolver } from './netguard.js';
import { SecretKeyError, type SecretBox } from './secrets.js';
import type { Store } from './store.js';

/**
 * Réglages de connexion (SMTP et CalDAV) modifiables depuis l'app.
 *
 * Priorité, réglage par réglage : valeur enregistrée dans l'app (table connection_settings),
 * sinon variable d'environnement (fichier .env), sinon valeur par défaut. Les mots de passe
 * sont chiffrés en base et ne ressortent jamais : ni dans l'état renvoyé à l'app, ni dans
 * une erreur, ni dans un journal.
 */

/** Refus affichable : statut HTTP, code stable, message, et erreurs par champ pour une saisie invalide. */
export class ConnectionError extends Error {
  constructor(
    readonly status: 400 | 409 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    /** Nature de la panne quand un essai de connexion a échoué (« auth », « timeout »…). */
    readonly reason?: string,
  ) {
    super(message);
  }
}

export interface ConnectionEnv {
  smtp: { host?: string; port?: string; user?: string; password?: string; from?: string; notifyTo?: string };
  caldav: { url?: string; username?: string; password?: string };
}

export const SMTP_DEFAULTS = { host: 'mail.infomaniak.com', port: '587', from: 'Antoine Quarroz <info@antoinequarroz.ch>' };
export const CALDAV_DEFAULT_URL = 'https://caldav.icloud.com';

export interface ConnectionsOptions {
  store: Store;
  secrets: SecretBox;
  caldav: CaldavSync;
  env?: ConnectionEnv;
  /** Développement : accepte les hôtes internes et un serveur CalDAV en http. */
  allowPrivateHosts?: boolean;
  /** STARTTLS obligatoire hors port 465 (vrai par défaut ; SMTP_REQUIRE_TLS=0 pour un serveur de test local). */
  smtpRequireTls?: boolean;
  /** Durée maximale d'un envoi (ms). */
  smtpTimeoutMs?: number;
  /** Durée maximale d'un essai de connexion CalDAV (ms). */
  caldavTimeoutMs?: number;
  /** Résolution DNS de remplacement (tests). */
  resolver?: Resolver;
  /** Essai de connexion CalDAV de remplacement (tests). */
  probe?: (opts: CaldavOptions, timeoutMs: number) => Promise<ProbeResult>;
}

const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
/** Mot de passe d'application Apple : 16 lettres minuscules, avec ou sans tirets tous les quatre. */
const APPLE_PASSWORD_RE = /^[a-z]{4}(-?)[a-z]{4}\1[a-z]{4}\1[a-z]{4}$/;

const SMTP_FIELDS = ['host', 'port', 'user', 'password', 'from', 'notifyTo'] as const;
type SmtpField = (typeof SMTP_FIELDS)[number];
const CALDAV_FIELDS = ['url', 'username', 'password'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** « Nom <adresse> » ou adresse seule → nom et adresse ; null si la forme est invalide. */
export function parseSender(value: string): { name: string; address: string } | null {
  const text = value.trim();
  const m = /^(.*)<([^<>\s]+)>$/.exec(text);
  const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  const address = m ? m[2] : text;
  if (!EMAIL_RE.test(address) || address.length > 254 || name.length > 100 || /[<>"\\]/.test(name)) return null;
  return { name, address };
}

const formatSender = (s: { name: string; address: string }) => (s.name ? `${s.name} <${s.address}>` : s.address);

/** Adresse d'un serveur CalDAV, sous une forme comparable (sans barre finale, hôte en minuscules). */
function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

const sameAccount = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface ResolvedSecret {
  value: string;
  state: ConnectionSecret;
}

export class ConnectionsService {
  private readonly db: Db;
  private readonly store: Store;
  private readonly secrets: SecretBox;
  private readonly caldav: CaldavSync;
  private readonly env: ConnectionEnv;
  private readonly allowPrivate: boolean;
  private readonly requireTls: boolean;
  private readonly smtpTimeoutMs: number;
  private readonly caldavTimeoutMs: number;
  private readonly resolver?: Resolver;
  private readonly probe: (opts: CaldavOptions, timeoutMs: number) => Promise<ProbeResult>;
  private cachedMailer: Mailer | null = null;
  private smtpTest: ConnectionTest | null = null;
  private caldavTest: ConnectionTest | null = null;
  /** Une seule modification CalDAV à la fois (essai de connexion puis enregistrement). */
  private caldavBusy = false;
  /** Synchro lancée après le dernier changement d'identifiants (pour les tests). */
  pendingSync: Promise<void> = Promise.resolve();
  /** Contexte de l'e-mail d'essai (nom public, adresse d'Alfred), branché par le serveur sur la prise de rendez-vous. */
  mailContext: () => MailContext = () => ({ publicName: '', timezone: 'Europe/Zurich', publicUrl: '' });

  /** Expéditeur toujours à jour : il suit les réglages sans redémarrage. */
  readonly mailer: Mailer = createDynamicMailer(() => this.currentMailer());

  constructor(opts: ConnectionsOptions) {
    this.store = opts.store;
    this.db = opts.store.db;
    this.secrets = opts.secrets;
    this.caldav = opts.caldav;
    this.env = opts.env ?? { smtp: {}, caldav: {} };
    this.allowPrivate = opts.allowPrivateHosts ?? false;
    this.requireTls = opts.smtpRequireTls ?? true;
    this.smtpTimeoutMs = opts.smtpTimeoutMs ?? 45_000;
    this.caldavTimeoutMs = opts.caldavTimeoutMs ?? 20_000;
    this.resolver = opts.resolver;
    this.probe = opts.probe ?? probeCaldav;
  }

  // --- lecture -------------------------------------------------------------

  private row(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM connection_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  private put(key: string, value: string, secret = false): void {
    this.db.prepare(
      'INSERT INTO connection_settings (key, value, secret, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at',
    ).run(key, value, secret ? 1 : 0, new Date().toISOString());
  }

  private drop(key: string): void {
    this.db.prepare('DELETE FROM connection_settings WHERE key = ?').run(key);
  }

  private hasAppValues(group: 'smtp' | 'caldav'): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM connection_settings WHERE key LIKE ? LIMIT 1').get(`${group}.%`));
  }

  private field(key: string, envValue: string | undefined, fallback?: string): ConnectionField {
    const app = this.row(key);
    if (app !== undefined && app !== '') return { value: app, source: 'app' };
    if (envValue) return { value: envValue, source: 'env' };
    if (fallback) return { value: fallback, source: 'default' };
    return { value: '', source: 'none' };
  }

  /** Un secret illisible (clé absente ou différente) compte comme non configuré : pas de repli silencieux sur le .env. */
  private secret(key: string, envValue: string | undefined): ResolvedSecret {
    const app = this.row(key);
    if (app !== undefined) {
      const value = this.secrets.open(key, app);
      if (value === null) return { value: '', state: { configured: false, source: 'app', unreadable: true } };
      return { value, state: { configured: true, source: 'app', unreadable: false } };
    }
    if (envValue) return { value: envValue, state: { configured: true, source: 'env', unreadable: false } };
    return { value: '', state: { configured: false, source: 'none', unreadable: false } };
  }

  private smtpFields() {
    const e = this.env.smtp;
    const envPort = e.port && /^\d{1,5}$/.test(e.port) && Number(e.port) >= 1 && Number(e.port) <= 65_535 ? e.port : undefined;
    const envFrom = e.from && parseSender(e.from) ? e.from : undefined;
    const host = this.field('smtp.host', e.host, SMTP_DEFAULTS.host);
    const port = this.field('smtp.port', envPort, SMTP_DEFAULTS.port);
    const user = this.field('smtp.user', e.user);
    const password = this.secret('smtp.password', e.password);
    const from = this.field('smtp.from', envFrom, SMTP_DEFAULTS.from);
    const sender = parseSender(from.value) ?? parseSender(SMTP_DEFAULTS.from)!;
    let notifyTo = this.field('smtp.notifyTo', e.notifyTo && EMAIL_RE.test(e.notifyTo) ? e.notifyTo : undefined);
    if (!notifyTo.value) notifyTo = { value: sender.address, source: 'default' };
    return { host, port, user, password, from, sender, notifyTo };
  }

  /** Options d'envoi du moment, ou null si l'identifiant ou le mot de passe manque. */
  smtpOptions(): SmtpOptions | null {
    const f = this.smtpFields();
    if (!f.user.value || !f.password.value) return null;
    const port = Number(f.port.value);
    return {
      host: f.host.value, port, secure: port === 465, requireTls: this.requireTls, totalTimeoutMs: this.smtpTimeoutMs,
      user: f.user.value, password: f.password.value, from: f.sender, notifyTo: f.notifyTo.value,
      // Un hôte saisi dans l'app est revérifié à chaque envoi ; celui du .env est de confiance.
      guard: f.host.source === 'app' ? { allowInternal: this.allowPrivate } : undefined,
    };
  }

  private currentMailer(): Mailer {
    if (!this.cachedMailer) {
      const options = this.smtpOptions();
      if (options) this.cachedMailer = createSmtpMailer(options);
      else {
        const f = this.smtpFields();
        this.cachedMailer = createDisabledMailer(formatSender(f.sender), f.notifyTo.value);
      }
    }
    return this.cachedMailer;
  }

  private caldavFields() {
    const e = this.env.caldav;
    return {
      url: this.field('caldav.url', e.url, CALDAV_DEFAULT_URL),
      username: this.field('caldav.username', e.username),
      password: this.secret('caldav.password', e.password),
    };
  }

  private caldavOptionsFor(url: ConnectionField, username: string, password: string): CaldavOptions {
    return {
      serverUrl: url.value, username, password,
      // Une adresse saisie dans l'app passe par le garde-fou réseau à chaque requête ; celle du .env est de confiance.
      fetch: url.source === 'app' ? guardedFetch(this.allowPrivate, this.resolver) : undefined,
    };
  }

  /** Identifiants CalDAV du moment, ou null s'il en manque. */
  caldavOptions(): CaldavOptions | null {
    const f = this.caldavFields();
    if (!f.username.value || !f.password.value) return null;
    return this.caldavOptionsFor(f.url, f.username.value, f.password.value);
  }

  private syncedCalendarUrls(): string[] {
    return this.store.listCalendars().filter((c) => c.source === 'caldav' && c.url).map((c) => c.url!);
  }

  state(): ConnectionsState {
    const s = this.smtpFields();
    const smtp: SmtpConnectionState = {
      configured: Boolean(s.user.value && s.password.value),
      host: s.host, port: s.port, user: s.user, password: s.password.state, from: s.from, notifyTo: s.notifyTo,
      hasAppValues: this.hasAppValues('smtp'),
      lastTest: this.smtpTest,
    };
    const c = this.caldavFields();
    const events = (this.db.prepare("SELECT COUNT(*) AS n FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.source = 'caldav'").get() as { n: number }).n;
    const caldav: CaldavConnectionState = {
      configured: Boolean(c.username.value && c.password.value),
      url: c.url, username: c.username, password: c.password.state,
      hasAppValues: this.hasAppValues('caldav'),
      accountLocked: this.accountLocked(c),
      canRevertToEnv: this.hasAppValues('caldav') && this.envCaldavMatches(c.username.value, c.url.value),
      sync: this.caldav.getStatus(),
      calendars: this.syncedCalendarUrls().length,
      events,
      lastTest: this.caldavTest,
    };
    const key = this.secrets.status();
    const notices: string[] = [];
    const lost = 'ne peut plus être déchiffré (la clé de chiffrement est absente ou n’est plus la même, par exemple après une restauration sans le fichier de clé)';
    if (s.password.state.unreadable) notices.push(`Le mot de passe d’envoi des e-mails enregistré dans l’app ${lost}. Ressaisis-le : en attendant, aucun e-mail ne part.`);
    if (c.password.state.unreadable) notices.push(`Le mot de passe d’application iCloud enregistré dans l’app ${lost}. Ressaisis-le : en attendant, la synchro est arrêtée.`);
    if (key.problem) notices.push(key.problem);
    return { smtp, caldav, secretKey: key, notices };
  }

  /** Retire d'un texte destiné au journal les mots de passe de connexion du moment. */
  redact(value: string): string {
    return redact(value, [this.smtpFields().password.value, this.caldavFields().password.value, this.env.smtp.password ?? '', this.env.caldav.password ?? '']);
  }

  // --- SMTP ----------------------------------------------------------------

  private seal(key: string, value: string): string {
    try {
      return this.secrets.seal(key, value);
    } catch (err) {
      if (err instanceof SecretKeyError) throw new ConnectionError(503, 'secret_key', `Impossible de chiffrer le mot de passe : ${err.message}`);
      throw err;
    }
  }

  /**
   * Enregistre les réglages SMTP fournis (les champs absents ne bougent pas). Un champ vide,
   * ou égal à la valeur du .env ou par défaut, retire le réglage de l'app. Mot de passe vide :
   * l'actuel est gardé. Aucun message d'erreur ne reprend une valeur saisie.
   */
  async saveSmtp(body: unknown): Promise<void> {
    if (!isObject(body)) throw new ConnectionError(400, 'invalid', 'Corps de requête invalide', { _: 'Corps de requête invalide' });
    const fields: Record<string, string> = {};
    const e = this.env.smtp;
    const changes: [SmtpField, string | null][] = [];
    const text = (name: SmtpField, max: number, label: string): string | undefined => {
      if (!(name in body) || body[name] === undefined || body[name] === null) return undefined;
      const v = body[name];
      if (typeof v !== 'string' || v.length > max || CONTROL_RE.test(v)) {
        fields[name] = `${label} : ${max} caractères au plus, sur une seule ligne`;
        return undefined;
      }
      return v.trim();
    };

    const host = text('host', 253, 'Serveur');
    if (host !== undefined) {
      if (host === '') changes.push(['host', null]);
      else {
        const lower = host.toLowerCase();
        const problem = checkHostSyntax(lower, this.allowPrivate);
        if (problem === 'syntax') fields.host = 'Serveur : un nom de domaine (mail.exemple.ch) ou une adresse IP';
        else if (problem === 'internal') fields.host = 'Serveur : les adresses internes ou privées sont refusées';
        else if (lower === (e.host ?? SMTP_DEFAULTS.host).toLowerCase()) changes.push(['host', null]);
        else {
          try {
            await resolveGuarded(lower, this.allowPrivate, this.resolver);
            changes.push(['host', lower]);
          } catch (err) {
            // Introuvable pour l'instant : l'enregistrement reste possible, l'essai d'envoi le dira.
            if (err instanceof HostRefusedError && err.reason === 'internal') fields.host = 'Serveur : ce nom désigne une adresse interne ou privée, refusée';
            else changes.push(['host', lower]);
          }
        }
      }
    }

    if ('port' in body && body.port !== undefined && body.port !== null) {
      const raw = body.port;
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : raw === '' ? null : NaN;
      if (n === null) changes.push(['port', null]);
      else if (!Number.isInteger(n) || n < 1 || n > 65_535) fields.port = 'Port : un nombre entre 1 et 65535 (587 ou 465 en général)';
      else changes.push(['port', String(n) === (e.port ?? SMTP_DEFAULTS.port) ? null : String(n)]);
    }

    const user = text('user', 254, 'Identifiant');
    if (user !== undefined) changes.push(['user', user === '' || user === e.user ? null : user]);

    const from = text('from', 360, 'Expéditeur');
    if (from !== undefined) {
      if (from === '') changes.push(['from', null]);
      else {
        const sender = parseSender(from);
        if (!sender) fields.from = 'Expéditeur : « Nom <adresse@exemple.ch> » ou une adresse seule';
        else {
          const canonical = formatSender(sender);
          const fallback = parseSender(e.from ?? '') ?? parseSender(SMTP_DEFAULTS.from)!;
          changes.push(['from', canonical === formatSender(fallback) ? null : canonical]);
        }
      }
    }

    const notifyTo = text('notifyTo', 254, 'Adresse des avis');
    if (notifyTo !== undefined) {
      if (notifyTo === '') changes.push(['notifyTo', null]);
      else if (!EMAIL_RE.test(notifyTo)) fields.notifyTo = 'Adresse des avis : une adresse e-mail valide';
      else changes.push(['notifyTo', notifyTo === e.notifyTo ? null : notifyTo]);
    }

    const password = text('password', 1024, 'Mot de passe');
    // Vide : on garde le mot de passe actuel.
    if (password !== undefined && password !== '') changes.push(['password', password === e.password ? null : password]);

    if (Object.keys(fields).length > 0) throw new ConnectionError(400, 'invalid', Object.values(fields)[0], fields);

    const sealed = changes.map(([name, value]): [SmtpField, string | null] => [name, name === 'password' && value !== null ? this.seal('smtp.password', value) : value]);
    tx(this.db, () => {
      for (const [name, value] of sealed) {
        if (value === null) this.drop(`smtp.${name}`);
        else this.put(`smtp.${name}`, value, name === 'password');
      }
    });
    this.cachedMailer = null;
    this.smtpTest = null;
    if (changes.length > 0) console.log(`[alfred] réglages d’envoi des e-mails modifiés dans l’app (${changes.map(([name]) => name).join(', ')})`);
  }

  /** Retire un réglage SMTP de l'app (ou tous) : le .env ou la valeur par défaut reprend la main. */
  clearSmtp(field?: string): void {
    if (field !== undefined && !(SMTP_FIELDS as readonly string[]).includes(field)) throw new ConnectionError(400, 'invalid', 'Réglage inconnu');
    if (field) this.drop(`smtp.${field}`);
    else this.db.prepare("DELETE FROM connection_settings WHERE key LIKE 'smtp.%'").run();
    this.cachedMailer = null;
    this.smtpTest = null;
    console.log(`[alfred] réglages d’envoi des e-mails retirés de l’app (${field ?? 'tous'})`);
  }

  /** Envoie l'e-mail d'essai à l'adresse des avis. Ne lève jamais : le résultat est un diagnostic lisible. */
  async testSmtp(): Promise<ConnectionTest> {
    const at = new Date().toISOString();
    if (!this.mailer.configured) {
      const unreadable = this.smtpFields().password.state.unreadable;
      this.smtpTest = {
        ok: false, code: 'not_configured', at,
        message: unreadable ? 'Le mot de passe enregistré ne peut plus être déchiffré : ressaisis-le.' : 'L’envoi n’est pas configuré : il manque l’identifiant ou le mot de passe.',
      };
      return this.smtpTest;
    }
    try {
      const to = this.mailer.notifyTo;
      await this.mailer.send(testMessage(this.mailContext(), to));
      this.smtpTest = { ok: true, code: 'ok', message: `E-mail d’essai envoyé à ${to}.`, at };
    } catch (err) {
      // Un échec d'envoi arrive ici déjà réduit à un diagnostic (voir mail.ts) ; le reste est traité comme inconnu.
      const diagnostic = describeSmtpError(err);
      this.smtpTest = { ok: false, code: diagnostic.code, message: diagnostic.message, at };
    }
    return this.smtpTest;
  }

  async saveSmtpAndMaybeTest(body: unknown): Promise<SmtpSaveResult> {
    await this.saveSmtp(body);
    const test = isObject(body) && body.test === true ? await this.testSmtp() : null;
    return { state: this.state(), test };
  }

  // --- CalDAV --------------------------------------------------------------

  private envCaldavMatches(username: string, url: string): boolean {
    const e = this.env.caldav;
    return Boolean(e.username && e.password && sameAccount(e.username, username) && normalizeUrl(e.url ?? CALDAV_DEFAULT_URL) === normalizeUrl(url));
  }

  /** Un compte est « en place » dès qu'il est configuré, que son mot de passe est à ressaisir, ou que ses calendriers sont en base. */
  private accountLocked(current: { username: ConnectionField; password: ResolvedSecret }): boolean {
    return current.username.value !== '' && (Boolean(current.password.value) || current.password.state.unreadable || this.syncedCalendarUrls().length > 0);
  }

  /** Remarque sur la forme du mot de passe d'application Apple, quand le serveur est iCloud. */
  private appleWarning(url: string, password: string): string | null {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch { /* adresse invalide : traitée ailleurs */ }
    if (!(host === 'icloud.com' || host.endsWith('.icloud.com'))) return null;
    if (APPLE_PASSWORD_RE.test(password)) return null;
    return 'Un mot de passe d’application Apple fait 16 lettres minuscules (abcd-efgh-ijkl-mnop). Ce que tu as saisi n’a pas cette forme : ce n’est pas le mot de passe de ton compte Apple qu’il faut ici.';
  }

  /**
   * Valide une saisie CalDAV et la rapproche de la configuration du moment.
   * En v1, un autre compte (identifiant ou serveur différent) est refusé dès qu'un compte est
   * en place : ses calendriers et événements sont en base et des réservations y sont liées.
   */
  private async caldavCandidate(body: unknown, passwordRequired: boolean): Promise<{ url: ConnectionField; username: string; password: string; warning: string | null }> {
    if (!isObject(body)) throw new ConnectionError(400, 'invalid', 'Corps de requête invalide', { _: 'Corps de requête invalide' });
    const current = this.caldavFields();
    const fields: Record<string, string> = {};
    const text = (name: string, max: number, label: string): string => {
      const v = body[name];
      if (v === undefined || v === null) return '';
      if (typeof v !== 'string' || v.length > max || CONTROL_RE.test(v)) {
        fields[name] = `${label} : ${max} caractères au plus, sur une seule ligne`;
        return '';
      }
      return v.trim();
    };
    const username = text('username', 254, 'Identifiant') || current.username.value;
    const password = text('password', 1024, 'Mot de passe') || (passwordRequired ? '' : current.password.value);
    const urlText = text('url', 500, 'Adresse du serveur');
    if (!fields.username && (!username || /\s/.test(username))) fields.username = 'Identifiant : ton identifiant Apple (une adresse e-mail), sans espace';
    if (!fields.password && !password) fields.password = passwordRequired ? 'Saisis le mot de passe d’application' : 'Aucun mot de passe enregistré : saisis-le';

    const known = current.username.value;
    const locked = this.accountLocked(current);
    let url = current.url;
    if (urlText && normalizeUrl(urlText) !== normalizeUrl(current.url.value)) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(urlText);
      } catch { /* invalide */ }
      const httpsOk = parsed?.protocol === 'https:' || (this.allowPrivate && parsed?.protocol === 'http:');
      if (!parsed || !httpsOk || parsed.username || parsed.password || parsed.search || parsed.hash) {
        fields.url = 'Adresse du serveur : une adresse https://, sans identifiant ni paramètre';
      } else {
        const problem = checkHostSyntax(parsed.hostname.toLowerCase(), this.allowPrivate);
        if (problem === 'syntax') fields.url = 'Adresse du serveur : nom de domaine invalide';
        else if (problem === 'internal') fields.url = 'Adresse du serveur : les adresses internes ou privées sont refusées';
        else {
          const normalized = normalizeUrl(urlText);
          const fallback = this.env.caldav.url ?? CALDAV_DEFAULT_URL;
          url = normalized === normalizeUrl(fallback) ? { value: fallback, source: this.env.caldav.url ? 'env' : 'default' } : { value: normalized, source: 'app' };
        }
      }
    }
    if (Object.keys(fields).length > 0) throw new ConnectionError(400, 'invalid', Object.values(fields)[0], fields);

    if (locked && (!sameAccount(username, known) || normalizeUrl(url.value) !== normalizeUrl(current.url.value))) {
      throw new ConnectionError(409, 'account_change',
        'Changer de compte de calendrier n’est pas encore possible depuis l’app : les calendriers et les événements du compte actuel sont enregistrés ici, et des réservations y sont liées. Tu peux changer le mot de passe d’application de ce compte, en gardant le même identifiant.');
    }
    if (url.source === 'app') {
      try {
        await resolveGuarded(new URL(url.value).hostname, this.allowPrivate, this.resolver);
      } catch (err) {
        if (err instanceof HostRefusedError && err.reason === 'internal') {
          throw new ConnectionError(400, 'invalid', 'Adresse du serveur : ce nom désigne une adresse interne ou privée, refusée', { url: 'Adresse du serveur : ce nom désigne une adresse interne ou privée, refusée' });
        }
        // Introuvable : l'essai de connexion le dira avec son propre diagnostic.
      }
    }
    return { url, username, password, warning: this.appleWarning(url.value, password) };
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.caldavBusy) throw new ConnectionError(429, 'busy', 'Un essai de connexion est déjà en cours. Réessaie dans un instant.');
    this.caldavBusy = true;
    try {
      return await fn();
    } finally {
      this.caldavBusy = false;
    }
  }

  private recordCaldavTest(result: ProbeResult): ConnectionTest {
    const at = new Date().toISOString();
    this.caldavTest = result.ok
      ? { ok: true, code: 'ok', at, message: `Connexion réussie : ${result.calendars} calendrier${result.calendars > 1 ? 's' : ''} trouvé${result.calendars > 1 ? 's' : ''}.` }
      : { ok: false, code: result.code, message: result.message, at };
    return this.caldavTest;
  }

  /** Applique la configuration du moment au client de synchro, puis lance une synchro (après celle en cours, s'il y en a une). */
  private applyCaldav(): void {
    const before = this.caldav.whenIdle();
    this.caldav.reconfigure(this.caldavOptions());
    this.pendingSync = before.then(() => this.caldav.sync());
  }

  /**
   * Essai de connexion sans rien enregistrer : avec les valeurs fournies, complétées par la
   * configuration du moment (corps vide : essai de la configuration actuelle).
   */
  async testCaldav(body: unknown): Promise<{ test: ConnectionTest; warning: string | null }> {
    return this.exclusive(async () => {
      const candidate = await this.caldavCandidate(body ?? {}, false);
      const result = await this.probe(this.caldavOptionsFor(candidate.url, candidate.username, candidate.password), this.caldavTimeoutMs);
      return { test: this.recordCaldavTest(result), warning: candidate.warning };
    });
  }

  /**
   * Enregistre de nouveaux identifiants CalDAV : essai de connexion d'abord ; s'il échoue, rien
   * ne change et la synchro continue avec l'ancienne configuration. S'il réussit : enregistrement,
   * client de synchro recréé à chaud, synchro lancée.
   */
  async saveCaldav(body: unknown): Promise<CaldavSaveResult> {
    return this.exclusive(async () => {
      const candidate = await this.caldavCandidate(body, true);
      const result = await this.probe(this.caldavOptionsFor(candidate.url, candidate.username, candidate.password), this.caldavTimeoutMs);
      const test = this.recordCaldavTest(result);
      if (!result.ok) {
        const kept = this.caldav.configured ? ' Rien n’a été modifié : la synchro continue avec la configuration actuelle.' : ' Rien n’a été enregistré.';
        throw new ConnectionError(422, 'connection_failed', `${result.message}${kept}${candidate.warning ? ` ${candidate.warning}` : ''}`, undefined, result.code);
      }
      const sealed = this.seal('caldav.password', candidate.password);
      tx(this.db, () => {
        if (candidate.url.source === 'app') this.put('caldav.url', candidate.url.value);
        else this.drop('caldav.url');
        // L'identifiant est enregistré avec son mot de passe : la paire reste cohérente même si le .env change ensuite.
        this.put('caldav.username', candidate.username);
        this.put('caldav.password', sealed, true);
      });
      console.log('[alfred] identifiants de calendrier modifiés dans l’app : client de synchro recréé');
      this.applyCaldav();
      return { state: this.state(), test, warning: candidate.warning };
    });
  }

  /**
   * Retire les identifiants CalDAV de l'app pour revenir à ceux du .env. Possible seulement
   * si le .env porte le même compte et que ses identifiants fonctionnent encore : on ne
   * coupe jamais une synchro qui marche.
   */
  async clearCaldav(): Promise<CaldavSaveResult> {
    return this.exclusive(async () => {
      if (!this.hasAppValues('caldav')) return { state: this.state(), test: this.caldavTest ?? { ok: true, code: 'ok', message: 'Rien à retirer.', at: new Date().toISOString() }, warning: null };
      const current = this.caldavFields();
      const e = this.env.caldav;
      if (!e.username || !e.password) {
        throw new ConnectionError(409, 'no_env', 'Le fichier .env du serveur ne contient pas d’identifiants de calendrier : il n’y a rien vers quoi revenir, et retirer ceux de l’app arrêterait la synchro.');
      }
      if (!this.envCaldavMatches(current.username.value, current.url.value)) {
        throw new ConnectionError(409, 'account_change', 'Le fichier .env du serveur désigne un autre compte de calendrier que celui de l’app : y revenir changerait de compte, ce qui n’est pas encore possible depuis l’app.');
      }
      const url: ConnectionField = { value: e.url ?? CALDAV_DEFAULT_URL, source: e.url ? 'env' : 'default' };
      const result = await this.probe(this.caldavOptionsFor(url, e.username, e.password), this.caldavTimeoutMs);
      const test = this.recordCaldavTest(result);
      if (!result.ok) {
        throw new ConnectionError(422, 'connection_failed', `Les identifiants du fichier .env ne fonctionnent pas. ${result.message} Rien n’a été modifié : la configuration de l’app reste active.`, undefined, result.code);
      }
      this.db.prepare("DELETE FROM connection_settings WHERE key LIKE 'caldav.%'").run();
      console.log('[alfred] identifiants de calendrier retirés de l’app : retour à ceux du fichier .env');
      this.applyCaldav();
      return { state: this.state(), test, warning: null };
    });
  }
}

export const CONNECTION_FIELDS = { smtp: SMTP_FIELDS, caldav: CALDAV_FIELDS };
export type { SettingSource };
