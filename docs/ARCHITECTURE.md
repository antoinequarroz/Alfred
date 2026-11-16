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

## Sécurité

- Un seul utilisateur. Mot de passe stocké sous forme d'empreinte scrypt, session par cookie `HttpOnly`, `Secure`, `SameSite=Lax`, blocage après cinq essais ratés.
- Protection CSRF, en-têtes de sécurité et politique CSP stricte.
- Le mot de passe d'application iCloud ne vit que dans le `.env` du serveur. Il ne donne accès qu'aux données iCloud accessibles aux apps et se révoque en un clic chez Apple.

## Limites connues de la v1

- La fenêtre d'édition propose les répétitions simples (jour, semaine, mois, an). Les règles plus complexes créées dans Apple Calendar sont affichées correctement et conservées, mais ne se modifient pas depuis Alfred.
- Décaler toute une série supprime les exceptions de cette série (occurrences déplacées ou supprimées une à une).
- Pas de gestion des invités ni des alarmes dans l'interface (ils sont conservés).
- Hors ligne, l'app s'ouvre mais n'affiche pas les événements.
- Fuseaux pris en charge pour l'écriture : Europe centrale.

## Comment la suite s'y branche

- **Prise de RDV (v1.1).** Les disponibilités se calculent sur la copie locale (`Store.occurrences`), déjà à jour avec tous les calendriers. Une réservation appelle `CalendarService.create`, donc l'événement part dans iCloud comme n'importe quel autre. Il reste à ajouter : types de RDV, page publique, envoi d'e-mails (SMTP Infomaniak, depuis info@antoinequarroz.ch).
- **Visio (v2).** LiveKit tourne dans son propre conteneur. Alfred ne fait que délivrer des jetons d'accès et rattacher une salle à un événement (lien dans le champ lieu ou la description, visible aussi dans Apple Calendar).
- **Apps Mac et mobile.** L'app web est déjà une PWA. Tauri (Mac) et Capacitor (iOS, Android) emballeront le même code.
- **Agent IA.** L'API JSON est le point d'entrée : lire l'agenda, créer et déplacer des événements.
