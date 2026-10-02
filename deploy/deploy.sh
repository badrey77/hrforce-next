#!/usr/bin/env bash
# Deploys (or rolls back to) one release of HRForce on this host. Run from anywhere; works in deploy/.
#   ./deploy.sh <git-sha>          e.g. ./deploy.sh 5719a52e…  (the full 40-character SHA the images are tagged with)
# Steps: check .env → pull the images of <sha> → run migrations (hrforce_migrator) → start/replace containers →
# wait until every healthcheck passes → record <sha> as HRFORCE_TAG in .env and in releases.log.
# The registry must be reachable: CI logs the host into ghcr.io for the duration of the deploy; for a manual run
# see README.md › Rollback.
set -euo pipefail
cd "$(dirname "$0")"

tag=${1:-}
if [[ ! $tag =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: ./deploy.sh <40-character git sha>   (see releases.log for previous releases)" >&2
  exit 2
fi
[[ -f .env ]] || { echo "deploy: deploy/.env is missing — run ./init-env.sh first (README.md › First install)" >&2; exit 1; }
[[ -f ../apps/api/scripts/create-roles.sql ]] || { echo "deploy: ../apps/api/scripts/ is missing — copy the whole bundle (README.md)" >&2; exit 1; }

# --- sanity checks on .env (values are never printed) --------------------------------------------------------
env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
missing=()
for name in STAGING_DOMAIN ACME_EMAIL POSTGRES_SUPERUSER_PASSWORD HRFORCE_MIGRATOR_PASSWORD HRFORCE_APP_PASSWORD \
            HRFORCE_WORKER_PASSWORD COOKIE_SECRET AUTH_ACCESS_SECRET AUTH_XSRF_SECRET AUTH_MFA_KEY ATTENDANCE_KEY OIDC_KEY SMTP_URL MAIL_FROM; do
  [[ -n $(env_value "$name") ]] || missing+=("$name")
done
if ((${#missing[@]})); then
  echo "deploy: empty in .env: ${missing[*]}" >&2
  exit 1
fi
for name in POSTGRES_SUPERUSER_PASSWORD HRFORCE_MIGRATOR_PASSWORD HRFORCE_APP_PASSWORD HRFORCE_WORKER_PASSWORD; do
  [[ $(env_value "$name") =~ ^[0-9a-f]{32,}$ ]] || { echo "deploy: $name must be hex (openssl rand -hex 32)" >&2; exit 1; }
done
if [[ $(env_value SMTP_URL) == *"user:password@smtp.example.dz"* ]]; then
  echo "deploy: SMTP_URL is still the example value — set your SMTP relay in .env" >&2
  exit 1
fi
if grep -Eq '^(DEV_AUTH|DEV_PERMISSIONS)=|^MAIL_TRANSPORT=log|^COOKIE_SECURE=false' .env; then
  echo "deploy: .env contains a development-only switch (DEV_AUTH / DEV_PERMISSIONS / MAIL_TRANSPORT=log / COOKIE_SECURE=false)" >&2
  exit 1
fi
if [[ $(stat -c %a .env) != 600 ]]; then
  echo "deploy: warning: .env is not mode 600 (chmod 600 .env)" >&2
fi

previous=$(env_value HRFORCE_TAG)
# Shell environment wins over .env for ${HRFORCE_TAG} substitution: .env keeps the old tag until this succeeds.
export HRFORCE_TAG=$tag

echo "deploy: ${previous:-<none>} → $tag"
docker compose pull --quiet
# Roles are cluster-level: re-apply create-roles.sql (idempotent; passwords from .env) so a release that adds a role
# (0012: hrforce_worker) also works on a database created by an older release.
docker compose up --detach --wait postgres
docker compose exec -T postgres psql -q -U postgres -v ON_ERROR_STOP=1 \
  -v migrator_password="'$(env_value HRFORCE_MIGRATOR_PASSWORD)'" -v app_password="'$(env_value HRFORCE_APP_PASSWORD)'" \
  -v worker_password="'$(env_value HRFORCE_WORKER_PASSWORD)'" -v db=hrforce -f /hrforce/create-roles.sql
docker compose run --rm migrate
if ! docker compose up --detach --remove-orphans --wait --wait-timeout 300; then
  echo "deploy: FAILED — containers did not become healthy. Inspect: docker compose ps; docker compose logs --tail=200 api worker" >&2
  [[ -n $previous ]] && echo "deploy: roll back with: ./deploy.sh $previous (migrations are forward-only: see README.md › Rollback)" >&2
  exit 1
fi

# --- record the release ----------------------------------------------------------------------------------------
if grep -q '^HRFORCE_TAG=' .env; then
  sed -i "s/^HRFORCE_TAG=.*/HRFORCE_TAG=$tag/" .env
else
  printf 'HRFORCE_TAG=%s\n' "$tag" >> .env
fi
printf '%s %s previous=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" "${previous:-none}" >> releases.log

# Keep a month of unused images locally (fast manual rollback without registry access), drop the rest.
docker image prune --all --force --filter "until=720h" >/dev/null || true

docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "deploy: $tag is live on https://$(env_value STAGING_DOMAIN)"
