FROM node:24.12.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/mcp-adapter/package.json ./apps/mcp-adapter/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY plugins/hydro-contest-center/package.json ./plugins/hydro-contest-center/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY scripts ./scripts
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm --filter @contest-center/server db:generate
RUN pnpm build
FROM build AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/server
USER node
CMD ["pnpm","start"]
FROM caddy:2.10.2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY infra/compose/Caddyfile /etc/caddy/Caddyfile
