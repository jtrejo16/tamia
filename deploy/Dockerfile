# Una sola imagen para todo: el ROL se elige con la variable APP_ROLE (web | worker | migrate).
#   web     -> panel (Next.js)         puerto 3000
#   worker  -> colas, recordatorios, conciliacion de cobros
#   migrate -> aplica migraciones y fija la contrasena del rol de la app (corre y termina)
# Contexto de construccion: la RAIZ del repositorio:  docker build -f deploy/Dockerfile .

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
# Instalacion exacta segun pnpm-lock.yaml (sin sorpresas de versiones).
RUN pnpm install --frozen-lockfile
# El panel se compila una vez, aqui. (Las variables secretas NO hacen falta para compilar.)
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @empleado/web build

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Donde el agente busca los "packs" de giro (ver packages/agent/src/pack.ts).
ENV PACKS_DIR=/app/packs
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
