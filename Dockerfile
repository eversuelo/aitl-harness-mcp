# AITL Harness — imagen de producción (una sola URL: API + SPA estática).
#
# Build:  docker build -t aitl .
# Run:    docker run -p 4317:4317 -e MONGODB_URI="mongodb+srv://…" aitl
# Cloud:  docker compose -f docker-compose.cloud.yml up -d   (ver ese archivo)
#
# Etapa 1 compila el TS (dist/) y la SPA (web/dist); la etapa 2 solo lleva
# runtime deps + artefactos. `aitl ui --static` sirve la SPA desde el puerto
# del API, así el contenedor expone UNA URL compartible.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
# vite build corre con cwd=web: los globs `content` de Tailwind son relativos al cwd.
RUN npm run build && npm run build:web

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime deps solamente (los optionalDeps incluyen los embeddings locales Xenova).
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
EXPOSE 4317
# --watch-restart habilita el botón "reiniciar ahora" de la UI (exit 75 → respawn).
CMD ["node", "dist/src/cli.js", "ui", "--static", "--no-web", "--api-port", "4317", "--watch-restart"]
