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
| `server/connections.ts`, `connections-routes.ts` | Connexions réglables depuis l'app (SMTP, CalDAV) : priorité app, `.env`, défaut ; API `/api/connections` |
| `server/secrets.ts` | Chiffrement des mots de passe enregistrés dans l'app, gestion de la clé |
| `server/netguard.ts`, `diagnostics.ts` | Refus des hôtes internes (SSRF) ; diagnostics en français sans détail sensible |
| `server/booking/slots.ts` | Prise de RDV : calcul des créneaux libres (module pur, sans base ni horloge) |
| `server/booking/service.ts`, `store.ts` | Prise de RDV : réglages, types, horaires, réservation, annulation |
| `server/booking/routes.ts`, `ratelimit.ts` | Prise de RDV : routes publiques et privées, limitation de débit |
| `server/booking/mail.ts` | Prise de RDV : e-mails (SMTP), pièce jointe iCalendar |
| `web/src/` | App web privée (React) : vues, fenêtre d'événement, glisser-déposer |
| `web/src/settings/` | Écran « Réglages » : calendrier iCloud et envoi des e-mails (`ConnectionsScreen.tsx`, `ConnectionCards.tsx`) |
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

## Les connexions réglables depuis l'app

L'envoi des e-mails (SMTP) et les identifiants du calendrier (CalDAV) se règlent dans l'app : écran **Réglages** de la barre latérale, et **Rendez-vous > Réglages** pour les e-mails. Le fichier `.env` reste lu : une installation configurée par `.env` fonctionne sans rien changer après la mise à jour.

- **Priorité.** Réglage par réglage : valeur de l'app (table `connection_settings`, une ligne par réglage), sinon variable du `.env`, sinon valeur par défaut. L'interface affiche l'origine de chacun. Une valeur saisie identique à celle du `.env` n'est pas recopiée en base.
- **SMTP à chaud.** L'expéditeur est reconstruit à chaque changement : aucun redémarrage. « Enregistrer et tester » enregistre puis envoie un e-mail d'essai à l'adresse des avis ; un mot de passe erroné s'enregistre quand même, et l'essai le dit.
- **CalDAV à chaud.** De nouveaux identifiants sont d'abord essayés (découverte du principal, liste des calendriers). Essai réussi : enregistrement, client de synchro recréé, synchro lancée. Essai raté : rien ne change, la synchro continue avec l'ancienne configuration. Le client de synchro existe toujours ; sans identifiants il reste inactif.
- **Pas de changement de compte en v1.** Les calendriers et les événements du compte sont en base et des réservations y sont liées : dès qu'un compte est en place, seul son mot de passe peut changer (même identifiant, même serveur). La première configuration, quand rien n'est en place, accepte n'importe quel compte.
- **Diagnostics.** Les erreurs de nodemailer et de tsdav peuvent reprendre la réponse du serveur, une URL ou un identifiant. Elles sont réduites à un code (`auth`, `host_not_found`, `timeout`, `tls`…) et à une phrase en français écrite par Alfred ; c'est tout ce qui part vers le navigateur, l'état de la synchro et les journaux.

### Chiffrement des mots de passe, et sa limite

Les mots de passe enregistrés dans l'app sont chiffrés en base : AES-256-GCM (`node:crypto`), un nonce aléatoire par valeur, et le nom du champ en données authentifiées (un chiffré recopié dans un autre champ ne s'ouvre pas). La clé de 32 octets vient de la variable `ALFRED_SECRET_KEY` si elle est définie ; sinon d'un fichier `secret.key` créé au premier mot de passe enregistré dans le dossier de données (mode 600, écrit à part puis lié sous son nom : jamais à moitié écrit, jamais écrasé). La clé n'est ni journalisée ni renvoyée par l'API.

**Ce que ce chiffrement protège, honnêtement.** Par défaut, la clé vit à côté de la base, dans le même volume. Le chiffrement protège donc contre une fuite de la base seule : une copie de `alfred.db`, une sauvegarde partielle, un export envoyé pour dépannage. Il ne protège pas contre quelqu'un qui a tout le volume (ou un accès au serveur) : il a la base et la clé. Définir `ALFRED_SECRET_KEY` dans le `.env` sépare la clé du volume de données, ce qui aide si le volume fuit sans le `.env`, mais pas contre un accès complet au serveur. C'est le même niveau de protection qu'avant pour quelqu'un qui lit le `.env`, et un mieux pour la base isolée.

**Clé absente ou différente** (volume restauré sans `secret.key`, variable modifiée) : l'app démarre normalement, le mot de passe concerné compte comme non configuré (pas de repli silencieux sur celui du `.env`, peut-être périmé), et l'écran Réglages demande de le ressaisir. Une ressaisie crée une nouvelle clé si besoin.

## La prise de rendez-vous (v1.1)

Une page publique laisse un client choisir un type de rendez-vous puis un créneau libre ; la réservation crée l'événement dans le calendrier d'Antoine (donc dans iCloud) et envoie les e-mails. La description complète de l'API est dans [API-RDV.md](API-RDV.md).

