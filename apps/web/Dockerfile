# syntax=docker/dockerfile:1.7
# HRForce web image: the Angular production build baked into a small Caddy static server (deploy/web/Caddyfile).
# Build from the REPOSITORY ROOT (npm workspaces share the root lockfile):
#   docker build -f apps/web/Dockerfile -t hrforce-web .
# Run:  docker run -p 8080:8080 hrforce-web      → http://localhost:8080 (static files only; no /api, no TLS)
#
# Why a Caddy image with the files baked in (not a "static files only" image copied into a volume):
#  - one immutable artifact per git SHA, pulled and rolled back exactly like the API image (deploy.sh <sha>);
#  - no shared volume to populate and keep in sync between releases, no init container;
#  - the edge proxy (deploy/Caddyfile) keeps TLS, security headers and /api routing, so this image only knows how
#    to serve files: cache headers for hashed bundles, SPA fallback to index.html.

ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2.10-alpine
ARG NPM_VERSION=11.20.0

# ---- deps: web workspace dependencies ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ARG NPM_VERSION
RUN npm install -g npm@${NPM_VERSION}
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
# Every workspace manifest must be present for `npm ci` to validate the shared lockfile.
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci -w @hrforce/web --include-workspace-root=false --ignore-scripts

# ---- build: Angular production build (+ CSP compatibility check of index.html) ---------------------------------
FROM deps AS build
# CI=true: no interactive prompts, no persistent build cache.
ENV CI=true NG_CLI_ANALYTICS=false
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY deploy/web/check-index-csp.mjs /tools/check-index-csp.mjs
RUN npm run build -w @hrforce/web \
 && node /tools/check-index-csp.mjs apps/web/dist/web/browser/index.html

# ---- runtime: Caddy serving /srv on :8080 as an unprivileged user ----------------------------------------------
FROM ${CADDY_IMAGE} AS runtime
# Caddy wants writable config/data dirs even with admin and autosave off; /tmp is a tmpfs in compose (read-only root).
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
# The official binary carries cap_net_bind_service=+ep; this server listens on :8080 and runs with every capability
# dropped (compose), where a file capability would make exec fail. setcap comes with the base image (libcap).
RUN setcap -r /usr/bin/caddy
COPY --chown=root:root deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build --chown=root:root /repo/apps/web/dist/web/browser /srv
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
