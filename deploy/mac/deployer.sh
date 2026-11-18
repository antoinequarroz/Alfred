#!/bin/bash
# Déploie sur le VPS une version précise de la branche main d'Alfred, en une commande, depuis le Mac.
#   bash deploy/mac/deployer.sh                 déploie le dernier commit de origin/main (montre d'abord ce qui change)
#   bash deploy/mac/deployer.sh <commit>        déploie ce commit (il doit être sur main)
#   bash deploy/mac/deployer.sh --oui [commit]  sans question (après avoir regardé la simulation)
#   bash deploy/mac/deployer.sh --simuler [commit]  montre seulement ce qui changerait sur le VPS
#   bash deploy/mac/deployer.sh --retour        remet la version précédente (image de retour), sans toucher aux données
#
# Étapes : 1) git fetch, export du commit (git archive : seulement les fichiers suivis, rien du dossier local) ;
# 2) simulation de la copie vers /opt/alfred ; 3) sur le VPS : sauvegarde des données + image de retour ;
# 4) copie du code ; 5) reconstruction d'Alfred seul, vérification /healthz, retour automatique sinon.
# Jamais copiés ni effacés sur le VPS : .env*, data/, node_modules/, dist/, .deploiement, .en-service.
set -euo pipefail

VPS=${ALFRED_VPS:-antoine-vps}
REMOTE=${ALFRED_REMOTE_DIR:-/opt/alfred}
REPO=$(cd "$(dirname "$0")/../.." && pwd)

yes=""; simulate=""; ref=""
for a in "$@"; do
  case "$a" in
    --oui) yes=1 ;;
    --simuler) simulate=1 ;;
    --retour) exec ssh "$VPS" "bash $REMOTE/deploy/mise-a-jour.sh --retour" ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "Option inconnue : $a" >&2; exit 2 ;;
    *) ref=$a ;;
  esac
done

git -C "$REPO" fetch -q origin main
ref=${ref:-origin/main}
sha=$(git -C "$REPO" rev-parse --verify "$ref^{commit}") || { echo "Commit introuvable : $ref" >&2; exit 1; }
if ! git -C "$REPO" merge-base --is-ancestor "$sha" origin/main; then
  echo "Refusé : $sha n'est pas sur main. On ne déploie que ce qui est fusionné." >&2
  exit 1
fi
echo "Version à déployer : $(git -C "$REPO" log -1 --format='%h  %ci  %s' "$sha")"
echo "Version en service : $(ssh -o ConnectTimeout=20 "$VPS" "cat $REMOTE/.en-service 2>/dev/null || cat $REMOTE/VERSION 2>/dev/null || echo inconnue")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$REPO" archive "$sha" | tar -x -C "$tmp"
echo "$sha" > "$tmp/VERSION"

RSYNC=(rsync -rlptz --delete --exclude='.env*' --exclude='/data/' --exclude='/node_modules/' --exclude='/dist/' --exclude='/.deploiement' --exclude='/.en-service')
echo; echo "Ce qui change sur le VPS :"
"${RSYNC[@]}" -nv "$tmp/" "$VPS:$REMOTE/" | grep -vE '/$|^sending|^sent |^total size|^$' | sed 's/^/  /' || true
[[ -n "$simulate" ]] && exit 0

if [[ -z "$yes" ]]; then
  read -r -p "Déployer cette version ? [o/N] " r
  [[ "$r" == o || "$r" == O || "$r" == oui ]] || { echo "Annulé."; exit 1; }
fi

# Sauvegarde + image de retour. Au tout premier passage, mise-a-jour.sh n'est pas encore sur le VPS : on le fait à la main.
ssh "$VPS" "if [ -f $REMOTE/deploy/mise-a-jour.sh ]; then bash $REMOTE/deploy/mise-a-jour.sh --preparer; else
  bash $REMOTE/deploy/sauvegarde.sh 2>/dev/null || docker cp alfred:/data /opt/sauvegardes/alfred-data-\$(date +%F-%H%M);
  t=retour-\$(date +%F-%H%M); docker tag alfred:latest alfred:\$t && echo \$t > $REMOTE/.deploiement && echo \"Image de retour : alfred:\$t\"; fi"
"${RSYNC[@]}" "$tmp/" "$VPS:$REMOTE/"
ssh "$VPS" "bash $REMOTE/deploy/mise-a-jour.sh"
echo "Déployé : $sha. Retour possible : bash deploy/mac/deployer.sh --retour"
