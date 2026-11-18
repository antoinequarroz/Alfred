import type { ConnectionTest, PaymentSettingsInput, PaymentSettingsState } from '../../shared/types.js';
import type { Db } from '../db.js';
import { SecretKeyError, type SecretBox } from '../secrets.js';
import { keyMode, STRIPE_API, STRIPE_KEY_RE, StripeClient, StripeError, type FetchLike } from './stripe.js';

/**
 * Réglages du paiement en ligne (Stripe), modifiables depuis l'app : clé secrète (chiffrée,
 * jamais renvoyée), TWINT, règle de remboursement. Rangés avec les autres connexions
 * (table connection_settings, préfixe « stripe. »).
 */

export const CURRENCY = 'CHF';
const KEY = 'stripe.secretKey';
const TWINT = 'stripe.twint';
const REFUND_HOURS = 'stripe.refundHours';
const LAST_TEST = 'status.stripe.lastTest';
/** Remboursement automatique si le client annule au moins 24 h avant, par défaut. */
const DEFAULT_REFUND_HOURS = 24;

export class PaymentSettingsError extends Error {
  constructor(readonly status: 400 | 422 | 503, readonly code: string, message: string, readonly fields?: Record<string, string>) {
    super(message);
  }
}

export interface PaymentsOptions {
  db: Db;
  secrets: SecretBox;
  /** Accès réseau de remplacement (tests). */
  fetch?: FetchLike;
  baseUrl?: string;
  /** Nombre de paiements en attente (retenues), pour l'état affiché. */
  pendingCount?: () => number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class PaymentsService {
  private readonly db: Db;
  private readonly secrets: SecretBox;
  private readonly fetchFn?: FetchLike;
  private readonly baseUrl: string;
  pendingCount: () => number;

  constructor(opts: PaymentsOptions) {
    this.db = opts.db;
    this.secrets = opts.secrets;
    this.fetchFn = opts.fetch;
    this.baseUrl = opts.baseUrl ?? STRIPE_API;
    this.pendingCount = opts.pendingCount ?? (() => 0);
  }

  private row(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM connection_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private put(key: string, value: string, secret = false): void {
    this.db.prepare(
      'INSERT INTO connection_settings (key, value, secret, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at',
    ).run(key, value, secret ? 1 : 0, new Date().toISOString());
  }

  private drop(key: string): void {
    this.db.prepare('DELETE FROM connection_settings WHERE key = ?').run(key);
  }

  /** Clé secrète en clair, ou null (absente ou indéchiffrable). */
  private secretKey(): string | null {
    const sealed = this.row(KEY);
    return sealed === undefined ? null : this.secrets.open(KEY, sealed);
  }

  get configured(): boolean {
    return this.secretKey() !== null;
  }

  get twint(): boolean {
    return this.row(TWINT) !== '0';
  }

  get refundHours(): number | null {
    const v = this.row(REFUND_HOURS);
    if (v === undefined) return DEFAULT_REFUND_HOURS;
    if (v === 'never') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_REFUND_HOURS;
  }

  /** Moyens de paiement proposés sur la page Stripe. Tous sont immédiats : le résultat est connu au retour du client. */
  get paymentMethods(): string[] {
    return this.twint ? ['card', 'twint'] : ['card'];
  }

  /** Client Stripe avec la clé enregistrée, ou null si aucune clé utilisable. */
  client(): StripeClient | null {
    const key = this.secretKey();
    return key ? new StripeClient(key, this.fetchFn, this.baseUrl) : null;
  }

  private lastTest(): ConnectionTest | null {
    const v = this.row(LAST_TEST);
    if (!v) return null;
    try {
      return JSON.parse(v) as ConnectionTest;
    } catch {
      return null;
    }
  }

  state(): PaymentSettingsState {
    const sealed = this.row(KEY);
    const key = this.secretKey();
    return {
      configured: key !== null,
      unreadable: sealed !== undefined && key === null,
      mode: key ? keyMode(key) : null,
      keyHint: key ? key.slice(-4) : null,
      twint: this.twint,
      refundHours: this.refundHours,
      currency: CURRENCY,
      lastTest: this.lastTest(),
      pendingCount: this.pendingCount(),
    };
  }

  /** Essaie une clé auprès de Stripe ; enregistre le résultat. */
  private async test(key: string): Promise<ConnectionTest> {
    const at = new Date().toISOString();
    let test: ConnectionTest;
    try {
      await new StripeClient(key, this.fetchFn, this.baseUrl).check();
      test = { ok: true, code: 'ok', message: `Clé acceptée par Stripe (mode ${keyMode(key) === 'live' ? 'réel' : 'test'}).`, at };
    } catch (err) {
      const e = err instanceof StripeError ? err : new StripeError('network', 'Stripe ne répond pas.');
      test = { ok: false, code: e.kind, message: e.message, at };
    }
    this.put(LAST_TEST, JSON.stringify(test));
    return test;
  }

  /** Enregistre les réglages. Une nouvelle clé n'est gardée que si Stripe l'accepte. */
  async save(body: unknown): Promise<{ state: PaymentSettingsState; test: ConnectionTest | null }> {
    if (!isObject(body)) throw new PaymentSettingsError(400, 'invalid', 'Corps de requête invalide');
    const input = body as PaymentSettingsInput;
    const fields: Record<string, string> = {};
    let key: string | null = null;
    if (input.secretKey !== undefined && input.secretKey !== '') {
      const k = typeof input.secretKey === 'string' ? input.secretKey.trim() : '';
      if (/^pk_/.test(k)) fields.secretKey = 'C’est la clé publiable (pk_…). Il faut la clé secrète (sk_…) ou une clé restreinte (rk_…).';
      else if (!STRIPE_KEY_RE.test(k)) fields.secretKey = 'Clé Stripe attendue : elle commence par sk_live_, sk_test_, rk_live_ ou rk_test_.';
      else key = k;
    }
    if (input.twint !== undefined && typeof input.twint !== 'boolean') fields.twint = 'Valeur attendue : vrai ou faux';
    let refund: string | undefined;
    if (input.refundHours !== undefined) {
      if (input.refundHours === null) refund = 'never';
      else if (typeof input.refundHours === 'number' && Number.isInteger(input.refundHours) && input.refundHours >= 0 && input.refundHours <= 720) refund = String(input.refundHours);
      else fields.refundHours = 'Délai : nombre entier d’heures entre 0 et 720';
    }
    if (Object.keys(fields).length > 0) throw new PaymentSettingsError(400, 'invalid', Object.values(fields)[0], fields);

    let test: ConnectionTest | null = null;
    if (key) {
      test = await this.test(key);
      if (!test.ok) throw new PaymentSettingsError(422, 'key_refused', test.message, { secretKey: test.message });
      try {
        this.put(KEY, this.secrets.seal(KEY, key), true);
      } catch (err) {
        if (err instanceof SecretKeyError) throw new PaymentSettingsError(503, 'secret_key', err.message);
        throw err;
      }
    }
    if (typeof input.twint === 'boolean') this.put(TWINT, input.twint ? '1' : '0');
    if (refund !== undefined) this.put(REFUND_HOURS, refund);
    return { state: this.state(), test };
  }

  /** Essaie la clé enregistrée. */
  async testSaved(): Promise<{ state: PaymentSettingsState; test: ConnectionTest }> {
    const key = this.secretKey();
    if (!key) throw new PaymentSettingsError(400, 'not_configured', 'Aucune clé Stripe enregistrée.');
    const test = await this.test(key);
    return { state: this.state(), test };
  }

  /** Retire la clé : plus aucun acompte ne peut être encaissé (les réservations existantes restent). */
  clear(): PaymentSettingsState {
    this.drop(KEY);
    this.drop(LAST_TEST);
    return this.state();
  }
}
