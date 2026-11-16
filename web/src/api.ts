import type { CalendarInfo, EditScope, EventInput, Occurrence, SyncStatus } from '../../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('alfred:logout'));
    throw new ApiError((data as { error?: string }).error ?? `Erreur ${res.status}`, res.status);
  }
  return data as T;
}

export const api = {
  me: () => request<{ authenticated: boolean }>('GET', '/api/me'),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),
  calendars: () => request<CalendarInfo[]>('GET', '/api/calendars'),
  setCalendarVisible: (id: string, visible: boolean) =>
    request<CalendarInfo>('PATCH', `/api/calendars/${encodeURIComponent(id)}`, { visible }),
  events: (start: Date, end: Date) =>
    request<Occurrence[]>('GET', `/api/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`),
  createEvent: (event: EventInput) => request<{ id: string }>('POST', '/api/events', event),
  updateEvent: (id: string, event: EventInput, scope: EditScope, occurrenceId: string | null) =>
    request<{ id: string }>('PUT', `/api/events/${encodeURIComponent(id)}`, { event, scope, occurrenceId }),
  deleteEvent: (id: string, scope: EditScope, occurrenceId: string | null) => {
    const q = new URLSearchParams({ scope });
    if (occurrenceId) q.set('occurrenceId', occurrenceId);
    return request<{ ok: true }>('DELETE', `/api/events/${encodeURIComponent(id)}?${q}`);
  },
  syncStatus: () => request<SyncStatus>('GET', '/api/sync'),
  sync: () => request<SyncStatus>('POST', '/api/sync'),
};
