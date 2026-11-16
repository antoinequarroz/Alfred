// Contrôle des horaires dans l'admin, avant l'envoi au serveur.
import { describe, expect, it } from 'vitest';
import { hoursProblems } from '../web/src/rdv/hours.js';

const r = (weekday: number, start: string, end: string) => {
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return { weekday, startMin: min(start), endMin: min(end) };
};

describe('admin : contrôle des horaires', () => {
  it('accepte des plages correctes, même saisies dans le désordre ou qui se touchent', () => {
    expect(hoursProblems([])).toEqual([]);
    expect(hoursProblems([r(1, '13:30', '17:30'), r(1, '09:00', '12:00'), r(2, '09:00', '12:00'), r(2, '12:00', '14:00'), r(7, '00:00', '24:00')])).toEqual([]);
  });

  it('désigne la plage dont la fin précède le début, en nommant le jour', () => {
    // Lundi, plage 1 : début passé à 14:00 alors que la fin est restée à 12:00.
    expect(hoursProblems([r(1, '14:00', '12:00'), r(1, '13:30', '17:30'), r(3, '10:00', '10:00')])).toEqual([
      { index: 0, message: 'Lundi : la fin doit être après le début' },
      { index: 2, message: 'Mercredi : la fin doit être après le début' },
    ]);
  });

  it('désigne la seconde de deux plages qui se chevauchent le même jour', () => {
    expect(hoursProblems([r(5, '09:00', '12:00'), r(4, '11:00', '13:00'), r(5, '11:30', '15:00')])).toEqual([
      { index: 2, message: 'Vendredi : deux plages se chevauchent' },
    ]);
    // Une plage déjà fautive ne déclenche pas en plus un chevauchement.
    expect(hoursProblems([r(1, '14:00', '12:00'), r(1, '11:00', '13:00')])).toEqual([{ index: 0, message: 'Lundi : la fin doit être après le début' }]);
  });
});
