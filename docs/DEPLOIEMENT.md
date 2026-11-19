# Déployer Alfred sur le VPS

Alfred tourne dans un seul conteneur, limité à 256 Mo de RAM, derrière le Caddy déjà en place. Rien d'autre n'est modifié sur le serveur, à part un bloc ajouté au Caddyfile.

## 1. Avant de commencer

1. **DNS** : créer un enregistrement `A` pour `alfred.postmelo.ch` vers l'IP du VPS.
2. **Mot de passe d'application iCloud** : sur [account.apple.com](https://account.apple.com) > Connexion et sécurité > Mots de passe pour les apps, en créer un nommé « Alfred ». Il a la forme `abcd-efgh-ijkl-mnop`.
3. **Mot de passe d'Alfred** : en choisir un long, puis générer son empreinte :

   ```bash
   npm run hash-password -- "mon mot de passe très long"
   ```

   La commande affiche une ligne `ALFRED_PASSWORD_HASH=scrypt:…` à copier telle quelle dans le `.env`.

## 2. Installation

Le Terminal ne sert qu'à cette première installation : ensuite, l'envoi des e-mails et le mot de passe d'application iCloud se règlent dans l'app (voir « Régler les connexions dans l'app »).

Le plus simple, une fois le code dans `/opt/alfred` : `bash /opt/alfred/deploy/configurer.sh`. Le script demande l'identifiant Apple, le mot de passe d'application, le mot de passe d'Alfred et, si tu le veux, l'identifiant et le mot de passe SMTP pour les e-mails de la prise de rendez-vous (saisies masquées, Entrée pour passer), écrit le `.env` en `chmod 600` et démarre le conteneur. Il peut être relancé à tout moment : si un `.env` existe, il propose de garder les secrets déjà enregistrés, sans les afficher ni les redemander, et conserve les autres lignes du fichier. À la main, ça donne :

```bash
git clone https://github.com/antoinequarroz/alfred.git /opt/alfred
cd /opt/alfred
cp .env.example .env
nano .env        # ALFRED_PASSWORD_HASH, CALDAV_USERNAME (identifiant Apple), CALDAV_PASSWORD
chmod 600 .env
docker compose -f deploy/docker-compose.yml up -d --build
```

Le fichier compose relie le conteneur au réseau Docker de Caddy (`antoinequarroz-vitrine_appnet` par défaut, modifiable avec la variable `CADDY_NETWORK`).

Vérifier :

```bash
curl http://127.0.0.1:3200/healthz          # {"ok":true}
docker logs alfred --tail 20                # « synchro CalDAV toutes les 120 s »
```

### Régler les connexions dans l'app

Plus besoin du Terminal pour ces deux réglages. Une valeur enregistrée dans l'app passe avant celle du `.env`, et l'app indique pour chaque réglage d'où il vient (app, fichier `.env`, valeur par défaut). Rien ne redémarre.

**Conséquence à retenir :** dès qu'un mot de passe (iCloud ou boîte d'envoi) a été enregistré dans l'app, c'est là qu'il se change ensuite. Relancer `configurer.sh` ou modifier le `.env` ne le remplace pas : la valeur de l'app masque celle du `.env`. Le script le rappelle, et Alfred l'écrit dans ses journaux au démarrage (« … du fichier .env sont ignorés »).

