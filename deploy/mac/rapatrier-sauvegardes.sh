#!/bin/bash
# Copie sur le Mac les sauvegardes d'Alfred faites chaque nuit sur le VPS (deploy/sauvegarde.sh).
#   bash deploy/mac/rapatrier-sauvegardes.sh               rapatrie maintenant
#   bash deploy/mac/rapatrier-sauvegardes.sh --installer   installe la tâche quotidienne (launchd, 9 h, rattrapée au réveil du Mac)
#   bash deploy/mac/rapatrier-sauvegardes.sh --desinstaller retire la tâche (les copies restent)
#
# Copies dans ~/Sauvegardes/Alfred (dossier en 700), gardées 90 jours. Ne supprime jamais rien sur le VPS.
# Si la dernière sauvegarde a plus de 2 jours ou si le VPS ne répond pas : notification macOS et ligne dans le journal.
set -uo pipefail
umask 077

VPS=${ALFRED_VPS:-antoine-vps}
REMOTE_DIR=${ALFRED_REMOTE_BACKUP_DIR:-/opt/sauvegardes/alfred}
DEST=${ALFRED_MAC_BACKUP_DIR:-$HOME/Sauvegardes/Alfred}
KEEP_DAYS=90
LABEL=ch.antoinequarroz.alfred.sauvegardes
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALLED="$HOME/Library/Application Support/Alfred/rapatrier-sauvegardes.sh"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
notify() { osascript -e "display notification \"$1\" with title \"Sauvegardes d'Alfred\"" >/dev/null 2>&1 || true; }

case "${1:-}" in
  --installer)
    mkdir -p "$DEST" "$(dirname "$INSTALLED")" "$HOME/Library/LaunchAgents" && chmod 700 "$DEST"
    # Copie du script hors du dépôt : la tâche continue de marcher même si le dépôt change de branche.
    cp "$0" "$INSTALLED" && chmod 700 "$INSTALLED"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$INSTALLED</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$DEST/rapatriement.log</string>
  <key>StandardErrorPath</key><string>$DEST/rapatriement.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { log "ÉCHEC : launchctl n'a pas chargé $PLIST"; exit 1; }
    log "Tâche installée : chaque jour à 9 h (au réveil du Mac s'il dormait). Copies dans $DEST."
    ;;
  --desinstaller)
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    log "Tâche retirée. Les copies de $DEST sont gardées."
    exit 0
    ;;
  "") ;;
  *) echo "Usage : $0 [--installer|--desinstaller]" >&2; exit 2 ;;
esac

mkdir -p "$DEST" && chmod 700 "$DEST"
if ! rsync -a --include='alfred-*.tar.gz' --include='derniere-reussie' --exclude='*' \
     -e 'ssh -o BatchMode=yes -o ConnectTimeout=20' "$VPS:$REMOTE_DIR/" "$DEST/"; then
  log "ÉCHEC : impossible de récupérer les sauvegardes depuis $VPS"
  notify "Le VPS n'a pas répondu : sauvegardes non copiées sur le Mac."
  exit 1
fi
chmod 600 "$DEST"/alfred-*.tar.gz 2>/dev/null || true

latest=$(ls -1t "$DEST"/alfred-*.tar.gz 2>/dev/null | head -1)
if [[ -z "$latest" ]]; then
  log "Aucune sauvegarde sur le VPS pour l'instant."
  notify "Aucune sauvegarde trouvée sur le VPS."
  exit 1
fi
age_h=$(( ( $(date +%s) - $(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest") ) / 3600 ))
log "Copies à jour : $(ls -1 "$DEST"/alfred-*.tar.gz | wc -l | tr -d ' ') archives, la plus récente $(basename "$latest") (il y a ${age_h} h)."
if (( age_h > 48 )); then
  log "ATTENTION : la dernière sauvegarde du VPS a plus de 2 jours."
  notify "La dernière sauvegarde d'Alfred a plus de 2 jours : vérifier le VPS."
fi

# Rétention sur le Mac : 90 jours, en gardant toujours les 7 plus récentes.
ls -1t "$DEST"/alfred-*.tar.gz | tail -n +8 | while read -r f; do
  if [[ -n "$(find "$f" -mtime +"$KEEP_DAYS")" ]]; then rm -f -- "$f" && log "Ancienne copie retirée : $(basename "$f")"; fi
done
exit 0
