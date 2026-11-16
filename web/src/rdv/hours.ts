import type { BookingHoursRange } from '../../../shared/types';

export const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

export interface HoursProblem {
  /** Position de la plage fautive dans la liste reçue. */
  index: number;
  /** Message pour Antoine, qui nomme le jour (« Lundi : la fin doit être après le début »). */
  message: string;
}

/**
 * Contrôle des horaires hebdomadaires avant l'envoi : fin après le début, pas de
 * chevauchement dans un même jour. Renvoie les plages fautives, dans l'ordre de la liste.
 */
export function hoursProblems(list: BookingHoursRange[]): HoursProblem[] {
  const problems = new Map<number, string>();
  list.forEach((r, index) => {
    if (r.endMin <= r.startMin) problems.set(index, `${WEEKDAYS[r.weekday - 1]} : la fin doit être après le début`);
  });
  list.forEach((r, index) => {
    if (problems.has(index)) return;
    // Chevauchement avec une plage valide du même jour placée plus haut : c'est la seconde qui est signalée.
    const clash = list.some((o, other) => other < index && !(o.endMin <= o.startMin) && o.weekday === r.weekday && o.startMin < r.endMin && r.startMin < o.endMin);
    if (clash) problems.set(index, `${WEEKDAYS[r.weekday - 1]} : deux plages se chevauchent`);
  });
  return [...problems].sort((a, b) => a[0] - b[0]).map(([index, message]) => ({ index, message }));
}
