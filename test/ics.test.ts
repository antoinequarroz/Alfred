import { describe, expect, it } from 'vitest';
import { applyEdit, buildNewEvent, expand, removeOccurrence, summarize } from '../server/ics.js';

const TZ = 'Europe/Zurich';

const ICLOUD_WEEKLY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//macOS 15.0//EN
BEGIN:VTIMEZONE
TZID:Europe/Zurich
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
DTSTART:19810329T020000
TZNAME:UTC+2
TZOFFSETTO:+0200
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
DTSTART:19961027T030000
TZNAME:UTC+1
TZOFFSETTO:+0100
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1
DTSTAMP:20261001T000000Z
DTSTART;TZID=Europe/Zurich:20261019T090000
DTEND;TZID=Europe/Zurich:20261019T100000
RRULE:FREQ=WEEKLY
SUMMARY:Cours
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
DTSTAMP:20261001T000000Z
RECURRENCE-ID;TZID=Europe/Zurich:20261109T090000
DTSTART;TZID=Europe/Zurich:20261109T140000
DTEND;TZID=Europe/Zurich:20261109T150000
SUMMARY:Cours déplacé
END:VEVENT
END:VCALENDAR`;

describe('expand', () => {
  it('suit l’heure d’été et applique les exceptions', () => {
    const occ = expand(ICLOUD_WEEKLY, new Date('2026-10-19T00:00:00Z'), new Date('2026-11-17T00:00:00Z'));
    expect(occ.map((o) => [o.start, o.title])).toEqual([
      ['2026-10-19T07:00:00.000Z', 'Cours'], // heure d'été : 9h = 07:00 UTC
      ['2026-10-26T08:00:00.000Z', 'Cours'], // heure d'hiver : 9h = 08:00 UTC
      ['2026-11-02T08:00:00.000Z', 'Cours'],
      ['2026-11-09T13:00:00.000Z', 'Cours déplacé'],
      ['2026-11-16T08:00:00.000Z', 'Cours'],
    ]);
    expect(occ[3].occurrenceId).toBe('2026-11-09T08:00:00.000Z');
    expect(occ.every((o) => o.recurring && o.repeat === 'weekly')).toBe(true);
  });

  it('résume une série infinie', () => {
    const s = summarize(ICLOUD_WEEKLY);
    expect(s.recurring).toBe(true);
    expect(s.recurEndMs).toBeNull();
    expect(s.uid).toBe('weekly-1');
  });
});

describe('écriture', () => {
  it('crée un événement avec fuseau et le relit', () => {
    const { ics, uid } = buildNewEvent({
      calendarId: 'x', title: 'Dentiste', start: '2026-11-20T13:30:00.000Z', end: '2026-11-20T14:30:00.000Z',
      allDay: false, location: 'Sion', repeat: 'none',
    }, TZ);
    expect(ics).toContain('DTSTART;TZID=Europe/Zurich:20261120T143000');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(uid).toMatch(/@alfred$/);
    const [o] = expand(ics, new Date('2026-11-20T00:00:00Z'), new Date('2026-11-21T00:00:00Z'));
    expect(o).toMatchObject({ title: 'Dentiste', start: '2026-11-20T13:30:00.000Z', location: 'Sion', recurring: false });
  });

  it('crée un événement sur la journée entière', () => {
    const { ics } = buildNewEvent({ calendarId: 'x', title: 'Vacances', start: '2026-12-24', end: '2026-12-27', allDay: true }, TZ);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261224');
    expect(ics).not.toContain('VTIMEZONE');
    const occ = expand(ics, new Date('2026-12-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
    expect(occ[0]).toMatchObject({ start: '2026-12-24', end: '2026-12-27', allDay: true });
  });

  it('modifie une seule occurrence', () => {
    const base = expand(ICLOUD_WEEKLY, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-03T00:00:00Z'))[0];
    const ics = applyEdit(ICLOUD_WEEKLY, {
      calendarId: 'x', title: 'Cours annulé ?', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z', allDay: false,
    }, { scope: 'this', occurrenceId: base.occurrenceId, tzid: TZ });
    const occ = expand(ics, new Date('2026-10-26T00:00:00Z'), new Date('2026-11-10T00:00:00Z'));
    expect(occ.map((o) => o.title)).toEqual(['Cours', 'Cours annulé ?', 'Cours déplacé']);
    expect(occ[1].start).toBe('2026-11-02T09:00:00.000Z');
  });

  it('décale toute la série depuis une occurrence', () => {
    const ics = applyEdit(ICLOUD_WEEKLY, {
      calendarId: 'x', title: 'Cours', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:30:00.000Z', allDay: false, repeat: 'custom',
    }, { scope: 'all', occurrenceId: '2026-11-02T08:00:00.000Z', tzid: TZ });
    const occ = expand(ics, new Date('2026-10-19T00:00:00Z'), new Date('2026-11-17T00:00:00Z'));
    // 10h heure locale chaque semaine, durée 1h30, exception supprimée
    expect(occ.map((o) => o.start)).toEqual([
      '2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z',
      '2026-11-09T09:00:00.000Z', '2026-11-16T09:00:00.000Z',
    ]);
    expect(occ[0].end).toBe('2026-10-19T09:30:00.000Z');
  });

  it('change le titre de la série sans toucher aux horaires', () => {
    const ics = applyEdit(ICLOUD_WEEKLY, {
      calendarId: 'x', title: 'Cours HES', start: '2026-11-16T08:00:00.000Z', end: '2026-11-16T09:00:00.000Z', allDay: false, repeat: 'weekly',
    }, { scope: 'all', occurrenceId: '2026-11-16T08:00:00.000Z', tzid: TZ });
    const occ = expand(ics, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-17T00:00:00Z'));
    expect(occ.map((o) => o.title)).toEqual(['Cours HES', 'Cours déplacé', 'Cours HES']);
    expect(ics).toContain('SEQUENCE:1');
  });

  it('supprime une occurrence par EXDATE', () => {
    const ics = removeOccurrence(ICLOUD_WEEKLY, '2026-11-09T08:00:00.000Z')!;
    expect(ics).toContain('EXDATE;TZID=Europe/Zurich:20261109T090000');
    const occ = expand(ics, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-17T00:00:00Z'));
    expect(occ.map((o) => o.start)).toEqual(['2026-11-02T08:00:00.000Z', '2026-11-16T08:00:00.000Z']);
  });

  it('crée une répétition hebdomadaire qui garde l’heure locale', () => {
    const { ics } = buildNewEvent({
      calendarId: 'x', title: 'Sport', start: '2026-10-20T16:00:00.000Z', end: '2026-10-20T17:00:00.000Z', allDay: false, repeat: 'weekly',
    }, TZ);
    const occ = expand(ics, new Date('2026-10-19T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    expect(occ.map((o) => o.start)).toEqual(['2026-10-20T16:00:00.000Z', '2026-10-27T17:00:00.000Z']);
    expect(summarize(ics).recurEndMs).toBeNull();
  });
});
