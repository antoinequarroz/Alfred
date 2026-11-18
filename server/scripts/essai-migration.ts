// Essai de la migration sur une COPIE d'une base Alfred, sans jamais écrire dans l'originale.
//
//   node dist/server/scripts/essai-migration.js /chemin/alfred.db
//
// Sur le VPS, dans un conteneur jetable de la nouvelle image, base montée en lecture seule :
//   docker run --rm -v /opt/alfred/data:/src:ro alfred:phase4 node dist/server/scripts/essai-migration.js /src/alfred.db
//
// Affiche ce que la migration ferait (fiches créées, réservations rattachées), vérifie le retour
// arrière, puis efface la copie.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db.js';
import { migrateDown, schemaVersion } from '../migrations.js';

const source = process.argv[2];
if (!source) {
  console.error('Usage : essai-migration <alfred.db>');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'alfred-essai-'));
try {
  const original = new DatabaseSync(source, { readOnly: true });
  original.exec(`VACUUM INTO '${join(dir, 'alfred.db').replace(/'/g, "''")}'`);
  const count = (db: { prepare(sql: string): { get(): unknown } }, sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const before = {
    bookings: count(original, 'SELECT COUNT(*) AS n FROM bookings'),
    emails: count(original, 'SELECT COUNT(DISTINCT lower(trim(email))) AS n FROM bookings'),
    events: count(original, 'SELECT COUNT(*) AS n FROM events'),
  };
  original.close();

  const db = openDb(dir);
  const after = {
    version: schemaVersion(db),
    bookings: count(db, 'SELECT COUNT(*) AS n FROM bookings'),
    people: count(db, 'SELECT COUNT(*) AS n FROM people'),
    orphans: count(db, 'SELECT COUNT(*) AS n FROM bookings WHERE person_id IS NULL'),
    events: count(db, 'SELECT COUNT(*) AS n FROM events'),
  };
  console.log('Avant :', before);
  console.log('Après :', after);
  const ok = after.bookings === before.bookings && after.events === before.events && after.people === before.emails && after.orphans === 0;
  migrateDown(db, 0);
  const back = count(db, 'SELECT COUNT(*) AS n FROM bookings') === before.bookings && schemaVersion(db) === 0;
  db.close();
  console.log(ok ? 'Migration : OK (aucune perte, chaque réservation a sa fiche)' : 'Migration : ÉCART, ne pas déployer');
  console.log(back ? 'Retour arrière : OK' : 'Retour arrière : ÉCHEC');
  process.exitCode = ok && back ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
