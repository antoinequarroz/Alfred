#!/usr/bin/env bash
# Sauvegarde de la base Cal.com (RDV, types d'événements, identifiants iCloud chiffrés).
# Usage : bash scripts/backup.sh [dossier]   (défaut : ~/backups/alfred-calcom)
# Cron quotidien conseillé : 15 3 * * * cd /opt/alfred/deploy/calcom && bash scripts/backup.sh >/dev/null
# Garde 14 jours. Pense aussi à sauvegarder .env (la clé CALENDSO_ENCRYPTION_KEY est indispensable à la restauration).
set -euo pipefail
DEST="${1:-$HOME/backups/alfred-calcom}"
mkdir -p "$DEST"
chmod 700 "$DEST"
FILE="$DEST/calcom-$(date +%Y%m%d-%H%M%S).sql.gz"
docker exec alfred-calcom-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$FILE"
chmod 600 "$FILE"
find "$DEST" -name 'calcom-*.sql.gz' -mtime +14 -delete
echo "Sauvegarde : $FILE ($(du -h "$FILE" | cut -f1))"
