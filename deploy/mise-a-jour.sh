#!/usr/bin/env bash
# Mise en service d'une nouvelle version d'Alfred sur le VPS, avec retour arrière automatique.
# Appelé par deploy/mac/deployer.sh après la copie du code dans /opt/alfred ; peut aussi se lancer à la main.
#   bash /opt/alfred/deploy/mise-a-jour.sh --preparer        avant la copie : sauvegarde des données + image de retour
#   bash /opt/alfred/deploy/mise-a-jour.sh                   après la copie : reconstruit Alfred, vérifie qu'il répond,
#                                                            revient à l'image précédente sinon
#   bash /opt/alfred/deploy/mise-a-jour.sh --retour [TAG]    remet l'image de retour la plus récente (ou alfred:TAG)
#   bash /opt/alfred/deploy/mise-a-jour.sh --etat            version en service et images de retour disponibles
# Seul le conteneur « alfred » est reconstruit : LiveKit (et donc les appels en cours) n'est pas touché.
# Images de retour : alfred:retour-<version>, on garde les 3 plus récentes (les autres images alfred:* ne sont jamais touchées).
set -euo pipefail

ALFRED_DIR=${ALFRED_DIR:-/opt/alfred}
COMPOSE_FILE=${ALFRED_COMPOSE_FILE:-$ALFRED_DIR/deploy/docker-compose.yml}
CONTAINER=${ALFRED_CONTAINER:-alfred}
KEEP_RETOUR=3
WAIT_S=${ALFRED_HEALTH_WAIT:-120}
STATE="$ALFRED_DIR/.deploiement"   # image de retour préparée pour le déploiement en cours
LIVE="$ALFRED_DIR/.en-service"      # version qui tourne vraiment (VERSION = code sur le disque)

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
fail() { log "ÉCHEC : $*"; exit 1; }
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
version() { cat "$ALFRED_DIR/VERSION" 2>/dev/null || echo inconnue; }
live_version() { cat "$LIVE" 2>/dev/null || version; }

# Attend que le conteneur soit « healthy » (HEALTHCHECK du Dockerfile : GET /healthz).
wait_healthy() {
  local s
  for _ in $(seq 1 "$WAIT_S"); do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo absent)
    [[ "$s" == healthy ]] && return 0
    [[ "$s" == unhealthy || "$s" == exited || "$s" == dead ]] && return 1
    sleep 1
  done
  return 1
}

# Remet une image de retour en service, sans reconstruire.
retour() {
  local tag=$1
  docker image inspect "alfred:$tag" >/dev/null 2>&1 || fail "image alfred:$tag introuvable"
  docker tag "alfred:$tag" alfred:latest
  compose up -d --no-build --force-recreate "$CONTAINER"
  if wait_healthy; then
    printf '%s\n' "${tag#retour-}" > "$LIVE"
    log "Retour fait : alfred:$tag est en service."
  else
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/  | /'
    fail "même alfred:$tag ne répond pas : regarder les journaux ci-dessus"
  fi
}

latest_retour() { docker images alfred --format '{{.CreatedAt}}\t{{.Tag}}' | grep -P '\tretour-' | sort -r | head -1 | cut -f2; }

case "${1:-}" in
  --preparer)
    bash "$ALFRED_DIR/deploy/sauvegarde.sh"
    if docker image inspect alfred:latest >/dev/null 2>&1; then
      tag="retour-$(live_version | cut -c1-12)"
      [[ "$tag" == retour-inconnue ]] && tag="retour-$(date +%F-%H%M)"
      docker tag alfred:latest "alfred:$tag"
      printf '%s\n' "$tag" > "$STATE"
      log "Image de retour : alfred:$tag (version $(live_version))."
    else
      rm -f "$STATE"
      log "Pas d'image alfred:latest : première installation, pas d'image de retour."
    fi
    exit 0
    ;;
  --retour)
    tag=${2:-$(latest_retour)}
    [[ -n "$tag" ]] || fail "aucune image de retour (alfred:retour-*)"
    retour "$tag"
    exit 0
    ;;
  --etat)
    log "Version en service : $(live_version) ; code sur le disque : $(version)"
    docker inspect -f '  conteneur {{.Name}} : {{.State.Status}} {{if .State.Health}}({{.State.Health.Status}}){{end}}, démarré {{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || true
    echo "  Images de retour :"; docker images alfred --format '    alfred:{{.Tag}}  {{.CreatedSince}}  {{.Size}}' | grep retour- || echo "    (aucune)"
    exit 0
    ;;
  "") ;;
  *) echo "Usage : $0 [--preparer|--retour [TAG]|--etat]" >&2; exit 2 ;;
esac

prev_tag=$(cat "$STATE" 2>/dev/null || true)
log "Construction de la version $(version)…"
if ! compose build "$CONTAINER"; then
  # L'image en service n'a pas changé : rien à remettre, le code sur le disque sera remplacé au prochain déploiement.
  [[ -n "$prev_tag" ]] && docker tag "alfred:$prev_tag" alfred:latest
  fail "la construction a échoué : Alfred n'a pas été touché"
fi
compose up -d --no-build "$CONTAINER"
if wait_healthy; then
  version > "$LIVE"
  log "En service : version $(version), Alfred répond."
else
  docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/  | /'
  if [[ -n "$prev_tag" ]]; then
    log "La nouvelle version ne répond pas : retour à alfred:$prev_tag."
    retour "$prev_tag"
    fail "nouvelle version refusée, l'ancienne est revenue (les données n'ont pas été restaurées ; si besoin : deploy/restaurer.sh --vrai)"
  fi
  fail "la nouvelle version ne répond pas et il n'y a pas d'image de retour"
fi

# Ménage : on ne garde que les KEEP_RETOUR images de retour les plus récentes.
docker images alfred --format '{{.CreatedAt}}\t{{.Tag}}' | grep -P '\tretour-' | sort -r | tail -n +"$((KEEP_RETOUR + 1))" | cut -f2 |
  while read -r t; do docker rmi "alfred:$t" >/dev/null 2>&1 && log "Ancienne image de retour retirée : alfred:$t" || true; done
rm -f "$STATE"
