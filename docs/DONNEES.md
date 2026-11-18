# Données d'Alfred dans la suite Media (phase 4)

Alfred prépare ses données pour devenir le module Calendrier de la suite Media, sans attendre
le socle. Référence : le document Linear « Architecture de données d'Alfred dans la suite Media ».

## Ce qui est en place

| Règle du contrat | Dans Alfred |
| -- | -- |
| Migrations versionnées | `server/migrations.ts` : migrations numérotées, appliquées une fois au démarrage dans une transaction, notées dans `schema_migrations`. Chacune a son retour arrière (`down`), testé. |
| Un espace partout | Table `spaces` (une ligne : l'espace « Personnel ») et colonne `space_id` sur toutes les tables, y compris celles qu'une autre branche ajoutera (rattrapées à chaque démarrage). **Toutes** les requêtes filtrent dessus et toutes les insertions l'écrivent ; en test, une garde refuse toute requête sur une table d'espace qui ne mentionne pas `space_id`. |
| Requêtes portables | `server/sql.ts` : couche d'accès commune (`get`, `all`, `run`, `exec`, `tx`) servie par SQLite (production) et PostgreSQL (`server/pg.ts`). Plus de SQL propre à SQLite dans le code métier (un test le vérifie). Toute la suite de tests tourne aussi sur PostgreSQL. |
| Journal d'événements | Table `outbox` au format commun, écrite dans la même transaction que le fait. Les notifications la lisent. Voir [JOURNAL.md](JOURNAL.md). |
| Un seul format d'instant | Texte ISO 8601 UTC avec millisecondes (`2026-11-18T21:45:00.000Z`), partout : voir « Dates et fuseaux » plus bas. |
| Identifiants universels | Les nouveaux objets reçoivent un UUID v7 (`server/ids.ts`). Les anciens identifiants restent valables, les UID iCalendar ne changent pas. |
| Adresses stables | `media://alfred/<type>/<id>` : `person`, `booking`, `event` (par UID iCalendar, qui survit à iCloud et aux changements de calendrier)… `GET /api/v1/resolve?address=` dit ce que désigne une adresse. |
| Personnes | Table `people` : une fiche par e-mail normalisé (minuscules, sans espaces) et par espace. Chaque réservation pointe vers sa fiche (`bookings.person_id`) et garde sa copie figée du nom, de l'e-mail et du téléphone. Rubrique « Personnes » dans l'app. |
| Liens | Table `links (space_id, from_ref, to_ref, kind, title, url)`, au format de la table commune du socle. Un lien de note Cairn collé (`https://cairn…/notes/<id>`) devient `media://cairn/note/<id>`. Depuis une fiche Personne ou un événement. |

Aucune app ne lit la base d'une autre : Cairn n'est jamais interrogé, Alfred garde seulement
l'adresse de la note et le lien pour l'ouvrir.

## Migrations

| N° | Nom | Change | Retour arrière |
| -- | -- | -- | -- |
| 1 | espaces | table `spaces`, `space_id` sur toutes les tables | retire les colonnes et la table |
| 2 | personnes | table `people`, `bookings.person_id`, fiches créées depuis les réservations existantes | retire la colonne et la table |
| 3 | liens | table `links` | retire la table |
| 4 | acomptes | table `payment_holds`, colonnes de paiement | retire les colonnes et la table |
| 5 | journal | tables `outbox` et `outbox_readers` | retire les tables |
| 6 | instants | `events.start_at/end_at/recur_end_at/modified_at/tzid`, `sessions.expires_at`, `booking_hours.tzid`, textes ISO mis au format exact | retire les colonnes |

Règle : une migration n'enlève ni ne renomme rien de ce que lit le code précédent. Remettre
l'image précédente d'Alfred fonctionne donc sans restaurer la base.

Avant un déploiement, essayer la migration sur une copie des données réelles, base montée en
lecture seule :

```bash
docker run --rm -v /opt/alfred/data:/src:ro alfred:phase4 node dist/server/scripts/essai-migration.js /src/alfred.db
```

## Dates et fuseaux

Un seul format d'instant dans la base : le texte ISO 8601 en UTC, avec millisecondes et `Z`
(`toISOString()`). Il a toujours la même longueur, donc l'ordre alphabétique est l'ordre
chronologique et les comparaisons marchent pareil sous SQLite et PostgreSQL. `server/instants.ts`
donne `toInstant()` et la liste de toutes les colonnes d'instant (`INSTANT_COLUMNS`) ; un test
vérifie que toute la base respecte le format et qu'aucune colonne d'instant n'échappe à la liste.

Une heure locale n'est jamais stockée sans son fuseau IANA :

- `booking_hours.tzid` : les minutes des horaires d'ouverture se comptent dans ce fuseau (celui
  d'Alfred au moment de l'enregistrement). Les créneaux sont calculés dans ce fuseau ; si Alfred
  change de fuseau, les Réglages le signalent.
