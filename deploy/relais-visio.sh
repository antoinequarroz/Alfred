#!/usr/bin/env bash
# Relais visio pour les réseaux filtrés (TURN sur le port 443) et tampons UDP de LiveKit, sur le VPS.
#   bash /opt/alfred/deploy/relais-visio.sh            simulation : vérifie tout, construit l'image Caddy,
#                                                     montre les changements, ne touche à rien d'autre
#   bash /opt/alfred/deploy/relais-visio.sh --oui      applique (Caddy recréé : 2 à 5 secondes de coupure
#                                                     pour tous les sites ; visio recréée : appels coupés)
#   bash /opt/alfred/deploy/relais-visio.sh --retour   remet le Caddyfile, compose.runtime.yml et l'image
#                                                     Caddy d'avant (LiveKit garde son relais, inutilisé)
#
# Ce que fait --oui, dans l'ordre :
#  1. tampons UDP : /etc/sysctl.d/90-alfred-visio.conf (rmem_max et wmem_max à 5 Mo), appliqué tout de suite ;
#  2. sauvegarde du Caddyfile et de compose.runtime.yml (suffixe .bak-<date>-avant-relais-visio) ;
#  3. Caddyfile : options globales layer4 en tête + bloc turn.postmelo.ch en fin (deploy/Caddyfile.snippet) ;
#     compose.runtime.yml : image alfred-caddy-l4:2.10.2 pour le service caddy ;
#  4. la nouvelle configuration est validée par la nouvelle image AVANT d'être posée ;
#  5. Caddy est recréé, puis les sites sont vérifiés ; au moindre échec, retour automatique à l'état d'avant ;
#  6. la visio est recréée (deploy/visio.sh) pour lire livekit.yaml (relais) et les nouveaux tampons.
# Peut être relancé : ce qui est déjà en place est laissé tel quel.
set -euo pipefail
# Attention avec pipefail : pas de « … | head » ni de « … | grep -q » (le premier maillon reçoit SIGPIPE,
# le tube renvoie 141 et set -e arrête le script) ; capturer la sortie dans une variable d'abord.

TURN_DOMAIN=turn.postmelo.ch
IMAGE=alfred-caddy-l4:2.10.2
ALFRED=${ALFRED_DIR:-/opt/alfred}
VITRINE=${VITRINE_DIR:-/home/ubuntu/antoinequarroz-vitrine}
RUNTIME=${VITRINE_RUNTIME_DIR:-/home/ubuntu/.config/antoinequarroz-vitrine/runtime}
CADDYFILE=$RUNTIME/Caddyfile
OVERLAY=$RUNTIME/compose.runtime.yml
SYSCTL_FILE=/etc/sysctl.d/90-alfred-visio.conf
BUFFER=5000000
MARK="# Alfred : relais visio (deploy/relais-visio.sh)"
SUFFIX=avant-relais-visio

mode=simuler
case "${1:-}" in
  "") ;;
  --oui) mode=oui ;;
  --retour) mode=retour ;;
  -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
  *) echo "Option inconnue : $1" >&2; exit 2 ;;
esac

say() { printf '\n== %s\n' "$*"; }
die() { echo "ARRÊT : $*" >&2; exit 1; }

compose() {
  docker compose --project-directory "$VITRINE" -f "$VITRINE/docker-compose.yml" -f "$OVERLAY" "$@"
}

caddy_container() { compose ps -q caddy 2>/dev/null | sed -n 1p || true; }

SITES="www.antoinequarroz.ch alfred.postmelo.ch tickup.postmelo.ch postmelo.ch repet.ch"

# Répond 0 si les sites répondent comme vus d'Internet : par l'adresse publique du VPS (même chemin
# que les visiteurs, sans passer par 127.0.0.1) et avec vérification complète du certificat.
sites_ok() {
  local host code failed=0
  for host in $SITES; do
    code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "$host:443:${PUBLIC_IP:-127.0.0.1}" "https://$host/" 2>/dev/null || true)
    code=${code:-000}
    printf '   %-24s %s\n' "$host" "$code"
    [[ "$code" =~ ^[234] ]] || failed=1
  done
  return $failed
}

