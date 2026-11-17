import { describe, expect, it } from 'vitest';
import {
  addDays, computeSlotDays, computeSlots, localDateOf, startOfLocalDay, wallToUtc,
  type BusyEvent, type HoursRange, type SlotQuery, type SlotType,
} from '../server/booking/slots.js';

const TZ = 'Europe/Zurich';
const TYPE: SlotType = { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeHours: 0, horizonDays: 365 };
/** Lundi à vendredi, 09:00-12:00 et 13:30-17:30. */
const WEEK: HoursRange[] = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMin: 9 * 60, endMin: 12 * 60 },
  { weekday, startMin: 13 * 60 + 30, endMin: 17 * 60 + 30 },
]);
/** Dimanche 15 novembre 2026, 12:00 à Zurich. */
const NOW = new Date('2026-11-15T11:00:00Z');

function query(over: Partial<SlotQuery> & { type?: SlotType } = {}): SlotQuery {
  return { type: TYPE, hours: WEEK, stepMin: 30, timezone: TZ, from: '2026-11-16', to: '2026-11-16', now: NOW, busy: [], ...over };
}

/** Heures locales « HH:MM » des créneaux d'un jour. */
function times(q: SlotQuery): string[] {
  const fmt = new Intl.DateTimeFormat('fr-CH', { timeZone: q.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return computeSlots(q).map((iso) => fmt.format(new Date(iso)));
}

const busy = (start: string, end: string, extra: Partial<BusyEvent> = {}): BusyEvent => ({ start, end, ...extra });

describe('conversions de fuseau', () => {
  it('convertit une heure murale en instant, été comme hiver', () => {
    expect(new Date(wallToUtc(TZ, 2026, 1, 15, 9 * 60)!).toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(new Date(wallToUtc(TZ, 2026, 7, 15, 9 * 60)!).toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('signale l’heure qui n’existe pas en mars et choisit la première en octobre', () => {
    // 29 mars 2026 : 02:00 → 03:00. 02:30 n'existe pas.
    expect(wallToUtc(TZ, 2026, 3, 29, 2 * 60 + 30)).toBeNull();
    expect(new Date(wallToUtc(TZ, 2026, 3, 29, 3 * 60)!).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(new Date(wallToUtc(TZ, 2026, 3, 29, 1 * 60 + 30)!).toISOString()).toBe('2026-03-29T00:30:00.000Z');
    // 25 octobre 2026 : 03:00 → 02:00. 02:30 existe deux fois : on garde la première (heure d'été).
    expect(new Date(wallToUtc(TZ, 2026, 10, 25, 2 * 60 + 30)!).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(new Date(wallToUtc(TZ, 2026, 10, 25, 3 * 60)!).toISOString()).toBe('2026-10-25T02:00:00.000Z');
  });

  it('donne le jour local et le début de journée', () => {
    expect(localDateOf(Date.parse('2026-11-15T23:30:00Z'), TZ)).toBe('2026-11-16');
    expect(localDateOf(Date.parse('2026-07-15T21:59:00Z'), TZ)).toBe('2026-07-15');
    expect(new Date(startOfLocalDay('2026-07-15', TZ)).toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('créneaux : horaires et pas', () => {
  it('propose les créneaux de plusieurs plages par jour, au pas de 30 minutes', () => {
    expect(times(query())).toEqual([
      '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
      '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00',
    ]);
    expect(computeSlots(query())[0]).toBe('2026-11-16T08:00:00.000Z');
  });

  it('respecte le pas de 15 minutes', () => {
    const t = times(query({ stepMin: 15 }));
    expect(t.slice(0, 5)).toEqual(['09:00', '09:15', '09:30', '09:45', '10:00']);
    expect(t).toContain('11:30');
    expect(t).not.toContain('11:45'); // 30 min ne tiennent plus avant midi
    expect(t).toContain('17:00');
    expect(t).toHaveLength(11 + 15);
  });

  it('respecte le pas de 60 minutes, aligné sur le début de chaque plage', () => {
    expect(times(query({ stepMin: 60 }))).toEqual(['09:00', '10:00', '11:00', '13:30', '14:30', '15:30', '16:30']);
  });

  it('ne propose un créneau que si le rendez-vous entier tient dans la plage', () => {
    const t = times(query({ type: { ...TYPE, durationMin: 90 } }));
    expect(t).toEqual(['09:00', '09:30', '10:00', '10:30', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']);
    // Rendez-vous plus long que toute plage : rien.
    expect(times(query({ type: { ...TYPE, durationMin: 300 } }))).toEqual([]);
  });

  it('ne propose rien les jours sans horaires et groupe par jour local', () => {
    // Du samedi 14 au mardi 17 : seuls lundi et mardi ont des horaires (et le 14 est passé).
    const days = computeSlotDays(query({ from: '2026-11-14', to: '2026-11-17' }));
    expect(days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17']);
    expect(days[0].slots).toHaveLength(14);
    expect(computeSlots(query({ hours: [] }))).toEqual([]);
  });

  it('renvoie des créneaux triés et sans doublon, même avec des plages qui se recouvrent', () => {
    const hours: HoursRange[] = [
      { weekday: 1, startMin: 600, endMin: 720 },
      { weekday: 1, startMin: 540, endMin: 660 },
    ];
    expect(times(query({ hours }))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('refuse une plage de dates ou un pas invalides', () => {
    expect(() => computeSlots(query({ from: '2026-13-01' }))).toThrow(RangeError);
    expect(() => computeSlots(query({ stepMin: 0 }))).toThrow(RangeError);
    expect(computeSlots(query({ from: '2026-11-17', to: '2026-11-16' }))).toEqual([]);
  });
});

describe('créneaux : changements d’heure', () => {
  it('garde 09:00 heure murale avant et après le passage à l’heure d’été (mars)', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    // Vendredi 27 mars (hiver, UTC+1) et lundi 30 mars (été, UTC+2).
    const days = computeSlotDays(query({ now, from: '2026-03-27', to: '2026-03-30' }));
    expect(days.map((d) => d.date)).toEqual(['2026-03-27', '2026-03-30']);
    expect(days[0].slots[0]).toBe('2026-03-27T08:00:00.000Z');
    expect(days[1].slots[0]).toBe('2026-03-30T07:00:00.000Z');
    expect(days[0].slots).toHaveLength(14);
    expect(days[1].slots).toHaveLength(14);
  });

  it('garde 09:00 heure murale avant et après le retour à l’heure d’hiver (octobre)', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const days = computeSlotDays(query({ now, from: '2026-10-23', to: '2026-10-26' }));
    expect(days.map((d) => d.date)).toEqual(['2026-10-23', '2026-10-26']);
    expect(days[0].slots[0]).toBe('2026-10-23T07:00:00.000Z');
    expect(days[1].slots[0]).toBe('2026-10-26T08:00:00.000Z');
    expect(days[1].slots.at(-1)).toBe('2026-10-26T16:00:00.000Z'); // 17:00 heure d'hiver
  });

  it('saute l’heure inexistante le jour du passage à l’heure d’été', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const hours: HoursRange[] = [{ weekday: 7, startMin: 0, endMin: 5 * 60 }];
    const q = query({ now, hours, stepMin: 30, from: '2026-03-29', to: '2026-03-29' });
    expect(times(q)).toEqual(['00:00', '00:30', '01:00', '01:30', '03:00', '03:30', '04:00', '04:30']);
    const slots = computeSlots(q);
    // 01:30 puis 03:00 : une seule demi-heure réelle les sépare.
    expect(Date.parse(slots[4]) - Date.parse(slots[3])).toBe(30 * 60_000);
  });

  it('ne propose qu’une fois l’heure doublée le jour du retour à l’heure d’hiver', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const hours: HoursRange[] = [{ weekday: 7, startMin: 60, endMin: 4 * 60 }];
    const q = query({ now, hours, stepMin: 60, type: { ...TYPE, durationMin: 60 }, from: '2026-10-25', to: '2026-10-25' });
    expect(computeSlots(q)).toEqual([
      '2026-10-24T23:00:00.000Z', // 01:00 été
      '2026-10-25T00:00:00.000Z', // 02:00 été (première des deux)
      '2026-10-25T02:00:00.000Z', // 03:00 hiver
    ]);
  });

  it('bloque correctement un événement situé après le changement d’heure', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    // Lundi 30 mars, 10:00-11:00 heure d'été = 08:00-09:00 UTC.
    const t = times(query({ now, from: '2026-03-30', to: '2026-03-30', busy: [busy('2026-03-30T08:00:00Z', '2026-03-30T09:00:00Z')] }));
    expect(t).not.toContain('10:00');
    expect(t).not.toContain('10:30');
    expect(t).toContain('09:30');
    expect(t).toContain('11:00');
  });
});

describe('créneaux : occupation', () => {
  it('retire les créneaux qui chevauchent un événement', () => {
    // 10:15-11:05 heure locale.
    const t = times(query({ busy: [busy('2026-11-16T09:15:00Z', '2026-11-16T10:05:00Z')] }));
    expect(t.slice(0, 4)).toEqual(['09:00', '09:30', '11:30', '13:30']);
  });

  it('accepte les créneaux qui touchent un événement aux bornes', () => {
    // Événement 10:00-11:00 : 09:30 (qui finit à 10:00) et 11:00 restent libres.
    const t = times(query({ busy: [busy('2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')] }));
    expect(t.slice(0, 4)).toEqual(['09:00', '09:30', '11:00', '11:30']);
  });

  it('retire un créneau dès une minute de chevauchement', () => {
    const t = times(query({ busy: [busy('2026-11-16T08:59:00Z', '2026-11-16T09:01:00Z')] }));
    // 09:59-10:01 locale : touche 09:30 et 10:00.
    expect(t.slice(0, 3)).toEqual(['09:00', '10:30', '11:00']);
  });

  it('applique les tampons avant et après', () => {
    const type = { ...TYPE, bufferBeforeMin: 15, bufferAfterMin: 30 };
    // Événement 10:00-11:00 locale.
    const t = times(query({ type, busy: [busy('2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')] }));
    // 09:30 finirait à 10:00 : il faut 30 min libres après → refusé. 09:00 finit à 09:30 + 30 = 10:00 → accepté.
    // 11:00 commencerait à la fin de l'événement : il faut 15 min libres avant → refusé. 11:30 accepté.
    expect(t.slice(0, 3)).toEqual(['09:00', '11:30', '13:30']);
  });

  it('accepte un créneau dont le tampon touche exactement un événement', () => {
    const type = { ...TYPE, bufferBeforeMin: 30, bufferAfterMin: 30 };
    const t = times(query({ type, busy: [busy('2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')] }));
    expect(t.slice(0, 3)).toEqual(['09:00', '11:30', '13:30']);
  });

  it('les tampons ne s’appliquent pas aux bornes des horaires', () => {
    const type = { ...TYPE, bufferBeforeMin: 30, bufferAfterMin: 30 };
    const t = times(query({ type }));
    expect(t[0]).toBe('09:00');
    expect(t.at(-1)).toBe('17:00');
  });

  it('protège les tampons d’une réservation existante', () => {
    // Réservation 10:00-10:30 dont le type demande 30 min après : 10:30 reste pris, même pour un type sans tampon.
    const existing = busy('2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z', { bufferBeforeMin: 0, bufferAfterMin: 30 });
    const t = times(query({ busy: [existing] }));
    expect(t.slice(0, 4)).toEqual(['09:00', '09:30', '11:00', '11:30']);
    // Les tampons ne s'additionnent pas : celui du nouveau (15 avant) est couvert par les 30 après de l'existant.
    const t2 = times(query({ type: { ...TYPE, bufferBeforeMin: 15 }, busy: [existing] }));
    expect(t2.slice(0, 4)).toEqual(['09:00', '09:30', '11:00', '11:30']);
  });

  it('ignore les événements « disponible » (TRANSP:TRANSPARENT) et annulés', () => {
    const b = [
      busy('2026-11-16T08:00:00Z', '2026-11-16T11:00:00Z', { transparent: true }),
      busy('2026-11-16T12:30:00Z', '2026-11-16T16:30:00Z', { cancelled: true }),
    ];
    expect(times(query({ busy: b }))).toHaveLength(14);
  });

  it('bloque toute la journée pour un événement « journée entière » opaque', () => {
    const b = [busy('2026-11-16', '2026-11-17', { allDay: true })];
    const days = computeSlotDays(query({ from: '2026-11-16', to: '2026-11-17', busy: b }));
    expect(days.map((d) => d.date)).toEqual(['2026-11-17']);
    expect(days[0].slots).toHaveLength(14);
  });

  it('bloque chaque jour d’un événement « journée entière » de plusieurs jours, pas le suivant', () => {
    const b = [busy('2026-11-16', '2026-11-19', { allDay: true })];
    const days = computeSlotDays(query({ from: '2026-11-16', to: '2026-11-20', busy: b }));
    expect(days.map((d) => d.date)).toEqual(['2026-11-19', '2026-11-20']);
  });

  it('une journée entière « disponible » ne bloque rien', () => {
    const b = [busy('2026-11-16', '2026-11-17', { allDay: true, transparent: true })];
    expect(times(query({ busy: b }))).toHaveLength(14);
  });

  it('une journée entière suit le jour local à travers un changement d’heure', () => {
    const now = new Date('2026-03-20T12:00:00Z');
    const hours: HoursRange[] = [{ weekday: 7, startMin: 0, endMin: 1440 }, { weekday: 1, startMin: 0, endMin: 1440 }];
    const b = [busy('2026-03-29', '2026-03-30', { allDay: true })];
    const days = computeSlotDays(query({ now, hours, stepMin: 60, from: '2026-03-29', to: '2026-03-30', busy: b }));
    expect(days.map((d) => d.date)).toEqual(['2026-03-30']);
    expect(days[0].slots[0]).toBe('2026-03-29T22:00:00.000Z'); // lundi 00:00 heure d'été
  });

  it('gère des événements qui se recouvrent entre eux', () => {
    const b = [
      busy('2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z'),
      busy('2026-11-16T08:30:00Z', '2026-11-16T10:30:00Z'),
      busy('2026-11-16T08:45:00Z', '2026-11-16T08:50:00Z'),
    ];
    expect(times(query({ busy: b })).slice(0, 2)).toEqual(['11:30', '13:30']);
  });

  it('un événement ponctuel (durée nulle) bloque le créneau qui le contient', () => {
    const t = times(query({ busy: [busy('2026-11-16T08:15:00Z', '2026-11-16T08:15:00Z')] }));
    expect(t.slice(0, 2)).toEqual(['09:30', '10:00']);
  });

  it('un événement ponctuel posé exactement au début d’un créneau bloque ce créneau, pas le précédent', () => {
    // Lundi 09:30 pile : [09:30, 10:00) le contient, [09:00, 09:30) se termine juste avant.
    const t = times(query({ busy: [busy('2026-11-16T08:30:00Z', '2026-11-16T08:30:00Z')] }));
    expect(t.slice(0, 3)).toEqual(['09:00', '10:00', '10:30']);
    // Fin avant le début (donnée incohérente) : traité comme ponctuel.
    const odd = times(query({ busy: [busy('2026-11-16T08:30:00Z', '2026-11-16T08:00:00Z')] }));
    expect(odd.slice(0, 3)).toEqual(['09:00', '10:00', '10:30']);
  });
});

describe('créneaux : préavis et horizon', () => {
  it('respecte le préavis minimal', () => {
    // Lundi 16 novembre, 08:00 locale. Préavis 2 h : premier créneau à 10:00.
    const now = new Date('2026-11-16T07:00:00Z');
    expect(times(query({ now, type: { ...TYPE, minNoticeHours: 2 } }))[0]).toBe('10:00');
    // Préavis 12 h : plus rien le jour même, tout le lendemain.
    const days = computeSlotDays(query({ now, type: { ...TYPE, minNoticeHours: 12 }, from: '2026-11-16', to: '2026-11-17' }));
    expect(days.map((d) => d.date)).toEqual(['2026-11-17']);
    expect(days[0].slots).toHaveLength(14);
  });

  it('accepte un créneau qui commence exactement à la fin du préavis', () => {
    const now = new Date('2026-11-16T07:00:00Z');
    expect(times(query({ now, type: { ...TYPE, minNoticeHours: 1 } }))[0]).toBe('09:00');
    const late = new Date('2026-11-16T07:00:01Z');
    expect(times(query({ now: late, type: { ...TYPE, minNoticeHours: 1 } }))[0]).toBe('09:30');
  });

  it('ne propose jamais de créneau passé', () => {
    const now = new Date('2026-11-16T14:10:00Z'); // 15:10 locale
    expect(times(query({ now }))).toEqual(['15:30', '16:00', '16:30', '17:00']);
    expect(computeSlots(query({ now, from: '2026-11-01', to: '2026-11-13' }))).toEqual([]);
  });

  it('respecte l’horizon maximal, compté en jours calendaires locaux', () => {
    // Aujourd'hui dimanche 15. Horizon 2 jours : jusqu'au mardi 17 inclus.
    const days = computeSlotDays(query({ type: { ...TYPE, horizonDays: 2 }, from: '2026-11-16', to: '2026-11-30' }));
    expect(days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17']);
    expect(days[1].slots).toHaveLength(14); // la dernière journée est entière
  });

  it('l’horizon se compte dans le fuseau, pas en UTC', () => {
    // 23:30 UTC le 15 = 00:30 le 16 à Zurich : « aujourd'hui » est déjà lundi.
    const now = new Date('2026-11-15T23:30:00Z');
    const days = computeSlotDays(query({ now, type: { ...TYPE, horizonDays: 1 }, from: '2026-11-16', to: '2026-11-30' }));
    expect(days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17']);
  });
});
