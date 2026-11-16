# Phase 1 — Prise de RDV en ligne synchronisée avec iCloud

Objectif : quand quelqu'un réserve en ligne, le RDV s'écrit **tout seul** dans ton Apple Calendar (iCloud), et tes créneaux déjà occupés ne sont plus proposés. Plus de recopie à la main.

Outil : [Cal.com](https://cal.com) auto-hébergé (open source), dans `deploy/calcom/`.

## Ce qui est installé

| Élément | Rôle | Mémoire max |
|---|---|---|
| `alfred-calcom` | L'application de prise de RDV | 1 Go |
| `alfred-calcom-db` | Sa base PostgreSQL dédiée | 256 Mo |

Garde-fous pour ton VPS (2 vCPU, 3,8 Go, ~40 conteneurs déjà en production) :

- **Rien d'existant n'est modifié** : réseau Docker, volume et base dédiés. Le seul ajout hors du dossier est un bloc dans le Caddyfile.
- **Limites mémoire strictes, sans swap** : si Cal.com déborde, c'est lui qui redémarre, pas Postmelo ni Supabase.
- **Aucun port public** : Cal.com écoute seulement sur `127.0.0.1:3100`, Caddy fait le HTTPS.
- **Pas de visio ni de Redis** pour l'instant : la visio attend l'agrandissement du VPS.

Le VPS a environ 1,6 Go de mémoire disponible et Cal.com en prend jusqu'à 1,25 Go : ça passe, mais c'est juste. Surveille tes autres sites les premiers jours (voir « Surveiller »).

## Ce qu'il te faut avant de commencer

1. **Un sous-domaine**, par exemple `rdv.tondomaine.ch`, avec un enregistrement DNS `A` vers l'IP du VPS (manager Infomaniak).
2. **Une boîte e-mail d'envoi** (confirmations et rappels), par exemple `rdv@tondomaine.ch` chez Infomaniak : SMTP `mail.infomaniak.com`, port `587`.
3. **Un mot de passe d'application iCloud** : [account.apple.com](https://account.apple.com) → Connexion et sécurité → Mots de passe pour les apps → « + ». Nomme-le « Alfred ». Il ne donne pas accès à ton compte Apple complet et se révoque d'un clic.

## Installation (environ 30 minutes)

### 1. Récupérer la config sur le VPS

```bash
sudo mkdir -p /opt/alfred && sudo chown "$USER" /opt/alfred
git clone https://github.com/antoinequarroz/alfred.git /opt/alfred
cd /opt/alfred/deploy/calcom
cp .env.example .env && chmod 600 .env
```

### 2. Remplir `.env`

Génère les secrets :

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
echo "CALENDSO_ENCRYPTION_KEY=$(openssl rand -base64 24)"
echo "CRON_API_KEY=$(openssl rand -hex 16)"
```

Colle-les dans `.env` (`nano .env`), puis remplace partout `rdv.example.ch` par ton sous-domaine et renseigne le SMTP.

`CALENDSO_ENCRYPTION_KEY` chiffre ton mot de passe d'app iCloud dans la base. Note-la dans ton gestionnaire de mots de passe et ne la change plus.

### 3. Vérifier avant de lancer

```bash
bash scripts/preflight.sh
```

Le script ne modifie rien. Il vérifie la mémoire, le disque (compte 12 Go libres avant le premier téléchargement), le port, et te dit si ton Caddy tourne sur l'hôte ou dans Docker.

### 4. Démarrer

Caddy sur l'hôte (cas simple) :

```bash
docker compose up -d
```

Caddy dans Docker : renseigne `CADDY_NETWORK` dans `.env`, puis

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy-network.yml up -d
```

Le premier démarrage prend 3 à 5 minutes (téléchargement d'environ 1,7 Go, soit environ 8 Go sur le disque une fois décompressé, puis création des tables). Suis-le avec `docker compose logs -f calcom` jusqu'à voir `Ready`. Teste en local :

```bash
curl -sI http://127.0.0.1:3100 | head -1
```

### 5. Brancher Caddy

Ajoute le bloc de `Caddyfile.snippet` à la fin de ton Caddyfile, avec ton sous-domaine. Ne modifie aucun autre bloc. Fais une copie du fichier avant.

Caddy sur l'hôte :

```bash
caddy validate --config /etc/caddy/Caddyfile   # doit dire "Valid configuration"
sudo systemctl reload caddy                    # rechargement sans coupure des autres sites
```

Caddy dans Docker (cas de `vps-antoine` : conteneur `antoinequarroz-caddy`, réseau `antoinequarroz-vitrine_appnet`), avec `reverse_proxy alfred-calcom:3000` dans le bloc :

```bash
docker exec antoinequarroz-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec antoinequarroz-caddy caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
```

Valide toujours avant de recharger : un Caddyfile invalide est refusé au rechargement et tes sites continuent de tourner avec l'ancienne config.

### 6. Créer ton compte

Ouvre `https://rdv.tondomaine.ch`. Tu arrives sur l'assistant `/auth/setup` :

1. Crée ton compte administrateur (mot de passe fort, active la double authentification ensuite dans Paramètres → Sécurité).
2. À l'étape licence, choisis **AGPLv3** (gratuite).
3. Ignore l'étape des apps.

L'inscription publique est fermée par le bloc Caddy : personne d'autre ne peut créer de compte.

### 7. Connecter iCloud

Dans Cal.com : **Apps** → cherche **Apple Calendar** → Installer.

- Identifiant : ton identifiant Apple (e-mail)
- Mot de passe : le **mot de passe d'application** créé plus haut (pas ton mot de passe Apple)

Puis dans **Paramètres → Calendriers** :

- **Ajouter au calendrier** : choisis le calendrier iCloud où écrire les RDV (par exemple « Pro »).
- **Vérifier les conflits** : coche tous les calendriers qui doivent bloquer des créneaux (perso et pro).

### 8. Régler tes RDV

- **Paramètres → Général** : langue Français, fuseau `Europe/Zurich`, semaine commençant lundi.
- **Disponibilités** : tes horaires d'ouverture.
- **Types d'événements** : un par type de RDV (durée, lieu, questions). Dans l'onglet Limites, ajoute un tampon avant/après et un délai minimum de réservation (par exemple 12 h).
- Lieu du RDV : présentiel, téléphone, ou en attendant ta propre visio, l'app **Jitsi** de Cal.com qui crée un lien `meet.jit.si` gratuit sans rien installer sur le VPS.

### 9. Tester de bout en bout

1. Ouvre ta page publique en navigation privée et réserve un créneau avec une autre adresse e-mail.
2. Le RDV doit apparaître dans Apple Calendar (Mac et iPhone) en moins d'une minute.
3. Crée un événement directement dans Apple Calendar : le créneau doit disparaître de ta page de réservation.
4. Annule le RDV depuis l'e-mail de confirmation : il doit disparaître du calendrier.

### 10. Mettre le lien sur ton site

Remplace l'outil actuel par un lien vers `https://rdv.tondomaine.ch/ton-identifiant`, ou intègre le calendrier dans une page : dans Cal.com, sur un type d'événement, menu « … » → **Intégrer** donne le code à coller.

## Au quotidien

### Surveiller

```bash
docker stats --no-stream alfred-calcom alfred-calcom-db   # mémoire utilisée / limite
free -m                                                    # mémoire globale du VPS
docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}}' alfred-calcom
```

Si `alfred-calcom` redémarre en boucle par manque de mémoire, monte `CALCOM_MEM_LIMIT=1200m` et `CALCOM_NODE_HEAP_MB=768` dans `.env` (si le VPS a la marge), ou agrandis le VPS.

### Sauvegarder

```bash
bash scripts/backup.sh          # dans ~/backups/alfred-calcom, 14 jours conservés
```

À mettre en cron quotidien (`crontab -e`) :

```
15 3 * * * cd /opt/alfred/deploy/calcom && bash scripts/backup.sh >/dev/null
```

Les RDV eux-mêmes vivent aussi dans iCloud. La sauvegarde protège surtout tes réglages et l'historique.

### Mettre à jour

```bash
bash scripts/backup.sh
# change CALCOM_VERSION dans .env, puis :
docker compose pull calcom && docker compose up -d
```

### Tout arrêter ou désinstaller

```bash
docker compose stop            # arrêt, données conservées, mémoire libérée tout de suite
docker compose down            # supprime les conteneurs, garde les données
docker compose down -v         # supprime aussi la base (irréversible)
```

Retire ensuite le bloc `rdv…` du Caddyfile et recharge Caddy. Tes autres services ne sont pas concernés.

## Limites connues

- **Délai iCloud** : Apple ne prévient pas le serveur des changements. Cal.com relit ton calendrier au moment où quelqu'un ouvre la page, donc le risque de double réservation est très faible, sans être nul.
- **Accès iCloud non garanti par Apple** pour les outils tiers : si la synchro casse un jour, recrée un mot de passe d'app et reconnecte. La phase 2 (ton propre serveur CalDAV) supprime cette dépendance.
- **Rappels par e-mail programmés** (workflows) : les confirmations, annulations et reports partent immédiatement et fonctionnent. Les rappels « 24 h avant » demandent une tâche planifiée supplémentaire, à ajouter si tu en as besoin.
- **Visio maison (Jitsi auto-hébergé)** : après agrandissement du VPS.
