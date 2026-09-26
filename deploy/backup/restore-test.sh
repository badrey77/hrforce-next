#!/usr/bin/env bash
# Restore test: proves the newest (or a named) dump restores into an empty PostgreSQL 18, without touching the
# live database. Run on the server, monthly and after any change to the backup setup:
#   deploy/backup/restore-test.sh                       newest dump
#   deploy/backup/restore-test.sh hrforce-20260926T013000Z.dump
# It starts a throwaway postgres:18-alpine with NO network, recreates the roles with create-roles.sql (throwaway
# passwords), runs pg_restore --exit-on-error, and prints row counts next to the live database's. Exit 0 = restorable.
set -euo pipefail
cd "$(dirname "$0")/.."

project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env | tail -n 1)
project=${project:-hrforce-staging}
volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=backups")
[[ -n $volume ]] || { echo "restore-test: no 'backups' volume for compose project $project" >&2; exit 1; }

dump=${1:-}
if [[ -z $dump ]]; then
  dump=$(docker compose exec -T backup sh -c 'ls -1t /backups/hrforce-*.dump 2>/dev/null | head -n 1' | xargs -r basename)
fi
[[ $dump =~ ^hrforce-[0-9TZ]+\.dump$ ]] || { echo "restore-test: no dump found (got '$dump')" >&2; exit 1; }

name="hrforce-restore-test-$$"
image=postgres:18-alpine
echo "restore-test: restoring $dump into throwaway container $name ($image, --network none)"
docker run --detach --rm --name "$name" --network none \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -v "$volume:/backups:ro" \
  -v "$PWD/../apps/api/scripts/create-roles.sql:/hrforce/create-roles.sql:ro" \
  "$image" > /dev/null
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -h 127.0.0.1 -U postgres > /dev/null || { echo "restore-test: postgres did not start" >&2; exit 1; }

docker exec "$name" psql -q -U postgres -v ON_ERROR_STOP=1 \
  -v migrator_password="'$(openssl rand -hex 16)'" -v app_password="'$(openssl rand -hex 16)'" -v db=hrforce \
  -f /hrforce/create-roles.sql
start=$(date +%s)
docker exec "$name" pg_restore -U postgres --dbname=hrforce --exit-on-error "/backups/$dump"
echo "restore-test: pg_restore ok in $(($(date +%s) - start)) s"

counts_sql="select 'last migration', coalesce(max(version)::text, '-') from public.schema_migrations
union all select 'companies', count(*)::text from public.company
union all select 'org units', count(*)::text from public.org_unit
union all select 'user accounts', count(*)::text from auth.user_account
union all select 'role grants', count(*)::text from public.role_grant
union all select 'persons', count(*)::text from public.person
union all select 'audit change_log', count(*)::text from audit.change_log"

restored=$(docker exec "$name" psql -U postgres -d hrforce -At -F '|' -v ON_ERROR_STOP=1 -c "$counts_sql")
live=$(docker compose exec -T postgres psql -U postgres -d hrforce -At -F '|' -c "$counts_sql" 2>/dev/null || echo "")

printf '\n%-18s %12s %12s\n' "" "restored" "live now"
while IFS='|' read -r label value; do
  live_value=$(grep -F "$label|" <<<"$live" | cut -d'|' -f2)
  printf '%-18s %12s %12s\n' "$label" "$value" "${live_value:--}"
done <<<"$restored"
echo
echo "restore-test: OK — $dump is restorable (live counts may be higher: they include changes made since the dump)"
