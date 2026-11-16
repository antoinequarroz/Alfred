#!/usr/bin/env bash
# Prépare et démarre le serveur de visio d'Alfred (LiveKit) sur le VPS. Sans question :
#   bash /opt/alfred/deploy/visio.sh            prépare les clés puis (re)démarre Alfred et la visio
#   bash /opt/alfred/deploy/visio.sh --env-only prépare seulement les fichiers de clés
# Peut être relancé : les clés existantes sont gardées. Rien n'est affiché des secrets.
#  - /opt/alfred/.env reçoit LIVEKIT_API_KEY et LIVEKIT_API_SECRET (lus par Alfred) ;
#  - /opt/alfred/.env.livekit reçoit LIVEKIT_KEYS et NODE_IP (lus par le conteneur alfred-livekit).
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

env_get() {
  [[ -f .env ]] || return 0
  local line
  line=$(grep -m1 -E "^$1=" .env || true)
  line=${line#*=}
  if [[ "$line" == \'*\' || "$line" == \"*\" ]]; then line=${line:1:${#line}-2}; fi
  printf '%s' "$line"
}

key=$(env_get LIVEKIT_API_KEY)
secret=$(env_get LIVEKIT_API_SECRET)
if [[ -z "$key" || ${#secret} -lt 32 ]]; then
  key="alfred$(openssl rand -hex 4)"
  secret=$(openssl rand -hex 32)
  touch .env
  tmp=$(mktemp .env.XXXXXX)
  { grep -vE '^(LIVEKIT_API_KEY|LIVEKIT_API_SECRET)=' .env || true; echo "LIVEKIT_API_KEY=$key"; echo "LIVEKIT_API_SECRET=$secret"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
  echo "Clés de la visio créées dans .env."
else
  echo "Clés de la visio déjà présentes dans .env : gardées."
fi

# Adresse publique annoncée aux navigateurs pour l'audio et la vidéo (IPv4 du VPS).
ip=${ALFRED_PUBLIC_IP:-}
if [[ -z "$ip" && -f .env.livekit ]]; then ip=$(grep -m1 -E '^NODE_IP=' .env.livekit | cut -d= -f2 || true); fi
if [[ -z "$ip" ]]; then ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}' | head -1 || true); fi
if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$ip" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.) ]]; then
  echo "Adresse publique du VPS introuvable : relance avec ALFRED_PUBLIC_IP=<adresse IPv4> bash deploy/visio.sh"; exit 1
fi
tmp=$(mktemp .env.livekit.XXXXXX)
{ echo "LIVEKIT_KEYS=$key: $secret"; echo "NODE_IP=$ip"; } > "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env.livekit
unset secret
echo "Fichier .env.livekit écrit (adresse publique $ip)."

[[ "${1:-}" == "--env-only" ]] && exit 0

docker compose -f deploy/docker-compose.yml up -d --build
echo -n "Démarrage de la visio"
for _ in $(seq 1 30); do
  if docker exec alfred wget -qO- http://alfred-livekit:7880/ >/dev/null 2>&1; then
    echo " : OK"
    docker logs alfred --tail 30 2>&1 | grep -i visio || true
    echo "La visio tourne. Vérifie dans Alfred : Réglages > Visioconférence (« Serveur de visio en ligne »)."
    exit 0
  fi
  echo -n "."; sleep 2
done
echo
echo "Le serveur de visio ne répond pas. Journaux : docker logs alfred-livekit --tail 50"
exit 1
