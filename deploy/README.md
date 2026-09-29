# Staging deploy pack

Runs HRForce on **one Linux server with Docker**, deployed from GitHub Actions. Contract: [`docs/contracts/staging.md`](../docs/contracts/staging.md).

```
Internet ──:80/:443──▶ proxy (Caddy, HTTPS for $STAGING_DOMAIN, security headers + CSP)
                          ├── /api, /api/* ──▶ api:3000   (hrforce-api image, NODE_ENV=production, DB role hrforce_app)
                          └── everything else ▶ web:8080  (hrforce-web image: Angular build + static Caddy, SPA fallback)
api ──▶ postgres:5432 (postgres:18-alpine; internal network only, never published)
worker ──▶ postgres (same hrforce-api image, `node dist/worker.js`, DB role hrforce_worker; no port) ──▶ SMTP relay
migrate (one-shot, hrforce_migrator) · backup (nightly pg_dump → volume `backups`, 14 days)
```

| File | Purpose |
|---|---|
| `compose.staging.yml` | the stack: `postgres`, `migrate`, `api`, `worker`, `web`, `proxy`, `backup` |
| `Caddyfile` | edge proxy: TLS, routing, headers, access log (setup tokens stripped) |
| `web/Caddyfile`, `web/check-index-csp.mjs` | baked into the web image by `apps/web/Dockerfile` |
| `.env.staging.example` | every variable, commented; the real file is `deploy/.env` on the server |
| `init-env.sh` | creates `.env` with generated secrets |
| `deploy.sh <sha>` | pull → roles (create-roles.sql) → migrate → up → wait for health → record the release (also the rollback command) |
| `smoke.sh <url>` | post-deploy checks (health, SPA, headers/CSP, 401 problem+json, redirects) |
| `backup/backup.sh`, `backup/restore-test.sh` | nightly dump; restore test into a throwaway container |
| `../.github/workflows/deploy-staging.yml` | CI: build and push images to GHCR, deploy over SSH, smoke check |

Images: `ghcr.io/<owner>/hrforce-api:<git sha>` and `ghcr.io/<owner>/hrforce-web:<git sha>`, also tagged `staging`. The
server always runs **by SHA**: the running release is `HRFORCE_TAG` in `deploy/.env`, and every release is listed in `deploy/releases.log`.

## Server prerequisites

