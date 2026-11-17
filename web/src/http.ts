import type { ApiErrorBody } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Code stable de l'API de prise de rendez-vous (voir docs/API-RDV.md). */
    readonly code?: string,
    /** Erreurs de validation par champ (code « invalid »). */
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Requête JSON vers l'API. `onUnauthorized` n'est fourni que par l'app privée. */
export async function requestJson<T>(method: string, path: string, body?: unknown, onUnauthorized?: () => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Connexion au serveur impossible.', 0, 'network');
  }
  const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>;
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(data.error ?? `Erreur ${res.status}`, res.status, data.code, data.fields);
  }
  return data as T;
}
