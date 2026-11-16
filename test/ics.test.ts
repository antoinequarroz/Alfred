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

  it('émet une occurrence avancée ou reculée de plusieurs semaines par une exception', () => {
    // Série mensuelle le 7 à 09:00 ; l'occurrence du 7 décembre est avancée au 23 novembre,
    // celle du 7 octobre repoussée au 25 novembre.
    const monthly = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:monthly-1
DTSTAMP:20260101T000000Z
DTSTART:20260107T080000Z
DTEND:20260107T090000Z
RRULE:FREQ=MONTHLY
SUMMARY:Supervision
END:VEVENT
BEGIN:VEVENT
UID:monthly-1
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261207T080000Z
DTSTART:20261123T080000Z
DTEND:20261123T090000Z
SUMMARY:Supervision avancée
END:VEVENT
BEGIN:VEVENT
UID:monthly-1
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261007T080000Z
DTSTART:20261125T080000Z
DTEND:20261125T090000Z
SUMMARY:Supervision repoussée
END:VEVENT
END:VCALENDAR`;
    const day = (d: string) => expand(monthly, new Date(`${d}T00:00:00Z`), new Date(`${d}T23:59:00Z`)).map((o) => [o.start, o.title, o.occurrenceId]);
    expect(day('2026-11-23')).toEqual([['2026-11-23T08:00:00.000Z', 'Supervision avancée', '2026-12-07T08:00:00.000Z']]);
    expect(day('2026-11-25')).toEqual([['2026-11-25T08:00:00.000Z', 'Supervision repoussée', '2026-10-07T08:00:00.000Z']]);
    // Les dates d'origine sont libérées, les autres occurrences sont intactes et rien n'est doublé.
    expect(day('2026-12-07')).toEqual([]);
    expect(day('2026-10-07')).toEqual([]);
    const all = expand(monthly, new Date('2026-10-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z')).map((o) => o.start);
    expect(all).toEqual(['2026-11-07T08:00:00.000Z', '2026-11-23T08:00:00.000Z', '2026-11-25T08:00:00.000Z']);
  });

  it('reprend une vieille série près de la période demandée, avec le même résultat que depuis son début', () => {
    const series = (dtstart: string, rule: string, extra: string[] = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0',
      ...ICLOUD_WEEKLY.split('\n').slice(3, 20), // VTIMEZONE Europe/Zurich
      'BEGIN:VEVENT', 'UID:old-1', 'DTSTAMP:20140101T000000Z', dtstart, 'DURATION:PT45M', `RRULE:${rule}`, ...extra, 'SUMMARY:Série', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const zurich = 'DTSTART;TZID=Europe/Zurich:20140106T023000'; // 02:30 : heure qui n'existe pas le jour du passage à l'heure d'été
    const cases = [
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=WEEKLY'),
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=WEEKLY;INTERVAL=2'),
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,WE,FR'),
      series('DTSTART;TZID=Europe/Zurich:20140108T090000', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=SU'),
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=WEEKLY;UNTIL=20261120T000000Z'),
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=DAILY'),
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=DAILY;INTERVAL=3'),
      series(zurich, 'FREQ=DAILY'),
      series('DTSTART:20140106T080000Z', 'FREQ=WEEKLY', ['EXDATE:20261116T080000Z', 'EXDATE:20270329T080000Z']),
      series('DTSTART;VALUE=DATE:20140106', 'FREQ=WEEKLY;INTERVAL=2').replace('DURATION:PT45M', 'DTEND;VALUE=DATE:20140107'),
      // Règles non accélérées : même résultat, par le chemin lent.
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=WEEKLY;COUNT=700'),
      series('DTSTART;TZID=Europe/Zurich:20140131T090000', 'FREQ=MONTHLY'),
      series('DTSTART;TZID=Europe/Zurich:20140106T090000', 'FREQ=DAILY;BYDAY=MO,TH'),
    ];
    const ranges: [string, string][] = [
      ['2026-11-09T00:00:00Z', '2026-12-01T00:00:00Z'],
      ['2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z'], // retour à l'heure d'hiver
      ['2027-03-22T00:00:00Z', '2027-04-05T00:00:00Z'], // passage à l'heure d'été
      ['2014-01-01T00:00:00Z', '2014-02-01T00:00:00Z'], // début de la série
    ];
    for (const ics of cases) {
      // Référence : la série développée depuis son début, puis réduite à la période.
      const all = expand(ics, new Date('2014-01-01T00:00:00Z'), new Date('2027-06-01T00:00:00Z'));
      expect(all.length).toBeGreaterThan(50);
      let found = 0;
      for (const [from, to] of ranges) {
        const got = expand(ics, new Date(from), new Date(to)).map((o) => [o.start, o.end, o.occurrenceId]);
        const day = 86_400_000;
        const want = all.filter((o) => (o.allDay
          ? new Date(`${o.start}T00:00:00`).getTime() < Date.parse(to) + day && new Date(`${o.end}T00:00:00`).getTime() > Date.parse(from) - day
          : o.start < new Date(to).toISOString() && o.end > new Date(from).toISOString())).map((o) => [o.start, o.end, o.occurrenceId]);
        expect(got).toEqual(want);
        found += got.length;
      }
      expect(found).toBeGreaterThan(0);
    }
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

  it('renommer la série depuis une occurrence déplacée ne décale rien', () => {
    const ics = applyEdit(ICLOUD_WEEKLY, {
      calendarId: 'x', title: 'Cours renommé', start: '2026-11-09T13:00:00.000Z', end: '2026-11-09T14:00:00.000Z', allDay: false, repeat: 'weekly',
    }, { scope: 'all', occurrenceId: '2026-11-09T08:00:00.000Z', tzid: TZ });
    expect(ics).toContain('DTSTART;TZID=Europe/Zurich:20261019T090000');
    expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Zurich:20261109T090000');
    const occ = expand(ics, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-17T00:00:00Z'));
    expect(occ.map((o) => o.start)).toEqual(['2026-11-02T08:00:00.000Z', '2026-11-09T13:00:00.000Z', '2026-11-16T08:00:00.000Z']);
  });

  it('garde le fuseau d’origine d’une série créée ailleurs', () => {
    const NY = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:ny-1
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20260302T090000
DURATION:PT1H
RRULE:FREQ=WEEKLY
EXDATE;TZID=America/New_York:20260316T090000
SUMMARY:Call
END:VEVENT
END:VCALENDAR`;
    const renamed = applyEdit(NY, {
      calendarId: 'x', title: 'Call US', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T15:00:00.000Z', allDay: false, repeat: 'weekly',
    }, { scope: 'all', occurrenceId: '2026-03-02T14:00:00.000Z', tzid: TZ });
    expect(renamed).toContain('DTSTART;TZID=America/New_York:20260302T090000');
    expect(renamed).toContain('DURATION:PT1H');
    expect(renamed).toContain('EXDATE;TZID=America/New_York:20260316T090000');
    // Décalage d'une heure : la série reste à New York.
    const moved = applyEdit(NY, {
      calendarId: 'x', title: 'Call', start: '2026-03-09T14:00:00.000Z', end: '2026-03-09T15:00:00.000Z', allDay: false, repeat: 'weekly',
    }, { scope: 'all', occurrenceId: '2026-03-09T13:00:00.000Z', tzid: TZ });
    expect(moved).toContain('DTSTART;TZID=America/New_York:20260302T100000');
    expect(moved).toContain('DTEND;TZID=America/New_York:20260302T110000');
  });

  it('décale une série de journées entières à travers le changement d’heure', () => {
    const ALLDAY = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ad-1
DTSTAMP:20260101T000000Z
DTSTART;VALUE=DATE:20260316
DTEND;VALUE=DATE:20260317
RRULE:FREQ=WEEKLY
SUMMARY:Ménage
END:VEVENT
END:VCALENDAR`;
    const ics = applyEdit(ALLDAY, { calendarId: 'x', title: 'Ménage', start: '2026-03-31', end: '2026-04-02', allDay: true, repeat: 'weekly' },
      { scope: 'all', occurrenceId: '2026-03-30', tzid: TZ });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260317');
    expect(ics).toContain('DTEND;VALUE=DATE:20260319');
  });

  it('refuse de changer de jour une série à règle personnalisée', () => {
    const custom = ICLOUD_WEEKLY.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE');
    expect(() => applyEdit(custom, {
      calendarId: 'x', title: 'Cours', start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T09:00:00.000Z', allDay: false, repeat: 'custom',
    }, { scope: 'all', occurrenceId: '2026-11-02T08:00:00.000Z', tzid: TZ })).toThrow(/règle personnalisée/);
    // Changer seulement l'heure reste possible.
    const ok = applyEdit(custom, {
      calendarId: 'x', title: 'Cours', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z', allDay: false, repeat: 'custom',
    }, { scope: 'all', occurrenceId: '2026-11-02T08:00:00.000Z', tzid: TZ });
    expect(ok).toContain('DTSTART;TZID=Europe/Zurich:20261019T100000');
  });

  it('affiche le premier jour d’une répétition par dates (RDATE)', () => {
    const RD = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:rd-1
DTSTAMP:20260101T000000Z
DTSTART:20260105T090000Z
DTEND:20260105T100000Z
RDATE:20260201T090000Z,20260301T090000Z
SUMMARY:Atelier
END:VEVENT
END:VCALENDAR`;
    const occ = expand(RD, new Date('2026-01-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));
    expect(occ.map((o) => o.start)).toEqual(['2026-01-05T09:00:00.000Z', '2026-02-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z']);
  });

  it('ne réécrit pas les horaires d’un événement simple quand seul le titre change', () => {
    const one = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:one-1
DTSTAMP:20260101T000000Z
DTSTART:20261120T130000Z
DURATION:PT45M
SUMMARY:Visio
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
END:VALARM
END:VEVENT
END:VCALENDAR`;
    const ics = applyEdit(one, { calendarId: 'x', title: 'Visio client', start: '2026-11-20T13:00:00.000Z', end: '2026-11-20T13:45:00.000Z', allDay: false, repeat: 'none' },
      { scope: 'all', occurrenceId: null, tzid: TZ });
    expect(ics).toContain('DTSTART:20261120T130000Z');
    expect(ics).toContain('DURATION:PT45M');
    expect(ics).toContain('TRIGGER:-PT15M');
    expect(ics).toContain('SUMMARY:Visio client');
  });
});
