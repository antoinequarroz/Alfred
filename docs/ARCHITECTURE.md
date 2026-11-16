# Architecture d'Alfred

## Vue d'ensemble

```
 iPhone / Mac (Apple Calendar)
            │
            ▼
      iCloud (CalDAV)  ◄──── synchro toutes les 2 min + écriture immédiate ────┐
                                                                               │
 Navigateur / PWA ──HTTPS──► Caddy ──► conteneur « alfred » (Node.js, ~110 Mo) │
                                         ├─ API JSON (Hono) ───────────────────┘
                                         ├─ app web compilée (React)
                                         └─ SQLite (/data/alfred.db)
```

Un seul processus Node.js sert l'API et l'app web. Pas de Postgres ni de Redis : la base est un fichier SQLite (module `node:sqlite` intégré à Node 22, aucune dépendance native).

## Arborescence

| Dossier | Rôle |
|---|---|
| `server/ics.ts` | Moteur iCalendar : lecture, développement des répétitions, création et modification des événements |
| `server/caldav.ts` | Synchronisation CalDAV (iCloud ou tout serveur standard) |
| `server/service.ts` | Opérations sur les événements, que le calendrier soit local ou CalDAV |
| `server/store.ts`, `server/db.ts` | Base SQLite |
| `server/app.ts` | API HTTP, connexion, sécurité |
| `server/booking/slots.ts` | Prise de RDV : calcul des créneaux libres (module pur, sans base ni horloge) |
| `server/booking/service.ts`, `store.ts` | Prise de RDV : réglages, types, horaires, réservation, annulation |
| `server/booking/routes.ts`, `ratelimit.ts` | Prise de RDV : routes publiques et privées, limitation de débit |
| `server/booking/mail.ts` | Prise de RDV : e-mails (SMTP), pièce jointe iCalendar |
| `web/src/` | App web (React) : vues, fenêtre d'événement, glisser-déposer |
| `shared/types.ts` | Types partagés entre serveur et app |
| `test/` | Tests du moteur, de l'API et de la synchro (contre Radicale) |

## La synchro iCloud

iCloud reste la référence : Alfred garde une copie locale pour afficher vite et, plus tard, calculer les disponibilités.

- **Lecture.** iCloud ne sait pas prévenir un serveur tiers, donc Alfred l'interroge (toutes les 120 s par défaut). Pour chaque calendrier, il compare d'abord le `ctag` (rien à faire s'il n'a pas bougé), puis la liste des `etag`, et ne télécharge que les événements nouveaux ou modifiés.
- **Écriture.** Chaque création, modification ou suppression est envoyée tout de suite à iCloud, puis reportée dans la copie locale. La modification est conditionnelle (`If-Match`) : si l'événement a changé ailleurs entre-temps, Alfred recharge la version d'iCloud et le signale au lieu d'écraser.
- **Fidélité.** La ressource iCalendar d'origine est conservée telle quelle. Une modification ne touche que les champs concernés, donc les invités, alarmes et autres propriétés posées par Apple Calendar sont préservés.
- **Fuseau.** Les événements créés dans Alfred sont écrits dans le fuseau configuré (`Europe/Zurich`) avec sa définition, pour que les répétitions suivent l'heure d'été.

Sans identifiants CalDAV, Alfred fonctionne avec un calendrier local, ce qui sert au développement.

## La prise de rendez-vous (v1.1)

Une page publique laisse un client choisir un type de rendez-vous puis un créneau libre ; la réservation crée l'événement dans le calendrier d'Antoine (donc dans iCloud) et envoie les e-mails. La description complète de l'API est dans [API-RDV.md](API-RDV.md).

