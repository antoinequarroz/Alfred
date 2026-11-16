import ICAL from 'ical.js';

/**
 * Fuseaux à heure d'Europe centrale (CET/CEST, changement le dernier dimanche
 * de mars et d'octobre). Alfred écrit ses événements dans le fuseau configuré
 * avec un VTIMEZONE, pour que les répétitions suivent l'heure d'été.
 */
const CET_ZONES = new Set([
  'Europe/Zurich', 'Europe/Paris', 'Europe/Berlin', 'Europe/Vienna', 'Europe/Rome',
  'Europe/Madrid', 'Europe/Brussels', 'Europe/Amsterdam', 'Europe/Luxembourg',
  'Europe/Monaco', 'Europe/Vaduz', 'Europe/Stockholm', 'Europe/Oslo',
  'Europe/Copenhagen', 'Europe/Prague', 'Europe/Warsaw', 'Europe/Budapest',
]);

export function isSupportedTimezone(tzid: string): boolean {
  return CET_ZONES.has(tzid) || tzid === 'UTC';
}

export function vtimezoneText(tzid: string): string | null {
  if (!CET_ZONES.has(tzid)) return null;
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19810329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19961027T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\r\n');
}

/** Composant VTIMEZONE prêt à insérer (null pour UTC). */
export function vtimezoneComponent(tzid: string): ICAL.Component | null {
  const text = vtimezoneText(tzid);
  if (!text) return null;
  return new ICAL.Component(ICAL.parse(text) as unknown[]);
}

/** Enregistre un fuseau auprès d'ical.js s'il ne l'est pas déjà. */
export function registerTimezone(tzid: string): void {
  if (tzid === 'UTC' || ICAL.TimezoneService.has(tzid)) return;
  const comp = vtimezoneComponent(tzid);
  if (comp) ICAL.TimezoneService.register(comp);
}

/** Enregistre les VTIMEZONE contenus dans un VCALENDAR (iCloud les inclut toujours). */
export function registerCalendarTimezones(vcal: ICAL.Component): void {
  for (const tz of vcal.getAllSubcomponents('vtimezone')) {
    const tzid = tz.getFirstPropertyValue('tzid');
    if (typeof tzid === 'string' && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(tz);
    }
  }
}

/** Instant JS → ICAL.Time dans le fuseau donné. */
export function timeInZone(date: Date, tzid: string): ICAL.Time {
  const utc = ICAL.Time.fromJSDate(date, true);
  if (tzid === 'UTC') return utc;
  registerTimezone(tzid);
  const zone = ICAL.TimezoneService.get(tzid);
  return zone ? utc.convertToZone(zone) : utc;
}