- **E-mails de la prise de rendez-vous** : rubrique **Rendez-vous**, onglet **Réglages**, carte « E-mails » (le bandeau « L'envoi d'e-mails n'est pas configuré » y mène). Saisir l'identifiant (l'adresse complète de la boîte, par exemple `info@antoinequarroz.ch`) et le mot de passe (celui de la boîte, ou un mot de passe d'application Infomaniak si la double authentification est active), puis **Enregistrer et tester** : un e-mail d'essai part à l'adresse des avis, et le résultat s'affiche en clair (identifiants refusés, hôte introuvable, délai dépassé…). Le serveur (`mail.infomaniak.com`), le port (`587`) et l'expéditeur ont de bonnes valeurs par défaut. Si tu changes le serveur ou le port, le mot de passe est à ressaisir en même temps : celui qui est enregistré n'est jamais envoyé à un autre serveur. Si l'essai échoue, l'en-tête de la rubrique Rendez-vous le rappelle tant qu'un essai n'a pas réussi.
- **Mot de passe d'application iCloud** : **Réglages** dans la barre latérale, carte « Calendrier iCloud ». Créer un nouveau mot de passe sur [account.apple.com](https://account.apple.com) > Connexion et sécurité > Mots de passe pour les apps, le coller, puis **Tester et enregistrer**. Alfred essaie la connexion avant d'enregistrer : si l'essai échoue, rien ne change et la synchro continue avec l'ancien. On y voit aussi l'état de la synchro, le nombre de calendriers et d'événements, et un bouton « Synchroniser ».
- **Ce qui reste hors de l'app** : changer de compte iCloud (un autre identifiant Apple), le mot de passe d'Alfred, l'adresse publique. « Revenir au fichier .env » retire les réglages de l'app ; pour les e-mails, quand le `.env` ne contient pas d'identifiants d'envoi (cas d'une installation réglée dans l'app), le bouton s'appelle « Supprimer la configuration d'envoi » : plus aucun e-mail ne part ensuite.

Les mots de passe saisis dans l'app sont chiffrés dans la base et ne sont plus jamais affichés. La clé de chiffrement est le fichier `secret.key` du volume de données (ou la variable facultative `ALFRED_SECRET_KEY`, voir `.env.example`) ; les limites de cette protection sont décrites dans [ARCHITECTURE.md](ARCHITECTURE.md).

### E-mails par le fichier `.env` (facultatif)

Le SMTP peut toujours se régler par le `.env`, par exemple avec `bash /opt/alfred/deploy/configurer.sh`, qui reconstruit l'image, garde les secrets existants et demande l'identifiant SMTP et son mot de passe, en masqué. À la main :

```bash
SMTP_HOST=mail.infomaniak.com
SMTP_PORT=587                 # STARTTLS ; 465 = TLS implicite
SMTP_USER=info@antoinequarroz.ch
SMTP_PASSWORD=…               # mot de passe de la boîte, ou mot de passe d'application Infomaniak
MAIL_FROM="Antoine Quarroz <info@antoinequarroz.ch>"
MAIL_NOTIFY_TO=               # qui reçoit les avis (défaut : l'adresse de MAIL_FROM)
ALFRED_PUBLIC_URL=https://alfred.postmelo.ch
```

Puis `docker compose -f deploy/docker-compose.yml up -d --build`. Sans identifiants, ni dans l'app ni dans le `.env`, la prise de rendez-vous fonctionne mais n'envoie aucun e-mail (un avertissement s'affiche dans l'admin, avec un lien vers le formulaire).

### Ouvrir la prise de rendez-vous

Tout se règle dans Alfred, rubrique **Rendez-vous** de la barre latérale :

1. **Types** : créer au moins un type (nom, durée, lieu, délais).
2. **Horaires** : vérifier les plages hebdomadaires et les calendriers qui bloquent les créneaux.
3. **Réglages** : nom affiché, texte d'accueil, calendrier où créer les rendez-vous ; la carte « E-mails » règle le SMTP et « Envoyer un e-mail d'essai » le vérifie.
4. Basculer l'interrupteur « Ouvrir la prise de rendez-vous », puis copier le lien public (`https://alfred.postmelo.ch/rdv`).

La page publique reste fermée tant que l'interrupteur n'est pas activé. Un lien direct vers un type existe aussi : `/rdv/<identifiant>`.

### Se connecter avec le Compte Postmelo (facultatif)

Alfred peut s'ouvrir avec le Compte Postmelo (`https://compte.postmelo.ch`), comme Lamio. Le mot de passe d'Alfred reste un secours.

1. Créer un secret : `openssl rand -base64 32`.
2. Dans le `.env` du service de compte (`~/compte/.env`), puis redémarrer le conteneur `compte` :

   ```env
   ALFRED_URL=https://alfred.antoinequarroz.ch
   ALFRED_CLIENT_SECRET=<le secret>
   ```

3. Dans le `.env` d'Alfred, puis `docker compose -f deploy/docker-compose.yml up -d` :

   ```env
   COMPTE_URL=https://compte.postmelo.ch
   COMPTE_CLIENT_SECRET=<le même secret>
   ```

`ALFRED_URL` côté compte doit être exactement `ALFRED_PUBLIC_URL` côté Alfred : le retour se fait sur `<adresse>/api/auth/compte/callback`. Au démarrage, Alfred écrit « connexion par le Compte Postmelo active » dans ses journaux.

C'est le service de compte qui décide qui entre : les administrateurs toujours, les membres seulement si Alfred leur est ouvert (Compte Postmelo > Personnes et accès). Alfred n'a qu'un seul espace : une personne qui entre voit tout le calendrier et les réglages.

Retour en arrière : vider les deux lignes d'Alfred et relancer. Se déconnecter d'Alfred ne ferme pas la session du compte.

## 3. Exposer en HTTPS

Ajouter le contenu de [`deploy/Caddyfile.snippet`](../deploy/Caddyfile.snippet) au Caddyfile existant, puis recharger Caddy :

```bash
docker exec antoinequarroz-caddy caddy reload --config /etc/caddy/Caddyfile   # adapter le chemin si besoin
```

Ouvrir https://alfred.postmelo.ch et se connecter. Les calendriers iCloud apparaissent après la première synchro (quelques secondes à une minute selon le nombre d'événements).

### La visio

Le serveur de visio (LiveKit) est un second conteneur du même fichier compose, `alfred-livekit`, limité à 256 Mo et 1 cœur.

1. **Clés et démarrage** : `bash /opt/alfred/deploy/visio.sh`. Sans question : crée les clés partagées (dans `.env` et `.env.livekit`, lisibles par toi seul), relève l'adresse publique du VPS, démarre les deux conteneurs. Relançable.
2. **Pare-feu** : ouvrir l'audio et la vidéo, `sudo ufw allow 7882/udp` et `sudo ufw allow 7881/tcp`. Rien d'autre n'est exposé.
3. **Caddy** : dans le bloc `alfred.postmelo.ch`, envoyer `/rtc*` vers `alfred-livekit:7880` (voir [`deploy/Caddyfile.snippet`](../deploy/Caddyfile.snippet)). Sauvegarder le Caddyfile avant, valider (`caddy validate`), puis recharger.
4. **Vérifier** : Alfred > Réglages > Visioconférence affiche « Serveur de visio en ligne ». Rubrique Visio > « Nouvelle visio », puis ouvrir le lien depuis un téléphone en 4G.

Tout le reste (activer, nombre de participants, qualité) se règle dans l'app. Pour arrêter la visio sans toucher à Alfred : `docker stop alfred-livekit` (les liens répondent « indisponible »).

#### Relais pour les réseaux filtrés (TURN sur le port 443) et tampons UDP

Un invité dont le réseau (entreprise, hôtel, hôpital) ne laisse sortir que le web passe par le relais TURN intégré à LiveKit, joint en TLS sur `turn.postmelo.ch:443`. Le port 443 étant celui de Caddy, Caddy reçoit aussi le relais : son module layer4 reconnaît le nom `turn.postmelo.ch` avant le déchiffrement, garde le TLS (certificat Let's Encrypt comme les sites) et transmet le flux à `alfred-livekit:5349` avec un en-tête PROXY (adresse réelle de l'invité). Les autres connexions continuent vers les sites sans changement. Le coturn de Nino n'est pas utilisé.

```
 Navigateur ──TLS 443 (turn.postmelo.ch)──► Caddy + layer4 ──TCP + PROXY──► alfred-livekit:5349 (relais) ──► SFU
```

1. **DNS** (Infomaniak, zone `postmelo.ch`) : enregistrement A `turn` → adresse IPv4 du VPS (la même que `NODE_IP` dans `/opt/alfred/.env.livekit`).
2. **Déployer Alfred** depuis le Mac (`deploy/mac/deployer.sh`) : il apporte `deploy/livekit.yaml` (section `turn`), `deploy/caddy-l4/Dockerfile` et le script.
3. **Simulation** : `bash /opt/alfred/deploy/relais-visio.sh`. Vérifie le DNS, les sites et le Caddyfile, construit l'image `alfred-caddy-l4:2.10.2` (Caddy 2.10.2 identique + layer4, 4 à 6 minutes), valide la nouvelle configuration et montre les changements, sans rien toucher d'autre.
4. **Appliquer** : `bash /opt/alfred/deploy/relais-visio.sh --oui` (un seul lancement à la fois : un second est refusé). Tampons UDP (`/etc/sysctl.d/90-alfred-visio.conf`, 5 Mo), sauvegarde puis modification de `~/.config/antoinequarroz-vitrine/runtime/Caddyfile` (options globales en tête, bloc `turn.postmelo.ch` en fin) et `compose.runtime.yml` (image `alfred-caddy-l4:2.10.2`), recréation de Caddy (2 à 5 secondes de coupure pour tous les sites), contrôle des sites par l'adresse publique du VPS avec vérification du certificat, puis surveillance pendant une minute, avec retour automatique au moindre échec (journaux du Caddy refusé gardés dans `runtime/caddy-refuse-*.log`), puis `deploy/visio.sh` (appels en cours coupés).
5. **Retour** de Caddy si besoin : `bash /opt/alfred/deploy/relais-visio.sh --retour`.

À savoir :
- L'image Caddy est imposée par `compose.runtime.yml`, qui sert aussi aux déploiements du site : ils gardent donc Caddy avec layer4. Pour changer de version de Caddy plus tard, reconstruire l'image (`deploy/caddy-l4/Dockerfile`) avec la même version, sinon le relais disparaît et le Caddyfile n'est plus valide.
- Le port 5349 du conteneur n'est pas publié : seul Caddy l'atteint, et LiveKit n'accepte l'en-tête PROXY que des réseaux Docker (`172.16.0.0/12`). Rien de nouveau à ouvrir dans UFW.
- Les tampons UDP suppriment l'avertissement « UDP receive buffer is too small » de LiveKit (`docker logs alfred-livekit | grep buffer` doit rester vide après le redémarrage).
- Essai : sur un téléphone en Wi-Fi d'entreprise ou d'hôtel, ou en forçant le relais dans un navigateur, la visio doit se connecter. Dans Chrome, `chrome://webrtc-internals` montre alors une paire de candidats `relay` via `turns:turn.postmelo.ch:443`.

## 4. Installer l'app

- **Mac** : dans Safari, Fichier > Ajouter au Dock.
- **iPhone** : dans Safari, Partager > Sur l'écran d'accueil.

## 5. Au quotidien

| Besoin | Commande |
|---|---|
| Mettre à jour (depuis le Mac) | `bash deploy/mac/deployer.sh` : déploie le dernier commit de `main`, voir « Déployer depuis main » ci-dessous |
| Revenir à la version précédente | `bash deploy/mac/deployer.sh --retour` (ou sur le VPS : `bash deploy/mise-a-jour.sh --retour`) |
| Version en service | `ssh antoine-vps 'bash /opt/alfred/deploy/mise-a-jour.sh --etat'` |
| Mettre à jour la visio | après un déploiement qui touche LiveKit : `bash deploy/visio.sh` sur le VPS (coupe les appels en cours) |
| Voir les journaux | `docker logs alfred --tail 100` |
| Sauvegarder la base et la clé (en plus de la sauvegarde quotidienne) | `bash deploy/sauvegarde.sh` |
| Vérifier que la dernière sauvegarde se restaure | `bash deploy/restaurer.sh --essai` |
| Arrêter | `docker compose -f deploy/docker-compose.yml down` |

**La base est à sauvegarder.** Les événements ne sont qu'une copie (la référence reste iCloud) et reviennent tout seuls à la synchro suivante, mais depuis la prise de rendez-vous la base porte aussi ce qui n'existe nulle part ailleurs : les réglages, les types, les horaires et surtout les réservations (coordonnées des clients, empreintes des liens d'annulation). Si le volume est perdu, la prise de rendez-vous se referme, les types et les horaires sont à refaire, la rubrique Rendez-vous ne liste plus aucune réservation et les liens d'annulation déjà envoyés répondent « ce lien n'est plus valable ».

La commande du tableau copie tout le dossier `/data` : la base et ses fichiers `-wal` et `-shm`, à garder ensemble, et le fichier de clé `secret.key` s'il existe (il apparaît au premier mot de passe enregistré dans l'app). **La clé est à sauvegarder avec la base** : sans elle, la base restaurée fonctionne, mais les mots de passe enregistrés dans l'app (boîte d'envoi, iCloud) ne se déchiffrent plus et sont à ressaisir dans Réglages ; rien d'autre n'est perdu. La copie contient donc de quoi déchiffrer ces mots de passe : la garder dans un dossier réservé (`chmod 700`). Si la clé est fournie par `ALFRED_SECRET_KEY`, c'est le `.env` qu'il faut sauvegarder avec la base. ### Déployer depuis main

