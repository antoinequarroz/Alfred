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

Le plus simple, une fois le code dans `/opt/alfred` : `bash /opt/alfred/deploy/configurer.sh`. Le script demande l'identifiant Apple, le mot de passe d'application et le mot de passe d'Alfred (saisie masquée), écrit le `.env` en `chmod 600` et démarre le conteneur. À la main, ça donne :

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

### E-mails de la prise de rendez-vous

Pour que les confirmations partent depuis `info@antoinequarroz.ch`, ajouter au `.env` (le script `configurer.sh` ne les demande pas encore, et il réécrit le `.env` : les remettre après l'avoir relancé) :

```bash
SMTP_HOST=mail.infomaniak.com
SMTP_PORT=587                 # STARTTLS ; 465 = TLS implicite
SMTP_USER=info@antoinequarroz.ch
SMTP_PASSWORD=…               # mot de passe de la boîte, ou mot de passe d'application Infomaniak
MAIL_FROM="Antoine Quarroz <info@antoinequarroz.ch>"
MAIL_NOTIFY_TO=               # qui reçoit les avis (défaut : l'adresse de MAIL_FROM)
ALFRED_PUBLIC_URL=https://alfred.antoinequarroz.ch
```

Puis `docker compose -f deploy/docker-compose.yml up -d`. Sans `SMTP_USER` et `SMTP_PASSWORD`, la prise de rendez-vous fonctionne mais n'envoie aucun e-mail (un avertissement s'affiche dans l'admin). La prise de rendez-vous reste fermée tant qu'elle n'est pas activée dans les réglages.

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
| Sauvegarder la base | `docker cp alfred:/data/alfred.db ./alfred-$(date +%F).db` |
| Arrêter | `docker compose -f deploy/docker-compose.yml down` |

La base ne contient qu'une copie des calendriers (la référence reste iCloud) et les sessions. En cas de perte, elle se reconstruit toute seule à la synchro suivante.

## Dépannage

- **« Synchro iCloud en échec »** dans la barre latérale : le détail de l'erreur est affiché dessous. Le plus souvent, c'est l'identifiant Apple ou le mot de passe d'application (une erreur 401).
- **Connexion refusée en boucle** : vérifier que `ALFRED_PASSWORD_HASH` commence par `scrypt:` et tient sur une seule ligne dans le `.env`.
- **Trop d'essais** : le blocage se lève après 15 minutes, ou tout de suite avec `docker restart alfred`.
