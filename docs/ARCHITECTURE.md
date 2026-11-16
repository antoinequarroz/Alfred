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
| `web/src/` | App web privée (React) : vues, fenêtre d'événement, glisser-déposer |
| `web/src/rdv/` | Prise de RDV : page publique (`PublicApp.tsx`), écran « Rendez-vous » de l'admin (`BookingAdmin.tsx`), dates dans le fuseau du serveur (`tz.ts`) |
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
- **Créneaux.** Calculés sur la copie locale : horaires hebdomadaires, pas de 15, 30 ou 60 minutes, durée et tampons du type, préavis, horizon. Tout se raisonne en heure murale de `Europe/Zurich`, jour par jour, puis chaque créneau est converti en instant : les changements d'heure ne décalent rien. Bloquent : les occurrences des calendriers marqués « bloque les créneaux » (même masqués) et les réservations déjà enregistrées. Ne bloquent pas : les événements « disponible » (`TRANSP:TRANSPARENT`) et annulés.
- **Journées entières.** Apple Calendar marque « disponible » les journées entières qu'il crée, congés compris (à confirmer sur les vrais événements d'Antoine : `SELECT ics FROM events WHERE ics LIKE '%VALUE=DATE%' LIMIT 5`). Par défaut, une journée entière bloque donc toute la journée quelle que soit cette marque ; le réglage se décoche dans Rendez-vous > Horaires.
- **Coût du calcul.** L'occupation de l'agenda est développée une seule fois pour toute la période réservable, puis gardée en mémoire tant que l'agenda ne change pas (toute écriture d'événement l'invalide, synchro comprise). Les événements simples sont lus depuis une colonne (`events.busy`), sans relire leur iCalendar ; les séries quotidiennes et hebdomadaires reprennent près de la période demandée au lieu d'être reparcourues depuis leur début. Une demande de créneaux coûte ainsi quelques millisecondes ; elle est limitée à 42 jours, à 30 demandes par minute et par adresse IP, et à 600 par minute au total.
- **Réservation.** Validation stricte, synchro iCloud fraîche (au mieux, 4 s au plus), puis section critique en mémoire (un seul processus) où tout est relu : réglages, type (supprimé, désactivé ou modifié entre-temps), disponibilité, plafonds. Puis `CalendarService.create` et enregistrement. Deux demandes simultanées pour le même créneau : une seule réussit. Si le serveur de calendrier enregistre l'événement sans que sa réponse arrive, l'événement est retiré (il se retrouve par son UID, choisi avant l'appel).
- **Annulation.** Lien `/rdv/annulation/<jeton>` (32 octets aléatoires ; seule l'empreinte SHA-256 est en base), ou depuis l'admin. L'événement est retiré par `CalendarService.remove`, en tolérant qu'il ait déjà disparu.
- **E-mails.** SMTP (Infomaniak par défaut) avec nodemailer, chargé au premier envoi seulement. Confirmation au client avec pièce jointe `.ics` (`METHOD:PUBLISH`, pas une invitation), avis à Antoine. Un échec d'envoi ne remet jamais en cause la réservation : il est journalisé et affiché dans l'admin. La réponse au client n'attend pas les envois plus de 8 secondes : au-delà, ils se poursuivent en arrière-plan et leur résultat est noté sur la réservation. Sans SMTP configuré, tout fonctionne sauf l'envoi.
- **Abus du formulaire.** L'adresse saisie n'est pas vérifiée avant l'envoi (pas de double confirmation en v1.1). Pour que le formulaire ne serve pas à inonder un tiers d'e-mails : 3 réservations créées au plus par adresse e-mail sur 24 heures (annulations comprises), 5 réservations abouties par heure et par adresse IP (IPv6 regroupée en /56), 60 par heure au total, pas d'e-mail au client qui annule dans le quart d'heure suivant sa réservation, 200 e-mails sortants au plus par 24 heures (compteur en mémoire, signalé dans l'admin quand il est atteint), et un nom limité à ce qu'est un nom (ni lien ni domaine).
- **Événement supprimé dans Apple Calendar.** Après la synchro, la réservation apparaît comme « événement supprimé » dans l'admin et reste confirmée (le créneau reste pris). Pas d'e-mail automatique en v1.1 : Antoine annule la réservation depuis l'admin pour prévenir le client et libérer le créneau.
- **Événement déplacé ou changé de calendrier.** La réservation retient l'UID iCalendar de son événement : changé de calendrier (dans Alfred ou dans Apple Calendar), il est retrouvé et l'annulation le retire. Déplacé dans le temps, la réservation suit : l'ancien créneau est libéré, le nouveau est protégé avec ses tampons, et la page d'annulation du client montre le nouvel horaire. Le client n'est pas prévenu automatiquement : l'admin signale « déplacé » avec l'horaire qu'il a reçu, et « Renvoyer l'e-mail » lui annonce le nouveau.
- **Interface.** La même page sert deux apps, chargées à la demande (`web/src/main.tsx`) : sous `/rdv`, `/rdv/<type>` et `/rdv/annulation/<jeton>`, la page publique, qui n'appelle que `/api/public/booking/*`, ne télécharge pas l'app privée et n'enregistre pas de service worker ; partout ailleurs, l'app privée, dont l'écran « Rendez-vous » (interrupteur d'ouverture, lien public, réservations, types, horaires, réglages, e-mails) n'est chargé qu'à l'ouverture. Les heures sont toujours affichées dans le fuseau annoncé par le serveur, pas dans celui du navigateur. Le service worker ne touche ni à l'API ni aux pages `/rdv`.
- **Données.** Tables `booking_settings`, `booking_types`, `booking_hours`, `bookings`, et les colonnes `calendars.blocks_booking` et `events.busy`, créées par une migration idempotente à l'ouverture de la base. Contrairement aux événements, ces données ne reviennent pas d'iCloud : la base est à sauvegarder (voir [DEPLOIEMENT.md](DEPLOIEMENT.md)).

## Sécurité

- Un seul utilisateur. Mot de passe stocké sous forme d'empreinte scrypt, session par cookie `HttpOnly`, `Secure`, `SameSite=Lax`, blocage après cinq essais ratés.
- Protection CSRF, en-têtes de sécurité et politique CSP stricte.
- Partie publique (`/api/public/booking/*`) : aucune session, aucun détail d'événement (seulement des débuts de créneaux libres), limitation de débit par adresse IP en mémoire bornée (dernier élément de `X-Forwarded-For`, posé par Caddy ; IPv6 comptée par /56), plafonds par adresse e-mail et d'e-mails sortants, champ piège anti-robot, corps limité à 16 Ko, mêmes réponses pour un jeton inconnu ou déjà utilisé, refus des écritures venues d'un autre site. Tout contenu saisi est échappé dans les e-mails et ne peut pas couper un en-tête.
- Le mot de passe d'application iCloud ne vit que dans le `.env` du serveur. Il ne donne accès qu'aux données iCloud accessibles aux apps et se révoque en un clic chez Apple.

## Limites connues de la v1

- La fenêtre d'édition propose les répétitions simples (jour, semaine, mois, an). Les règles plus complexes créées dans Apple Calendar sont affichées correctement et conservées, mais ne se modifient pas depuis Alfred.
- Décaler toute une série supprime les exceptions de cette série (occurrences déplacées ou supprimées une à une).
- Pas de gestion des invités ni des alarmes dans l'interface (ils sont conservés).
- Hors ligne, l'app s'ouvre mais n'affiche pas les événements.
- Fuseaux pris en charge pour l'écriture : Europe centrale.

## Comment la suite s'y branche

- **Visio (v2).** LiveKit tourne dans son propre conteneur. Alfred ne fait que délivrer des jetons d'accès et rattacher une salle à un événement (lien dans le champ lieu ou la description, visible aussi dans Apple Calendar).
- **Apps Mac et mobile.** L'app web est déjà une PWA. Tauri (Mac) et Capacitor (iOS, Android) emballeront le même code.
- **Agent IA.** L'API JSON est le point d'entrée : lire l'agenda, créer et déplacer des événements.
