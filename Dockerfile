# Image d'Alfred : un seul conteneur léger (serveur + app web compilée).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3200 \
    ALFRED_DATA_DIR=/data \
    TZ=Europe/Zurich
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3200/healthz || exit 1
# Tas limité pour rester très sobre sur un petit VPS.
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=128", "dist/server/index.js"]
