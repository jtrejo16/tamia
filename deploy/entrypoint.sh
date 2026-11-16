#!/bin/sh
# Arranca el rol pedido en APP_ROLE. Sin pnpm en tiempo de ejecucion: se llama a cada herramienta directo.
set -eu

case "${APP_ROLE:-}" in
  web)
    cd /app/apps/web
    exec ./node_modules/.bin/next start -p "${PORT:-3000}"
    ;;
  worker)
    cd /app/apps/worker
    exec ./node_modules/.bin/tsx src/main.ts
    ;;
  migrate)
    cd /app/packages/db
    exec ./node_modules/.bin/tsx src/migrate.ts
    ;;
  *)
    echo "APP_ROLE debe ser web, worker o migrate (recibido: '${APP_ROLE:-}')" >&2
    exit 64
    ;;
esac
