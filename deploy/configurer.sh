#!/usr/bin/env bash
# Configure les secrets d'Alfred sur le VPS puis démarre le conteneur.
# Usage, depuis le VPS :  bash /opt/alfred/deploy/configurer.sh
# Rien n'est affiché à l'écran ni gardé dans l'historique : les mots de passe
# sont tapés en masqué et écrits seulement dans /opt/alfred/.env (chmod 600).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker image inspect alfred:latest >/dev/null 2>&1; then
  echo "Construction de l'image…"
  docker compose -f deploy/docker-compose.yml build
fi

echo "== Configuration d'Alfred =="
read -rp "Identifiant Apple (e-mail iCloud) : " apple_id
read -rsp "Mot de passe d'application iCloud (xxxx-xxxx-xxxx-xxxx) : " app_pw; echo
while :; do
  read -rsp "Mot de passe pour te connecter à Alfred (10 caractères min.) : " pw1; echo
  read -rsp "Encore une fois : " pw2; echo
  if [[ "$pw1" != "$pw2" ]]; then echo "Les deux ne correspondent pas, on recommence."; continue; fi
  if (( ${#pw1} < 10 )); then echo "Trop court, au moins 10 caractères."; continue; fi
  break
done

hash=$(printf '%s' "$pw1" | docker run --rm -i --entrypoint node alfred:latest dist/server/scripts/hash-password.js | head -1)
hash=${hash#ALFRED_PASSWORD_HASH=}
[[ "$hash" == scrypt* ]] || { echo "Échec du calcul de l'empreinte."; exit 1; }
unset pw1 pw2

esc() { printf '%s' "${1//\$/\$\$}"; }   # docker compose : chaque $ doit être doublé

umask 077
cat > .env <<EOF
ALFRED_PASSWORD_HASH=$(esc "$hash")
CALDAV_URL=https://caldav.icloud.com
CALDAV_USERNAME=$(esc "$apple_id")
CALDAV_PASSWORD=$(esc "$app_pw")
CALDAV_SYNC_INTERVAL=120
ALFRED_TIMEZONE=Europe/Zurich
EOF
chmod 600 .env
unset app_pw
echo "Fichier .env écrit (lisible par toi seul)."

docker compose -f deploy/docker-compose.yml up -d
echo -n "Démarrage"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3200/healthz >/dev/null 2>&1; then
    echo " : OK"
    docker logs alfred --tail 10
    echo
    echo "Alfred tourne. Ouvre https://alfred.antoinequarroz.ch"
    exit 0
  fi
  echo -n "."; sleep 2
done
echo
echo "Alfred ne répond pas encore. Journaux :"
docker logs alfred --tail 40
exit 1
