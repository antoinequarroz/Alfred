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
echo "Le mot de passe d'application est généré par Apple (account.apple.com >"
echo "Connexion et sécurité > Mots de passe pour les apps) : 16 lettres, abcd-efgh-ijkl-mnop."
echo "Ce n'est ni ton mot de passe Apple habituel, ni celui d'Alfred."
while :; do
  read -rsp "Mot de passe d'application iCloud (colle-le ici) : " app_pw; echo
  app_pw=${app_pw//[[:space:]]/}
  if [[ ! "$app_pw" =~ ^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$ ]]; then
    echo "Ce n'est pas un mot de passe d'application (16 lettres minuscules attendues, reçu ${#app_pw} caractères). On recommence."
    continue
  fi
  # Test de connexion à iCloud ; les identifiants passent par l'entrée standard, pas par la ligne de commande.
  code=$(printf 'user = "%s:%s"\n' "$apple_id" "$app_pw" | curl -K - -s -o /dev/null -w '%{http_code}' \
    -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml' \
    --data '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>' \
    --max-time 20 https://caldav.icloud.com/ || true)
  case "$code" in
    207|200) echo "Connexion à iCloud : OK"; break ;;
    401) echo "iCloud refuse cet identifiant ou ce mot de passe (401)."
         read -rp "Identifiant Apple (Entrée pour garder $apple_id) : " again
         [[ -n "$again" ]] && apple_id=$again ;;
    *) echo "Impossible de tester la connexion à iCloud (réponse « $code »), je continue quand même."; break ;;
  esac
done
while :; do
  read -rsp "Mot de passe pour te connecter à Alfred (10 caractères min.) : " pw1; echo
  read -rsp "Encore une fois : " pw2; echo
  if [[ "$pw1" != "$pw2" ]]; then echo "Les deux ne correspondent pas, on recommence."; continue; fi
  if (( ${#pw1} < 10 )); then echo "Trop court, au moins 10 caractères."; continue; fi
  break
done

hash=$(printf '%s' "$pw1" | docker run --rm -i --entrypoint node alfred:latest dist/server/scripts/hash-password.js)
hash=${hash#ALFRED_PASSWORD_HASH=}
[[ "$hash" =~ ^scrypt:[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]] || { echo "Échec du calcul de l'empreinte."; exit 1; }
unset pw1 pw2

# Les valeurs iCloud sont écrites entre apostrophes : docker compose les lit telles quelles.
if [[ "$apple_id$app_pw" == *"'"* ]]; then echo "Les identifiants iCloud ne peuvent pas contenir d'apostrophe."; exit 1; fi

umask 077
cat > .env <<EOF
ALFRED_PASSWORD_HASH=$hash
CALDAV_URL=https://caldav.icloud.com
CALDAV_USERNAME='$apple_id'
CALDAV_PASSWORD='$app_pw'
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
    sleep 8   # laisse le temps à la première synchro de démarrer
    docker logs alfred --tail 10
    echo
    if docker logs alfred 2>&1 | grep -q 'synchro CalDAV en échec'; then
      echo "Alfred tourne, mais la synchro iCloud échoue (voir ci-dessus)."
      exit 1
    fi
    echo "Alfred tourne. Ouvre https://alfred.antoinequarroz.ch"
    exit 0
  fi
  echo -n "."; sleep 2
done
echo
echo "Alfred ne répond pas encore. Journaux :"
docker logs alfred --tail 40
exit 1
