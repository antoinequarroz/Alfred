# API v1 d'Alfred (lecture, écriture des événements) et flux iCalendar

Pour que la suite PostMelo affiche l'agenda d'Alfred sans le recopier (LAMIO-259), et pour
s'abonner à un calendrier d'Alfred depuis Apple Calendrier. Phase 4, ALFRED-303.

Code : `server/api-v1.ts` (routes), `server/api-tokens.ts` (jetons). Types : `shared/types.ts`
(`ApiV1Event`, `ApiV1Busy`, `ApiToken`).

## Accès

Deux façons d'appeler `/api/v1` :

- **la session d'Alfred** (cookie), comme le reste de l'app ;
- **un jeton d'API**, créé dans Réglages > Accès à l'agenda, envoyé dans l'en-tête :

  ```
  Authorization: Bearer alf_…
  ```

Un **jeton d'écriture** (`alfw_…`, « API en lecture et écriture » dans les Réglages) lit comme
un jeton d'API et peut en plus **créer, modifier et supprimer des événements**
(`POST`, `PUT`, `DELETE /api/v1/events`), rien d'autre (ALFRED-312). Lamio s'en sert pour son
onglet Calendrier. Ces requêtes viennent d'un autre serveur : la protection CSRF ne s'applique
pas aux requêtes de `/api/v1` qui portent un jeton (un navigateur n'ajoute jamais cet en-tête).

Un jeton d'API ne fait que **lire** : toute autre méthode que `GET` répond `405`, et il n'ouvre
aucune autre route que `/api/v1` (`/api/people`, `/api/tokens`… répondent `401`). Le jeton n'est
montré qu'une fois, à sa création ; Alfred ne garde que son empreinte SHA-256. Le retirer dans
les Réglages coupe l'accès tout de suite. La connexion unique de la suite remplacera ces jetons.

Réponses d'erreur : `{ "error": "message lisible", "code": "code_stable" }`.

| Statut | Code | Quand |
| -- | -- | -- |
| 401 | `unauthorized` | ni session ni jeton |
| 401 | `invalid_token` | jeton inconnu, retiré, ou jeton de flux présenté comme jeton d'API |
| 405 | `read_only` | jeton d'API sur une autre méthode que GET, ou jeton d'écriture hors de `/api/v1/events` |
| 400 | `invalid_range` | période absente, illisible, à l'envers ou de plus de 400 jours |
| 404 | `unknown_calendar` | calendrier demandé inconnu |

## Routes

Les instants sont en ISO 8601 UTC (`2026-11-16T08:00:00.000Z`). Une journée entière est donnée
par ses dates (`2026-11-20` → `2026-11-21`, fin exclusive). Les périodes se demandent avec
`start` et `end` (ISO 8601, 400 jours au plus).

### `GET /api/v1`

Version de l'API et liste des routes.

### `GET /api/v1/calendars`

```json
[{ "id": "local:…", "name": "Personnel", "color": "#2f7cf6", "source": "local", "visible": true, "readOnly": false, "blocksBooking": true }]
```

### `GET /api/v1/events?start=&end=&calendar=`

Occurrences de la période, **récurrences développées**, triées par début. Tous les calendriers,
affichés ou masqués dans Alfred ; `calendar` (identifiants séparés par des virgules) restreint.

```json
[{
  "id": "01a1…", "address": "media://alfred/event/<UID>", "occurrenceId": "2026-11-23T08:00:00.000Z",
  "calendarId": "local:…", "title": "Cours", "start": "2026-11-23T08:00:00.000Z", "end": "2026-11-23T09:00:00.000Z",
  "allDay": false, "location": "", "description": "", "recurring": true
}]
```

`address` est l'adresse stable de l'événement dans la suite (par son UID iCalendar).
`occurrenceId` distingue les occurrences d'une série (null pour un événement simple).

Chaque événement porte aussi `repeat` (`none`, `daily`, `weekly`, `monthly`, `yearly`, ou
`custom` pour une règle qu'Alfred ne sait pas résumer), pour préremplir un formulaire.

### `POST /api/v1/events` (jeton d'écriture ou session)

Crée un événement. Corps :

```json
{ "calendarId": "local:…", "title": "Tournage", "start": "2026-11-17T09:00:00.000Z", "end": "2026-11-17T11:00:00.000Z",
  "allDay": false, "location": "Sion", "description": "", "repeat": "none" }
```

Journée entière : `allDay: true` et des dates (`2026-11-20` → `2026-11-21`, fin exclusive).
Répond `201 { "id" }`. Un calendrier iCloud est écrit par CalDAV ; un calendrier en lecture
seule répond `403`, un calendrier inconnu `404`, un champ manquant `400`.

### `PUT /api/v1/events/:id` (jeton d'écriture ou session)

`{ "event": { …même forme… }, "scope": "all" | "this", "occurrenceId": "…" }`. Pour une série,
`scope: "this"` avec l'`occurrenceId` de l'occurrence ne modifie qu'elle. Changer `calendarId`
déplace l'événement (toute la série seulement) ; l'`id` renvoyé est alors le nouveau.
`repeat` absent ou `custom` garde la règle existante. Conflit avec iCloud : `409`.

### `DELETE /api/v1/events/:id?scope=&occurrenceId=` (jeton d'écriture ou session)

Supprime l'événement, ou une seule occurrence avec `scope=this&occurrenceId=…`.

### `GET /api/v1/busy?start=&end=`

Périodes occupées des calendriers qui bloquent la prise de rendez-vous, **sans titre ni détail**
(les événements « disponibles » et annulés n'y sont pas) : `[{ "start", "end", "allDay" }]`.

### `GET /api/v1/booking-types`

Types de rendez-vous : `[{ "id", "slug", "name", "durationMin", "mode", "active" }]`.

### `GET /api/v1/booking-types/:id/slots?from=AAAA-MM-JJ&to=AAAA-MM-JJ`

Créneaux libres d'un type, jour par jour (même forme que les créneaux publics, voir
[API-RDV.md](API-RDV.md)), même si la prise de rendez-vous est fermée au public.

### `GET /api/v1/bookings?start=&end=`

Réservations qui chevauchent la période, annulées comprises, par date croissante :
`id`, `address` (`media://alfred/booking/<id>`), `status`, `typeId`, `typeName`, `start`, `end`,
`location`, `name`, `email`, `phone`, `personId`, `personAddress`, `eventId`, `calendarId`,
`videoUrl`, `createdAt`, `cancelledAt`.

### `GET /api/v1/resolve?address=media://alfred/…`

Ce que désigne une adresse (voir [DONNEES.md](DONNEES.md)).

## Flux iCalendar d'un calendrier

Réglages > Accès à l'agenda > « Flux d'un calendrier » donne une adresse d'abonnement :

```
webcal://alfred.postmelo.ch/api/v1/feeds/alfcal_….ics
```

Dans Apple Calendrier : Fichier › Nouvel abonnement à un calendrier. Le flux sert tout le
calendrier choisi (iCalendar complet, avec ses fuseaux), en `text/calendar`, avec son nom
(`X-WR-CALNAME`) et une relecture conseillée toutes les 15 minutes (`REFRESH-INTERVAL`).
Le jeton est dans l'adresse (Apple Calendrier ne sait pas envoyer d'en-tête) : il ne sert qu'à
ce flux, pas à l'API. Retirer l'accès arrête le flux (`404`).

## Gestion des jetons (session requise)

- `GET /api/tokens` : liste (jamais le jeton lui-même).
- `POST /api/tokens { name, kind: 'api' | 'write' | 'feed', calendarId? }` → `201`, avec `token` (montré
  cette fois seulement) et `feedPath` pour un flux.
- `DELETE /api/tokens/:id`.

Les jetons ne sont pas exportés (voir [EXPORT.md](EXPORT.md)) : à recréer après un import.
