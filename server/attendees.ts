import { attendeesOf } from './ics.js';
import { ALL_SPACES, type Sql } from './sql.js';

// Invités des événements (phase 4, ALFRED-300).
//
//   event_attendees (space_id, event_id, email, name, partstat)   clé : (space_id, event_id, email)
//
// Copie des lignes ATTENDEE de chaque événement, refaite à chaque enregistrement (Store.saveEvent).
// L'e-mail est normalisé comme celui des fiches (people.email) : un invité est reconnu comme une
// Personne par simple jointure, dès que son e-mail est connu, sans créer de fiche pour lui.
//
// events.attendees_at garde la date de modification de l'événement au moment de la copie. L'image
// précédente d'Alfred ne remplit pas la table : au démarrage suivant, syncEventAttendees refait la
// copie des événements dont attendees_at ne correspond plus à modified_at.

/** Refait la copie des invités d'un événement (iCalendar illisible : aucun invité). */
export function saveAttendees(db: Sql, spaceId: string, eventId: string, ics: string, modifiedAt: string | null): void {
  let list: ReturnType<typeof attendeesOf> = [];
  try {
    list = attendeesOf(ics);
  } catch {
    list = [];
  }
  db.run(`DELETE FROM event_attendees WHERE space_id = ? AND event_id = ? ${ALL_SPACES}`, spaceId, eventId);
  for (const a of list) {
    db.run(
      `INSERT INTO event_attendees (space_id, event_id, email, name, partstat) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (space_id, event_id, email) DO NOTHING ${ALL_SPACES}`,
      spaceId, eventId, a.email, a.name, a.partstat);
  }
  db.run(`UPDATE events SET attendees_at = ? WHERE id = ? AND space_id = ? ${ALL_SPACES}`, modifiedAt, eventId, spaceId);
}

/**
 * Refait la copie des invités des événements qui ne l'ont pas (écrits par l'image précédente,
 * importés, ou d'avant la migration 8) et retire celle des événements disparus. Tous les espaces.
 * Renvoie le nombre d'événements relus.
 */
export function syncEventAttendees(db: Sql): number {
  if (!db.tables().includes('event_attendees')) return 0;
  const rows = db.all<{ id: string; space_id: string; ics: string; modified_at: string | null }>(
    `SELECT id, space_id, ics, modified_at FROM events
     WHERE attendees_at IS NULL OR attendees_at <> modified_at ORDER BY id ${ALL_SPACES}`);
  for (const r of rows) saveAttendees(db, r.space_id, r.id, r.ics, r.modified_at);
  db.run(`DELETE FROM event_attendees WHERE NOT EXISTS (
      SELECT 1 FROM events e WHERE e.id = event_attendees.event_id AND e.space_id = event_attendees.space_id) ${ALL_SPACES}`);
  return rows.length;
}
