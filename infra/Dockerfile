FROM node:24.12.0-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/mcp-adapter/package.json ./apps/mcp-adapter/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN pnpm install --frozen-lockfile
FROM dependencies AS backend-build
COPY apps/server ./apps/server
COPY apps/mcp-adapter ./apps/mcp-adapter
COPY packages ./packages
COPY scripts ./scripts
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm --filter @contest-center/server db:generate
RUN pnpm --filter @contest-center/server... --filter @contest-center/mcp-adapter build

FROM node:24.12.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.25.0
# Dependencies are verified and installed in the build stage; startup must stay offline.
ENV NODE_ENV=production PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
WORKDIR /app
COPY --from=backend-build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=backend-build --chown=node:node /app/node_modules ./node_modules
COPY --from=backend-build --chown=node:node /app/apps/server ./apps/server
COPY --from=backend-build --chown=node:node /app/apps/mcp-adapter ./apps/mcp-adapter
COPY --from=backend-build --chown=node:node /app/packages ./packages
COPY --from=backend-build --chown=node:node /app/scripts/archive-crypto.ts /app/scripts/restore-public-url.ts ./scripts/
WORKDIR /app/apps/server
USER node
CMD ["pnpm","start"]

FROM runtime AS worker
CMD ["pnpm","worker"]

FROM dependencies AS frontend-build
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
RUN pnpm --filter @contest-center/web... build

FROM node:24.12.0-bookworm-slim AS web
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=frontend-build --chown=node:node /app/apps/web/dist ./public
COPY --chown=node:node infra/web/server.mjs ./server.mjs
USER node
CMD ["node","server.mjs"]
