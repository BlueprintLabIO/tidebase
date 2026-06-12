# Tidebase server image. Build context must be the repo root:
#   docker build -f apps/server/Dockerfile -t tidebase .
# Run:
#   docker run -p 7373:7373 -e DATABASE_URL=postgres://... ghcr.io/blueprintlabio/tidebase
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --frozen-lockfile --filter @tidebase/server --filter @tidebase/sdk
COPY packages/sdk packages/sdk
COPY apps/server apps/server
RUN pnpm --filter @tidebase/sdk build && pnpm --filter @tidebase/server build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Keep the repo layout: dist/db.js resolves migrations at ../../../migrations.
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY migrations migrations
# The workspace package.json uses workspace: specifiers npm can't install;
# the runtime needs only the four production deps.
RUN printf '{"name":"tidebase-server","private":true,"type":"module"}' > apps/server/package.json \
  && cd apps/server && npm install --omit=dev --no-audit --no-fund \
  hono@^4.6.16 @hono/node-server@^1.13.8 pg@^8.13.1 zod@^3.24.1
EXPOSE 7373
CMD ["node", "apps/server/dist/index.js"]