`/opt/alfred` n'est pas un dépôt git : on y copie une version précise de `main`, jamais le dossier de travail du Mac. Depuis le clone du Mac :

```bash
bash deploy/mac/deployer.sh --simuler        # montre ce qui changerait sur le VPS, sans rien toucher
bash deploy/mac/deployer.sh                  # déploie le dernier commit de origin/main (demande confirmation)
bash deploy/mac/deployer.sh 47e8711          # déploie un commit précis de main
bash deploy/mac/deployer.sh --retour         # remet la version précédente
```

Ce que fait [`deploy/mac/deployer.sh`](../deploy/mac/deployer.sh) :

1. `git fetch`, puis refuse tout commit qui n'est pas sur `main` ;
2. exporte ce commit avec `git archive` (seulement les fichiers suivis : rien de non commité, aucun secret local), et y ajoute un fichier `VERSION` ;
3. montre la copie à blanc (`rsync -n`) et demande confirmation (`--oui` pour s'en passer) ;
4. sur le VPS, [`deploy/mise-a-jour.sh --preparer`](../deploy/mise-a-jour.sh) : sauvegarde des données (`sauvegarde.sh`) et image de retour `alfred:retour-<version>` ;
5. copie le code dans `/opt/alfred` (avec `--delete` : les fichiers retirés du dépôt disparaissent ; jamais touchés : `.env*`, `data/`, `node_modules/`, `dist/`) ;
6. `mise-a-jour.sh` reconstruit le conteneur `alfred` seul (LiveKit et les appels en cours ne sont pas touchés), attend qu'il soit « healthy » (`/healthz`, 2 minutes au plus) et, sinon, remet automatiquement l'image de retour.

Les 3 images de retour les plus récentes sont gardées, les plus anciennes retirées (seulement les `alfred:retour-*` ; les autres images ne sont jamais touchées). Le retour arrière remet le code précédent, pas les données : si une version a abîmé la base, restaurer en plus la sauvegarde faite juste avant (`deploy/restaurer.sh --vrai`, voir plus bas). Les migrations de la base ajoutent sans supprimer, donc l'image précédente tourne sur une base migrée.

### Sauvegardes automatiques

[`deploy/sauvegarde.sh`](../deploy/sauvegarde.sh) fait une archive `/opt/sauvegardes/alfred/alfred-AAAA-MM-JJ_HHMM.tar.gz` (mode 600, dossier en 700) avec :

- `alfred.db` : copie cohérente de la base prise à chaud (`VACUUM INTO`), sans arrêter Alfred, vérifiée par `PRAGMA integrity_check` ;
- `secret.key` : la clé des mots de passe enregistrés dans l'app, s'il y en a une ;
- `env` et `env.livekit` : les fichiers `.env` d'`/opt/alfred` (empreinte du mot de passe, clés de la visio) ;
- `resume.txt` : le nombre de lignes de chaque table (RDV, types, événements…), pour voir d'un coup d'œil ce que contient la sauvegarde.

La copie se fait dans un conteneur jetable de l'image `alfred:latest` (sans réseau, 128 Mo, quelques secondes), que le conteneur `alfred` tourne ou non. L'archive pèse quelques Mo. On garde 14 jours, et toujours au moins les 3 dernières ; la sauvegarde s'annule s'il reste moins de 500 Mo sur le disque. Chaque passage est noté dans `/opt/sauvegardes/alfred/sauvegarde.log`, et la date du dernier succès dans `derniere-reussie`.

```bash
bash /opt/alfred/deploy/sauvegarde.sh --installer     # tâche quotidienne (cron de l'utilisateur, 3 h 17) + première sauvegarde
bash /opt/alfred/deploy/sauvegarde.sh                 # sauvegarde immédiate, par exemple avant une mise à jour
bash /opt/alfred/deploy/sauvegarde.sh --desinstaller  # retire la tâche, garde les archives
```

**Copie sur le Mac.** Les archives du VPS protègent d'une erreur ou d'une mise à jour ratée, pas de la perte du serveur. [`deploy/mac/rapatrier-sauvegardes.sh`](../deploy/mac/rapatrier-sauvegardes.sh) les copie chaque jour sur le Mac, dans `~/Sauvegardes/Alfred` (gardées 90 jours, au moins les 7 dernières). Il passe par `ssh antoine-vps` (la clé SSH du Mac, sans mot de passe à taper) et ne supprime rien sur le VPS. Si le VPS ne répond pas ou si la dernière sauvegarde a plus de 2 jours, une notification macOS s'affiche. Journal : `~/Sauvegardes/Alfred/rapatriement.log`.

```bash
bash deploy/mac/rapatrier-sauvegardes.sh --installer     # sur le Mac : tâche launchd chaque jour à 9 h (rattrapée au réveil) + script copié dans ~/Library/Application Support/Alfred
bash deploy/mac/rapatrier-sauvegardes.sh                 # copie immédiate
bash deploy/mac/rapatrier-sauvegardes.sh --desinstaller  # retire la tâche, garde les copies
```

Les archives contiennent la clé de déchiffrement des mots de passe enregistrés dans l'app : le dossier est en 700 et les fichiers en 600. Un stockage objet suisse (Infomaniak Swiss Backup, ~1 à 3 €/mois) reste possible plus tard si le Mac ne suffit pas.

### Restaurer

```bash
bash /opt/alfred/deploy/restaurer.sh --essai                      # essai à blanc sur la dernière archive
bash /opt/alfred/deploy/restaurer.sh --essai /opt/sauvegardes/alfred/alfred-AAAA-MM-JJ_HHMM.tar.gz
bash /opt/alfred/deploy/restaurer.sh --vrai  /opt/sauvegardes/alfred/alfred-AAAA-MM-JJ_HHMM.tar.gz
```

`--essai` ne touche pas à Alfred en service : il démarre une copie d'Alfred (conteneur `alfred-essai-restauration`, sans réseau, donc ni synchro iCloud ni e-mail) sur les données de l'archive, attend qu'elle réponde sur `/healthz`, affiche ce qu'elle contient, puis l'efface avec son volume. À lancer de temps en temps, et après chaque changement de version.

`--vrai` fait d'abord une sauvegarde de l'état actuel, arrête le conteneur `alfred`, remplace la base et la clé du volume par celles de l'archive (avec les droits de l'utilisateur `node`), puis redémarre Alfred. Les `.env` ne sont pas remplacés (ceux de l'archive sont dans `env` et `env.livekit` si besoin). Ensuite, ouvrir Réglages : aucun message « à ressaisir » ne doit apparaître, et la synchro doit repartir.

## Dépannage

- **« Synchro iCloud en échec »** dans la barre latérale : le diagnostic est affiché dessous, avec un lien vers Réglages. Le plus souvent, « Identifiants refusés » : le mot de passe d'application a été révoqué ou mal recopié ; en créer un nouveau chez Apple et le coller dans Réglages > Calendrier iCloud.
- **« Mot de passe à ressaisir »** dans Réglages : la base a été restaurée sans son fichier `secret.key` (ou `ALFRED_SECRET_KEY` a changé). Ressaisir le mot de passe concerné suffit. Variante « le serveur a changé » : le serveur d'envoi ou son port n'est plus celui pour lequel le mot de passe avait été saisi ; le ressaisir suffit aussi.
- **« Alfred n'a pas le droit de lire le fichier de clé »**, ou « Impossible de chiffrer le mot de passe » : les fichiers du volume appartiennent à root, typiquement après une restauration par `docker cp` sans l'étape `chown`. Rejouer la restauration avec `bash deploy/restaurer.sh --vrai <archive>`, qui remet les bons droits, ou : `docker run --rm --volumes-from alfred -u 0 --entrypoint sh alfred:latest -c "chown -R node:node /data && chmod 700 /data"` puis `docker restart alfred`.
- **Le nouveau mot de passe saisi dans `configurer.sh` n'a aucun effet** : un mot de passe enregistré dans l'app passe avant le `.env`. Le changer dans l'app (Réglages pour iCloud, Rendez-vous > Réglages pour les e-mails).
- **Un serveur refusé comme « adresse interne ou privée »** : c'est voulu, Alfred ne se connecte pas au réseau interne du VPS pour un serveur saisi dans l'app. Un serveur interne légitime se déclare dans le `.env`.
- **Connexion refusée en boucle** : vérifier que `ALFRED_PASSWORD_HASH` commence par `scrypt:` et tient sur une seule ligne dans le `.env`.
- **Trop d'essais** : le blocage se lève après 15 minutes, ou tout de suite avec `docker restart alfred`.

## Changer de domaine

Alfred est passé de `alfred.antoinequarroz.ch` à `alfred.postmelo.ch` le 17 novembre 2026. Pour refaire un tel changement :

1. **DNS** : un enregistrement `A` pour le nouveau nom vers l'IP du VPS (garder l'ancien).
2. **Caddy** : un bloc pour le nouveau nom (copie de l'ancien, `/rtc*` compris), et l'ancien bloc remplacé par une redirection permanente (`redir https://<nouveau>{uri} permanent`), pour que les liens déjà envoyés (gestion de rendez-vous, visios) continuent de marcher. Voir [`deploy/Caddyfile.snippet`](../deploy/Caddyfile.snippet).
3. **Alfred** : `ALFRED_PUBLIC_URL` dans `/opt/alfred/.env` (et `LIVEKIT_PUBLIC_URL` s'il est renseigné), puis redémarrer le conteneur `alfred`. Les nouveaux e-mails et liens de visio prennent la nouvelle adresse.
4. **Ce qui ne bouge pas** : les UID des fichiers `.ics` envoyés aux clients (`BOOKING_UID_DOMAIN` dans `server/booking/mail.ts`) restent sur l'ancien domaine, sinon un déplacement ou une annulation créerait un doublon dans leur calendrier.
5. **Apps installées** : l'app iPhone/Mac et ses notifications sont liées à l'adresse. Il faut se reconnecter, réinstaller l'app depuis la nouvelle adresse et réactiver les notifications.
