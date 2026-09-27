#!/usr/bin/env bash
# Creates deploy/.env from .env.staging.example with every secret generated (first install only).
#   ./init-env.sh staging.hrforce.example.dz ops@example.dz
# Then edit SMTP_URL and MAIL_FROM in .env. Refuses to overwrite an existing .env.
set -euo pipefail
cd "$(dirname "$0")"

domain=${1:?usage: ./init-env.sh <staging-domain> <acme-email>}
email=${2:?usage: ./init-env.sh <staging-domain> <acme-email>}

if [[ -e .env ]]; then
  echo "init-env: .env already exists — not touching it" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "init-env: openssl is required" >&2; exit 1; }

hex() { openssl rand -hex 32; }
b64() { openssl rand -base64 48 | tr -d '\n'; }

umask 077
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    STAGING_DOMAIN=*) line="STAGING_DOMAIN=$domain" ;;
    ACME_EMAIL=*) line="ACME_EMAIL=$email" ;;
    POSTGRES_SUPERUSER_PASSWORD=*) line="POSTGRES_SUPERUSER_PASSWORD=$(hex)" ;;
    HRFORCE_MIGRATOR_PASSWORD=*) line="HRFORCE_MIGRATOR_PASSWORD=$(hex)" ;;
    HRFORCE_APP_PASSWORD=*) line="HRFORCE_APP_PASSWORD=$(hex)" ;;
    HRFORCE_WORKER_PASSWORD=*) line="HRFORCE_WORKER_PASSWORD=$(hex)" ;;
    COOKIE_SECRET=*) line="COOKIE_SECRET=$(b64)" ;;
    AUTH_ACCESS_SECRET=*) line="AUTH_ACCESS_SECRET=$(b64)" ;;
    AUTH_XSRF_SECRET=*) line="AUTH_XSRF_SECRET=$(b64)" ;;
    AUTH_MFA_KEY=*) line="AUTH_MFA_KEY=$(openssl rand -base64 32)" ;;
  esac
  printf '%s\n' "$line"
done < .env.staging.example > "$tmp"
mv "$tmp" .env
trap - EXIT
echo "init-env: wrote .env (mode 600). Now set SMTP_URL and MAIL_FROM in it, then run the first deploy."
