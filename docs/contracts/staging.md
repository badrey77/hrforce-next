# Contract — Staging deploy pack (M1 exit item "deployed to staging from CI")

Target is not chosen yet (open question). Deliver a pack that runs on **any single Linux server with Docker** and a CI job that deploys to it when the owner provides the host.

## Deliverables (all under `deploy/` unless stated)

- `deploy/compose.staging.yml`: services `postgres` (18, persistent volume, not published to the internet), `migrate` (one-shot: the API image running migrations as the migrator role, then exits), `api` (the API image, `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`, no dev flags), `web` (a new web image: Angular production build served by the reverse proxy), `proxy` (**Caddy**: automatic HTTPS for `${STAGING_DOMAIN}`, serves the web app with SPA fallback, proxies `/api` to `api:3000`, security headers incl. a strict CSP compatible with the app (self-hosted fonts, no inline scripts), HSTS, `Referrer-Policy: no-referrer`), and `backup` (nightly `pg_dump` to a volume with 14-day retention).
- `apps/web/Dockerfile`: multi-stage build → static files (or directly a Caddy image with the files baked in — choose and justify).
- `deploy/.env.staging.example`: every variable with a comment; secrets generated with `openssl rand -base64 48`; roles/passwords for `hrforce_migrator` and `hrforce_app` created by the Postgres init script already in `apps/api/scripts`.
- `deploy/README.md`: server prerequisites (Ubuntu 24.04, Docker, DNS A record, ports 80/443), first install, update, rollback (image tags = git SHA), backup/restore test, how to create the first real admin (`user:invite` inside the api container) and how to seed demo data **only if wanted** (never automatic on staging).
- `.github/workflows/deploy-staging.yml`: on push to `main` after CI succeeds (`workflow_run`) or manual dispatch: build and push `hrforce-api` and `hrforce-web` images to **GHCR** tagged with the SHA and `staging`; then deploy over SSH (`appleboy/ssh-action` pinned by SHA, or plain ssh) with `docker compose pull && docker compose run --rm migrate && docker compose up -d`; secrets `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY`, `STAGING_DOMAIN`; the job is skipped with a clear message when `STAGING_HOST` is not set. `permissions:` minimal (`contents: read`, `packages: write`).
- A smoke-check script `deploy/smoke.sh <url>`: `/api/health` 200, the SPA loads, security headers present, `GET /api/me` → 401 problem+json.

## Constraints

- Postgres only (ADR 005): no Redis or other services. Mail via an external SMTP relay (`SMTP_URL`).
- Nothing in the pack may enable `DEV_AUTH`, `DEV_PERMISSIONS`, `MAIL_TRANSPORT=log` or `COOKIE_SECURE=false` (the API refuses them in production anyway — keep it that way).
- Validate everything that can be validated here: `docker compose config` syntax (install the compose plugin binary if needed; image pulls are blocked in this sandbox), YAML lint of the workflow, `caddy validate` if the binary can be installed, shellcheck on scripts, the web production build output served locally with the Caddyfile rules reproduced (or explain what couldn't be verified).
