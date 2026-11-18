#!/usr/bin/env bash
# Restauration des données d'Alfred depuis une archive de deploy/sauvegarde.sh.
#   bash /opt/alfred/deploy/restaurer.sh --essai [ARCHIVE]   essai à blanc : démarre une COPIE d'Alfred sur l'archive, sans réseau,
#                                                            vérifie qu'elle répond, puis l'efface. Ne touche pas à Alfred en service.
#   bash /opt/alfred/deploy/restaurer.sh --vrai ARCHIVE      vraie restauration : remplace les données d'Alfred par l'archive
#                                                            (une sauvegarde de l'état actuel est faite juste avant).
# Sans ARCHIVE, --essai prend la plus récente de /opt/sauvegardes/alfred.
set -euo pipefail
umask 077

ALFRED_DIR=${ALFRED_DIR:-/opt/alfred}
DEST=${ALFRED_BACKUP_DIR:-/opt/sauvegardes/alfred}
IMAGE=${ALFRED_IMAGE:-alfred:latest}
CONTAINER=${ALFRED_CONTAINER:-alfred}
TEST_NAME=alfred-essai-restauration

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
fail() { log "ÉCHEC : $*"; exit 1; }

mode=${1:-}
archive=${2:-}
[[ "$mode" == --essai || "$mode" == --vrai ]] || { echo "Usage : $0 --essai [ARCHIVE] | --vrai ARCHIVE" >&2; exit 2; }
if [[ -z "$archive" ]]; then
  [[ "$mode" == --essai ]] || fail "--vrai demande le chemin de l'archive à restaurer"
  archive=$(ls -1t "$DEST"/alfred-*.tar.gz 2>/dev/null | head -1 || true)
  [[ -n "$archive" ]] || fail "aucune sauvegarde dans $DEST"
fi
[[ -f "$archive" ]] || fail "archive introuvable : $archive"

work=$(mktemp -d "$DEST/.restauration-XXXXXX")
cleanup() { docker rm -f "$TEST_NAME" >/dev/null 2>&1 || true; docker volume rm "$TEST_NAME" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
tar -xzf "$archive" -C "$work"
[[ -s "$work/alfred.db" ]] || fail "l'archive ne contient pas alfred.db"
log "Archive : $archive"
sed 's/^/  /' "$work/resume.txt" 2>/dev/null || true

# Copie les fichiers de l'archive dans un volume Docker, avec les droits attendus par Alfred (utilisateur node).
fill_volume() {
  local target=$1
  docker run --rm -v "$target" -v "$work:/in:ro" --network none -u 0 --entrypoint sh "$IMAGE" -c '
    set -e
    rm -f /data/alfred.db /data/alfred.db-wal /data/alfred.db-shm
    cp /in/alfred.db /data/alfred.db
    if [ -f /in/secret.key ]; then cp /in/secret.key /data/secret.key; chmod 600 /data/secret.key; fi
    chown -R node:node /data && chmod 700 /data'
}

if [[ "$mode" == --essai ]]; then
  docker rm -f "$TEST_NAME" >/dev/null 2>&1 || true
  docker volume create "$TEST_NAME" >/dev/null
  fill_volume "$TEST_NAME:/data"
  envfile=()
  [[ -f "$work/env" ]] && envfile=(--env-file "$work/env")
  # Sans réseau : la copie ne synchronise pas iCloud et n'envoie aucun e-mail (rappels compris).
  docker run -d --name "$TEST_NAME" "${envfile[@]}" -v "$TEST_NAME:/data" --network none \
    --memory 128m --cpus 0.5 "$IMAGE" >/dev/null
  ok=""
  for _ in $(seq 1 30); do
    if docker exec "$TEST_NAME" wget -qO- http://127.0.0.1:3200/healthz >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [[ -n "$ok" ]] || { docker logs --tail 30 "$TEST_NAME" 2>&1 | sed 's/^/  | /'; fail "la copie d'Alfred ne répond pas sur la sauvegarde"; }
  # La copie a rouvert la base (migrations comprises) : on relit ce qu'elle contient.
  read -r -d '' COUNT_JS <<'JS' || true
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/alfred.db', { readOnly: true });
const n = (t) => { try { return db.prepare('SELECT count(*) AS n FROM ' + t).get().n; } catch { return 'absente'; } };
console.log('  Copie démarrée : ' + n('bookings') + ' RDV, ' + n('booking_types') + ' types, ' + n('events') + ' événements, ' + n('connection_settings') + ' réglages de connexion');
JS
  docker exec "$TEST_NAME" node --disable-warning=ExperimentalWarning -e "$COUNT_JS"
  if [[ -f "$work/secret.key" ]]; then log "Clé de chiffrement présente : les mots de passe enregistrés dans l'app se déchiffreront."; fi
  log "ESSAI RÉUSSI : la sauvegarde se restaure et Alfred démarre dessus. La copie d'essai est effacée."
  exit 0
fi

# --vrai : on garde d'abord l'état actuel, au cas où.
log "Sauvegarde de l'état actuel avant restauration…"
bash "$ALFRED_DIR/deploy/sauvegarde.sh"
cd "$ALFRED_DIR"
docker compose -f deploy/docker-compose.yml stop alfred
fill_volume "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER"):/data"
docker compose -f deploy/docker-compose.yml start alfred
log "Données restaurées depuis $archive. Les fichiers .env ne sont pas remplacés : ceux de l'archive sont dans env et env.livekit si besoin."
log "Vérifier dans l'app : Réglages sans message « à ressaisir », synchro iCloud qui repart, liste des rendez-vous."
