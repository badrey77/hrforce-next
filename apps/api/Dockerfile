# syntax=docker/dockerfile:1.7
# HRForce API image. Build from the REPOSITORY ROOT (npm workspaces share the root lockfile):
#   docker build -f apps/api/Dockerfile -t hrforce-api .
# Run:      docker run --env-file apps/api/.env -p 3000:3000 hrforce-api
# Migrate:  docker run --env-file apps/api/.env hrforce-api node dist/platform/db/migrate.js

ARG NODE_IMAGE=node:22-alpine
ARG NPM_VERSION=11.20.0

# ---- deps: full install (dev deps needed to compile) -------------------------------------------
FROM ${NODE_IMAGE} AS deps
ARG NPM_VERSION
RUN npm install -g npm@${NPM_VERSION}
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
# Every workspace manifest must be present for `npm ci` to validate the shared lockfile.
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci -w @hrforce/api --include-workspace-root=false --ignore-scripts

# ---- build: compile TypeScript ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build -w @hrforce/api

# ---- prod-deps: runtime dependencies only -------------------------------------------------------
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm npm ci -w @hrforce/api --include-workspace-root=false --omit=dev --ignore-scripts

# ---- runtime ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app/apps/api
COPY --from=prod-deps --chown=root:root /repo/node_modules /app/node_modules
COPY --from=build --chown=root:root /repo/apps/api/package.json ./package.json
COPY --from=build --chown=root:root /repo/apps/api/dist ./dist
COPY --from=build --chown=root:root /repo/apps/api/migrations ./migrations
# Files are root-owned and read-only for the runtime user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "dist/main.js"]
