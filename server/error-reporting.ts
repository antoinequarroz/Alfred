/**
 * Remontée des erreurs du serveur vers Orbi (le monitoring de la suite), avec le SDK Sentry : Orbi
 * accepte son protocole tel quel. Côté serveur seulement : l'app web ne charge aucun script de plus,
 * et la Content-Security-Policy ne change pas.
 *
 * SENTRY_DSN vide = rien n'est envoyé (développement, tests). En production : le DSN du projet
 * « Alfred » d'Orbi (orbi.postmelo.ch > Alfred > Brancher).
 *
 * Sobre pour le petit VPS : ni OpenTelemetry ni intégrations automatiques, seulement les erreurs
 * imprévues que le serveur renvoie en 500.
 */

/** Ce qui part vers Orbi avec une erreur : ni cookie, ni en-tête, ni corps, ni paramètre d'URL. */
type ScrubbableEvent = {
  request?: { url?: string; cookies?: unknown; headers?: unknown; data?: unknown; query_string?: unknown };
  user?: unknown;
};

export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.request) {
    const url = event.request.url;
    event.request = { url: url ? url.split('?')[0].split('#')[0] : undefined };
  }
  delete event.user;
  return event;
}

/** Copie de l'erreur sans ses éventuels secrets (mots de passe de connexion, identifiants dans une URL). */
export function redactedError(err: unknown, redact: (value: string) => string = (v) => v): Error {
  const source = err instanceof Error ? err : new Error(String(err));
  const copy = new Error(redact(source.message));
  copy.name = source.name;
  copy.stack = source.stack ? redact(source.stack) : undefined;
  return copy;
}

type Sentry = typeof import('@sentry/node');
let sentry: Sentry | null = null;

export async function startErrorReporting(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  sentry = await import('@sentry/node');
  sentry.init({
    dsn,
    environment: env.NODE_ENV,
    release: env.APP_RELEASE?.trim() || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    defaultIntegrations: false,
    beforeSend: scrubEvent,
  });
  return true;
}

/** Une erreur imprévue d'une requête (le serveur a répondu 500). */
export function reportError(err: unknown, request: { method: string; path: string }, redact?: (value: string) => string): void {
  const s = sentry;
  if (!s) return;
  s.withScope((scope) => {
    scope.setContext('request', { method: request.method, path: request.path.split('?')[0] });
    s.captureException(redactedError(err, redact));
  });
}
