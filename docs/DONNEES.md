# Données d'Alfred dans la suite Media (phase 4)

Alfred prépare ses données pour devenir le module Calendrier de la suite Media, sans attendre
le socle. Référence : le document Linear « Architecture de données d'Alfred dans la suite Media ».

## Ce qui est en place

| Règle du contrat | Dans Alfred |
| -- | -- |
| Migrations versionnées | `server/migrations.ts` : migrations numérotées, appliquées une fois au démarrage dans une transaction, notées dans `schema_migrations`. Chacune a son retour arrière (`down`), testé. |
| Un espace partout | Table `spaces` (une ligne : l'espace « Personnel ») et colonne `space_id` sur toutes les tables, y compris celles qu'une autre branche ajoutera (rattrapées à chaque démarrage). Les nouvelles requêtes (personnes, liens) filtrent dessus. |
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

Règle : une migration n'enlève ni ne renomme rien de ce que lit le code précédent. Remettre
l'image précédente d'Alfred fonctionne donc sans restaurer la base.

Avant un déploiement, essayer la migration sur une copie des données réelles, base montée en
lecture seule :

```bash
docker run --rm -v /opt/alfred/data:/src:ro alfred:phase4 node dist/server/scripts/essai-migration.js /src/alfred.db
```

## API (session requise)

- `GET /api/people?q=` : fiches, prochain et dernier RDV.
- `GET /api/people/:id` : une fiche, ses RDV à venir et passés, ses liens.
- `GET /api/links?from=<adresse>` ou `?eventId=<id>` ; `POST /api/links { from | eventId, target, title? }` ; `DELETE /api/links/:id`.
- `GET /api/v1/resolve?address=media://alfred/…`

## Reste à faire (phase 4)

- Dates : un seul format d'instant (`events.start_ms` en millisecondes, `bookings.start_utc` en texte ISO), fuseau explicite (ANT-296).
- Filtre d'espace sur les requêtes existantes du calendrier, de la prise de RDV et de la visio, et requêtes portables PostgreSQL (ANT-295, ANT-297).
- Une seule table de réglages (ANT-298), à faire après la fusion des PR 4 et 6 qui en ajoutent.
- Participants visio et invités iCloud reliés aux Personnes (ANT-300), journal d'événements, API v1 complète, export (E4.3).
- Côté Cairn : bouton « Note de réunion » qui crée la note et le lien d'un coup (ANT-175).
