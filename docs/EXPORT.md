# Export et import des données d'Alfred

Réglages > **Données**. Deux fichiers, dans des formats ouverts :

- **Exporter tout** : un fichier JSON (`alfred-export-AAAA-MM-JJ.json`) avec toutes les données
  de l'espace. C'est une sauvegarde lisible, et la base de la migration vers le socle de la suite.
- **Calendrier (.ics)** : tous les événements en un seul fichier iCalendar, à ouvrir dans Apple
  Calendrier, Google Agenda, Outlook… (`GET /api/export/calendar.ics?calendar=<id>` pour un seul
  calendrier).

**Importer un export…** recharge un fichier JSON dans un Alfred **vide** : aucun événement,
rendez-vous, type, personne, lien, salle de visio, acompte ni fait du journal. Le calendrier vide
« Personnel », les horaires proposés d'office et les réglages sont remplacés par ceux du fichier.
L'import est tout ou rien : au moindre refus, rien n'est modifié. Un nouvel export redonne
ensuite exactement le même fichier (seule la date d'export change ; c'est testé).

## Format (version 1)

```json
{
  "format": "alfred-export",
  "version": 1,
  "schemaVersion": 6,
  "exportedAt": "2026-11-18T21:45:00.000Z",
  "space": { "id": "01930000-0000-7000-8000-000000000001", "name": "Personnel" },
  "tables": {
    "calendars": [ { "id": "…", "source": "local", "name": "Personnel", … } ],
    "events": [ … ],
    …
  }
}
```

- `format` et `version` : la forme du fichier. `version` augmente seulement si cette forme change ;
  Alfred refuse une version qu'il ne connaît pas.
- `schemaVersion` : la version du schéma de la base qui a produit le fichier (migrations de
  `server/migrations.ts`). Un fichier d'une version plus récente est refusé : mettre Alfred à jour
  d'abord. Un fichier plus ancien s'importe ; les colonnes ajoutées depuis prennent leur valeur par
  défaut.
- `tables` : une liste de lignes par table, avec les colonnes de la base telles quelles (voir
  `server/db.ts` et `server/migrations.ts`), sans `space_id` (l'import écrit l'espace courant).
  Les lignes sont triées (identifiant, ou ordre d'affichage) pour qu'un même contenu donne
  toujours le même fichier.
- Instants : texte ISO 8601 UTC avec millisecondes (`2026-11-18T21:45:00.000Z`). Une heure locale
  est toujours accompagnée de son fuseau IANA (`booking_hours.tzid`, `events.tzid`). Voir
  [DONNEES.md](DONNEES.md#dates-et-fuseaux).
- Événements : la colonne `ics` garde l'iCalendar complet, tel qu'iCloud ou Alfred l'a écrit
  (avec son VTIMEZONE) ; c'est lui qui fait foi.

### Tables exportées

Dans l'ordre d'import : `calendars`, `events`, `booking_types`, `booking_hours`, `people`,
`bookings`, `booking_tokens`, `payment_holds`, `video_rooms`, `video_participations`, `links`, `settings`, `outbox`.

Les invités des événements (`event_attendees`) ne sont pas exportés : ils sont tirés à nouveau de
l'iCalendar de chaque événement à l'import.

`settings` (schéma 7 et suivants) regroupe les réglages de tous les modules (`module`, `key`,
`value`, `secret`). Un export d'avant le schéma 7 porte à la place les anciennes tables
`booking_settings`, `video_settings`, `connection_settings` et `push_settings` : il s'importe aussi.

Colonnes laissées de côté : les anciennes colonnes en millisecondes des événements (recalculées à
l'import), la date de copie des invités (`events.attendees_at`), la date de modification des réglages, l'identifiant interne des horaires (`booking_hours.id`) et la position des faits du
journal (`outbox.seq`, recréée dans le même ordre).

### Ce qui n'est jamais exporté

| Quoi | Pourquoi |
| -- | -- |
| Réglages secrets (`settings` avec `secret = 1` : mots de passe SMTP et iCloud, clé Stripe, clés VAPID des notifications) | secrets ; à ressaisir dans les Réglages après un import |
| Date de départ des notifications (`push` / `since`) et abonnements des appareils (`push_subscriptions`) | propres à l'installation ; chaque appareil se réabonne |
| Jeton en clair d'un paiement en cours (`payment_holds.cancel_token`) | secret de passage, vidé |
| Sessions de connexion, notifications déjà envoyées, positions de lecture du journal | mécanique interne de l'installation |
| Jetons de l'API v1 et des flux iCalendar (`api_tokens`) | accès propres à l'installation ; à recréer dans les Réglages |

Les empreintes des liens d'annulation des clients (`bookings.token_hash`, `booking_tokens`) sont
exportées : ce ne sont pas des secrets (seule l'empreinte est gardée), et les liens déjà envoyés
continuent de marcher après un import.

Après un import, les faits du journal sont considérés comme déjà traités : aucune notification ne
repart pour l'histoire importée.

## API (session requise)

- `GET /api/export` : le fichier JSON.
- `GET /api/export/calendar.ics[?calendar=<id>]` : le fichier .ics.
- `POST /api/import` (corps : le fichier JSON, 50 Mo au plus) → `{ ok, counts }` ; `409 not_empty`
  si Alfred contient déjà des données, `400 invalid_export` ou `400 import_failed` sinon.

## Faire évoluer le format

Une nouvelle table doit être ajoutée à `EXPORTED_TABLES` ou à `NOT_EXPORTED` dans
`server/export.ts` (un test le rappelle). Une nouvelle colonne passe toute seule. Si la forme du
fichier change (pas juste une colonne), augmenter `EXPORT_VERSION` et garder la lecture de
l'ancienne version.
