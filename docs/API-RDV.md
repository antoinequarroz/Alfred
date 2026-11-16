# API de la prise de rendez-vous (v1.1)

Ce document décrit l'API utilisée par l'interface : la page publique (`/rdv`, `/rdv/<type>`, `/rdv/annulation/<jeton>`, code dans `web/src/rdv/PublicApp.tsx`) et la rubrique « Rendez-vous » de l'admin (`web/src/rdv/BookingAdmin.tsx`). Les types TypeScript correspondants sont dans `shared/types.ts` (noms indiqués entre parenthèses).

- [Principes communs](#principes-communs)
- [API publique](#api-publique) : `/api/public/booking/*`, sans session
- [API privée](#api-privée) : `/api/booking/*`, session requise
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
| Lectures (infos, créneaux, consultation par jeton) | 120 par minute et par IP |
| Réservations (réussies ou non) | 20 par heure et par IP |
| Réservations abouties, toutes IP confondues | 60 par heure |
| Annulations par jeton | 20 par heure et par IP |

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

Créneaux libres d'un type entre deux jours inclus (`PublicSlots`). 62 jours au plus par appel.

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
| `name` | Obligatoire. 2 à 80 caractères, une seule ligne, sans `<`, `>`, `@`, lien (`://`, `www.`). |
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
  "cancelUrl": "https://alfred.antoinequarroz.ch/rdv/annulation/Jq3…43 caractères",
  "emailSent": true
}
```

- `emailSent: false` : le rendez-vous **est pris**, mais l'e-mail de confirmation n'a pas pu partir. Afficher le récapitulatif et inviter à noter le rendez-vous ; proposer `cancelUrl` comme lien d'annulation.
- La réponse peut prendre quelques secondes (synchro iCloud avant confirmation, puis envoi des e-mails) : désactiver le bouton et montrer une attente.

Erreurs :

| Statut | `code` | Quand | Que faire |
|---|---|---|---|
| 400 | `invalid` | Champ invalide (`fields`) | Afficher les messages sous les champs |
| 400 | `rejected` | Champ piège rempli | Message générique |
| 403 | `closed` | Prise de RDV fermée | Recharger les infos |
| 404 | `unknown_type` | Type inconnu ou désactivé | Recharger les infos |
| 409 | `slot_unavailable` | Créneau plus libre (pris entre-temps, ou pas un créneau proposé) | Recharger les créneaux et faire choisir de nouveau |
| 409 | `too_many_bookings` | Déjà 5 rendez-vous à venir pour cette adresse e-mail | Afficher le message |
| 413 | — | Corps trop gros | — |
| 415 | `unsupported` | Corps pas en JSON | — |
| 429 | `rate_limited` | Trop de demandes | Réessayer après `Retry-After` |
| 502 / 503 | `calendar_unavailable` | Le calendrier (iCloud) ne répond pas | « Réessayez plus tard » ; rien n'a été réservé |
| 503 | `busy` | Trop de réservations simultanées | Réessayer dans un instant |

### `GET /api/public/booking/cancel/:token`

Récapitulatif pour la page `/rdv/annulation/<jeton>` (`PublicBooking`, même forme que `booking` ci-dessus). Consulter n'annule rien.

- `cancellable: false` : le rendez-vous a commencé ou est passé ; ne pas proposer le bouton.
- `404 not_found` : jeton inconnu, mal formé **ou rendez-vous déjà annulé** (réponse volontairement identique). Afficher « Ce lien n'est plus valable : rendez-vous introuvable ou déjà annulé. »

### `POST /api/public/booking/cancel/:token`

Annule (sans corps). Réponse `200` : le `PublicBooking` avec `status: "cancelled"` et `cancellable: false`. L'événement est retiré du calendrier, le client et Antoine reçoivent un e-mail.

Erreurs : `404 not_found` (comme ci-dessus, y compris pour un second clic), `409 too_late` (déjà commencé ou passé), `429 rate_limited`, `502 calendar_unavailable` (rien n'a été annulé, réessayer).

L'annulation par jeton reste possible même si la prise de rendez-vous a été refermée.

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
    "slotStepMin": 30
  },
  "effectiveCalendarId": "caldav:Q2x…",
  "timezone": "Europe/Zurich",
  "publicPageUrl": "https://alfred.antoinequarroz.ch/rdv",
  "mail": { "configured": false, "from": "Antoine Quarroz <info@antoinequarroz.ch>", "notifyTo": "info@antoinequarroz.ch" },
  "warnings": [
    "L’envoi d’e-mails n’est pas configuré (SMTP_USER et SMTP_PASSWORD) : les réservations fonctionnent, mais aucun e-mail ne part.",
    "Aucun type de rendez-vous actif.",
    "La prise de rendez-vous est fermée : la page publique n’accepte aucune réservation."
  ]
}
```

- `settings.calendarId` : calendrier où créer les rendez-vous ; `null` = le premier calendrier modifiable. `effectiveCalendarId` est celui réellement utilisé (`null` si aucun calendrier n'est modifiable).
- `warnings` : phrases prêtes à afficher (SMTP non configuré, aucun calendrier modifiable, calendrier choisi inutilisable, aucun type actif, aucun horaire, synchro iCloud en échec, prise de RDV fermée).
- `mail.configured: false` : afficher l'avertissement ; tout fonctionne sauf l'envoi.

#### `PUT /api/booking/settings`

Modification partielle : n'envoyer que les champs à changer. Réponse : le `BookingAdminState` à jour.

| Champ | Règle |
|---|---|
| `enabled` | booléen |
| `publicName` | 100 caractères au plus, une ligne |
| `welcomeText` | 2000 caractères au plus |
| `calendarId` | identifiant d'un calendrier modifiable, ou `null` |
| `slotStepMin` | `15`, `30` ou `60` |

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
    "mailError": null
  }
]
```

- `eventState` (réservations confirmées seulement, sinon `null`) :
  - `ok` : l'événement est dans le calendrier, à l'heure réservée.
  - `missing` : **« événement supprimé »**. Antoine l'a supprimé (par exemple dans Apple Calendar) ou déplacé dans un autre calendrier. La réservation reste confirmée et **le créneau reste pris** : proposer « Annuler la réservation » pour prévenir le client et libérer le créneau.
  - `moved` : l'événement a été déplacé ; `eventStart` et `eventEnd` donnent son horaire actuel. Le client n'est pas prévenu automatiquement.
- `mailError` : dernier échec d'envoi d'e-mail pour cette réservation (texte à afficher), `null` si tout est parti. Sans SMTP : « E-mails non configurés : aucun message envoyé ».
- `cancelledBy` : `client` ou `admin`.

#### `POST /api/booking/bookings/:id/cancel`

Annulation par Antoine. Corps facultatif : `{ "notifyClient": false }` pour ne pas écrire au client (défaut : le client reçoit un e-mail). Réponse : le `Booking` annulé. L'événement est retiré du calendrier (sans erreur s'il a déjà disparu).

Erreurs : `404 not_found`, `409 already_cancelled`, `502 calendar_unavailable`.

#### `POST /api/booking/bookings/:id/resend`

Renvoie la confirmation au client. Le jeton d'annulation n'étant jamais conservé, **un nouveau lien est créé et l'ancien cesse de fonctionner**. Réponse : le `Booking` (regarder `mailError`).

Erreurs : `400 mail_not_configured`, `404 not_found`, `409 already_cancelled`.

### E-mails

#### `POST /api/booking/mail/test`

Envoie un message d'essai à l'adresse d'avis (`mail.notifyTo`). Réponse : `{ "ok": true, "to": "info@antoinequarroz.ch" }`. Erreurs : `400 mail_not_configured`, `502 mail_failed` (le message d'erreur du serveur SMTP est dans `error`).

## Codes d'erreur

| `code` | Statut | Sens |
|---|---|---|
| `invalid` | 400 | Données invalides ; détail par champ dans `fields` |
| `invalid_range` | 400 | `from` / `to` absents, mal formés, inversés, ou plus de 62 jours |
| `rejected` | 400 | Champ piège rempli |
| `mail_not_configured` | 400 | SMTP non configuré |
| `closed` | 403 | Prise de rendez-vous fermée |
| `forbidden` | 403 | Requête d'écriture venue d'un autre site |
| `not_found` | 404 | Ressource inconnue ; pour un jeton : inconnu ou déjà annulé |
| `unknown_type` | 404 | Type inconnu ou inactif (côté public) |
| `slot_unavailable` | 409 | Créneau pas ou plus libre |
| `too_many_bookings` | 409 | Trop de rendez-vous à venir pour cette adresse e-mail |
| `too_late` | 409 | Rendez-vous commencé ou passé : plus d'annulation en ligne |
| `already_cancelled` | 409 | Réservation déjà annulée (admin) |
| `slug_taken` | 409 | Identifiant de type déjà utilisé |
| `unsupported` | 415 | Corps pas en JSON |
| `rate_limited` | 429 | Limite de débit atteinte (`Retry-After`) |
| `calendar_unavailable` | 502 / 503 | Calendrier injoignable ou aucun calendrier modifiable ; rien n'a été fait |
| `mail_failed` | 502 | L'e-mail d'essai n'est pas parti |
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
- **Admin.** Afficher `warnings`, `mailError`, et un repère visible pour `eventState` `missing` (« événement supprimé ») et `moved` (« déplacé au … »).