# Attend que les sites répondent (Caddy vient d'être recréé), puis les surveille encore une minute :
# une panne qui n'apparaît qu'après quelques secondes déclenche aussi le retour.
wait_sites() {
  local ok=0
  for _ in $(seq 1 20); do
    if sites_ok >/dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  if [[ "$ok" != 1 ]]; then sites_ok || true; return 1; fi
  echo "   Surveillance pendant une minute…"
  for _ in $(seq 1 6); do
    sleep 10
    sites_ok >/dev/null 2>&1 || { echo "   Un site a cessé de répondre :"; sites_ok || true; return 1; }
  done
  sites_ok
}

latest_backup() { ls -1t "$1".bak-*-$SUFFIX 2>/dev/null | head -1 || true; }

restore() {
  local cf ov
  cf=$(latest_backup "$CADDYFILE"); ov=$(latest_backup "$OVERLAY")
  [[ -n "$cf" && -n "$ov" ]] || die "pas de sauvegarde *-$SUFFIX trouvée dans $RUNTIME"
  echo "Remise de $cf et $ov"
  cp -p "$cf" "$CADDYFILE"
  cp -p "$ov" "$OVERLAY"
  compose up -d --no-deps --force-recreate caddy
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
}

[[ -f "$CADDYFILE" && -f "$OVERLAY" && -f "$VITRINE/docker-compose.yml" ]] || die "fichiers de Caddy introuvables ($RUNTIME, $VITRINE)"

# Un seul passage à la fois : deux lancements en même temps se gênent (l'un recrée Caddy pendant
# que l'autre contrôle les sites, qui semblent alors en panne).
exec 9>"${TMPDIR:-/tmp}/alfred-relais-visio.lock"
flock -n 9 || die "relais-visio.sh tourne déjà (autre terminal ou autre session) : attends qu'il ait fini"

PUBLIC_IP=$(grep -m1 -E '^NODE_IP=' "$ALFRED/.env.livekit" 2>/dev/null | cut -d= -f2 || true)

if [[ "$mode" == retour ]]; then
  say "Retour de Caddy à l'état d'avant le relais"
  restore
  if wait_sites; then echo "Caddy est revenu à l'état d'avant."; else echo "Les sites ne répondent pas : voir docker logs antoinequarroz-caddy --tail 50"; exit 1; fi
  exit 0
fi

# --- Vérifications (sans rien changer) ---------------------------------------------------------------
say "Vérifications"
node_ip=$PUBLIC_IP
[[ -n "$node_ip" ]] || die "NODE_IP absent de $ALFRED/.env.livekit (la visio est-elle installée ?)"
grep -q "^turn:" "$ALFRED/deploy/livekit.yaml" || die "$ALFRED/deploy/livekit.yaml n'a pas encore le relais : déploie d'abord Alfred (deploy/mac/deployer.sh)"
[[ -f "$ALFRED/deploy/caddy-l4/Dockerfile" ]] || die "$ALFRED/deploy/caddy-l4/Dockerfile manquant : déploie d'abord Alfred"
dns=$(getent ahostsv4 "$TURN_DOMAIN" 2>/dev/null | awk 'NR == 1 {print $1}' || true)
if [[ "$dns" == "$node_ip" ]]; then
  echo "DNS : $TURN_DOMAIN → $dns (OK)"
else
  die "DNS : $TURN_DOMAIN → ${dns:-introuvable}, attendu $node_ip. Crée l'enregistrement A chez Infomaniak, attends quelques minutes, relance."
fi
if grep -qF "$MARK" "$CADDYFILE"; then
  caddy_done=1; echo "Caddyfile : relais déjà en place"
