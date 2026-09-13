# syntax=docker/dockerfile:1.7
# AlKÉ Finance API — production image.
# Build:  docker build -t alke-api:local .
# Run:    docker run --env-file .env -p 3000:3000 alke-api:local
# The same image runs migrations when RUN_MIGRATIONS=true (see docker-entrypoint.sh),
# so a one-off ECS task can migrate before the service rolls.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

# ---- dependencies (dev deps included: prisma CLI is needed for migrate deploy) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    NODE_ENV=development pnpm install --frozen-lockfile \
 && pnpm prisma generate

# ---- compile ----
FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# ---- runtime ----
FROM base AS runtime
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    PORT=3000
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
