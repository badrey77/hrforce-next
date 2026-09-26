#!/usr/bin/env bash
# Starts HRForce Next locally in one command: Postgres + Mailpit (Docker), migrations, demo seed, API and web.
# Usage (repo root):  ./scripts/dev-up.sh          Ctrl+C stops the API and web (the containers keep running).
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

set -a; source apps/api/.env; set +a

step "Migrating and seeding the demo data"
npm run migrate -w @hrforce/api
npm run seed:dev -w @hrforce/api

step "Starting the API (http://localhost:3000) and the web app (http://localhost:4200)"
npm start -w @hrforce/api &
API_PID=$!
npm start -w @hrforce/web &
WEB_PID=$!
trap 'kill $API_PID $WEB_PID 2>/dev/null; exit 0' INT TERM

cat <<'EOF'

  Open http://localhost:4200 — password for every demo user: demo-password-2026
    rh.admin@demo.dz       central HR admin (everything, salaries, Access screens)
    rh.est@demo.dz         regional HR, Région Est (Arabic UI)
    lecture.ouest@demo.dz  read-only, Région Ouest
  Mails (password links): http://localhost:8025
  Ctrl+C stops the API and web; `cd apps/api && docker compose down` stops the database.

EOF
wait