- **Fermée par défaut.** Rien n'est réservable tant qu'Antoine n'a pas activé la prise de rendez-vous dans les réglages.
- **Créneaux.** Calculés à la demande sur la copie locale : horaires hebdomadaires, pas de 15, 30 ou 60 minutes, durée et tampons du type, préavis, horizon. Tout se raisonne en heure murale de `Europe/Zurich`, jour par jour, puis chaque créneau est converti en instant : les changements d'heure ne décalent rien. Bloquent : les occurrences des calendriers marqués « bloque les créneaux » (même masqués) et les réservations déjà enregistrées. Ne bloquent pas : les événements « disponible » (`TRANSP:TRANSPARENT`) et annulés.
- **Réservation.** Validation stricte, synchro iCloud fraîche (au mieux, 4 s au plus), puis section critique en mémoire (un seul processus) : nouveau calcul de disponibilité, `CalendarService.create`, enregistrement. Deux demandes simultanées pour le même créneau : une seule réussit.
- **Annulation.** Lien `/rdv/annulation/<jeton>` (32 octets aléatoires ; seule l'empreinte SHA-256 est en base), ou depuis l'admin. L'événement est retiré par `CalendarService.remove`, en tolérant qu'il ait déjà disparu.
- **E-mails.** SMTP (Infomaniak par défaut) avec nodemailer, chargé au premier envoi seulement. Confirmation au client avec pièce jointe `.ics` (`METHOD:PUBLISH`, pas une invitation), avis à Antoine. Un échec d'envoi ne remet jamais en cause la réservation : il est journalisé et affiché dans l'admin. Sans SMTP configuré, tout fonctionne sauf l'envoi.
- **Événement supprimé dans Apple Calendar.** Après la synchro, la réservation apparaît comme « événement supprimé » dans l'admin et reste confirmée (le créneau reste pris). Pas d'e-mail automatique en v1.1 : Antoine annule la réservation depuis l'admin pour prévenir le client et libérer le créneau. De même, un événement déplacé est signalé « déplacé » sans prévenir le client.
- **Données.** Tables `booking_settings`, `booking_types`, `booking_hours`, `bookings`, et une colonne `blocks_booking` sur `calendars`, créées par une migration idempotente à l'ouverture de la base.

## Sécurité

- Un seul utilisateur. Mot de passe stocké sous forme d'empreinte scrypt, session par cookie `HttpOnly`, `Secure`, `SameSite=Lax`, blocage après cinq essais ratés.
- Protection CSRF, en-têtes de sécurité et politique CSP stricte.
- Partie publique (`/api/public/booking/*`) : aucune session, aucun détail d'événement (seulement des débuts de créneaux libres), limitation de débit par adresse IP en mémoire bornée (dernier élément de `X-Forwarded-For`, posé par Caddy), champ piège anti-robot, corps limité à 16 Ko, mêmes réponses pour un jeton inconnu ou déjà utilisé, refus des écritures venues d'un autre site. Tout contenu saisi est échappé dans les e-mails et ne peut pas couper un en-tête.
- Le mot de passe d'application iCloud ne vit que dans le `.env` du serveur. Il ne donne accès qu'aux données iCloud accessibles aux apps et se révoque en un clic chez Apple.

## Limites connues de la v1

- La fenêtre d'édition propose les répétitions simples (jour, semaine, mois, an). Les règles plus complexes créées dans Apple Calendar sont affichées correctement et conservées, mais ne se modifient pas depuis Alfred.
- Décaler toute une série supprime les exceptions de cette série (occurrences déplacées ou supprimées une à une).
- Pas de gestion des invités ni des alarmes dans l'interface (ils sont conservés).
- Hors ligne, l'app s'ouvre mais n'affiche pas les événements.
- Fuseaux pris en charge pour l'écriture : Europe centrale.

## Comment la suite s'y branche

- **Interface de la prise de RDV.** Le moteur et l'API sont en place ; il reste la page publique et l'écran d'administration, décrits dans [API-RDV.md](API-RDV.md).
- **Visio (v2).** LiveKit tourne dans son propre conteneur. Alfred ne fait que délivrer des jetons d'accès et rattacher une salle à un événement (lien dans le champ lieu ou la description, visible aussi dans Apple Calendar).
- **Apps Mac et mobile.** L'app web est déjà une PWA. Tauri (Mac) et Capacitor (iOS, Android) emballeront le même code.
- **Agent IA.** L'API JSON est le point d'entrée : lire l'agenda, créer et déplacer des événements.
