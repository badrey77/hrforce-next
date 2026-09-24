#!/bin/sh
# docker-entrypoint-initdb.d hook for the official postgres image (see apps/api/docker-compose.yml).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="'${HRFORCE_MIGRATOR_PASSWORD}'" \
  -v app_password="'${HRFORCE_APP_PASSWORD}'" \
  -v db="${HRFORCE_DB:-hrforce}" \
  -f /hrforce/create-roles.sql
