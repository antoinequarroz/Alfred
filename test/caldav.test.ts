// Test d'intégration contre un vrai serveur CalDAV (Radicale).
// Lancer : RADICALE_URL=http://127.0.0.1:5232 RADICALE_USER=antoine RADICALE_PASSWORD=secret npm test
import { describe, expect, it } from 'vitest';
import { CaldavSync, ConflictError } from '../server/caldav.js';
import { openDb } from '../server/db.js';
import { CalendarService } from '../server/service.js';
import { Store } from '../server/store.js';

const url = process.env.RADICALE_URL;
const user = process.env.RADICALE_USER ?? '';
const password = process.env.RADICALE_PASSWORD ?? '';
const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

const external = (uid: string, summary: string, start = '20261118T100000Z') => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iOS 18//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:20261116T000000Z
DTSTART:${start}
DTEND:20261118T110000Z
SUMMARY:${summary}
END:VEVENT
END:VCALENDAR
`;

describe.skipIf(!url)('synchro CalDAV (Radicale)', () => {
  const store = new Store(openDb(':memory:'));
  const caldav = new CaldavSync(store, { serverUrl: url!, username: user, password });
  const service = new CalendarService(store, caldav, 'Europe/Zurich');
  const range = [new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z')] as const;

  it('fait l’aller-retour complet', async () => {
    const name = `test-${Date.now()}`;
    const mk = await fetch(`${url}/${user}/${name}/`, { method: 'MKCALENDAR', headers: { authorization: auth } });
    expect(mk.status).toBe(201);
    await caldav.sync();
    expect(caldav.getStatus().lastError).toBeNull();
    const cal = store.listCalendars().find((c) => c.url?.endsWith(`/${name}/`))!;
    expect(cal).toBeDefined();

    const titles = () => store.occurrences(...range).filter((o) => o.calendarId === cal.id).map((o) => o.title);

    // 1. Création depuis Alfred → présente sur le serveur
    const id = await service.create({ calendarId: cal.id, title: 'Créé dans Alfred', start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T10:00:00.000Z', allDay: false });
    const ev = store.getEvent(id)!;
    const remote = await fetch(ev.href!, { headers: { authorization: auth } });
    expect(remote.status).toBe(200);
    expect(await remote.text()).toContain('SUMMARY:Créé dans Alfred');

    // 2. Création « depuis l'iPhone » → apparaît après synchro
    const extHref = new URL('ext-1.ics', cal.url!).href;
    await fetch(extHref, { method: 'PUT', headers: { authorization: auth, 'content-type': 'text/calendar' }, body: external('ext-1', 'Depuis iPhone') });
    await caldav.sync();
    expect(titles().sort()).toEqual(['Créé dans Alfred', 'Depuis iPhone']);

    // 3. Modification externe → reflétée
    await fetch(extHref, { method: 'PUT', headers: { authorization: auth, 'content-type': 'text/calendar' }, body: external('ext-1', 'Modifié sur Mac') });
    await caldav.sync();
    expect(titles()).toContain('Modifié sur Mac');

    // 4. Conflit : modifié ailleurs entre-temps → refus propre et rechargement
    const created = store.getEvent(id)!;
    await fetch(created.href!, { method: 'PUT', headers: { authorization: auth, 'content-type': 'text/calendar' }, body: (await (await fetch(created.href!, { headers: { authorization: auth } })).text()).replace('Créé dans Alfred', 'Changé sur iPhone') });
    await expect(service.update(id, { calendarId: cal.id, title: 'Version Alfred', start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T10:00:00.000Z', allDay: false }, 'all', null)).rejects.toBeInstanceOf(ConflictError);
    expect(titles()).toContain('Changé sur iPhone');

    // 5. Modification depuis Alfred après rechargement → OK
    await service.update(id, { calendarId: cal.id, title: 'Version Alfred', start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T11:00:00.000Z', allDay: false }, 'all', null);
    expect(await (await fetch(created.href!, { headers: { authorization: auth } })).text()).toContain('SUMMARY:Version Alfred');

    // 6. Suppression externe → disparaît ; suppression depuis Alfred → disparaît du serveur
    await fetch(extHref, { method: 'DELETE', headers: { authorization: auth } });
    await caldav.sync();
    expect(titles()).toEqual(['Version Alfred']);
    await service.remove(id, 'all', null);
    expect((await fetch(created.href!, { headers: { authorization: auth } })).status).toBe(404);
    await caldav.sync();
    expect(titles()).toEqual([]);
    await fetch(cal.url!, { method: 'DELETE', headers: { authorization: auth } });
  });
});
