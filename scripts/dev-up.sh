#!/usr/bin/env bash
# Starts HRForce Next locally in one command: Postgres + Mailpit (Docker), migrations, demo seed, API, background
# worker (notification e-mails, cron), web and the SSO demo sister app (apps/sso-demo, http://localhost:4300).
# Usage (repo root):  ./scripts/dev-up.sh          Ctrl+C stops the API, worker, web and SSO demo (the containers keep running).
#                     ./scripts/dev-up.sh --reset  also wipes the database first (docker compose down -v).
# Needs: Node >= 22.22.3, npm 11, Docker. On Windows use WSL or Git Bash.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&(b>22||(b===22&&c>=3)))?0:1)' \
  || { echo "Node >= 22.22.3 is required (found $(node -v))." >&2; exit 1; }

[ -d node_modules ] || { step "Installing dependencies"; npm ci; }
[ -f apps/api/.env ] || { step "Creating apps/api/.env from .env.example"; cp apps/api/.env.example apps/api/.env; }
[ -f apps/sso-demo/.env ] || { step "Creating apps/sso-demo/.env from .env.example"; cp apps/sso-demo/.env.example apps/sso-demo/.env; }
# An .env created before the worker existed: add its settings from .env.example.
if ! grep -q '^WORKER_DATABASE_URL=' apps/api/.env; then
  step "Adding the worker settings (WORKER_DATABASE_URL, WORKER_CONCURRENCY) to apps/api/.env"
  { echo; grep -E '^(WORKER_DATABASE_URL|WORKER_CONCURRENCY)=' apps/api/.env.example; } >> apps/api/.env
fi

if [ "${1:-}" = "--reset" ]; then
  step "Wiping the local database"
  (cd apps/api && docker compose down -v)
fi

step "Starting Postgres and Mailpit"
(cd apps/api && docker compose up -d)
printf 'Waiting for Postgres'
for _ in $(seq 1 60); do
  if (cd apps/api && docker compose exec -T postgres pg_isready -U postgres -d hrforce >/dev/null 2>&1); then break; fi
  printf '.'; sleep 1
done
echo

# A database volume created before migration 0012 has no hrforce_worker role (the init hook only runs on an empty
# volume): create it with the development password of .env.example.
(cd apps/api && docker compose exec -T postgres psql -q -U postgres -v ON_ERROR_STOP=1 -c \
  "do \$\$ begin if not exists (select from pg_roles where rolname = 'hrforce_worker') then
     create role hrforce_worker login nosuperuser nocreatedb nocreaterole nobypassrls password 'hrforce_worker_dev'; end if; end \$\$")

set -a; source apps/api/.env; set +a

step "Migrating and seeding the demo data"
npm run migrate -w @hrforce/api
npm run seed:dev -w @hrforce/api

step "Building the SSO demo sister app"
npm run build -w @hrforce/sso-demo

step "Starting the API (http://localhost:3000), the worker, the web app (http://localhost:4200) and the SSO demo (http://localhost:4300)"
npm start -w @hrforce/api &
API_PID=$!
# Background jobs (Graphile Worker): notification e-mails and the monthly/daily cron. Built by seed:dev above.
npm run start:worker -w @hrforce/api &
WORKER_PID=$!
# PORT (3000, from apps/api/.env above) would override `ng serve --port 4200`: the Angular dev server reads
# process.env.PORT first, and would then take the API's port.
PORT=4200 npm start -w @hrforce/web &
WEB_PID=$!
# SSO demo sister app: reads apps/sso-demo/.env (SSO_DEMO_PORT=4300; PORT is not used). It waits for HRForce's OpenID
# discovery (through the web dev server's /oidc proxy), retrying for 60 s.
env -u PORT npm start -w @hrforce/sso-demo &
DEMO_PID=$!
trap 'kill $API_PID $WORKER_PID $WEB_PID $DEMO_PID 2>/dev/null; exit 0' INT TERM

cat <<'EOF'

  Open http://localhost:4200 — password for every demo user: demo-password-2026
    rh.admin@demo.dz       central HR admin (everything, salaries, Access screens)
    rh.est@demo.dz         regional HR, Région Est (Arabic UI)
    lecture.ouest@demo.dz  read-only, Région Ouest
  Mails (password links, notification e-mails sent by the worker): http://localhost:8025
  SSO demo: http://localhost:4300 — agent.annaba@demo.dz (Opérateur), chef.annaba@demo.dz (Superviseur), rh.est@demo.dz (aucun rôle, arabe)
  Ctrl+C stops the API, worker, web and SSO demo; `cd apps/api && docker compose down` stops the database.

EOF
wait
