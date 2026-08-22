# apps/api — real hosting (Railway/Render/Fly.io/any container platform).
# Build context MUST be the repo ROOT, not apps/api (db.ts reads
# 03-schema.sql/seed.sql from the repo root at boot — see its own comment —
# and this is an npm-workspaces monorepo, so packages/core and the root
# lockfile have to be in the build context too). Build with:
#
#   docker build -f apps/api/Dockerfile -t fieldready-api .
#
# from the repo root. See apps/api/HOSTING.md for the full deployment guide
# (why Playwright rules out Vercel-style serverless functions, why the
# object store needs a persistent volume, required env vars).

FROM node:22-slim

# Playwright needs a real Debian/Ubuntu userland for Chromium's system
# dependencies (fonts, libnss3, libatk, etc.) — Alpine (musl libc) is not
# supported by Playwright's own browsers at all, which is why this is
# node:22-slim (Debian) and not node:22-alpine.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# ---- install deps first (own layer, cached across source-only changes) ---
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci

# ---- Chromium + its OS deps, matching the exact playwright version in ----
# ---- package-lock.json (not a hand-picked base-image tag, so it can ------
# ---- never drift out of sync with what's actually installed) -------------
RUN npx --prefix apps/api playwright install --with-deps chromium

# ---- now the real source ---------------------------------------------------
COPY . .

# packages/core is consumed straight from its TypeScript source at runtime
# (same as apps/web — see apps/web/README.md's note on this), so no
# separate `tsc` build step is required for it to be usable here. apps/api
# itself also runs directly from source via tsx (see package.json's
# start:container script) rather than a compiled dist/ — `npm run build`
# still exists and is exercised by CI/proof scripts, but isn't what this
# image runs, matching how every proof/smoke script in this repo already
# spawns apps/api (via tsx, never a build step) rather than a difference
# introduced for this container specifically.

ENV NODE_ENV=production
ENV PORT=3001
# Confirmed necessary by actually running this image: src/index.ts defaults
# to 127.0.0.1 (correct for local dev/proof scripts, all same-machine
# callers), which is unreachable through a container's published port —
# built this image, ran it, and it passed its own internal /health check
# while being completely unreachable from the host until this was set.
ENV HOST=0.0.0.0
EXPOSE 3001

WORKDIR /repo/apps/api
CMD ["npm", "run", "start:container"]