- **Fermée par défaut.** Rien n'est réservable tant qu'Antoine n'a pas activé la prise de rendez-vous dans les réglages.
- **Créneaux.** Calculés sur la copie locale : horaires hebdomadaires, pas de 15, 30 ou 60 minutes, durée et tampons du type, préavis, horizon. Tout se raisonne en heure murale de `Europe/Zurich`, jour par jour, puis chaque créneau est converti en instant : les changements d'heure ne décalent rien. Bloquent : les occurrences des calendriers marqués « bloque les créneaux » (même masqués) et les réservations déjà enregistrées. Ne bloquent pas : les événements « disponible » (`TRANSP:TRANSPARENT`) et annulés.
- **Journées entières.** Apple Calendar marque « disponible » les journées entières qu'il crée, congés compris (à confirmer sur les vrais événements d'Antoine : `SELECT ics FROM events WHERE ics LIKE '%VALUE=DATE%' LIMIT 5`). Par défaut, une journée entière bloque donc toute la journée quelle que soit cette marque ; le réglage se décoche dans Rendez-vous > Horaires.
- **Coût du calcul.** L'occupation de l'agenda est développée une seule fois pour toute la période réservable, puis gardée en mémoire tant que l'agenda ne change pas (toute écriture d'événement l'invalide, synchro comprise). Les événements simples sont lus depuis une colonne (`events.busy`), sans relire leur iCalendar ; les séries quotidiennes et hebdomadaires reprennent près de la période demandée au lieu d'être reparcourues depuis leur début. Une demande de créneaux coûte ainsi quelques millisecondes ; elle est limitée à 42 jours, à 30 demandes par minute et par adresse IP, et à 600 par minute au total.
- **Réservation.** Validation stricte, synchro iCloud fraîche (au mieux, 4 s au plus), puis section critique en mémoire (un seul processus) où tout est relu : réglages, type (supprimé, désactivé ou modifié entre-temps), disponibilité, plafonds. Puis `CalendarService.create` et enregistrement. Deux demandes simultanées pour le même créneau : une seule réussit. Si le serveur de calendrier enregistre l'événement sans que sa réponse arrive, l'événement est retiré (il se retrouve par son UID, choisi avant l'appel).
- **Annulation.** Lien `/rdv/annulation/<jeton>` (32 octets aléatoires ; seule l'empreinte SHA-256 est en base), ou depuis l'admin. L'événement est retiré par `CalendarService.remove`, en tolérant qu'il ait déjà disparu.
- **E-mails.** SMTP (Infomaniak par défaut, réglable dans l'app) avec nodemailer, chargé au premier envoi seulement. Confirmation au client avec pièce jointe `.ics` (`METHOD:PUBLISH`, pas une invitation), avis à Antoine. Un échec d'envoi ne remet jamais en cause la réservation : il est journalisé et affiché dans l'admin. La réponse au client n'attend pas les envois plus de 8 secondes : au-delà, ils se poursuivent en arrière-plan et leur résultat est noté sur la réservation. Sans SMTP configuré, tout fonctionne sauf l'envoi.
- **Abus du formulaire.** L'adresse saisie n'est pas vérifiée avant l'envoi (pas de double confirmation en v1.1). Pour que le formulaire ne serve pas à inonder un tiers d'e-mails : 3 réservations créées au plus par adresse e-mail sur 24 heures (annulations comprises), 5 réservations abouties par heure et par adresse IP (IPv6 regroupée en /56), 60 par heure au total, pas d'e-mail au client qui annule dans le quart d'heure suivant sa réservation, 200 e-mails sortants au plus par 24 heures (compteur en mémoire, signalé dans l'admin quand il est atteint), et un nom limité à ce qu'est un nom (ni lien ni domaine).
- **Événement supprimé dans Apple Calendar.** Après la synchro, la réservation apparaît comme « événement supprimé » dans l'admin et reste confirmée (le créneau reste pris). Pas d'e-mail automatique en v1.1 : Antoine annule la réservation depuis l'admin pour prévenir le client et libérer le créneau.
- **Événement déplacé ou changé de calendrier.** La réservation retient l'UID iCalendar de son événement : changé de calendrier (dans Alfred ou dans Apple Calendar), il est retrouvé et l'annulation le retire. Déplacé dans le temps, la réservation suit : l'ancien créneau est libéré, le nouveau est protégé avec ses tampons, et la page d'annulation du client montre le nouvel horaire. Le client n'est pas prévenu automatiquement : l'admin signale « déplacé » avec l'horaire qu'il a reçu, et « Renvoyer l'e-mail » lui annonce le nouveau.
- **Interface.** La même page sert deux apps, chargées à la demande (`web/src/main.tsx`) : sous `/rdv`, `/rdv/<type>` et `/rdv/annulation/<jeton>`, la page publique, qui n'appelle que `/api/public/booking/*`, ne télécharge pas l'app privée et n'enregistre pas de service worker ; partout ailleurs, l'app privée, dont l'écran « Rendez-vous » (interrupteur d'ouverture, lien public, réservations, types, horaires, réglages, e-mails) n'est chargé qu'à l'ouverture. Les heures sont toujours affichées dans le fuseau annoncé par le serveur, pas dans celui du navigateur. Le service worker ne touche ni à l'API ni aux pages `/rdv`.
- **Données.** Tables `booking_settings`, `booking_types`, `booking_hours`, `bookings`, `connection_settings`, et les colonnes `calendars.blocks_booking` et `events.busy`, créées par une migration idempotente à l'ouverture de la base. Contrairement aux événements, ces données ne reviennent pas d'iCloud : la base est à sauvegarder (voir [DEPLOIEMENT.md](DEPLOIEMENT.md)).

## Sécurité

- Un seul utilisateur. Mot de passe stocké sous forme d'empreinte scrypt, session par cookie `HttpOnly`, `Secure`, `SameSite=Lax`, blocage après cinq essais ratés.
- Protection CSRF, en-têtes de sécurité et politique CSP stricte.
- Partie publique (`/api/public/booking/*`) : aucune session, aucun détail d'événement (seulement des débuts de créneaux libres), limitation de débit par adresse IP en mémoire bornée (dernier élément de `X-Forwarded-For`, posé par Caddy ; IPv6 comptée par /56), plafonds par adresse e-mail et d'e-mails sortants, champ piège anti-robot, corps limité à 16 Ko, mêmes réponses pour un jeton inconnu ou déjà utilisé, refus des écritures venues d'un autre site. Tout contenu saisi est échappé dans les e-mails et ne peut pas couper un en-tête.
- Le mot de passe d'application iCloud et celui de la boîte d'envoi vivent dans le `.env` du serveur ou, s'ils ont été saisis dans l'app, chiffrés dans la base (voir « Chiffrement des mots de passe, et sa limite »). Aucune route ne les renvoie, même en partie : l'API dit seulement s'ils sont configurés et d'où ils viennent. Le mot de passe d'application iCloud ne donne accès qu'aux données iCloud accessibles aux apps et se révoque en un clic chez Apple.
- Connexions (`/api/connections/*`) : session obligatoire, protection CSRF commune plus refus des écritures venues d'un autre site, corps limités à 8 Ko, validation stricte (aucun retour à la ligne, longueurs bornées, messages d'erreur qui ne répètent jamais la saisie), 10 essais de connexion par 10 minutes.
- Requêtes vers le réseau interne (SSRF). Un serveur saisi dans l'app est contacté depuis le VPS, qui voit le réseau Docker et ses conteneurs voisins. Même pour le propriétaire connecté, donc pour une session volée, sont refusés : les adresses de bouclage, lien-local, privées et réservées (IPv4 et IPv6, y compris les IPv4 portées par une IPv6), les noms courts ou locaux, les écritures numériques exotiques, et les noms publics qui résolvent vers ces adresses. Pour le SMTP, le nom est résolu et vérifié à chaque envoi et la connexion se fait vers l'adresse vérifiée (le certificat reste contrôlé pour le nom). Pour le CalDAV, chaque requête et chaque redirection sont vérifiées (https obligatoire, identifiants non transmis à un autre hôte). Les valeurs du `.env`, posées par l'administrateur du serveur, ne passent pas par ce filtre. `ALFRED_ALLOW_PRIVATE_HOSTS=1` le lève pour le développement (tests contre Radicale et un faux SMTP) : à ne jamais activer sur le VPS.
- Limite connue du filtre CalDAV : la vérification précède la connexion, et `fetch` résout ensuite le nom lui-même. Un DNS qui changerait de réponse entre les deux (« rebinding ») pourrait en théorie passer ; il faudrait pour cela une session volée, une première configuration (le changement de serveur est refusé dès qu'un compte est en place) et un domaine contrôlé par l'attaquant. Le SMTP n'a pas cette fenêtre.

## Limites connues de la v1

- La fenêtre d'édition propose les répétitions simples (jour, semaine, mois, an). Les règles plus complexes créées dans Apple Calendar sont affichées correctement et conservées, mais ne se modifient pas depuis Alfred.
- Décaler toute une série supprime les exceptions de cette série (occurrences déplacées ou supprimées une à une).
- Pas de gestion des invités ni des alarmes dans l'interface (ils sont conservés).
- Changer de compte iCloud (un autre identifiant Apple) ne se fait pas depuis l'app ; déconnecter iCloud non plus.
- Hors ligne, l'app s'ouvre mais n'affiche pas les événements.
- Fuseaux pris en charge pour l'écriture : Europe centrale.

## Comment la suite s'y branche

- **Visio (v2).** LiveKit tourne dans son propre conteneur. Alfred ne fait que délivrer des jetons d'accès et rattacher une salle à un événement (lien dans le champ lieu ou la description, visible aussi dans Apple Calendar).
- **Apps Mac et mobile.** L'app web est déjà une PWA. Tauri (Mac) et Capacitor (iOS, Android) emballeront le même code.
- **Agent IA.** L'API JSON est le point d'entrée : lire l'agenda, créer et déplacer des événements.
