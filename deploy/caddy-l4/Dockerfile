# Caddy du VPS + module layer4, pour le relais visio d'Alfred sur le port 443 (voir docs/DEPLOIEMENT.md,
# « Relais pour les réseaux filtrés »). Même version de Caddy et même image de base qu'avant
# (caddy:2.10.2-alpine, empreinte identique) : seul le module layer4 est ajouté.
# Construit sur le VPS par deploy/relais-visio.sh (4 à 6 minutes, ~600 Mo de mémoire au plus).
FROM caddy:2.10.2-builder-alpine AS build
# caddy-l4 au dernier commit compatible avec Caddy 2.10.2 (les versions suivantes exigent Caddy 2.11).
ARG CADDY_L4=github.com/mholt/caddy-l4@b02a6fd06dafbaa1f950d099eb73e4ac77d70b06
# Une compilation à la fois : plus lent, mais la mémoire reste basse sur un VPS partagé.
ENV GOFLAGS=-p=1 GOTOOLCHAIN=auto
RUN xcaddy build v2.10.2 --with "$CADDY_L4" --output /usr/bin/caddy-l4 \
 && /usr/bin/caddy-l4 list-modules | grep -q '^caddy.listeners.layer4$'

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY --from=build /usr/bin/caddy-l4 /usr/bin/caddy
