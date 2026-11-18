# Journal d'événements d'Alfred

Alfred écrit ses faits dans une boîte d'envoi (table `outbox`) au format commun de la suite :
« un rendez-vous a été pris », « un acompte a été payé », « un invité attend en visio »… Chaque
fait est écrit **dans la même transaction** que le changement qu'il décrit : si le changement
échoue, le fait disparaît avec lui, et un fait écrit correspond toujours à un changement réel.

Les lecteurs lisent le journal dans l'ordre et retiennent leur position (`outbox_readers`) : un
fait n'est jamais perdu quand un lecteur est arrêté, ni traité deux fois. Aujourd'hui, le seul
lecteur est celui des notifications (`push`). La distribution vers les autres modules de la
suite viendra ensuite (ALFRED-308).

Code : `server/outbox.ts` (`recordFact`, `OutboxReader`, `onFacts`). Migration 5 (`journal`).

## Format

| Colonne | Contenu |
| -- | -- |
| `seq` | Ordre d'écriture (entier croissant). Position des lecteurs. |
| `id` | UUID v7 du fait, unique dans toute la suite. |
| `space_id` | Espace du fait. |
| `source` | Module qui écrit : `alfred`. |
| `type` | Type du fait, ci-dessous. |
| `subject` | Adresse `media://alfred/<type>/<id>` de l'objet concerné. |
| `occurred_at` | Instant du fait, ISO 8601 UTC. |
| `data` | Détails, en JSON. Jamais d'e-mail ni de téléphone : le journal circulera entre modules. |
| `data_version` | Version du format de `data` (1). |

## Types de faits

Les réservations portent toujours dans `data` : `bookingId`, `typeName`, `start`, `end`
(horaire après le fait), `name`, `personId`, `status`.

| Type | Sujet | Écrit quand | `data` en plus |
| -- | -- | -- | -- |
| `booking.created` | `booking` | Un client prend rendez-vous (après paiement de l'acompte s'il y en a un). | `deposit` : `{ amountCents, currency }` ou `null` |
| `booking.rescheduled` | `booking` | Le client déplace son rendez-vous depuis son lien, ou l'événement est déplacé dans l'agenda (iCloud compris). | `by` : `client` ou `agenda` ; `previousStart` |
| `booking.cancelled` | `booking` | Le client ou Antoine annule. | `by` : `client` ou `admin` |
| `payment.received` | `payment` | L'acompte est payé en ligne (Stripe) ; le créneau est retenu, la réservation suit. | `holdId`, `amountCents`, `currency`, `typeName`, `start`, `end`, `name` |
| `payment.refunded` | `booking` | L'acompte est remboursé (annulation). | `amountCents`, `currency` |
| `video.guest_waiting` | `room` | Un invité attend d'être admis dans une salle de visio. | `roomId`, `slug`, `title`, `kind`, `bookingId`, `guestName` |
| `video.guest_joined` | `room` | Un invité entre dans une salle de visio. | comme `video.guest_waiting` |
| `video.call_ended` | `room` | *Prévu* : Alfred ne reçoit pas encore la fin des appels du serveur de visio. | |
| `video.recording_ready` | `recording` | *Prévu* : l'enregistrement des visios n'existe pas encore. | |
| `video.transcript_ready` | `recording` | *Prévu* : la transcription n'existe pas encore. | |

Un nouveau type s'ajoute dans `FACT_TYPES` (`server/outbox.ts`) et dans ce tableau ; un test
vérifie que chaque type y est documenté.

## Notifications

Les notifications (Web Push) lisent le journal à chaque passe (toutes les 30 secondes), et tout
de suite quand un invité arrive en visio :

- `booking.created` : « Nouveau rendez-vous », avec l'horaire actuel (rien si le rendez-vous a été
  annulé avant d'être signalé) ;
- `booking.cancelled` par le client : « Rendez-vous annulé » ;
- `video.guest_waiting` / `video.guest_joined` : « … attend d'entrer » / « … est dans la visio »
  (pas plus d'une fois toutes les 2 minutes par invité, et rien après 5 minutes).

Les rappels avant un rendez-vous ne sont pas des faits : ils dépendent de l'heure et sont calculés
à chaque passe depuis l'agenda et les réservations.

Les faits sont gardés : la distribution vers la suite (ALFRED-308) décidera de leur durée de vie.
