import type {
  Booking, BookingAdminState, BookingHoursRange, BookingSettings, BookingType, BookingTypeInput,
  CalendarInfo, EditScope, EventInput, Occurrence, PublicSlots, SyncStatus,
} from '../../shared/types';

import { ApiError, requestJson } from './http';

export { ApiError };

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return requestJson<T>(method, path, body, path === '/api/login' ? undefined : () => window.dispatchEvent(new Event('alfred:logout')));
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

/** Administration de la prise de rendez-vous (session requise). */
export const bookingApi = {
  state: () => request<BookingAdminState>('GET', '/api/booking/settings'),
  saveSettings: (patch: Partial<BookingSettings>) => request<BookingAdminState>('PUT', '/api/booking/settings', patch),
  types: () => request<BookingType[]>('GET', '/api/booking/types'),
  createType: (input: BookingTypeInput) => request<BookingType>('POST', '/api/booking/types', input),
  updateType: (id: string, input: BookingTypeInput) => request<BookingType>('PUT', `/api/booking/types/${encodeURIComponent(id)}`, input),
  deleteType: (id: string) => request<{ ok: true }>('DELETE', `/api/booking/types/${encodeURIComponent(id)}`),
  reorderTypes: (ids: string[]) => request<BookingType[]>('PUT', '/api/booking/types/order', { ids }),
  typeSlots: (id: string, from: string, to: string) =>
    request<PublicSlots>('GET', `/api/booking/types/${encodeURIComponent(id)}/slots?from=${from}&to=${to}`),
  hours: () => request<BookingHoursRange[]>('GET', '/api/booking/hours'),
  saveHours: (hours: BookingHoursRange[]) => request<BookingHoursRange[]>('PUT', '/api/booking/hours', hours),
  calendars: () => request<CalendarInfo[]>('GET', '/api/booking/calendars'),
  setCalendarBlocks: (id: string, blocksBooking: boolean) =>
    request<CalendarInfo>('PATCH', `/api/booking/calendars/${encodeURIComponent(id)}`, { blocksBooking }),
  bookings: (scope: 'upcoming' | 'past') => request<Booking[]>('GET', `/api/booking/bookings?scope=${scope}&limit=200`),
  cancelBooking: (id: string, notifyClient: boolean) =>
    request<Booking>('POST', `/api/booking/bookings/${encodeURIComponent(id)}/cancel`, { notifyClient }),
  resendConfirmation: (id: string) => request<Booking>('POST', `/api/booking/bookings/${encodeURIComponent(id)}/resend`, {}),
  testMail: () => request<{ ok: true; to: string }>('POST', '/api/booking/mail/test', {}),
};