- Ubuntu 24.04 LTS, 2 vCPU / 4 GB RAM / 40 GB disk is plenty for staging.
- Docker Engine + Compose plugin from Docker's apt repository ([docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/)); check with `docker compose version` (≥ 2.24).
- DNS: an **A record** (and AAAA if the host has IPv6) for the staging domain → the server's public IP.
- Firewall: inbound **22** (SSH; restrict it to your IPs if you can), **80** and **443** (TCP; 443/UDP too for HTTP/3). Nothing else: Postgres is not published.
- Outbound: 443 (Let's Encrypt, ghcr.io) and your SMTP relay's port (465 or 587).
- A deploy user in the `docker` group, owning the deploy directory:

```sh
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy /opt/hrforce
# CI's public key → /home/deploy/.ssh/authorized_keys (the private key goes into the STAGING_SSH_KEY secret):
ssh-keygen -t ed25519 -N "" -C hrforce-staging-ci -f hrforce-staging-ci    # on your machine
```

Note: membership of the `docker` group is root-equivalent on that host; use this user for deploys only.

## CI secrets (GitHub → Settings → Secrets and variables → Actions → *Repository* secrets)

| Secret | Value |
|---|---|
| `STAGING_HOST` | server IP or DNS name. **Unset = images are still built and pushed, the deploy job is skipped with a notice.** |
| `STAGING_USER` | `deploy` |
| `STAGING_SSH_KEY` | the private key (`hrforce-staging-ci`), whole file |
| `STAGING_DOMAIN` | e.g. `staging.hrforce.example.dz` (used by the smoke check) |
| `STAGING_SSH_KNOWN_HOSTS` | optional but recommended: output of `ssh-keyscan -H <host>` run from a trusted network; without it the first key seen is trusted |

Optional repository *variables*: `STAGING_DIR` (default `/opt/hrforce`), `STAGING_SSH_PORT` (default `22`).
GHCR needs no secret: the workflow uses `GITHUB_TOKEN` to push, and hands the server that short-lived token to pull
during the deploy (then logs it out). The first push creates the packages `hrforce-api` / `hrforce-web` under your
account, private by default.

## First install

1. **Copy the bundle** to the server (the workflow does this on every deploy; for the first install do it by hand, or
   run the workflow once and let it fail at `deploy.sh` because `.env` is missing):

   ```sh
   # from a checkout of the repository, on your machine
   tar -czf - deploy apps/api/scripts | ssh deploy@<host> 'tar -xzf - -C /opt/hrforce'
   ```

   The server layout mirrors the repository: `/opt/hrforce/deploy/…` and `/opt/hrforce/apps/api/scripts/…`
   (the Postgres init hook `create-roles.sql` + `docker-init-roles.sh`).

2. **Create `.env`** with every secret generated:

   ```sh
   ssh deploy@<host>
   cd /opt/hrforce/deploy
   ./init-env.sh staging.hrforce.example.dz ops@example.dz
   nano .env        # set SMTP_URL and MAIL_FROM (and HRFORCE_REGISTRY if the GitHub owner is not badrey77)
   ```

   What `init-env.sh` does, if you prefer to do it by hand (`cp .env.staging.example .env && chmod 600 .env`):
   - `POSTGRES_SUPERUSER_PASSWORD`, `HRFORCE_MIGRATOR_PASSWORD`, `HRFORCE_APP_PASSWORD`, `HRFORCE_WORKER_PASSWORD`:
     `openssl rand -hex 32` each
     (hex because they go into `postgres://` URLs);
   - `COOKIE_SECRET`, `AUTH_ACCESS_SECRET`, `AUTH_XSRF_SECRET`: `openssl rand -base64 48` each (all different).
   - `AUTH_MFA_KEY`: `openssl rand -base64 32` (exactly 32 bytes; key of the two-step sign-in secrets). **Existing
     installs: add it to `.env` before the next deploy** (the API refuses to start without it in production).

   **Back up `.env` somewhere safe** (password manager): without it, backups can still be restored but every
   password must be reset.

3. **Deploy**: push to `main` (the deploy runs after CI is green) or *Actions → Deploy staging → Run workflow* on
   `main` with an empty sha. The first run creates the database: the Postgres container runs `create-roles.sql` on
   its empty volume (roles `hrforce_migrator`, `hrforce_app` and `hrforce_worker` with the `.env` passwords, database
   `hrforce`), then `migrate` applies every migration and installs the job queue schema, then the stack starts and
   Caddy obtains the certificate. By hand, on the server:
   `docker login ghcr.io` (a PAT with `read:packages`), then `./deploy.sh <full sha>`.

4. **Check**: `./smoke.sh https://staging.hrforce.example.dz` (CI runs it too), `docker compose ps`,
   `docker compose logs --tail=100 api proxy`.

5. **Create the first real admin** (see below). Optionally load demo data (see below).

## Everyday operations (on the server, in `/opt/hrforce/deploy`)

`.env` sets `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, so plain `docker compose …` works in this directory.

```sh
docker compose ps
docker compose logs -f --tail=200 api          # JSON logs (pino); proxy = access log
docker compose logs -f --tail=200 worker       # one JSON line per job: "job done" / "job failed" (task, jobId, attempt)
docker compose restart api
docker compose exec postgres psql -U postgres -d hrforce
cat releases.log                               # what ran when
```

### Update

Automatic: every push to `main` whose CI run succeeds is built, pushed and deployed (one deploy at a time;
`concurrency` queues the next). Manual: *Run workflow* on a branch with an empty sha. Under the hood:
`docker compose pull`, re-apply `create-roles.sql` (idempotent, passwords from `.env` — so a release that adds a role
works on an existing database), `docker compose run --rm migrate && docker compose up -d --wait` (`deploy.sh`).

**Upgrading an install from before the worker (migration 0012):** add `HRFORCE_WORKER_PASSWORD=$(openssl rand -hex 32)`
(and optionally `WORKER_CONCURRENCY=4`) to `.env` first; `deploy.sh` refuses to run without it, then creates the role.

### Background worker

`worker` runs the jobs the API enqueues in its transactions (one notification e-mail per notification, sent through
`SMTP_URL`) and the cron (UTC): audit partitions (1st of the month 00:10), leave accruals for the previous month (1st,
01:00), auth cleanup (daily 03:00), read-notification cleanup (daily 03:30). Missed ticks are caught up when it starts
again (7 days back for the monthly jobs, 12 h for the daily ones). `docker compose stop worker` is safe: queued jobs
wait in Postgres. Health = a heartbeat file touched every 30 s after a database check. Inspect the queue:
`docker compose exec postgres psql -U postgres -d hrforce -c "select task_identifier, attempts, last_error, run_at from graphile_worker.jobs order by run_at"`.
Live notifications (`/api/me/notifications/stream`) are Server-Sent Events: Caddy flushes `text/event-stream`
immediately (no config needed); the stream closes itself within 15 minutes and the browser reconnects.

### Rollback

- **From GitHub:** *Actions → Deploy staging → Run workflow*, `sha` = a previous full SHA (see `releases.log` or the
  workflow summaries). Nothing is rebuilt: the images of that SHA are pulled and deployed with that commit's
  `deploy/` files.
- **On the server:** `./deploy.sh <previous sha>` (the images of the last 30 days stay in the local cache; older ones
  need `docker login ghcr.io` with a PAT that has `read:packages`).

Migrations are **forward-only**: rolling back the code does not roll back the schema. That is safe as long as each
migration stays compatible with the previous release (add columns/tables; drop only in a later release). If a
migration itself is the problem, restore the pre-deploy backup (below) and then deploy the older SHA.
Take a manual dump before a risky deploy: `docker compose exec backup /bin/sh /hrforce/backup.sh --once`.

### First company and admin (empty database)

Run **once**, in the API image as the migrator (the `migrate` service carries `MIGRATOR_DATABASE_URL`, `WEB_BASE_URL`
and the SMTP settings; the running `api` container deliberately has no migrator credentials):

```sh
docker compose run --rm migrate node dist/scripts/bootstrap.js \
  --company-code ACME --company-name "ACME SPA" \
  --root-code DG --root-name "Direction Générale" --root-name-ar "المديرية العامة" \
  --site-code HQ --site-name "Siège" --wilaya "Alger" \
  --admin-email prenom.nom@example.dz --admin-name "Prénom Nom" --locale fr
```

It creates the company, its root unit and site, the system roles, the default leave types, holidays and approval
workflows (no demo data), and invites the admin with `admin_rh_central` on the whole company. The admin receives a 72 h
link to `https://$STAGING_DOMAIN/password/setup?token=…`, then builds the rest of the organisation, invites nobody
else by hand and grants roles from the Access screens. It refuses to run twice for the same company code.

More accounts later (no role granted — grant it in Access afterwards):

```sh
docker compose run --rm migrate node dist/scripts/user-invite.js \
  --email prenom.nom@example.dz --name "Prénom Nom" --company ACME --locale fr
```

### Demo data (only if wanted — never automatic)

`seed:dev` creates the `DEMO` company, its organisation, 40 **fictitious** employees and three users with the
**publicly known** password `demo-password-2026`. It refuses `NODE_ENV=production`, so it has to be asked for explicitly:

```sh
docker compose run --rm -e NODE_ENV=development migrate node dist/scripts/seed-dev.js
```

Anyone who finds the staging URL can then sign in as `rh.admin@demo.dz`. Restrict access (firewall / VPN) or change
those passwords (`/password/forgot` flow) right after seeding.

### Rotate secrets

- `COOKIE_SECRET`, `AUTH_ACCESS_SECRET`, `AUTH_XSRF_SECRET`: edit `.env`, `docker compose up -d api` (signs everyone out).
- `AUTH_MFA_KEY`: **no rotation procedure yet** — a new key makes every enrolled authenticator unusable (each user then
  needs "Reset two-step sign-in" by an admin). Keep a copy of it outside the server (apps/api/README.md › Two-step sign-in).
- DB passwords (`.env` is only read by the init hook on the first start): edit `.env`, then
  ```sh
  docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 \
    -v migrator_password="'$(sed -n 's/^HRFORCE_MIGRATOR_PASSWORD=//p' .env)'" \
    -v app_password="'$(sed -n 's/^HRFORCE_APP_PASSWORD=//p' .env)'" \
    -v worker_password="'$(sed -n 's/^HRFORCE_WORKER_PASSWORD=//p' .env)'" -v db=hrforce \
    -f /hrforce/create-roles.sql
  docker compose exec -T postgres psql -U postgres -c "alter role postgres password '$(sed -n 's/^POSTGRES_SUPERUSER_PASSWORD=//p' .env)'"
  docker compose up -d api worker backup
  ```

## Backups

- `backup` service: `pg_dump --format=custom` of `hrforce` every night at `BACKUP_TIME_UTC` (default 01:30 UTC =
  02:30 Algiers), plus one immediately when the newest dump is older than 24 h (first start, host was down). Each dump
  is checked with `pg_restore --list` before it counts; dumps older than `BACKUP_RETENTION_DAYS` (14) are removed only
  after a successful dump. Files: `hrforce-<UTC timestamp>.dump` in the Docker volume `hrforce-staging_backups`.
- Dumps contain personal data and password hashes: they are mode 600 and stay on the server. **Copy them off the
  host** (a disk loss takes the volume with it), e.g. from another machine:
  ```sh
  ssh deploy@<host> 'cd /opt/hrforce/deploy && docker compose exec -T backup sh -c "cat \$(ls -1t /backups/hrforce-*.dump | head -n 1)"' > hrforce-latest.dump
  ```
- Roles are cluster-level and not in the dump; they are recreated from `.env` by `create-roles.sql`.
- **Employee files** (uploaded PDF/JPEG/PNG, docs/contracts/documents.md › Phase B) are stored in Postgres and are in
  every dump. A file deleted in the app (or purged by the retention job) is gone from the database at once but stays
  in the dumps taken before, i.e. up to `BACKUP_RETENTION_DAYS` (14 days) on the server — and as long as any copy
  taken off the host is kept. Uploads are limited by the API (`EMPLOYEE_FILE_MAX_BYTES`, default 10 MB, at most
  20 MB; optional in `.env`) and by Caddy (`request_body max_size 25MB` on `POST /api/employees/*/files`); expect the
  dump to grow by the size of the files uploaded.
- Manual dump now: `docker compose exec backup /bin/sh /hrforce/backup.sh --once`. List: `docker compose exec backup ls -lh /backups`.

### Restore test (monthly, and after any change to the backup setup)

```sh
cd /opt/hrforce/deploy
./backup/restore-test.sh                                    # newest dump
./backup/restore-test.sh hrforce-20260926T013000Z.dump      # a given one
```

It starts a throwaway `postgres:18-alpine` with **no network**, recreates the roles with `create-roles.sql`
(throwaway passwords), runs `pg_restore --exit-on-error`, and prints restored row counts (last migration, companies,
org units, user accounts, grants, persons, audit rows) next to the live database's, then removes the container.
Exit code 0 = the dump is restorable. Record the date and result.

### Restore for real (replaces the live database)

```sh
cd /opt/hrforce/deploy
docker compose exec backup /bin/sh /hrforce/backup.sh --once           # safety copy of the current state
docker compose stop api worker
docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 \
  -c "drop database hrforce with (force)" -c "create database hrforce owner hrforce_migrator"
docker compose exec -T backup pg_restore --dbname=hrforce --exit-on-error /backups/hrforce-<timestamp>.dump
docker compose start api worker && ./smoke.sh https://$(sed -n 's/^STAGING_DOMAIN=//p' .env)
```

Then deploy the SHA that matches the restored schema if it is older than the running one (`releases.log`).

## Security notes

- The API gets only the `hrforce_app` URL, the worker only the `hrforce_worker` URL (RLS applies to both; the worker
  sets each job's company); the migrator password lives in the one-shot `migrate` container, the superuser password in
  `postgres` and `backup`. `DEV_AUTH`, `DEV_PERMISSIONS`, `MAIL_TRANSPORT=log` and
  `COOKIE_SECURE=false` are never set (the API refuses them in production; `deploy.sh` refuses an `.env` containing them).
- The proxy strips `X-Dev-User-Id` / `X-Dev-Company-Id`, replaces any client `X-Forwarded-For` (so the login throttle
  sees the real IP with `TRUST_PROXY_HOPS=1`), removes the `Server` header, and drops the `token` query parameter from
  its access log.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  connect-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`.
  `style-src 'unsafe-inline'` is needed because Angular inserts component styles as `<style>` elements at runtime;
  scripts are strictly same-origin files. The web image build fails if `index.html` gains an inline script or event
  handler (e.g. Angular's critical-CSS inlining, which must stay off: `inlineCritical: false`).
- HSTS is `max-age=31536000` without `includeSubDomains`/`preload` (a staging host should not pin its parent domain).
  `X-Robots-Tag: noindex` keeps staging out of search engines.
- Containers: `api`, `worker` and `web` run as non-root with a read-only root filesystem and every capability dropped; `proxy`
  keeps only `NET_BIND_SERVICE`.

### Protect the `staging` environment

In GitHub → Settings → Environments → `staging`: add a **deployment branch rule** allowing only `main`, and optionally
required reviewers. The workflow already refuses manual runs from other branches; the environment rule also protects
the SSH secrets from workflows on other branches.
