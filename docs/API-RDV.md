# API de la prise de rendez-vous (v1.1)

Ce document décrit l'API utilisée par l'interface : la page publique (`/rdv`, `/rdv/<type>`, `/rdv/annulation/<jeton>`, code dans `web/src/rdv/PublicApp.tsx`) et la rubrique « Rendez-vous » de l'admin (`web/src/rdv/BookingAdmin.tsx`). Les types TypeScript correspondants sont dans `shared/types.ts` (noms indiqués entre parenthèses).

- [Principes communs](#principes-communs)
- [API publique](#api-publique) : `/api/public/booking/*`, sans session
- [API privée](#api-privée) : `/api/booking/*`, session requise
- [Connexions](#connexions-e-mails-et-calendrier) : `/api/connections/*`, session requise (réglages SMTP et iCloud)
- [Codes d'erreur](#codes-derreur)
- [Comportement du moteur](#comportement-du-moteur) : ce que l'interface peut supposer
- [À faire côté interface](#à-faire-côté-interface) : consignes appliquées par l'interface

## Principes communs

- **JSON partout.** Les corps de requête sont en JSON avec `Content-Type: application/json`.
- **Dates.** Un instant est une chaîne ISO UTC (`2026-11-16T08:00:00.000Z`). Un jour est `AAAA-MM-JJ`, **dans le fuseau d'Antoine** (`Europe/Zurich`, renvoyé dans le champ `timezone`). L'interface doit afficher les heures dans ce fuseau (`Intl.DateTimeFormat('fr-CH', { timeZone })`), pas dans celui du navigateur.
- **Jours de semaine.** `1` = lundi … `7` = dimanche. Les heures des horaires sont en minutes depuis minuit, heure locale (`540` = 09:00).
- **Erreurs.** Toute erreur a la forme (`ApiErrorBody`) :

  ```json
  { "error": "Message en français, affichable tel quel", "code": "slot_unavailable", "fields": { "email": "Adresse e-mail invalide" } }
  ```

  `code` est stable (voir [Codes d'erreur](#codes-derreur)). `fields` n'est présent que pour `invalid` : une entrée par champ fautif. Les erreurs génériques héritées de la v1 (`401 Non connecté`, `403 Requête refusée`, `413`) n'ont que `error`.
- **CSRF.** Comme pour le reste de l'API : `fetch` en `same-origin` suffit. Un `POST` sans corps (annulation) doit venir d'un navigateur (en-tête `Sec-Fetch-Site: same-origin` ou `Origin` identique à l'hôte), sinon `403`. La partie publique refuse en plus toute requête d'écriture dont l'`Origin` est un autre site.

## API publique

Sans session. Réponses jamais mises en cache (`Cache-Control: no-store`). Corps limité à 16 Ko. Limitation de débit par adresse IP : au-delà, `429` avec `code: "rate_limited"` et l'en-tête `Retry-After` (secondes).

| Limite | Valeur par défaut |
|---|---|
| Lectures (infos, consultation par jeton) | 120 par minute et par IP |
| Demandes de créneaux | 30 par minute et par IP, 600 par minute toutes IP confondues |
| Essais de réservation (réussis ou non) | 30 par heure et par IP |
| Réservations abouties | 5 par heure et par IP, 60 par heure toutes IP confondues |
| Réservations créées pour une même adresse e-mail (annulées comprises) | 3 par 24 heures |
| Annulations par jeton | 10 par heure et par IP |
| E-mails sortants, tous destinataires confondus | 200 par 24 heures (au-delà, `emailSent: false`) |

Une adresse IPv6 est comptée par préfixe /56. Les plafonds de réservations abouties et par adresse e-mail sont contrôlés dans la section critique : des demandes simultanées ne les dépassent pas. Le plafond par adresse e-mail répond exactement comme la limite de débit (`429 rate_limited`) : la réponse ne dit rien des rendez-vous d'une adresse.

### `GET /api/public/booking`

Infos de la page (`PublicBookingInfo`). Toujours `200`.

```json
{
  "enabled": true,
  "publicName": "Antoine Quarroz",
  "welcomeText": "Bienvenue.\nChoisissez un créneau.",
  "timezone": "Europe/Zurich",
  "types": [
    {
      "slug": "consultation",
      "name": "Consultation",
      "durationMin": 30,
      "description": "",
      "mode": "cabinet",
      "locationLabel": "Rue du Lac 1, Sion",
      "phoneRequired": false,
      "horizonDays": 60
    }
  ]
}
```

- `enabled: false` : la prise de rendez-vous n'est pas ouverte. `types` est vide, `welcomeText` est vide : afficher « La prise de rendez-vous n'est pas ouverte ». Les autres routes publiques (sauf l'annulation par jeton) répondent alors `403 closed`.
- `types` : seuls les types actifs, dans l'ordre choisi par Antoine. `mode` vaut `cabinet`, `telephone`, `visio` ou `autre` ; `locationLabel` est le texte prêt à afficher. `phoneRequired` : rendre le champ téléphone obligatoire. `horizonDays` : nombre de jours à l'avance jusqu'où des créneaux existent (pour borner le calendrier affiché).
- `welcomeText` et `description` sont du **texte brut** (retours à la ligne possibles) : les afficher comme du texte, jamais comme du HTML.

### `GET /api/public/booking/types/:slug/slots?from=AAAA-MM-JJ&to=AAAA-MM-JJ`

Créneaux libres d'un type entre deux jours inclus (`PublicSlots`). 42 jours au plus par appel (un mois affiché) : la page demande un mois à la fois.

```json
{
  "timezone": "Europe/Zurich",
  "durationMin": 30,
  "days": [
    { "date": "2026-11-16", "slots": ["2026-11-16T08:00:00.000Z", "2026-11-16T08:30:00.000Z"] },
    { "date": "2026-11-17", "slots": ["2026-11-17T08:00:00.000Z"] }
  ]
}
```

- `days` ne contient que les jours qui ont au moins un créneau, dans l'ordre. Un jour absent = rien de libre.
- `slots` : uniquement des **débuts** de créneaux libres. La fin est `début + durationMin`. Aucun détail des événements d'Antoine ne sort jamais de cette route.
- Les jours passés, le préavis et l'horizon sont déjà appliqués : demander une plage large est sans danger (elle est rognée).

Erreurs : `400 invalid_range`, `403 closed`, `404 unknown_type`, `429 rate_limited`.

### `POST /api/public/booking/book`

Réserve un créneau. Corps (`BookingRequest`) :

```json
{
  "typeSlug": "consultation",
  "start": "2026-11-16T08:00:00.000Z",
  "name": "Élodie Müller",
  "email": "elodie@example.org",
  "phone": "+41 79 123 45 67",
  "message": "Première visite.",
  "website": ""
}
```

| Champ | Règle |
|---|---|
| `typeSlug` | Obligatoire. Type actif. |
| `start` | Obligatoire. Instant ISO, **exactement** une valeur renvoyée par la route des créneaux. |
| `name` | Obligatoire. 2 à 60 caractères : lettres (toutes écritures), espaces, tirets, apostrophes, point d'abréviation suivi d'une espace ou d'un tiret (« Dr. Müller », « J.-P. »). Ni chiffre, ni `/`, ni `:`, ni `@`, ni domaine (« exemple.ch »), ni caractère invisible : le nom ouvre l'e-mail envoyé à une adresse non vérifiée. |
| `email` | Obligatoire. Adresse valide, 254 caractères au plus. |
| `phone` | Facultatif (obligatoire si `phoneRequired`). Chiffres, espaces, `+ ( ) . / -`, 6 à 29 caractères. |
| `message` | Facultatif. 2000 caractères au plus. |
| `website` | **Champ piège** : doit être absent ou vide. Voir [À faire côté interface](#à-faire-côté-interface). |

Réponse `201` (`BookingConfirmation`) :

```json
{
  "booking": {
    "typeName": "Consultation",
    "start": "2026-11-16T08:00:00.000Z",
    "end": "2026-11-16T08:30:00.000Z",
    "timezone": "Europe/Zurich",
    "locationLabel": "Rue du Lac 1, Sion",
    "name": "Élodie Müller",
    "status": "confirmed",
    "cancellable": true
  },
  "cancelUrl": "https://alfred.postmelo.ch/rdv/annulation/Jq3…43 caractères",
  "emailSent": true
}
```

- `emailSent: false` : le rendez-vous **est pris**, mais l'e-mail de confirmation n'a pas pu partir, ou n'est pas encore parti : la réponse n'attend pas le serveur d'envoi plus de 8 secondes (l'envoi se poursuit ensuite en arrière-plan). Afficher le récapitulatif et inviter à noter le rendez-vous ; proposer `cancelUrl` comme lien d'annulation.
- La réponse peut prendre quelques secondes (synchro iCloud avant confirmation, puis envoi des e-mails) : désactiver le bouton et montrer une attente.

Erreurs :

| Statut | `code` | Quand | Que faire |
|---|---|---|---|
| 400 | `invalid` | Champ invalide (`fields`) | Afficher les messages sous les champs |
| 400 | `rejected` | Champ piège rempli | Message générique |
| 403 | `closed` | Prise de RDV fermée | Recharger les infos |
| 404 | `unknown_type` | Type inconnu ou désactivé | Recharger les infos |
| 409 | `slot_unavailable` | Créneau plus libre (pris entre-temps, ou pas un créneau proposé) | Recharger les créneaux et faire choisir de nouveau |
| 413 | — | Corps trop gros | — |
| 415 | `unsupported` | Corps pas en JSON | — |
| 429 | `rate_limited` | Trop de demandes (par IP, au total, ou trop de réservations récentes pour cette adresse e-mail) | Réessayer plus tard (`Retry-After` quand il est connu) |
| 502 / 503 | `calendar_unavailable` | Le calendrier (iCloud) ne répond pas | « Réessayez plus tard » ; rien n'a été réservé |
| 503 | `busy` | Trop de réservations simultanées | Réessayer dans un instant |

### `GET /api/public/booking/cancel/:token`

Récapitulatif pour la page `/rdv/gerer/<jeton>` (les anciens liens `/rdv/annulation/<jeton>` mènent à la même page) : `PublicBooking`, même forme que `booking` ci-dessus. Consulter ne change rien.

- `cancellable: false` : le rendez-vous a commencé, est passé, ou est trop proche (réglage `changeNoticeHours`) ; ne pas proposer le bouton.
- `reschedulable` : le client peut choisir un autre créneau (déplacement autorisé, prise de rendez-vous ouverte, délai respecté, type encore existant, moins de 3 déplacements déjà faits).
- `changeUntil` : dernier instant (ISO UTC) où annuler ou déplacer en ligne est possible.
- `mode`, `durationMin`, `horizonDays` : de quoi afficher le choix d'un autre créneau.
- `404 not_found` : jeton inconnu, mal formé **ou rendez-vous déjà annulé** (réponse volontairement identique). Afficher « Ce lien n'est plus valable : rendez-vous introuvable ou déjà annulé. »

Un jeton est valable tant que le rendez-vous n'est pas annulé : celui de la confirmation, et ceux des rappels (chaque rappel porte un nouveau jeton, le jeton n'étant jamais conservé en clair).

### `POST /api/public/booking/cancel/:token`

Annule (sans corps). Réponse `200` : le `PublicBooking` avec `status: "cancelled"`, `cancellable: false` et `emailSent`. L'événement est retiré du calendrier et Antoine reçoit un avis.

- `emailSent: true` : un e-mail confirme l'annulation au client. `false` : aucun e-mail ne lui est parti (SMTP absent ou en panne, plafond atteint, ou annulation dans le quart d'heure qui suit la réservation, où l'on n'écrit pas une seconde fois à une adresse non vérifiée) : ne pas annoncer d'e-mail.

Erreurs : `404 not_found` (comme ci-dessus, y compris pour un second clic), `409 too_late` (commencé, passé, ou dans le délai `changeNoticeHours` ; le message le dit), `429 rate_limited`, `502 calendar_unavailable` (rien n'a été annulé, réessayer).

L'annulation par jeton reste possible même si la prise de rendez-vous a été refermée.

### `GET /api/public/booking/manage/:token/slots?from=AAAA-MM-JJ&to=AAAA-MM-JJ`

Créneaux libres pour déplacer le rendez-vous (`PublicSlots`, comme pour un type). Ils suivent le type d'origine (préavis, horizon, horaires) avec la durée et les tampons de la réservation ; l'horaire actuel ne bloque pas les créneaux voisins et n'est pas proposé.

Erreurs : `404 not_found`, `403 reschedule_disabled` (déplacement désactivé ou prise de rendez-vous fermée), `409 too_late`, `409 too_many_changes`, `409 not_reschedulable` (type supprimé, événement retiré du calendrier), `400 invalid_range`, `429 rate_limited`.

### `POST /api/public/booking/manage/:token/reschedule`

Corps : `{ "start": "<un début renvoyé par la route précédente>" }`. Réponse `200` : le `PublicBooking` au nouvel horaire, avec `emailSent` (e-mail « rendez-vous déplacé » au client, avec l'événement à jour en pièce jointe). L'événement du calendrier est déplacé (même UID : il reste le même dans Apple Calendar, la visio garde son lien), la description note l'horaire précédent, Antoine reçoit un avis, et les rappels repartent pour le nouvel horaire. Le jeton utilisé reste valable.

Erreurs : celles de la route précédente, plus `400 same_slot` (c'est déjà l'horaire du rendez-vous), `400 invalid` (créneau illisible), `409 slot_unavailable` (pris entre-temps : revenir au choix), `502 calendar_unavailable` (rien n'a changé, réessayer). Même verrou et même synchro préalable qu'une réservation : deux clients ne peuvent pas obtenir le même créneau.

## API privée

Session requise (cookie de connexion, comme le reste de l'API). Sans session : `401 { "error": "Non connecté" }`.

### Réglages

#### `GET /api/booking/settings`

État complet pour l'écran de réglages (`BookingAdminState`) :

```json
{
  "settings": {
    "enabled": false,
    "publicName": "Antoine Quarroz",
    "welcomeText": "",
    "calendarId": null,
    "slotStepMin": 30,
    "allDayBlocks": true
  },
  "effectiveCalendarId": "caldav:Q2x…",
  "timezone": "Europe/Zurich",
  "publicPageUrl": "https://alfred.postmelo.ch/rdv",
  "mail": { "configured": false, "from": "Antoine Quarroz <info@antoinequarroz.ch>", "notifyTo": "info@antoinequarroz.ch", "sentLast24h": 0, "dailyLimit": 200 },
  "warnings": [
    "L’envoi d’e-mails n’est pas configuré : les réservations fonctionnent, mais aucun e-mail ne part. Il se règle dans Rendez-vous > Réglages.",
    "Aucun type de rendez-vous actif.",
    "La prise de rendez-vous est fermée : la page publique n’accepte aucune réservation."
  ]
}
```

- `settings.calendarId` : calendrier où créer les rendez-vous ; `null` = le premier calendrier modifiable. `effectiveCalendarId` est celui réellement utilisé (`null` si aucun calendrier n'est modifiable).
- `warnings` : phrases prêtes à afficher (SMTP non configuré, aucun calendrier modifiable, calendrier choisi inutilisable, aucun type actif, aucun horaire, synchro iCloud en échec, prise de RDV fermée).
- `mail.configured: false` : afficher l'avertissement ; tout fonctionne sauf l'envoi.
- `mail.sentLast24h` / `mail.dailyLimit` : e-mails partis sur 24 heures et plafond. Plafond atteint : plus rien ne part, un avertissement le dit (compteur en mémoire, remis à zéro au redémarrage).
- `settings.allDayBlocks` : vrai (défaut), une journée entière bloque toute la journée même marquée « disponible » (Apple Calendar marque ainsi celles qu'il crée) ; faux, seules les journées entières « occupé » bloquent.

Réglages des rappels et des changements (dans `settings`) :

- `reminderHours` : rappels envoyés au client, en heures avant le rendez-vous, parmi `72, 48, 24, 12, 4, 2, 1` (défaut `[24, 1]`, vide : aucun). Un passage par minute envoie ceux qui sont dus ; un rappel ne part qu'une fois par horaire, pas si le client a pris ou déplacé le rendez-vous après son moment, et un seul message part si plusieurs sont dus ensemble. Le rappel reprend le lieu ou le lien de la visio et un lien pour déplacer ou annuler. Si Antoine a déplacé l'événement dans son agenda, le rappel le signale, joint l'événement à jour, et la réservation n'est plus « à prévenir ».
- `allowReschedule` : le client peut choisir lui-même un autre créneau (défaut `true`). Trois déplacements au plus par rendez-vous.
- `changeNoticeHours` : annulation et déplacement en ligne possibles jusqu'à ce nombre d'heures avant le début, parmi `0, 1, 2, 4, 12, 24, 48` (défaut `0` : jusqu'au début).

#### `PUT /api/booking/settings`

Modification partielle : n'envoyer que les champs à changer. Réponse : le `BookingAdminState` à jour.

| Champ | Règle |
|---|---|
| `enabled` | booléen |
| `publicName` | 100 caractères au plus, une ligne |
| `welcomeText` | 2000 caractères au plus |
| `calendarId` | identifiant d'un calendrier modifiable, ou `null` |
| `slotStepMin` | `15`, `30` ou `60` |
| `allDayBlocks` | booléen |

Erreur : `400 invalid` avec `fields`. Rien n'est modifié si un champ est invalide.

### Types de rendez-vous

Forme (`BookingType`) :

```json
{
  "id": "0b6c…",
  "slug": "consultation",
  "name": "Consultation",
  "durationMin": 30,
  "description": "",
  "mode": "cabinet",
  "location": "Rue du Lac 1, Sion",
  "bufferBeforeMin": 0,
  "bufferAfterMin": 0,
  "minNoticeHours": 12,
  "horizonDays": 60,
  "active": true,
  "sort": 0
}
```

| Champ | Règle | Défaut |
|---|---|---|
| `name` | obligatoire, 100 caractères au plus | — |
| `durationMin` | obligatoire, entier de 5 à 480 | — |
| `slug` | minuscules, chiffres, tirets, 50 caractères au plus, unique | dérivé du nom (`appel`, `appel-2`…) |
| `description` | 2000 caractères au plus | `""` |
| `mode` | `cabinet`, `telephone`, `visio`, `autre` | `cabinet` |
| `location` | précision libre (adresse, lien, consigne), 300 caractères au plus ; obligatoire si `mode` = `autre` | `""` |
| `bufferBeforeMin`, `bufferAfterMin` | entier de 0 à 240 | `0` |
| `minNoticeHours` | entier de 0 à 720 | `12` |
| `horizonDays` | entier de 1 à 365 | `60` |
| `active` | booléen | `true` |
| `sort` | entier de 0 à 10000 | à la suite |

Lieu affiché au client (`locationLabel`) : `cabinet` → `location` ou « Au cabinet » ; `telephone` → « Par téléphone » (+ précision entre parenthèses) ; `visio` → « En visio » (+ précision) ; `autre` → `location`.

| Route | Corps | Réponse |
|---|---|---|
| `GET /api/booking/types` | — | `BookingType[]`, dans l'ordre |
| `POST /api/booking/types` | `BookingTypeInput` (au moins `name`, `durationMin`) | `201`, le type créé |
| `PUT /api/booking/types/:id` | champs à modifier | le type à jour |
| `DELETE /api/booking/types/:id` | — | `{ "ok": true }` |
| `PUT /api/booking/types/order` | `{ "ids": ["id1", "id2", …] }` (tous les types, une fois chacun) | `BookingType[]` réordonné |
| `GET /api/booking/types/:id/slots?from=&to=` | — | `PublicSlots` : aperçu des créneaux, même si la prise de RDV est fermée ou le type inactif |

Erreurs : `400 invalid` (`fields`), `404 not_found`, `409 slug_taken`, `400 invalid_range`.

Supprimer un type ne supprime pas ses réservations : elles gardent le nom du type (`typeId` devient `null`). Changer le `slug` casse les liens déjà partagés vers ce type.

### Horaires hebdomadaires

| Route | Corps | Réponse |
|---|---|---|
| `GET /api/booking/hours` | — | `BookingHoursRange[]`, triés par jour puis début |
| `PUT /api/booking/hours` | la liste complète (elle **remplace** tout) | la liste enregistrée |

```json
[
  { "weekday": 1, "startMin": 540, "endMin": 720 },
  { "weekday": 1, "startMin": 810, "endMin": 1050 }
]
```

Règles : `weekday` de 1 à 7, `startMin` de 0 à 1439, `endMin` de 1 à 1440, fin après début, pas de chevauchement dans un même jour, plusieurs plages par jour permises, 70 plages au plus. Une liste vide est permise (plus aucun créneau). Erreur : `400 invalid` avec `fields.hours`.

Valeurs initiales : lundi à vendredi, 09:00-12:00 et 13:30-17:30.

### Calendriers bloquants

| Route | Corps | Réponse |
|---|---|---|
| `GET /api/booking/calendars` | — | `CalendarInfo[]` |
| `PATCH /api/booking/calendars/:id` | `{ "blocksBooking": false }` | le `CalendarInfo` à jour |

`CalendarInfo` gagne le champ `blocksBooking` (vrai par défaut), aussi renvoyé par `GET /api/calendars`. Un calendrier bloquant occupe l'agenda **même s'il est masqué** dans l'affichage. L'identifiant contient `:` : l'encoder dans l'URL (`encodeURIComponent`). Erreurs : `400 invalid`, `404 not_found`.

### Réservations

#### `GET /api/booking/bookings?scope=upcoming|past&limit=100&offset=0`

- `scope=upcoming` (défaut) : réservations confirmées non terminées, de la plus proche à la plus lointaine.
- `scope=past` : réservations terminées ou annulées, les plus récentes d'abord (`limit` 500 au plus, `offset` pour paginer).

Réponse : `Booking[]`.

```json
[
  {
    "id": "c716…",
    "typeId": "0b6c…",
    "typeName": "Consultation",
    "location": "Rue du Lac 1, Sion",
    "start": "2026-11-16T08:00:00.000Z",
    "end": "2026-11-16T08:30:00.000Z",
    "name": "Élodie Müller",
    "email": "elodie@example.org",
    "phone": "+41 79 123 45 67",
    "message": "Première visite.",
    "status": "confirmed",
    "createdAt": "2026-11-15T11:00:00.000Z",
    "cancelledAt": null,
    "cancelledBy": null,
    "eventId": "5446…",
    "calendarId": "caldav:Q2x…",
    "eventState": "ok",
    "eventStart": null,
    "eventEnd": null,
    "notifiedStart": null,
    "mailError": null,
    "remindersSent": [24],
    "clientReschedules": 0
  }
]
```

- `eventState` (réservations confirmées seulement, sinon `null`) :
  - `ok` : l'événement est dans le calendrier, à l'heure réservée.
  - `missing` : **« événement supprimé »**. Antoine l'a supprimé (par exemple dans Apple Calendar). La réservation reste confirmée et **le créneau reste pris** : proposer « Annuler la réservation » pour prévenir le client et libérer le créneau. Un événement seulement changé de calendrier n'est pas « supprimé » : il est retrouvé par son UID (`eventId` et `calendarId` sont mis à jour) et l'annulation le retire.
  - `moved` : l'événement a été déplacé dans le temps. **La réservation suit** : `start` et `end` (repris dans `eventStart` et `eventEnd`) donnent le nouvel horaire, l'ancien créneau est libéré, le nouveau est protégé, et la page d'annulation du client montre le nouvel horaire. `notifiedStart` est le début que le client a reçu dans son dernier e-mail : il n'est pas prévenu sur le moment ; le prochain rappel lui annonce le nouvel horaire, et « Renvoyer l'e-mail » lui annonce le nouvel horaire et ramène l'état à `ok`.
- `mailError` : dernier échec d'envoi d'e-mail pour cette réservation (texte à afficher), `null` si tout est parti. Sans SMTP : « E-mails non configurés : aucun message envoyé ».
- `cancelledBy` : `client` ou `admin`.
- `remindersSent` : rappels déjà partis pour l'horaire actuel (heures avant le début). `clientReschedules` : nombre de déplacements faits par le client lui-même.

#### `POST /api/booking/bookings/:id/cancel`

Annulation par Antoine. Corps facultatif : `{ "notifyClient": false }` pour ne pas écrire au client (défaut : le client reçoit un e-mail). Réponse : le `Booking` annulé. L'événement est retiré du calendrier (sans erreur s'il a déjà disparu).

Erreurs : `404 not_found`, `409 already_cancelled`, `502 calendar_unavailable`.

#### `POST /api/booking/bookings/:id/resend`

Renvoie la confirmation au client, avec l'horaire actuel. Le jeton d'annulation n'étant jamais conservé, un nouveau lien est créé ; **il ne remplace l'ancien qu'une fois l'e-mail réellement parti** : si l'envoi échoue, le lien que le client possède déjà continue de fonctionner. Réponse : le `Booking` (regarder `mailError`).

Erreurs : `400 mail_not_configured`, `404 not_found`, `409 already_cancelled`.

### E-mails

L'e-mail d'essai part par `POST /api/connections/smtp/test` (voir plus bas), seule route d'essai : l'ancienne `POST /api/booking/mail/test` a été retirée, parce qu'elle envoyait le même message sans limite de débit.

`GET /api/booking/settings` ajoute à `warnings`, quand l'envoi est configuré mais que le dernier essai a échoué, une phrase qui commence par « Le dernier essai d’envoi d’e-mails a échoué » et se termine par le diagnostic.

## Connexions (e-mails et calendrier)

Session requise, comme toute l'API privée. Ces routes règlent depuis l'app ce qui ne se réglait que dans le `.env` du serveur : l'envoi des e-mails (SMTP) et les identifiants du calendrier (CalDAV, iCloud par défaut). Types : `ConnectionsState`, `SmtpSettingsInput`, `SmtpSaveResult`, `CaldavSettingsInput`, `CaldavSaveResult`, `ConnectionTest`.

Règles communes :

- **Priorité, réglage par réglage** : valeur enregistrée dans l'app, sinon variable du `.env`, sinon valeur par défaut (`mail.infomaniak.com`, port `587`, `https://caldav.icloud.com`). Chaque réglage renvoyé porte sa `source` : `app`, `env`, `default` ou `none`.
- **Aucun mot de passe ne ressort**, même en partie : l'état dit seulement `{ "configured": true, "source": "app", "unreadable": false }`. Ils n'apparaissent ni dans les erreurs (les messages de validation ne répètent jamais la saisie), ni dans les journaux. `unreadable: true` : le mot de passe est en base mais ne se déchiffre plus (clé absente ou différente) ; il compte comme non configuré et doit être ressaisi. `otherServer: true` : un mot de passe existe, mais pour un autre serveur que celui réglé maintenant ; il n'est pas utilisé et doit être ressaisi.
- **Un mot de passe ne part que vers le serveur pour lequel il a été saisi.** Changer l'hôte ou le port SMTP sans fournir `password` dans la même requête est refusé ; le mot de passe du `.env` ne sert jamais avec un hôte ou un port saisi dans l'app ; un essai CalDAV avec un autre identifiant ou une autre adresse exige `password`.
- **Corps** : JSON, 8 Ko au plus (`413` au-delà) ; un `PUT` sans `Content-Type: application/json` reçoit `415`. Toute écriture venue d'un autre site reçoit `403 forbidden`. Réponses en `Cache-Control: no-store`.
- **Hôtes** : un serveur saisi dans l'app doit être un nom de domaine complet ou une adresse IP publique. Les adresses de bouclage, lien-local, privées ou réservées, et les noms qui y résolvent, sont refusés (`400 invalid`, champ `host` ou `url`), sauf si le serveur tourne avec `ALFRED_ALLOW_PRIVATE_HOSTS=1` (développement). Le contrôle est refait à chaque connexion.
- **Débit** : 10 essais de connexion par 10 minutes, toutes routes d'essai confondues (il n'existe pas d'autre route d'essai d'envoi) (`429 rate_limited`, en-tête `Retry-After`) ; 60 enregistrements par 10 minutes.

### `GET /api/connections`

```json
{
  "smtp": {
    "configured": true,
    "host": { "value": "mail.infomaniak.com", "source": "default" },
    "port": { "value": "587", "source": "default" },
    "user": { "value": "info@antoinequarroz.ch", "source": "app" },
    "password": { "configured": true, "source": "app", "unreadable": false, "otherServer": false },
    "from": { "value": "Antoine Quarroz <info@antoinequarroz.ch>", "source": "env" },
    "notifyTo": { "value": "info@antoinequarroz.ch", "source": "default" },
    "hasAppValues": true,
    "envConfigured": false,
    "lastTest": { "ok": true, "code": "ok", "message": "E-mail d’essai envoyé à info@antoinequarroz.ch.", "at": "2026-11-16T15:00:00.000Z" }
  },
  "caldav": {
    "configured": true,
    "url": { "value": "https://caldav.icloud.com", "source": "env" },
    "username": { "value": "antoine@example.org", "source": "env" },
    "password": { "configured": true, "source": "env", "unreadable": false, "otherServer": false },
    "hasAppValues": false,
    "accountLocked": true,
    "canRevertToEnv": false,
    "sync": { "configured": true, "running": false, "lastSuccessAt": "2026-11-16T15:00:00.000Z", "lastError": null, "lastErrorAt": null },
    "calendars": 2,
    "events": 396,
    "lastTest": null
  },
  "secretKey": { "source": "file", "problem": null },
  "notices": []
}
```

- `smtp.configured` : un identifiant et un mot de passe utilisables sont en place. `smtp.lastTest` : dernier essai d'envoi, gardé en base (il survit au redémarrage) et oublié à chaque modification des réglages. `smtp.envConfigured` : le `.env` porte un identifiant et un mot de passe d'envoi ; sinon, retirer les réglages de l'app coupe l'envoi (l'interface libelle alors le bouton « Supprimer la configuration d'envoi »).
- `caldav.accountLocked` : un compte est en place (identifiant connu, et configuré, mot de passe à ressaisir, ou calendriers en base) ; seul son mot de passe peut changer. `canRevertToEnv` : le `.env` porte des identifiants pour ce même compte. `caldav.lastTest` : dernier essai de la configuration en place depuis le démarrage ; l'essai d'identifiants candidats, refusés ou seulement testés, n'y est jamais gardé (il n'est renvoyé que dans la réponse de la requête).
- `caldav.calendars > 0` sans `accountLocked` : des calendriers sont en base mais aucun identifiant n'est connu ; seul le compte qui retrouve au moins un de ces calendriers peut être relié (`409 account_change` sinon).
- `secretKey.source` : `env` (variable `ALFRED_SECRET_KEY`), `file` (fichier `secret.key` du dossier de données), `none` (pas encore créée, ou inutilisable : voir `problem`).
- `notices` : phrases prêtes à afficher en tête (mot de passe à ressaisir, clé invalide).

### `PUT /api/connections/smtp`

Corps (`SmtpSettingsInput`), tous les champs facultatifs ; un champ absent ne bouge pas :

```json
{ "host": "mail.infomaniak.com", "port": 587, "user": "info@antoinequarroz.ch", "password": "…", "from": "Antoine Quarroz <info@antoinequarroz.ch>", "notifyTo": "", "test": true }
```

- `password` vide ou absent : le mot de passe actuel est gardé, **sauf si l'hôte ou le port change** : la requête est alors refusée (`400 invalid`, `fields.password` : « Ressaisis le mot de passe : le serveur ou le port change »). Le mot de passe enregistré est lié à son serveur.
- Un champ vide, ou égal à la valeur du `.env` ou par défaut, retire le réglage de l'app (sa source redevient `env` ou `default`).
- Validation : `host` (nom de domaine ou IP publique, 253 caractères), `port` (entier de 1 à 65535), `user` (254), `password` (1024), `from` (« Nom <adresse> » ou adresse seule, adresse valide, nom de 100 caractères au plus), `notifyTo` (adresse valide). Aucun retour à la ligne ni caractère de contrôle, nulle part. Les espaces en début et fin sont retirés, mot de passe compris. Une erreur ne modifie rien, même pas les autres champs de la requête.
- `test: true` : un e-mail d'essai part juste après l'enregistrement (« Enregistrer et tester »). Enregistrer un mot de passe erroné est possible : la réponse le signale.

Réponse `200` (`SmtpSaveResult`) : `{ "state": { … }, "test": { "ok": false, "code": "auth", "message": "Identifiants refusés par le serveur d’envoi : vérifie l’identifiant (l’adresse de la boîte) et le mot de passe.", "at": "…" } }` ; `test` vaut `null` si aucun essai n'était demandé. Le service d'envoi relit sa configuration tout de suite : pas de redémarrage. Erreurs : `400 invalid`, `503 secret_key` (clé de chiffrement inutilisable).

### `POST /api/connections/smtp/test`

Envoie l'e-mail d'essai à l'adresse des avis avec la configuration enregistrée. Toujours `200` : `{ "state": { … }, "test": { "ok", "code", "message", "at" } }`. Codes de `test` : `ok`, `not_configured`, `auth` (identifiants refusés), `host_not_found`, `host_refused` (hôte interne), `connection_refused`, `connection_failed`, `timeout`, `tls`, `rejected` (expéditeur, destinataire ou message refusé), `temporary`, `protocol`, `unknown`.

### `DELETE /api/connections/smtp` et `DELETE /api/connections/smtp/:field`

Retire de l'app tous les réglages SMTP, ou un seul (`host`, `port`, `user`, `password`, `from`, `notifyTo`) : le `.env` ou la valeur par défaut reprend la main. Réponse : `{ "state": { … }, "test": null }`. Si le serveur change de ce fait (hôte ou port retiré alors que le mot de passe est dans l'app, mot de passe retiré alors que l'hôte est dans l'app), le mot de passe restant n'est pas utilisé : `password.otherServer` passe à vrai et `configured` à faux.

### `PUT /api/connections/caldav`

Corps (`CaldavSettingsInput`) : `{ "username": "antoine@example.org", "password": "abcd-efgh-ijkl-mnop", "url": "https://caldav.icloud.com" }`. `password` est obligatoire ; `url` est facultative (https uniquement, sans identifiant ni paramètre).

Déroulement : validation, **essai de connexion** (découverte du principal et liste des calendriers) avec les nouveaux identifiants, puis seulement enregistrement, client de synchro recréé à chaud et synchro lancée. Si l'essai échoue, rien n'est enregistré et la synchro continue avec l'ancienne configuration.

- `200` (`CaldavSaveResult`) : `{ "state": { … }, "test": { "ok": true, "code": "ok", "message": "Connexion réussie : 2 calendriers trouvés.", "at": "…" }, "warning": null }`. `warning` : remarque non bloquante quand le serveur est iCloud et que le mot de passe n'a pas la forme d'un mot de passe d'application Apple (16 lettres minuscules, avec ou sans tirets).
- `400 invalid` : saisie invalide (`fields.username`, `fields.password`, `fields.url`).
- `409 account_change` : un compte est déjà en place et l'identifiant ou le serveur diffère ; ou bien des calendriers sont en base sans identifiant connu et le compte essayé n'en retrouve aucun. En v1, seul le mot de passe du même identifiant peut changer (les calendriers et événements du compte sont en base, des réservations y sont liées) ; la première configuration, quand rien n'est en place, accepte n'importe quel compte.
- `422 connection_failed` : l'essai a échoué ; `error` porte le diagnostic, `reason` son code (`auth`, `host_not_found`, `host_refused`, `connection_refused`, `connection_failed`, `timeout`, `tls`, `forbidden`, `not_caldav`, `temporary`, `unknown`).
- `429 busy` : un autre essai est en cours.

### `POST /api/connections/caldav/test`

Essai sans rien enregistrer, avec les valeurs fournies complétées par la configuration du moment ; corps vide : essai de la configuration actuelle. Le mot de passe enregistré n'est repris que si l'identifiant et l'adresse sont ceux en place ; sinon `password` est obligatoire (`400 invalid`). Seul l'essai de la configuration en place est gardé dans `caldav.lastTest`. Mêmes validations et mêmes refus que l'enregistrement. Réponse `200` : `{ "state": { … }, "test": { … }, "warning": null }` (un essai raté est un `200` avec `test.ok: false`).

### `DELETE /api/connections/caldav`

Retire les identifiants de l'app pour revenir à ceux du `.env`. Refusé si le `.env` n'en contient pas (`409 no_env`), s'il désigne un autre compte (`409 account_change`), ou si ses identifiants ne fonctionnent plus (`422 connection_failed`) : la configuration de l'app reste alors active.

## Codes d'erreur

| `code` | Statut | Sens |
|---|---|---|
| `invalid` | 400 | Données invalides ; détail par champ dans `fields` |
| `invalid_range` | 400 | `from` / `to` absents, mal formés, inversés, ou plus de 42 jours |
| `rejected` | 400 | Champ piège rempli |
| `mail_not_configured` | 400 | SMTP non configuré |
| `account_change` | 409 | Connexions : autre compte de calendrier que celui en place |
| `no_env` | 409 | Connexions : pas d'identifiants dans le `.env` vers lesquels revenir |
| `connection_failed` | 422 | Connexions : l'essai de connexion au calendrier a échoué (`reason`) ; rien n'a changé |
| `secret_key` | 503 | Connexions : clé de chiffrement inutilisable, mot de passe non enregistré |
| `closed` | 403 | Prise de rendez-vous fermée |
| `forbidden` | 403 | Requête d'écriture venue d'un autre site |
| `not_found` | 404 | Ressource inconnue ; pour un jeton : inconnu ou déjà annulé |
| `unknown_type` | 404 | Type inconnu ou inactif (côté public) |
| `slot_unavailable` | 409 | Créneau pas ou plus libre |
| `too_late` | 409 | Rendez-vous commencé ou passé : plus d'annulation en ligne |
| `already_cancelled` | 409 | Réservation déjà annulée (admin) |
| `slug_taken` | 409 | Identifiant de type déjà utilisé |
| `unsupported` | 415 | Corps pas en JSON |
| `rate_limited` | 429 | Limite de débit atteinte (`Retry-After`) |
| `calendar_unavailable` | 502 / 503 | Calendrier injoignable ou aucun calendrier modifiable ; rien n'a été fait |
| `busy` | 503 | Trop de demandes simultanées |

## Comportement du moteur

- **Créneaux.** Dans chaque plage horaire du jour : début de plage, puis tous les `slotStepMin`, tant que le rendez-vous entier tient dans la plage (plage 13:30-17:30, pas de 60 → 13:30, 14:30, 15:30, 16:30). Tout est calculé en heure murale de `Europe/Zurich` : 09:00 reste 09:00 avant et après un changement d'heure.
- **Ce qui bloque.** Toute occurrence d'un calendrier bloquant qui chevauche le créneau élargi des tampons du type. Ne bloquent pas : les événements marqués « disponible » (`TRANSP:TRANSPARENT`), les événements annulés (`STATUS:CANCELLED`). Une journée entière opaque bloque tout le jour. Se toucher aux bornes n'est pas un chevauchement.
- **Réservations existantes.** Elles bloquent toujours, même si l'événement n'est pas (ou plus) dans la copie locale, et protègent leurs propres tampons (ceux du type au moment de la réservation). Les tampons ne s'additionnent pas : l'écart entre deux rendez-vous est le plus grand des deux tampons en jeu.
- **Préavis et horizon.** Début ≥ maintenant + `minNoticeHours`. Jour local ≤ aujourd'hui + `horizonDays` (jours calendaires).
- **Réservation.** Synchro iCloud fraîche (4 s au plus, sans échouer si iCloud est lent), puis, une seule demande à la fois : nouveau calcul de disponibilité, création de l'événement « <type> : <nom> » (description : nom, e-mail, téléphone, message ; lieu selon le type), enregistrement, e-mails. Deux clients qui demandent le même créneau en même temps : un seul l'obtient, l'autre reçoit `409 slot_unavailable`.
- **E-mails.** Au client : confirmation (texte et HTML, lien d'annulation, pièce jointe `rendez-vous.ics`), avis d'annulation. À Antoine : nouveau rendez-vous, annulation par le client (pas d'avis quand il annule lui-même). Le message libre du client n'est jamais renvoyé au client. Un échec d'envoi ne remet jamais en cause la réservation.
- **Jeton d'annulation.** 32 octets aléatoires en base64url (43 caractères). Seule son empreinte SHA-256 est en base : il n'apparaît que dans l'e-mail et dans la réponse de la réservation.
- **Événement supprimé dans Apple Calendar.** La réservation passe à `eventState: "missing"` dans l'admin après la synchro. **Aucun e-mail automatique en v1.1** : c'est à Antoine d'annuler la réservation depuis l'admin s'il veut prévenir le client et libérer le créneau.

## À faire côté interface

Ces consignes sont appliquées par l'interface livrée ; elles restent la référence pour toute évolution.

- **Pages publiques.** `/rdv` et `/rdv/annulation/<jeton>` sont servies par le repli vers `index.html`. Elles ne doivent appeler que `/api/public/booking/*` : surtout pas `/api/me`, `/api/calendars` ni rien de privé, et ne pas afficher l'écran de connexion.
- **Champ piège.** Ajouter au formulaire un champ texte invisible pour un humain (hors écran en CSS, `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`), et envoyer sa valeur dans `website`. Lui donner un `name` qu'un gestionnaire de mots de passe ne remplit pas (éviter `email`, `url`, `phone`).
- **Page d'annulation.** D'abord `GET` (récapitulatif et bouton « Annuler ce rendez-vous »), puis `POST` au clic. Ne jamais annuler au simple chargement de la page : les antivirus et les aperçus de liens ouvrent les liens des e-mails.
- **Créneau perdu.** Sur `409 slot_unavailable`, recharger les créneaux et garder les champs saisis.
- **CSP.** La politique stricte existante s'applique aux pages publiques : pas de script ni de police externes.
- **Texte saisi.** `welcomeText`, `description`, `message`, `name` : toujours du texte, jamais du HTML.
- **Admin.** Afficher `warnings`, `mailError`, et un repère visible pour `eventState` `missing` (« événement supprimé ») et `moved` (« déplacé : le client a reçu l'horaire du … »).
