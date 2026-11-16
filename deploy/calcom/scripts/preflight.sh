#!/usr/bin/env bash
# Vérifications AVANT installation. Lecture seule : ne modifie rien sur le VPS.
# Usage : bash scripts/preflight.sh
set -u
PORT="${CALCOM_PORT:-3100}"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
ko()   { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
FAIL=0

echo "== Mémoire"
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
swap_used=$(awk '/SwapTotal/ {t=$2} /SwapFree/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo)
echo "  Disponible : ${avail} Mo, swap utilisé : ${swap_used} Mo"
if   [ "$avail" -ge 1500 ]; then ok "Assez de marge pour Cal.com (~1,1 Go max avec la base)"
elif [ "$avail" -ge 1200 ]; then warn "Juste : ça passe, surveille tes autres sites les premiers jours"
else ko "Moins de 1,2 Go dispo : agrandir le VPS ou baisser CALCOM_MEM_LIMIT avant d'installer"; fi

echo "== Disque"
free_gb=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9')
[ -z "$free_gb" ] && free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if [ "${free_gb:-0}" -ge 5 ]; then ok "${free_gb} Go libres (l'image Cal.com fait ~1,7 Go)"; else ko "Seulement ${free_gb} Go libres"; fi

echo "== Port local ${PORT}"
if ss -ltn "( sport = :${PORT} )" 2>/dev/null | grep -q LISTEN; then ko "Port ${PORT} déjà pris : choisis un autre CALCOM_PORT dans .env"
else ok "Port ${PORT} libre"; fi

echo "== Noms Docker"
for c in alfred-calcom alfred-calcom-db; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then warn "Conteneur $c existe déjà (réinstallation ?)"; else ok "Nom $c libre"; fi
done

echo "== Caddy"
if systemctl is-active --quiet caddy 2>/dev/null; then ok "Caddy tourne sur l'hôte (systemd) : utilise reverse_proxy 127.0.0.1:${PORT}"
elif docker ps --format '{{.Image}} {{.Names}}' | grep -qi caddy; then
  warn "Caddy tourne dans Docker : utilise docker-compose.caddy-network.yml (réseau(x) : $(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' $(docker ps -q --filter ancestor=caddy | head -1) 2>/dev/null))"
else warn "Caddy introuvable automatiquement : vérifie comment il est lancé"; fi

echo "== Fichier .env"
if [ -f .env ]; then
  for v in NEXT_PUBLIC_WEBAPP_URL POSTGRES_PASSWORD NEXTAUTH_SECRET CALENDSO_ENCRYPTION_KEY EMAIL_SERVER_PASSWORD; do
    grep -qE "^${v}=.+" .env && ok "$v rempli" || ko "$v vide"
  done
  key=$(grep -E '^CALENDSO_ENCRYPTION_KEY=' .env | cut -d= -f2-)
  [ -n "$key" ] && [ "${#key}" -ne 32 ] && ko "CALENDSO_ENCRYPTION_KEY doit faire 32 caractères (actuel : ${#key})"
  grep -q 'example.ch' .env && warn "Il reste des valeurs example.ch dans .env"
else ko ".env absent : cp .env.example .env"; fi

echo
[ "$FAIL" -eq 0 ] && echo "Prêt pour : docker compose up -d" || echo "À corriger avant d'installer."
exit "$FAIL"