else
  caddy_done=0
  first=$(awk 'NF && $1 !~ /^#/ {print; exit}' "$CADDYFILE")
  [[ "$first" =~ ^[[:space:]]*\{[[:space:]]*$ ]] && die "le Caddyfile a déjà un bloc d'options globales : à fusionner à la main (voir deploy/Caddyfile.snippet)"
  grep -q -E "^[[:space:]]*$TURN_DOMAIN[[:space:]]*\{" "$CADDYFILE" && die "le Caddyfile a déjà un bloc $TURN_DOMAIN : à regarder à la main"
  echo "Caddyfile : options globales et bloc $TURN_DOMAIN à ajouter"
fi
if grep -q -E "^[[:space:]]+image:[[:space:]]*$IMAGE([[:space:]]|$)" "$OVERLAY"; then
  echo "compose.runtime.yml : image $IMAGE déjà en place"
else
  grep -q -E '^[[:space:]]+image:' "$OVERLAY" && die "compose.runtime.yml impose déjà une image : à regarder à la main"
  grep -q -E '^  caddy:[[:space:]]*$' "$OVERLAY" || die "service caddy introuvable dans compose.runtime.yml"
  echo "compose.runtime.yml : image $IMAGE à poser"
fi
echo "Sites avant changement :"
sites_ok || die "un site ne répond déjà pas comme prévu : on ne touche à rien (le contrôle d'après ne serait pas fiable)"
current=$(sysctl -n net.core.rmem_max)
echo "Tampon UDP : net.core.rmem_max = $current (visé : $BUFFER)"

# --- Image Caddy avec layer4 (sans effet sur le Caddy en service) ------------------------------------
say "Image $IMAGE"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Déjà construite."
else
  echo "Construction (4 à 6 minutes, une compilation à la fois)…"
  nice -n 10 docker build -q -t "$IMAGE" "$ALFRED/deploy/caddy-l4"
fi
modules=$(docker run --rm "$IMAGE" caddy list-modules)
grep -q '^caddy.listeners.layer4$' <<<"$modules" || die "l'image $IMAGE n'a pas le module layer4"
docker run --rm "$IMAGE" caddy version

# --- Nouvelle configuration, préparée à côté et validée -----------------------------------------------
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
new_cf=$tmpdir/Caddyfile
new_ov=$tmpdir/compose.runtime.yml
if [[ "$caddy_done" == 1 ]]; then
  cp "$CADDYFILE" "$new_cf"
else
  {
    echo "$MARK : début"
    sed -n '/^{$/,/^}$/p' "$ALFRED/deploy/Caddyfile.snippet"
    echo "$MARK : fin des options globales"
    echo
    cat "$CADDYFILE"
    echo
    echo "$MARK : certificat du relais (les connexions TLS pour ce nom vont au relais)"
    echo "$TURN_DOMAIN {"
    printf '\trespond "Relais visio d'"'"'Alfred" 404\n'
    echo "}"
  } > "$new_cf"
fi
if grep -q -E "^[[:space:]]+image:[[:space:]]*$IMAGE([[:space:]]|$)" "$OVERLAY"; then
  cp "$OVERLAY" "$new_ov"
else
  awk -v img="$IMAGE" '{ print } /^  caddy:[[:space:]]*$/ { print "    image: " img "   # Caddy + layer4 pour le relais visio d'"'"'Alfred (deploy/relais-visio.sh)" }' "$OVERLAY" > "$new_ov"
fi
chmod 600 "$new_cf" "$new_ov"
say "Validation de la nouvelle configuration par $IMAGE"
docker run --rm --network none -v "$new_cf:/etc/caddy/Caddyfile:ro" "$IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | grep -E 'Valid configuration|Error|error' | tail -3 || true
docker run --rm --network none -v "$new_cf:/etc/caddy/Caddyfile:ro" "$IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || die "configuration refusée : rien n'a été changé"

say "Changements prévus"
diff -u "$OVERLAY" "$new_ov" | sed 's/^/   /' || true
diff -u "$CADDYFILE" "$new_cf" | grep -E '^[+-]' | grep -v -E '^(\+\+\+|---)' | head -40 | sed 's/^/   /' || true
[[ "$current" -lt "$BUFFER" ]] && echo "   $SYSCTL_FILE : net.core.rmem_max = $BUFFER, net.core.wmem_max = $BUFFER"

if [[ "$mode" == simuler ]]; then
  echo
  echo "Simulation terminée, rien n'a été changé (l'image $IMAGE est prête)."
  echo "Pour appliquer : bash $ALFRED/deploy/relais-visio.sh --oui"
  exit 0
fi

# --- 1. Tampons UDP ------------------------------------------------------------------------------------
say "1. Tampons UDP"
if [[ "$current" -lt "$BUFFER" ]]; then
  printf '# Tampons UDP pour la visio d%sAlfred (LiveKit), voir /opt/alfred/deploy/relais-visio.sh\nnet.core.rmem_max = %s\nnet.core.wmem_max = %s\n' "'" "$BUFFER" "$BUFFER" \
    | sudo tee "$SYSCTL_FILE" >/dev/null
  sudo sysctl -q -p "$SYSCTL_FILE"
fi
echo "net.core.rmem_max = $(sysctl -n net.core.rmem_max), net.core.wmem_max = $(sysctl -n net.core.wmem_max)"

# --- 2 à 5. Caddy ----------------------------------------------------------------------------------------
if cmp -s "$new_cf" "$CADDYFILE" && cmp -s "$new_ov" "$OVERLAY" \
   && [[ "$(docker inspect --format '{{.Config.Image}}' "$(caddy_container)" 2>/dev/null)" == "$IMAGE" ]]; then
  say "2-5. Caddy : déjà à jour"
else
  say "2. Sauvegarde"
  # Seul un état SANS relais est sauvegardé : --retour remet toujours un Caddy d'avant le relais.
  if grep -qF "$MARK" "$CADDYFILE" || grep -q -E "^[[:space:]]+image:[[:space:]]*$IMAGE([[:space:]]|$)" "$OVERLAY"; then
    echo "Relais déjà présent en partie : sauvegarde d'avant gardée ($(latest_backup "$CADDYFILE"))"
  else
    stamp=$(date +%F-%H%M)
    cp -p "$CADDYFILE" "$CADDYFILE.bak-$stamp-$SUFFIX"
    cp -p "$OVERLAY" "$OVERLAY.bak-$stamp-$SUFFIX"
    echo "$CADDYFILE.bak-$stamp-$SUFFIX"
    echo "$OVERLAY.bak-$stamp-$SUFFIX"
  fi

  say "3-5. Pose et recréation de Caddy"
  cat "$new_cf" > "$CADDYFILE"
  cat "$new_ov" > "$OVERLAY"
  compose up -d --no-deps --force-recreate caddy
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  if wait_sites; then
    echo "Sites : OK"
  else
    echo "Les sites ne répondent pas comme avant : retour automatique."
    docker logs "$(caddy_container)" > "$RUNTIME/caddy-refuse-$(date +%F-%H%M).log" 2>&1 || true
    restore
    wait_sites || true
    die "Caddy remis à l'état d'avant. Journaux du Caddy refusé : $RUNTIME/caddy-refuse-*.log"
  fi
fi

# Certificat du relais (Let's Encrypt, quelques secondes après le premier démarrage).
echo -n "Certificat de $TURN_DOMAIN"
cert_ok=0
for _ in $(seq 1 30); do
  san=$(echo | timeout 5 openssl s_client -connect "$PUBLIC_IP:443" -servername "$TURN_DOMAIN" -verify_return_error 2>/dev/null \
     | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)
  if grep -q "DNS:$TURN_DOMAIN" <<<"$san"; then cert_ok=1; break; fi
  echo -n "."; sleep 3
done
if [[ "$cert_ok" == 1 ]]; then echo " : OK"; else echo " : pas encore (voir docker logs antoinequarroz-caddy | grep $TURN_DOMAIN)"; fi

# --- 6. Visio ---------------------------------------------------------------------------------------------
say "6. Visio (les appels en cours sont coupés)"
bash "$ALFRED/deploy/visio.sh"
sleep 2
docker logs alfred-livekit 2>&1 | grep -E 'Starting TURN server|UDP receive buffer' | tail -3 | cut -c1-220 || true
lk_logs=$(docker logs alfred-livekit 2>&1 || true)
if grep -q 'Starting TURN server' <<<"$lk_logs"; then echo "Relais TURN : démarré"; else echo "Relais TURN : absent des journaux (docker logs alfred-livekit)"; fi
echo
echo "Fini. Essai : rejoindre une visio avec un téléphone sur un réseau qui ne laisse passer que le web."
echo "Retour possible pour Caddy : bash $ALFRED/deploy/relais-visio.sh --retour"
