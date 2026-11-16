#!/usr/bin/env bash
# Configure les secrets d'Alfred sur le VPS puis démarre le conteneur.
# Usage, depuis le VPS :  bash /opt/alfred/deploy/configurer.sh
# Rien n'est affiché à l'écran ni gardé dans l'historique : les mots de passe
# sont tapés en masqué et écrits seulement dans /opt/alfred/.env (chmod 600).
# Le script peut être relancé : il propose de garder les secrets déjà enregistrés
# (sans les afficher) et permet d'ajouter l'envoi d'e-mails de la prise de rendez-vous.
set -euo pipefail
cd "$(dirname "$0")/.."

# L'image est toujours reconstruite : relancé après un « git pull », le script doit démarrer
# la nouvelle version (et calculer l'empreinte du mot de passe avec elle), pas l'ancienne image.
# Quand rien n'a changé, le cache de Docker rend cette étape presque immédiate.
echo "Construction de l'image (rapide si rien n'a changé)…"
docker compose -f deploy/docker-compose.yml build

# Lit une valeur du .env existant, sans jamais l'afficher (apostrophes ou guillemets retirés).
env_get() {
  [[ -f .env ]] || return 0
  local line
  line=$(grep -m1 -E "^$1=" .env || true)
  line=${line#*=}
  if [[ "$line" == \'*\' || "$line" == \"*\" ]]; then line=${line:1:${#line}-2}; fi
  printf '%s' "$line"
}

echo "== Configuration d'Alfred =="

apple_id=$(env_get CALDAV_USERNAME)
app_pw=$(env_get CALDAV_PASSWORD)
hash=$(env_get ALFRED_PASSWORD_HASH)
smtp_user=$(env_get SMTP_USER)
smtp_pw=$(env_get SMTP_PASSWORD)

# Si un .env complet existe déjà, on propose de garder ses secrets : rien n'est affiché ni redemandé.
keep_icloud=n
keep_password=n
if [[ -n "$apple_id" && -n "$app_pw" ]]; then
  read -rp "Un .env existe déjà. Garder l'identifiant Apple et le mot de passe d'application iCloud enregistrés ? [O/n] " answer
  [[ "$answer" =~ ^[nN] ]] || keep_icloud=o
fi
if [[ "$hash" =~ ^scrypt: ]]; then
  read -rp "Garder le mot de passe d'Alfred enregistré ? [O/n] " answer
  [[ "$answer" =~ ^[nN] ]] || keep_password=o
fi

if [[ "$keep_icloud" != o ]]; then
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
fi

if [[ "$keep_password" != o ]]; then
  while :; do
    read -rsp "Mot de passe pour te connecter à Alfred (10 caractères min.) : " pw1; echo
    read -rsp "Encore une fois : " pw2; echo
    if [[ "$pw1" != "$pw2" ]]; then echo "Les deux ne correspondent pas, on recommence."; continue; fi
    if (( ${#pw1} < 10 )); then echo "Trop court, au moins 10 caractères."; continue; fi
    break
  done
  hash=$(printf '%s' "$pw1" | docker run --rm -i --entrypoint node alfred:latest dist/server/scripts/hash-password.js)
  hash=${hash#ALFRED_PASSWORD_HASH=}
  unset pw1 pw2
fi
[[ "$hash" =~ ^scrypt:[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]] || { echo "Échec du calcul de l'empreinte."; exit 1; }

# E-mails de la prise de rendez-vous (facultatif) : identifiant et mot de passe de la boîte d'envoi.
echo
echo "E-mails de la prise de rendez-vous (facultatif) : la boîte qui envoie les confirmations,"
echo "par exemple info@antoinequarroz.ch chez Infomaniak. Sans elle, les réservations"
echo "fonctionnent mais aucun e-mail ne part."
if [[ -n "$smtp_user" && -n "$smtp_pw" ]]; then
  read -rp "Identifiant SMTP (Entrée pour garder celui enregistré, « - » pour désactiver l'envoi) : " answer
  read -rsp "Mot de passe SMTP (Entrée pour garder celui enregistré) : " answer_pw; echo
  if [[ "$answer" == "-" ]]; then
    smtp_user=""; smtp_pw=""
  else
    if [[ -n "$answer" ]]; then smtp_user=$answer; fi
    if [[ -n "$answer_pw" ]]; then smtp_pw=$answer_pw; fi
  fi
else
  echo "Envoi des e-mails : il se règle aussi plus tard dans l'app (Rendez-vous > Réglages)."
  read -rp "Identifiant SMTP (adresse de la boîte ; Entrée pour passer) : " smtp_user
  if [[ -n "$smtp_user" ]]; then
    read -rsp "Mot de passe SMTP (Entrée pour passer) : " smtp_pw; echo
    if [[ -z "$smtp_pw" ]]; then echo "Pas de mot de passe : l'envoi d'e-mails reste désactivé."; smtp_user=""; fi
  else
    smtp_pw=""
  fi
fi
unset answer answer_pw

# Les valeurs sont écrites entre apostrophes : docker compose les lit telles quelles.
if [[ "$apple_id$app_pw$smtp_user$smtp_pw" == *"'"* || "$apple_id$app_pw$smtp_user$smtp_pw" == *$'\n'* ]]; then
  echo "Les identifiants et mots de passe ne peuvent pas contenir d'apostrophe."; exit 1
fi

# Les autres lignes d'un .env existant (SMTP_HOST, MAIL_FROM, ALFRED_PUBLIC_URL…) sont conservées.
umask 077
managed='^(ALFRED_PASSWORD_HASH|CALDAV_URL|CALDAV_USERNAME|CALDAV_PASSWORD|SMTP_USER|SMTP_PASSWORD)='
tmp=$(mktemp .env.XXXXXX)
{
  echo "ALFRED_PASSWORD_HASH=$hash"
  echo "CALDAV_URL=https://caldav.icloud.com"
  echo "CALDAV_USERNAME='$apple_id'"
  echo "CALDAV_PASSWORD='$app_pw'"
  if [[ -f .env ]]; then
    grep -vE "$managed" .env || true
  else
    echo "CALDAV_SYNC_INTERVAL=120"
    echo "ALFRED_TIMEZONE=Europe/Zurich"
  fi
  if [[ -n "$smtp_user" ]]; then
    echo "SMTP_USER='$smtp_user'"
    echo "SMTP_PASSWORD='$smtp_pw'"
  fi
} > "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
unset app_pw smtp_pw hash
echo "Fichier .env écrit (lisible par toi seul)."
if [[ -n "$smtp_user" ]]; then
  echo "E-mails : envoi activé. Après le démarrage, vérifie-le dans Alfred : Rendez-vous > Réglages > « Envoyer un e-mail d'essai »."
else
  echo "E-mails : envoi non configuré (relance ce script pour l'ajouter)."
fi

docker compose -f deploy/docker-compose.yml up -d --build
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