- `events.tzid` : fuseau de l'heure de début, celui que suivent les répétitions (`UTC` pour une
  heure en UTC, vide pour une journée entière ou une heure « flottante »). L'iCalendar d'origine
  reste la référence, avec son VTIMEZONE.

Les anciennes colonnes en millisecondes (`events.start_ms`, `end_ms`, `recur_end_ms`,
`updated_at`, `sessions.expires_ms`) ne sont plus lues. Elles sont encore écrites pour que
l'image précédente d'Alfred reste utilisable sans restaurer ; si elle a tourné, ses écritures sont
recopiées dans les colonnes ISO au démarrage suivant. Elles pourront être retirées par une
migration quand le retour arrière avant la migration 6 ne sera plus utile.

## Couche d'accès et espaces

Tout le code passe par `Sql` (`server/sql.ts`). Règles pour que le SQL tourne sur SQLite et
PostgreSQL :

- paramètres `?` seulement (convertis en `$1, $2…` pour PostgreSQL) ;
- `INSERT … ON CONFLICT (…) DO NOTHING / DO UPDATE`, jamais `INSERT OR IGNORE / OR REPLACE` ;
- pas de `PRAGMA`, `sqlite_master`, `COLLATE NOCASE`, `datetime()` : `lower(x) = lower(?)` pour
  ignorer la casse, dates calculées en JS ;
- un `ORDER BY` complet (avec `id` en dernier) dès que l'ordre compte ;
- schéma écrit une fois : `INTEGER` devient `BIGINT` et `AUTOINCREMENT` une identité sous PostgreSQL.

Chaque `Sql` porte un espace (`db.spaceId`) ; `db.inSpace(id)` donne la même base vue d'un autre
espace. Une requête qui doit voir tous les espaces le dit avec `ALL_SPACES` (sessions de connexion,
unicité des liens de visio, migrations).

Limite connue : les tables de réglages (`booking_settings`, `connection_settings`, `video_settings`,
`push_settings`) gardent une clé unique dans toute la base, pour que l'image précédente d'Alfred
reste utilisable sans restaurer. Un autre espace ne peut donc pas encore y écrire ses propres
réglages ; il ne lit et n'écrase jamais ceux d'Antoine (testé). La clé (espace, réglage) viendra
avec la table de réglages unique (ALFRED-298).

### Lancer les tests sur PostgreSQL

```bash
ALFRED_TEST_PG=postgres://utilisateur@127.0.0.1:5432/alfred_test npm run test:pg
```

Chaque base ouverte par un test devient un schéma neuf de cette base PostgreSQL. La CI le fait
à chaque PR (service `postgres:16`).

## API (session requise)

- `GET /api/people?q=` : fiches, prochain et dernier RDV.
- `GET /api/people/:id` : une fiche, ses RDV à venir et passés, ses liens.
- `GET /api/links?from=<adresse>` ou `?eventId=<id>` ; `POST /api/links { from | eventId, target, title? }` ; `DELETE /api/links/:id`.
- `GET /api/v1/resolve?address=media://alfred/…`

## Reste à faire (phase 4)

- Une seule table de réglages (ANT-298), à faire après la fusion des PR 4 et 6 qui en ajoutent.
- Participants visio et invités iCloud reliés aux Personnes (ANT-300), distribution du journal (ALFRED-308), API v1 complète, export (E4.3).
- Côté Cairn : bouton « Note de réunion » qui crée la note et le lien d'un coup (ANT-175).
