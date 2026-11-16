# Déployer Alfred sur le VPS

Alfred tourne dans un seul conteneur, limité à 256 Mo de RAM, derrière le Caddy déjà en place. Rien d'autre n'est modifié sur le serveur, à part un bloc ajouté au Caddyfile.

## 1. Avant de commencer

1. **DNS** : créer un enregistrement `A` pour `alfred.antoinequarroz.ch` vers l'IP du VPS.
2. **Mot de passe d'application iCloud** : sur [account.apple.com](https://account.apple.com) > Connexion et sécurité > Mots de passe pour les apps, en créer un nommé « Alfred ». Il a la forme `abcd-efgh-ijkl-mnop`.
3. **Mot de passe d'Alfred** : en choisir un long, puis générer son empreinte :

   ```bash
   npm run hash-password -- "mon mot de passe très long"
   ```

   La commande affiche deux lignes. Pour le `.env` du VPS, prendre la seconde (celle où les `$` sont doublés).

## 2. Installation

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
- **Connexion refusée en boucle** : vérifier que les `$` de `ALFRED_PASSWORD_HASH` sont bien doublés dans le `.env`.
- **Trop d'essais** : le blocage se lève après 15 minutes, ou tout de suite avec `docker restart alfred`.
