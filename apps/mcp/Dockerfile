# Tidebase product MCP server image. Build context must be the repo root:
#   docker build -f apps/mcp/Dockerfile -t tidebase-mcp .
# Reaches the Tidebase server via TIDEBASE_URL / TIDEBASE_API_KEY at runtime.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN pnpm install --frozen-lockfile --filter @tidebase/mcp-server
COPY apps/mcp apps/mcp
# build = bundle the guest MCP-App (esbuild) into a string + tsc the server
RUN pnpm --filter @tidebase/mcp-server build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/mcp/dist apps/mcp/dist
# Runtime needs only hono + @mcp-ui/server (createUIResource); the guest app SDK
# is bundled into the resource HTML at build time, so it is not a runtime dep.
RUN printf '{"name":"tidebase-mcp","private":true,"type":"module"}' > apps/mcp/package.json \
  && cd apps/mcp && npm install --omit=dev --no-audit --no-fund \
  hono@^4.6.16 @hono/node-server@^1.13.8 @mcp-ui/server@^6.1.0
EXPOSE 7377
CMD ["node", "apps/mcp/dist/index.js"]
