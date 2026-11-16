#!/bin/sh
# Respaldo diario de la base de datos (corre dentro del servicio "backup" del compose).
# Guarda un .sql.gz por dia en /backups y borra los de mas de KEEP_DAYS (14 por defecto).
set -eu
KEEP_DAYS="${KEEP_DAYS:-14}"
export PGPASSWORD="${POSTGRES_PASSWORD}"
while true; do
  stamp="$(date +%Y-%m-%d_%H%M)"
  if pg_dump -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner | gzip > "/backups/empleado_${stamp}.sql.gz.tmp"; then
    mv "/backups/empleado_${stamp}.sql.gz.tmp" "/backups/empleado_${stamp}.sql.gz"
    echo "[backup] listo: empleado_${stamp}.sql.gz"
  else
    rm -f "/backups/empleado_${stamp}.sql.gz.tmp"
    echo "[backup] FALLO el respaldo ${stamp}" >&2
  fi
  find /backups -name 'empleado_*.sql.gz' -mtime +"${KEEP_DAYS}" -delete
  sleep 86400
done
