// Dates de l'interface de prise de rendez-vous : affichage dans le fuseau du serveur, calendrier par clés de jour.
import { describe, expect, it } from 'vitest';
import {
  addDaysKey, addMonths, dayKeyIn, dayLabel, dayLongIn, durationLabel, lastDayOf, monthLabel, monthOf, monthWeeks, timeIn, timezoneLabel,
} from '../web/src/rdv/tz';

const ZURICH = 'Europe/Zurich';

describe('interface de prise de RDV : dates', () => {
  it('affiche les heures dans le fuseau donné, été comme hiver', () => {
    expect(timeIn(ZURICH, '2026-11-16T08:00:00.000Z')).toBe('09:00');
    expect(timeIn(ZURICH, '2026-07-16T07:00:00.000Z')).toBe('09:00');
    expect(timeIn(ZURICH, '2026-11-16T23:30:00.000Z')).toBe('00:30');
    expect(timeIn('America/New_York', '2026-11-16T08:00:00.000Z')).toBe('03:00');
  });

  it('donne le jour local d’un instant, y compris autour de minuit et du changement d’heure', () => {
    expect(dayKeyIn(ZURICH, new Date('2026-11-16T22:59:00Z'))).toBe('2026-11-16');
    expect(dayKeyIn(ZURICH, new Date('2026-11-16T23:00:00Z'))).toBe('2026-11-17');
    expect(dayKeyIn(ZURICH, new Date('2026-03-28T23:30:00Z'))).toBe('2026-03-29');
    expect(dayKeyIn(ZURICH, new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');
  });

  it('écrit les dates en français, sans virgule', () => {
    expect(dayLongIn(ZURICH, '2026-11-19T08:30:00.000Z')).toBe('jeudi 19 novembre 2026');
    expect(dayLabel('2026-11-19')).toBe('jeudi 19 novembre');
    expect(monthLabel('2026-11')).toBe('Novembre 2026');
    expect(timezoneLabel(ZURICH)).toBe('heure de Suisse (Europe/Zurich)');
  });

  it('calcule sur les clés de jour sans dépendre du fuseau', () => {
    expect(addDaysKey('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDaysKey('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysKey('2026-11-16', 60)).toBe('2027-01-15');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(lastDayOf('2026-02')).toBe('2026-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(monthOf('2026-11-16')).toBe('2026-11');
  });

  it('découpe un mois en semaines complètes, du lundi au dimanche', () => {
    const november = monthWeeks('2026-11'); // le 1er est un dimanche
    expect(november).toHaveLength(6);
    expect(november[0][0]).toBe('2026-10-26');
    expect(november[0][6]).toBe('2026-11-01');
    expect(november[5][0]).toBe('2026-11-30');
    const february = monthWeeks('2027-02'); // du lundi 1er au dimanche 28
    expect(february).toHaveLength(4);
    expect(february[0][0]).toBe('2027-02-01');
    expect(february[3][6]).toBe('2027-02-28');
    for (const week of [...november, ...february]) expect(week).toHaveLength(7);
  });

  it('écrit les durées', () => {
    expect(durationLabel(30)).toBe('30 min');
    expect(durationLabel(60)).toBe('1 h');
    expect(durationLabel(90)).toBe('1 h 30');
  });
});
