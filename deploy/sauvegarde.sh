#!/usr/bin/env bash
# Sauvegarde automatique des données d'Alfred sur le VPS.
#   bash /opt/alfred/deploy/sauvegarde.sh               fait une sauvegarde maintenant
#   bash /opt/alfred/deploy/sauvegarde.sh --installer   ajoute la tâche quotidienne (cron, 3 h 17) et fait une première sauvegarde
#   bash /opt/alfred/deploy/sauvegarde.sh --desinstaller retire la tâche quotidienne (les sauvegardes restent)
#
# Chaque sauvegarde est une archive /opt/sauvegardes/alfred/alfred-AAAA-MM-JJ_HHMM.tar.gz (mode 600) qui contient :
#  - alfred.db   copie cohérente de la base, prise à chaud (VACUUM INTO) sans arrêter Alfred, vérifiée (integrity_check) ;
#  - secret.key  la clé qui déchiffre les mots de passe enregistrés dans l'app (si elle existe) ;
#  - env, env.livekit   les fichiers .env d'/opt/alfred (mot de passe d'Alfred, clés de la visio) ;
#  - resume.txt  ce que contient la base (nombre de RDV, types, événements…), pour vérifier d'un coup d'œil.
# Rétention : 14 jours, et toujours au moins les 3 dernières. Rien d'autre sur le VPS n'est touché.
# Sobre : un conteneur jetable (sans réseau, 128 Mo) le temps de la copie, quelques Mo de disque par jour.
set -euo pipefail
umask 077

ALFRED_DIR=${ALFRED_DIR:-/opt/alfred}
DEST=${ALFRED_BACKUP_DIR:-/opt/sauvegardes/alfred}
KEEP_DAYS=${ALFRED_BACKUP_DAYS:-14}
KEEP_MIN=3
MIN_FREE_MB=500
IMAGE=${ALFRED_IMAGE:-alfred:latest}
CONTAINER=${ALFRED_CONTAINER:-alfred}
CRON_TAG='# alfred-sauvegarde'
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
fail() { log "ÉCHEC : $*"; exit 1; }

install_cron() {
  local line="17 3 * * * bash $SELF >> $DEST/sauvegarde.log 2>&1 $CRON_TAG"
  { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; echo "$line"; } | crontab -
  log "Tâche quotidienne installée (3 h 17, heure du VPS) : $line"
}

case "${1:-}" in
  --installer)
    mkdir -p "$DEST" && chmod 700 "$DEST"
    install_cron
    ;;
  --desinstaller)
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    log "Tâche quotidienne retirée. Les sauvegardes de $DEST sont gardées."
    exit 0
    ;;
  "") ;;
  *) echo "Usage : $0 [--installer|--desinstaller]" >&2; exit 2 ;;
esac

command -v docker >/dev/null || fail "docker introuvable"
docker container inspect "$CONTAINER" >/dev/null 2>&1 || fail "conteneur $CONTAINER introuvable"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE introuvable"

mkdir -p "$DEST" && chmod 700 "$DEST"
free_mb=$(df -Pm "$DEST" | awk 'NR==2 {print $4}')
[[ "$free_mb" -ge "$MIN_FREE_MB" ]] || fail "seulement ${free_mb} Mo libres sur le disque (minimum ${MIN_FREE_MB} Mo) : sauvegarde annulée"

stamp=$(date +%F_%H%M)
work=$(mktemp -d "$DEST/.en-cours-XXXXXX")
trap 'rm -rf "$work"' EXIT

# Copie cohérente de la base dans un conteneur jetable qui monte le volume d'Alfred (que le conteneur tourne ou non).
# VACUUM INTO lit un instantané : Alfred continue de servir pendant la copie.
read -r -d '' SNAPSHOT_JS <<'JS' || true
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const src = new DatabaseSync('/data/alfred.db');
src.exec('PRAGMA busy_timeout = 15000');
src.prepare('VACUUM INTO ?').run('/out/alfred.db');
src.close();
const db = new DatabaseSync('/out/alfred.db', { readOnly: true });
const ok = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
if (ok !== 'ok') { console.error('integrity_check : ' + ok); process.exit(3); }
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const lines = tables.map((t) => t + ' ' + db.prepare('SELECT count(*) AS n FROM "' + t + '"').get().n);
db.close();
fs.writeFileSync('/out/resume.txt', 'integrity_check ok\n' + lines.join('\n') + '\n');
if (fs.existsSync('/data/secret.key')) fs.copyFileSync('/data/secret.key', '/out/secret.key');
for (const f of fs.readdirSync('/out')) { fs.chownSync('/out/' + f, +process.env.OUT_UID, +process.env.OUT_GID); fs.chmodSync('/out/' + f, 0o600); }
JS
docker run --rm --volumes-from "$CONTAINER" -v "$work:/out" --network none -u 0 \
  --memory 128m --cpus 0.5 --entrypoint node \
  -e OUT_UID="$(id -u)" -e OUT_GID="$(id -g)" \
  "$IMAGE" --disable-warning=ExperimentalWarning -e "$SNAPSHOT_JS" \
  || fail "copie de la base impossible (voir le message ci-dessus)"

[[ -s "$work/alfred.db" ]] || fail "copie de la base vide"
[[ -f "$ALFRED_DIR/.env" ]] && cp "$ALFRED_DIR/.env" "$work/env"
[[ -f "$ALFRED_DIR/.env.livekit" ]] && cp "$ALFRED_DIR/.env.livekit" "$work/env.livekit"

archive="$DEST/alfred-$stamp.tar.gz"
tar -czf "$archive.part" -C "$work" .
chmod 600 "$archive.part"
mv "$archive.part" "$archive"
log "Sauvegarde faite : $archive ($(du -h "$archive" | cut -f1)) ; $(grep -cv integrity "$work/resume.txt") tables, $(awk '$1=="bookings"{print $2" RDV"}' "$work/resume.txt")"

# Rétention : on retire les archives de plus de KEEP_DAYS jours, en gardant toujours les KEEP_MIN plus récentes.
mapfile -t all < <(ls -1t "$DEST"/alfred-*.tar.gz 2>/dev/null || true)
for f in "${all[@]:$KEEP_MIN}"; do
  if [[ -n "$(find "$f" -maxdepth 0 -mtime +"$((KEEP_DAYS - 1))")" ]]; then rm -f -- "$f" && log "Ancienne sauvegarde retirée : $f"; fi
done
date '+%F %T' > "$DEST/derniere-reussie"
