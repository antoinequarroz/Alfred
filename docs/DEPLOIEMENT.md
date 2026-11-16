# Déployer Alfred sur le VPS

Alfred tourne dans un seul conteneur, limité à 256 Mo de RAM, derrière le Caddy déjà en place. Rien d'autre n'est modifié sur le serveur, à part un bloc ajouté au Caddyfile.

## 1. Avant de commencer

1. **DNS** : créer un enregistrement `A` pour `alfred.antoinequarroz.ch` vers l'IP du VPS.
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
ALFRED_PUBLIC_URL=https://alfred.antoinequarroz.ch
```

Puis `docker compose -f deploy/docker-compose.yml up -d --build`. Sans identifiants, ni dans l'app ni dans le `.env`, la prise de rendez-vous fonctionne mais n'envoie aucun e-mail (un avertissement s'affiche dans l'admin, avec un lien vers le formulaire).

### Ouvrir la prise de rendez-vous

Tout se règle dans Alfred, rubrique **Rendez-vous** de la barre latérale :

1. **Types** : créer au moins un type (nom, durée, lieu, délais).
2. **Horaires** : vérifier les plages hebdomadaires et les calendriers qui bloquent les créneaux.
3. **Réglages** : nom affiché, texte d'accueil, calendrier où créer les rendez-vous ; la carte « E-mails » règle le SMTP et « Envoyer un e-mail d'essai » le vérifie.
4. Basculer l'interrupteur « Ouvrir la prise de rendez-vous », puis copier le lien public (`https://alfred.antoinequarroz.ch/rdv`).

La page publique reste fermée tant que l'interrupteur n'est pas activé. Un lien direct vers un type existe aussi : `/rdv/<identifiant>`.

## 3. Exposer en HTTPS

Ajouter le contenu de [`deploy/Caddyfile.snippet`](../deploy/Caddyfile.snippet) au Caddyfile existant, puis recharger Caddy :

```bash
docker exec antoinequarroz-caddy caddy reload --config /etc/caddy/Caddyfile   # adapter le chemin si besoin
```

Ouvrir https://alfred.antoinequarroz.ch et se connecter. Les calendriers iCloud apparaissent après la première synchro (quelques secondes à une minute selon le nombre d'événements).

## 4. Installer l'app

- **Mac** : dans Safari, Fichier > Ajouter au Dock.
- **iPhone** : dans Safari, Partager > Sur l'écran d'accueil.

## 5. Au quotidien

| Besoin | Commande |
|---|---|
| Mettre à jour | `cd /opt/alfred && git pull && docker compose -f deploy/docker-compose.yml up -d --build` |
| Voir les journaux | `docker logs alfred --tail 100` |
| Sauvegarder la base et la clé | `docker cp alfred:/data ./alfred-data-$(date +%F)` |
| Arrêter | `docker compose -f deploy/docker-compose.yml down` |

**La base est à sauvegarder.** Les événements ne sont qu'une copie (la référence reste iCloud) et reviennent tout seuls à la synchro suivante, mais depuis la prise de rendez-vous la base porte aussi ce qui n'existe nulle part ailleurs : les réglages, les types, les horaires et surtout les réservations (coordonnées des clients, empreintes des liens d'annulation). Si le volume est perdu, la prise de rendez-vous se referme, les types et les horaires sont à refaire, la rubrique Rendez-vous ne liste plus aucune réservation et les liens d'annulation déjà envoyés répondent « ce lien n'est plus valable ».

La commande du tableau copie tout le dossier `/data` : la base et ses fichiers `-wal` et `-shm`, à garder ensemble, et le fichier de clé `secret.key` s'il existe (il apparaît au premier mot de passe enregistré dans l'app). **La clé est à sauvegarder avec la base** : sans elle, la base restaurée fonctionne, mais les mots de passe enregistrés dans l'app (boîte d'envoi, iCloud) ne se déchiffrent plus et sont à ressaisir dans Réglages ; rien d'autre n'est perdu. La copie contient donc de quoi déchiffrer ces mots de passe : la garder dans un dossier réservé (`chmod 700`). Si la clé est fournie par `ALFRED_SECRET_KEY`, c'est le `.env` qu'il faut sauvegarder avec la base. Pour une sauvegarde hebdomadaire automatique, par exemple le lundi à 3 h, ajouter avec `crontab -e` :

```bash
0 3 * * 1  docker cp alfred:/data /opt/sauvegardes/alfred-data-$(date +\%F)
```

Pour restaurer, depuis `/opt/alfred` :

```bash
docker compose -f deploy/docker-compose.yml stop
docker cp ./alfred-data-AAAA-MM-JJ/. alfred:/data/
# docker cp crée les fichiers au nom de root, alors qu'Alfred tourne sous l'utilisateur « node » :
# sans cette étape, la base ne peut plus être modifiée et le fichier de clé (mode 600) ne peut plus être lu.
docker run --rm --volumes-from alfred -u 0 --entrypoint sh alfred:latest -c 'chown -R node:node /data && chmod 700 /data && { [ ! -f /data/secret.key ] || chmod 600 /data/secret.key; }'
docker compose -f deploy/docker-compose.yml start
```

Puis ouvrir Réglages : aucun message « à ressaisir » ne doit apparaître, et la synchro doit repartir. Cette procédure est à répéter une fois à blanc sur le VPS avant d'en avoir besoin (elle n'a pas pu être jouée dans l'environnement de développement, qui n'a pas Docker).

## Dépannage

- **« Synchro iCloud en échec »** dans la barre latérale : le diagnostic est affiché dessous, avec un lien vers Réglages. Le plus souvent, « Identifiants refusés » : le mot de passe d'application a été révoqué ou mal recopié ; en créer un nouveau chez Apple et le coller dans Réglages > Calendrier iCloud.
- **« Mot de passe à ressaisir »** dans Réglages : la base a été restaurée sans son fichier `secret.key` (ou `ALFRED_SECRET_KEY` a changé). Ressaisir le mot de passe concerné suffit. Variante « le serveur a changé » : le serveur d'envoi ou son port n'est plus celui pour lequel le mot de passe avait été saisi ; le ressaisir suffit aussi.
- **« Alfred n'a pas le droit de lire le fichier de clé »**, ou « Impossible de chiffrer le mot de passe » : les fichiers du volume appartiennent à root, typiquement après une restauration par `docker cp` sans l'étape `chown`. Jouer la ligne `docker run … chown …` de la section Sauvegarde, puis `docker restart alfred`.
- **Le nouveau mot de passe saisi dans `configurer.sh` n'a aucun effet** : un mot de passe enregistré dans l'app passe avant le `.env`. Le changer dans l'app (Réglages pour iCloud, Rendez-vous > Réglages pour les e-mails).
- **Un serveur refusé comme « adresse interne ou privée »** : c'est voulu, Alfred ne se connecte pas au réseau interne du VPS pour un serveur saisi dans l'app. Un serveur interne légitime se déclare dans le `.env`.
- **Connexion refusée en boucle** : vérifier que `ALFRED_PASSWORD_HASH` commence par `scrypt:` et tient sur une seule ligne dans le `.env`.
- **Trop d'essais** : le blocage se lève après 15 minutes, ou tout de suite avec `docker restart alfred`.
