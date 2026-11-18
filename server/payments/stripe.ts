/**
 * Client Stripe minimal (API REST, sans dépendance) : ce dont la prise de rendez-vous a besoin
 * pour encaisser un acompte avec Stripe Checkout, suivre le paiement et le rembourser.
 *
 * La clé secrète ne sort que dans l'en-tête Authorization vers api.stripe.com ; elle n'apparaît
 * ni dans une erreur, ni dans un journal.
 */

export const STRIPE_API = 'https://api.stripe.com';
/** Version d'API figée : les réponses ne changent pas de forme sous nos pieds. */
const STRIPE_VERSION = '2024-06-20';

/** Clé secrète (sk_) ou restreinte (rk_), test ou live. */
export const STRIPE_KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,250}$/;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/** Refus ou panne côté Stripe, avec un message en français sans détail sensible. */
export class StripeError extends Error {
  constructor(
    /** auth : clé refusée ; permission : clé restreinte sans le droit ; invalid : demande refusée ; network : Stripe injoignable. */
    readonly kind: 'auth' | 'permission' | 'invalid' | 'network' | 'server',
    message: string,
    /** Code Stripe (« resource_missing », « charge_already_refunded »…), s'il y en a un. */
    readonly code?: string,
    /** Paramètre en cause, pour une demande refusée (« payment_method_types »…). */
    readonly param?: string,
  ) {
    super(message);
  }
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  /** open : en cours ; complete : terminé ; expired : abandonné ou expiré. */
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  payment_intent: string | null;
  amount_total: number | null;
  currency: string | null;
}

export interface CheckoutInput {
  amountCents: number;
  currency: string;
  productName: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** Instant (s depuis l'époque) où la page de paiement expire : 30 min à 24 h après sa création. */
  expiresAt: number;
  paymentMethods: string[];
  /** Notre référence (retenue), reprise dans les métadonnées et comme clé d'idempotence. */
  reference: string;
}

/** Encode des paramètres à la manière de Stripe : a[b][0]=c. */
export function formEncode(params: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) out.push(...formEncode(item as Record<string, unknown>, `${name}[${i}]`));
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      out.push(...formEncode(value as Record<string, unknown>, name));
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out;
}

export function keyMode(key: string): 'test' | 'live' {
  return /^(sk|rk)_live_/.test(key) ? 'live' : 'test';
}

export class StripeClient {
  constructor(
    private readonly key: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly baseUrl = STRIPE_API,
    private readonly timeoutMs = 20_000,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const body = params ? formEncode(params).join('&') : undefined;
    const url = method === 'GET' && body ? `${this.baseUrl}${path}?${body}` : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.key}`,
      'stripe-version': STRIPE_VERSION,
    };
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(url, { method, headers, body: method === 'POST' ? (body ?? '') : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new StripeError('network', 'Stripe ne répond pas. Réessaie dans un instant.');
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // réponse illisible : traitée selon le statut
    }
    if (res.status >= 200 && res.status < 300) return data as T;
    const err = (data as { error?: { message?: string; code?: string; param?: string } } | null)?.error;
    if (res.status === 401) throw new StripeError('auth', 'Stripe refuse cette clé : vérifie-la dans le tableau de bord Stripe (Développeurs > Clés API).');
    if (res.status === 403) {
      throw new StripeError('permission', 'Cette clé restreinte n’a pas les droits nécessaires (Checkout Sessions et Refunds en écriture).', err?.code);
    }
    if (res.status >= 500 || res.status === 429) throw new StripeError('server', 'Stripe est momentanément indisponible. Réessaie dans un instant.');
    // Le message de Stripe ne contient pas la clé ; il est raccourci et gardé pour le diagnostic.
    const detail = typeof err?.message === 'string' ? err.message.replace(/(sk|rk)_(test|live)_[A-Za-z0-9]+/g, '…').slice(0, 300) : 'demande refusée';
    throw new StripeError('invalid', detail, err?.code, err?.param);
  }

  /** Vérifie la clé : lecture la plus légère qu'une clé restreinte « Checkout » puisse faire. */
  async check(): Promise<void> {
    await this.call('GET', '/v1/checkout/sessions', { limit: 1 });
  }

  createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    return this.call<CheckoutSession>('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      locale: 'fr',
      customer_email: input.customerEmail,
      client_reference_id: input.reference,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: input.expiresAt,
      payment_method_types: input.paymentMethods,
      line_items: [{
        quantity: 1,
        price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountCents, product_data: { name: input.productName, description: input.description } },
      }],
      payment_intent_data: { description: `${input.productName} – ${input.description}`.slice(0, 1000), metadata: { alfred_hold: input.reference } },
      metadata: { alfred_hold: input.reference },
    }, `alfred-checkout-${input.reference}`);
  }

  getCheckout(id: string): Promise<CheckoutSession> {
    return this.call<CheckoutSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
  }

  /** Ferme une page de paiement encore ouverte : plus aucun paiement possible ensuite. */
  expireCheckout(id: string): Promise<CheckoutSession> {
    return this.call<CheckoutSession>('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`);
  }

  /** Rembourse un paiement en entier. Une même clé d'idempotence ne rembourse jamais deux fois. */
  refund(paymentIntent: string, idempotencyKey: string): Promise<{ id: string; status: string }> {
    return this.call('POST', '/v1/refunds', { payment_intent: paymentIntent, reason: 'requested_by_customer' }, idempotencyKey);
  }
}
