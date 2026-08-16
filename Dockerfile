# =============================================================================
#  Multi-stage image for the Node services (bot, worker, signer).
#
#  The web app is deployed to Vercel and does not use this file. One image serves all three
#  services; the start command selects which one runs, so they always share a build.
#
#  Security posture:
#    * slim base, non-root user;
#    * production dependencies only in the final stage — devDependencies never reach runtime;
#    * no secrets in any layer. Everything comes from the environment at run time.
#
#  NOTE: NODE_ENV is deliberately NOT set before the install step. pnpm skips
#  devDependencies when NODE_ENV=production, which removes typescript/tsc and breaks the
#  build. It is set only in the runtime stage, where it belongs.
# =============================================================================
FROM node:22.14.0-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/db/package.json          packages/db/
COPY packages/blockchain/package.json  packages/blockchain/
COPY packages/currency/package.json    packages/currency/
COPY packages/telegram/package.json    packages/telegram/
COPY packages/core/package.json        packages/core/
COPY apps/bot/package.json             apps/bot/
COPY apps/worker/package.json          apps/worker/
COPY apps/signer/package.json          apps/signer/
# The web app is excluded on purpose: it is not built here, and skipping it keeps Next.js
# and React out of this image entirely.
#
# --prod=false is explicit rather than implied: the build platform may inject
# NODE_ENV=production into the build environment, and devDependencies (typescript) are
# required to compile. They are removed again by `pnpm prune --prod` below.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false \
      --filter "@wallet/shared..." \
      --filter "@wallet/db..." \
      --filter "@wallet/blockchain..." \
      --filter "@wallet/currency..." \
      --filter "@wallet/telegram..." \
      --filter "@wallet/core..." \
      --filter "@wallet/bot..." \
      --filter "@wallet/worker..." \
      --filter "@wallet/signer..."

# ---------------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/bot ./apps/bot
COPY apps/worker ./apps/worker
COPY apps/signer ./apps/signer
RUN pnpm run build:packages \
 && pnpm --filter @wallet/bot build \
 && pnpm --filter @wallet/worker build \
 && pnpm --filter @wallet/signer build
# Drop devDependencies now that compilation is done.
RUN pnpm prune --prod

# -------------------------------------------------------------------- runtime
FROM node:22.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"
WORKDIR /app
# Unprivileged user. The node image ships one; reuse it rather than inventing another.
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/package.json ./package.json
# Migrations travel with the image so `db:migrate` can run as a release step.
COPY --from=build --chown=node:node /app/supabase ./supabase
EXPOSE 8080
# Overridden per service by the Railway start command.
CMD ["node", "apps/worker/dist/index.js"]
