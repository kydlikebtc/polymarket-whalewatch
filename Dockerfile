# syntax=docker/dockerfile:1

# ---- Builder ----------------------------------------------------------------
# Compiles the native better-sqlite3 addon for Linux and runs `next build`.
# We install ALL deps here (build needs them) and rebuild node_modules from
# scratch so the native binary matches the container's platform — never copy
# the host's macOS-built node_modules in.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain for compiling better-sqlite3 if no prebuilt binary is available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Next reads PORT at runtime, not build time. Build is env-agnostic here.
RUN npm run build

# ---- Runner -----------------------------------------------------------------
# Same base image as the builder so the compiled native addon stays compatible.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy the built app plus node_modules (with the Linux-compiled better-sqlite3).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/app ./app
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/instrumentation.ts ./instrumentation.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# SQLite lives on a mounted volume so alerts survive container restarts.
# Engine + dashboard both honor DASH_DB (see worker/embeddedEngine.ts, app/api/*).
RUN mkdir -p /app/data && chown -R node:node /app
ENV DASH_DB=/app/data/data.sqlite

USER node
EXPOSE 3000

# `npm run start` -> scripts/dev-server.mjs start: loads .env if present, then spawns
# `next start` inheriting PORT/DASH_DB from the container env.
CMD ["npm", "run", "start"]
