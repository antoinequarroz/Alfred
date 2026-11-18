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
/** Destination (hôte:port) pour laquelle le mot de passe SMTP de l'app a été saisi. */
const SMTP_PASSWORD_FOR = 'smtp.passwordFor';
/** Dernier essai d'envoi, gardé d'un redémarrage à l'autre (hors du groupe « smtp. » : ce n'est pas un réglage). */
const SMTP_LAST_TEST = 'status.smtp.lastTest';
const smtpDestination = (host: string, port: string) => `${host.toLowerCase()}:${port}`;
/** Nom de champ authentifié avec le mot de passe SMTP : il porte la destination. */
const smtpPasswordField = (destination: string) => `smtp.password@${destination}`;
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
  /** undefined : pas encore relu de la base. */
  private smtpTest: ConnectionTest | null | undefined;
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
    return this.db.get<{ value: string }>('SELECT value FROM connection_settings WHERE key = ? AND space_id = ?', key, this.db.spaceId)?.value;
  }

  private put(key: string, value: string, secret = false): void {
    this.db.run(
      `INSERT INTO connection_settings (key, value, secret, updated_at, space_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at
       WHERE connection_settings.space_id = excluded.space_id`,
      key, value, secret ? 1 : 0, new Date().toISOString(), this.db.spaceId);
  }

  private drop(key: string): void {
    this.db.run('DELETE FROM connection_settings WHERE key = ? AND space_id = ?', key, this.db.spaceId);
  }

  private hasAppValues(group: 'smtp' | 'caldav'): boolean {
    return Boolean(this.db.get('SELECT 1 AS ok FROM connection_settings WHERE key LIKE ? AND space_id = ? LIMIT 1', `${group}.%`, this.db.spaceId));
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
      if (value === null) return { value: '', state: { configured: false, source: 'app', unreadable: true, otherServer: false } };
      return { value, state: { configured: true, source: 'app', unreadable: false, otherServer: false } };
    }
    if (envValue) return { value: envValue, state: { configured: true, source: 'env', unreadable: false, otherServer: false } };
    return { value: '', state: { configured: false, source: 'none', unreadable: false, otherServer: false } };
  }

  /** Valeurs SMTP du .env, une fois écartées celles qui sont invalides. */
  private smtpEnv() {
    const e = this.env.smtp;
    return {
      host: e.host || undefined,
      port: e.port && /^\d{1,5}$/.test(e.port) && Number(e.port) >= 1 && Number(e.port) <= 65_535 ? e.port : undefined,
      from: e.from && parseSender(e.from) ? e.from : undefined,
      notifyTo: e.notifyTo && EMAIL_RE.test(e.notifyTo) ? e.notifyTo : undefined,
    };
  }

  /**
   * Mot de passe SMTP, lié à sa destination : un mot de passe n'est présenté qu'au serveur
   * (hôte et port) pour lequel il a été saisi. Celui de l'app porte sa destination (ligne
   * smtp.passwordFor, reprise dans les données authentifiées du chiffrement) ; celui du .env
   * ne va qu'à un serveur qui ne vient pas de l'app. Sinon il compte comme non configuré :
   * changer de serveur sans ressaisir le mot de passe ne le fait jamais sortir.
   */
  private smtpSecret(destination: string, fromApp: boolean): ResolvedSecret {
    const app = this.row('smtp.password');
    if (app !== undefined) {
      if (this.row(SMTP_PASSWORD_FOR) !== destination) return { value: '', state: { configured: false, source: 'app', unreadable: false, otherServer: true } };
      const value = this.secrets.open(smtpPasswordField(destination), app);
      if (value === null) return { value: '', state: { configured: false, source: 'app', unreadable: true, otherServer: false } };
      return { value, state: { configured: true, source: 'app', unreadable: false, otherServer: false } };
    }
    if (this.env.smtp.password) {
      if (fromApp) return { value: '', state: { configured: false, source: 'env', unreadable: false, otherServer: true } };
      return { value: this.env.smtp.password, state: { configured: true, source: 'env', unreadable: false, otherServer: false } };
    }
    return { value: '', state: { configured: false, source: 'none', unreadable: false, otherServer: false } };
  }

  private smtpFields() {
    const e = this.smtpEnv();
    const host = this.field('smtp.host', e.host, SMTP_DEFAULTS.host);
    const port = this.field('smtp.port', e.port, SMTP_DEFAULTS.port);
    const user = this.field('smtp.user', this.env.smtp.user);
    const destination = smtpDestination(host.value, port.value);
    const password = this.smtpSecret(destination, host.source === 'app' || port.source === 'app');
    const from = this.field('smtp.from', e.from, SMTP_DEFAULTS.from);
    const sender = parseSender(from.value) ?? parseSender(SMTP_DEFAULTS.from)!;
    let notifyTo = this.field('smtp.notifyTo', e.notifyTo);
    if (!notifyTo.value) notifyTo = { value: sender.address, source: 'default' };
    return { host, port, user, password, from, sender, notifyTo, destination };
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
    const url = this.field('caldav.url', e.url, CALDAV_DEFAULT_URL);
    const username = this.field('caldav.username', e.username);
    let password = this.secret('caldav.password', e.password);
    // Le mot de passe du .env ne va qu'au serveur et au compte du .env, jamais à ceux saisis dans l'app.
    if (password.state.source === 'env' && (url.source === 'app' || username.source === 'app')) {
      password = { value: '', state: { configured: false, source: 'env', unreadable: false, otherServer: true } };
    }
    return { url, username, password };
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
      envConfigured: Boolean(this.env.smtp.user && this.env.smtp.password),
      lastTest: this.lastSmtpTest(),
    };
    const c = this.caldavFields();
    const events = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events e JOIN calendars c ON c.id = e.calendar_id AND c.space_id = e.space_id WHERE e.space_id = ? AND c.source = 'caldav'",
      this.db.spaceId)!.n;
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
    if (s.password.state.otherServer) {
      notices.push(s.password.state.source === 'app'
        ? 'Le mot de passe d’envoi des e-mails a été enregistré pour un autre serveur (ou un autre port) que celui réglé maintenant. Ressaisis-le : en attendant, aucun e-mail ne part.'
        : 'Le mot de passe d’envoi du fichier .env n’est pas utilisé avec un serveur réglé dans l’app. Saisis le mot de passe dans l’app : en attendant, aucun e-mail ne part.');
    }
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
    const e = { ...this.env.smtp, ...this.smtpEnv() };
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

    // Vide : on garde le mot de passe actuel.
    const password = text('password', 1024, 'Mot de passe') || undefined;

    // Le mot de passe est lié à sa destination : si le serveur ou le port change, l'actuel
    // n'est pas repris. Sans cela, une session volée le ferait partir vers un serveur de son choix.
    const before = this.smtpFields();
    const pending = new Map(changes);
    const next = (name: 'host' | 'port', fallback: string) => {
      if (!pending.has(name)) return { value: before[name].value, app: before[name].source === 'app' };
      const value = pending.get(name) ?? null;
      return { value: value ?? e[name] ?? fallback, app: value !== null };
    };
    const nextHost = next('host', SMTP_DEFAULTS.host);
    const nextPort = next('port', SMTP_DEFAULTS.port);
    const destination = smtpDestination(nextHost.value, nextPort.value);
    if (!fields.host && !fields.port && !fields.password && password === undefined && destination !== before.destination && before.password.value) {
      fields.password = 'Ressaisis le mot de passe : le serveur ou le port change';
    }

    if (Object.keys(fields).length > 0) throw new ConnectionError(400, 'invalid', Object.values(fields)[0], fields);

    // Identique à celui du .env, pour le serveur du .env : rien à recopier dans l'app.
    const envSuffices = password !== undefined && password === e.password && !nextHost.app && !nextPort.app;
    const sealed = password !== undefined && !envSuffices ? this.seal(smtpPasswordField(destination), password) : null;
    tx(this.db, () => {
      for (const [name, value] of changes) {
        if (value === null) this.drop(`smtp.${name}`);
        else this.put(`smtp.${name}`, value);
      }
      if (sealed !== null) {
        this.put('smtp.password', sealed, true);
        this.put(SMTP_PASSWORD_FOR, destination);
      } else if (envSuffices) {
        this.drop('smtp.password');
        this.drop(SMTP_PASSWORD_FOR);
      }
    });
    if (password !== undefined) changes.push(['password', envSuffices ? null : '']);
    this.cachedMailer = null;
    if (changes.length > 0) this.setSmtpTest(null);
    if (changes.length > 0) console.log(`[alfred] réglages d’envoi des e-mails modifiés dans l’app (${changes.map(([name]) => name).join(', ')})`);
  }

  /** Retire un réglage SMTP de l'app (ou tous) : le .env ou la valeur par défaut reprend la main. */
  clearSmtp(field?: string): void {
    if (field !== undefined && !(SMTP_FIELDS as readonly string[]).includes(field)) throw new ConnectionError(400, 'invalid', 'Réglage inconnu');
    if (field) {
      this.drop(`smtp.${field}`);
      if (field === 'password') this.drop(SMTP_PASSWORD_FOR);
    } else this.db.run("DELETE FROM connection_settings WHERE key LIKE 'smtp.%' AND space_id = ?", this.db.spaceId);
    this.cachedMailer = null;
    this.setSmtpTest(null);
    console.log(`[alfred] réglages d’envoi des e-mails retirés de l’app (${field ?? 'tous'})`);
  }

  /** Dernier essai d'envoi : gardé en base, pour qu'un échec reste signalé après un redémarrage. */
  private lastSmtpTest(): ConnectionTest | null {
    if (this.smtpTest === undefined) {
      this.smtpTest = null;
      try {
        const saved = JSON.parse(this.row(SMTP_LAST_TEST) ?? 'null') as Partial<ConnectionTest> | null;
        if (saved && typeof saved.ok === 'boolean' && typeof saved.code === 'string' && typeof saved.message === 'string' && typeof saved.at === 'string') {
          this.smtpTest = { ok: saved.ok, code: saved.code, message: saved.message, at: saved.at };
        }
      } catch { /* ligne illisible : pas de dernier essai */ }
    }
    return this.smtpTest;
  }

  /** Mémorise le résultat d'un essai (un diagnostic écrit ici, sans détail sensible), ou l'oublie avec null. */
  private setSmtpTest(test: ConnectionTest | null): ConnectionTest | null {
    this.smtpTest = test;
    try {
      if (test) this.put(SMTP_LAST_TEST, JSON.stringify(test));
      else this.drop(SMTP_LAST_TEST);
    } catch { /* base indisponible : le résultat reste au moins en mémoire */ }
    return test;
  }

  /** Message à afficher quand l'envoi est configuré mais que le dernier essai a échoué, sinon null. */
  smtpProblem(): string | null {
    const test = this.lastSmtpTest();
    return this.mailer.configured && test && !test.ok ? test.message : null;
  }

  /** Envoie l'e-mail d'essai à l'adresse des avis. Ne lève jamais : le résultat est un diagnostic lisible. */
  async testSmtp(): Promise<ConnectionTest> {
    const at = new Date().toISOString();
    if (!this.mailer.configured) {
      const secret = this.smtpFields().password.state;
      return this.setSmtpTest({
        ok: false, code: 'not_configured', at,
        message: secret.unreadable ? 'Le mot de passe enregistré ne peut plus être déchiffré : ressaisis-le.'
          : secret.otherServer ? 'Le mot de passe a été enregistré pour un autre serveur que celui réglé maintenant : ressaisis-le.'
            : 'L’envoi n’est pas configuré : il manque l’identifiant ou le mot de passe.',
      })!;
    }
    try {
      const to = this.mailer.notifyTo;
      await this.mailer.send(testMessage(this.mailContext(), to));
      return this.setSmtpTest({ ok: true, code: 'ok', message: `E-mail d’essai envoyé à ${to}.`, at })!;
    } catch (err) {
      // Un échec d'envoi arrive ici déjà réduit à un diagnostic (voir mail.ts) ; le reste est traité comme inconnu.
      const diagnostic = describeSmtpError(err);
      return this.setSmtpTest({ ok: false, code: diagnostic.code, message: diagnostic.message, at })!;
    }
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
  private async caldavCandidate(body: unknown, passwordRequired: boolean): Promise<{
    url: ConnectionField; username: string; password: string; warning: string | null;
    /** La saisie désigne exactement la configuration en place (rien de nouveau n'est essayé). */
    active: boolean;
    /** Calendriers déjà en base alors qu'aucun identifiant n'est connu : seul leur compte peut être relié. */
    orphans: string[];
  }> {
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
    const typed = text('password', 1024, 'Mot de passe');
    const urlText = text('url', 500, 'Adresse du serveur');
    if (!fields.username && (!username || /\s/.test(username))) fields.username = 'Identifiant : ton identifiant Apple (une adresse e-mail), sans espace';

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
    // Le mot de passe enregistré n'est repris que pour le compte et le serveur en place : envoyé
    // avec un autre identifiant ou à une autre adresse, il sortirait du serveur.
    const sameTarget = sameAccount(username, known) && normalizeUrl(url.value) === normalizeUrl(current.url.value);
    const password = typed || (!passwordRequired && sameTarget ? current.password.value : '');
    if (!fields.password && !password) {
      fields.password = passwordRequired ? 'Saisis le mot de passe d’application'
        : sameTarget ? 'Aucun mot de passe enregistré : saisis-le'
          : 'Saisis le mot de passe d’application : celui qui est enregistré ne sert que pour le compte et le serveur actuels';
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
    const orphans = known === '' ? this.syncedCalendarUrls() : [];
    return { url, username, password, warning: this.appleWarning(url.value, password), active: sameTarget && !typed, orphans };
  }

  /**
   * Des calendriers sont en base sans qu'aucun identifiant soit connu (fichier .env perdu ou
   * vidé) : le compte qu'on relie doit en retrouver au moins un. Sinon la première synchro
   * les supprimerait, avec leurs événements et le lien des réservations. Renvoie le refus, ou null.
   */
  private orphanRefusal(orphans: string[], result: ProbeResult & { ok: true }): string | null {
    if (orphans.length === 0) return null;
    const found = new Set((result.urls ?? []).map(normalizeUrl));
    if (orphans.some((u) => found.has(normalizeUrl(u)))) return null;
    const n = orphans.length;
    return `Ce compte ne contient aucun des ${n > 1 ? `${n} calendriers déjà enregistrés` : 'calendriers déjà enregistrés'} dans Alfred : c’est sans doute un autre compte, ou une faute dans l’identifiant. `
      + 'Le relier supprimerait ces calendriers, leurs événements et le lien avec les réservations, ce qui n’est pas encore possible depuis l’app. Rien n’a été enregistré.';
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

  /**
   * Résultat d'un essai, en clair. active : l'essai porte sur la configuration en place, il est
   * alors gardé comme « dernier essai » ; celui d'identifiants candidats, jamais enregistrés,
   * ne doit pas rester affiché sous une synchro qui marche.
   */
  private caldavTestResult(result: ProbeResult, active: boolean): ConnectionTest {
    const at = new Date().toISOString();
    const test: ConnectionTest = result.ok
      ? { ok: true, code: 'ok', at, message: `Connexion réussie : ${result.calendars} calendrier${result.calendars > 1 ? 's' : ''} trouvé${result.calendars > 1 ? 's' : ''}.` }
      : { ok: false, code: result.code, message: result.message, at };
    if (active) this.caldavTest = test;
    return test;
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
      const refusal = result.ok ? this.orphanRefusal(candidate.orphans, result) : null;
      if (refusal) return { test: { ok: false, code: 'account_change', message: refusal, at: new Date().toISOString() }, warning: candidate.warning };
      return { test: this.caldavTestResult(result, candidate.active), warning: candidate.warning };
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
      if (!result.ok) {
        const kept = this.caldav.configured ? ' Rien n’a été modifié : la synchro continue avec la configuration actuelle.' : ' Rien n’a été enregistré.';
        throw new ConnectionError(422, 'connection_failed', `${result.message}${kept}${candidate.warning ? ` ${candidate.warning}` : ''}`, undefined, result.code);
      }
      const refusal = this.orphanRefusal(candidate.orphans, result);
      if (refusal) throw new ConnectionError(409, 'account_change', refusal);
      // Enregistrés juste après : cet essai devient celui de la configuration en place.
      const test = this.caldavTestResult(result, true);
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
      if (!result.ok) {
        throw new ConnectionError(422, 'connection_failed', `Les identifiants du fichier .env ne fonctionnent pas. ${result.message} Rien n’a été modifié : la configuration de l’app reste active.`, undefined, result.code);
      }
      const test = this.caldavTestResult(result, true);
      this.db.run("DELETE FROM connection_settings WHERE key LIKE 'caldav.%' AND space_id = ?", this.db.spaceId);
      console.log('[alfred] identifiants de calendrier retirés de l’app : retour à ceux du fichier .env');
      this.applyCaldav();
      return { state: this.state(), test, warning: null };
    });
  }
}

export const CONNECTION_FIELDS = { smtp: SMTP_FIELDS, caldav: CALDAV_FIELDS };
export type { SettingSource };
