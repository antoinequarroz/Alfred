// Prise de rendez-vous contre un vrai serveur CalDAV (Radicale) : l'événement part sur le serveur.
// Lancer : RADICALE_URL=http://127.0.0.1:5232 RADICALE_USER=alfred RADICALE_PASSWORD=secret npm test
import { describe, expect, it } from 'vitest';
import { BookingService } from '../server/booking/service.js';
import { CaldavSync } from '../server/caldav.js';
import { openDb } from '../server/db.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const url = process.env.RADICALE_URL;
const user = process.env.RADICALE_USER ?? '';
const password = process.env.RADICALE_PASSWORD ?? '';
const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

describe.skipIf(!url)('prise de rendez-vous avec CalDAV (Radicale)', () => {
  it('réserve dans le calendrier distant, voit les événements ajoutés ailleurs et les suppressions', async () => {
    const store = new Store(openDb(':memory:'));
    const caldav = new CaldavSync(store, { serverUrl: url!, username: user, password });
    const calendar = new CalendarService(store, caldav, 'Europe/Zurich');
    const clock = { now: new Date('2026-11-15T11:00:00Z') };
    const booking = new BookingService({ store, calendar, caldav, timezone: 'Europe/Zurich', publicUrl: 'https://alfred.example.ch', now: () => clock.now });

    const name = `rdv-${Date.now()}`;
    expect((await fetch(`${url}/${user}/${name}/`, { method: 'MKCALENDAR', headers: { authorization: auth } })).status).toBe(201);
    await caldav.sync();
    const cal = store.listCalendars().find((c) => c.url?.endsWith(`/${name}/`))!;
    expect(cal).toBeDefined();
    // Seul le calendrier du test compte : les autres calendriers du serveur ne doivent pas influencer les créneaux.
    for (const c of store.listCalendars()) store.setCalendarBlocksBooking(c.id, c.id === cal.id);

    booking.updateSettings({ enabled: true, calendarId: cal.id });
    booking.createType({ name: 'Consultation', durationMin: 30 });
    const request = (start: string, email: string) => ({ typeSlug: 'consultation', start, name: 'Élodie Müller', email });

    // 1. Un événement ajouté « sur l'iPhone » juste avant : la synchro fraîche le ramène, le créneau est refusé.
    const ext = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18//EN', 'BEGIN:VEVENT', 'UID:ext-rdv', 'DTSTAMP:20261101T000000Z',
      'DTSTART:20261116T080000Z', 'DTEND:20261116T090000Z', 'SUMMARY:Pris sur iPhone', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    await fetch(new URL('ext-rdv.ics', cal.url!).href, { method: 'PUT', headers: { authorization: auth, 'content-type': 'text/calendar' }, body: ext });
    // La copie locale ne le connaît pas encore : le créneau paraît libre…
    expect(booking.publicSlots('consultation', '2026-11-16', '2026-11-16').days[0].slots).toContain('2026-11-16T08:00:00.000Z');
    // … mais la réservation resynchronise avant de confirmer.
    await expect(booking.book(request('2026-11-16T08:00:00.000Z', 'elodie@example.org'))).rejects.toMatchObject({ code: 'slot_unavailable' });

    // 2. Réservation d'un créneau libre : l'événement existe sur le serveur.
    const confirmation = await booking.book(request('2026-11-16T09:00:00.000Z', 'elodie@example.org'));
    expect(confirmation.emailSent).toBe(false); // pas de SMTP dans ce test
    const [b] = booking.listBookings('upcoming');
    expect(b.eventState).toBe('ok');
    const ev = store.getEvent(b.eventId!)!;
    const remote = await fetch(ev.href!, { headers: { authorization: auth } });
    expect(remote.status).toBe(200);
    const ics = await remote.text();
    expect(ics).toContain('SUMMARY:Consultation : Élodie Müller');
    expect(ics).toContain('DTSTART;TZID=Europe/Zurich:20261116T100000');
    await caldav.sync();
    expect(booking.listBookings('upcoming')[0].eventState).toBe('ok');

    // 3. Antoine supprime l'événement dans Apple Calendar : « événement supprimé » après synchro, la réservation reste.
    expect((await fetch(ev.href!, { method: 'DELETE', headers: { authorization: auth } })).status).toBeLessThan(300);
    await caldav.sync();
    expect(booking.listBookings('upcoming')[0]).toMatchObject({ status: 'confirmed', eventState: 'missing' });
    // L'annulation tolère que l'événement ait disparu.
    const token = confirmation.cancelUrl.split('/').pop()!;
    expect((await booking.cancelByToken(token)).status).toBe('cancelled');

    // 4. Annulation normale : l'événement est retiré du serveur.
    const second = await booking.book(request('2026-11-16T10:00:00.000Z', 'elodie@example.org'));
    const href = store.getEvent(booking.listBookings('upcoming')[0].eventId!)!.href!;
    expect((await fetch(href, { headers: { authorization: auth } })).status).toBe(200);
    await booking.cancelByToken(second.cancelUrl.split('/').pop()!);
    expect((await fetch(href, { headers: { authorization: auth } })).status).toBe(404);
    expect(booking.listBookings('upcoming')).toEqual([]);

    // 5. Le serveur enregistre l'événement mais la réponse se perd : le client lit un refus,
    // et l'événement est retiré du serveur (il se retrouve par son UID) au lieu de rester sans réservation.
    const create = caldav.create.bind(caldav);
    caldav.create = async (calendarUrl, uid, ics) => {
      await create(calendarUrl, uid, ics);
      throw new Error('socket hang up');
    };
    await expect(booking.book(request('2026-11-16T12:30:00.000Z', 'elodie@example.org'))).rejects.toMatchObject({ status: 502, code: 'calendar_unavailable' });
    caldav.create = create;
    const listing = async () => {
      const res = await fetch(cal.url!, { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } });
      return [...(await res.text()).matchAll(/<href>([^<]+\.ics)<\/href>/g)].map((m) => m[1]);
    };
    for (let i = 0; i < 40 && (await listing()).length > 1; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await listing()).toHaveLength(1); // seul « Pris sur iPhone » reste
    await caldav.sync();
    expect(booking.listBookings('upcoming')).toEqual([]);
    expect(booking.publicSlots('consultation', '2026-11-16', '2026-11-16').days[0].slots).toContain('2026-11-16T12:30:00.000Z');

    await fetch(cal.url!, { method: 'DELETE', headers: { authorization: auth } });
  }, 30_000);
});
