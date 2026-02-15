# ──────────────────────────────────────────────────
# GhostHands Production Dockerfile
# Multi-stage build: deps -> build -> runtime
#
# Targets: API server and Worker (same image, different CMD)
#   API:    docker run ghosthands  (default)
#   Worker: docker run ghosthands bun packages/ghosthands/src/workers/main.ts
# ──────────────────────────────────────────────────

# Stage 1: Install dependencies
FROM oven/bun:1.2-debian AS deps

WORKDIR /app

# Copy workspace root files for dependency resolution
COPY package.json bun.lock turbo.json ./

# Copy package.json for workspace resolution
COPY packages/ghosthands/package.json packages/ghosthands/

# Install dependencies (magnitude-core and magnitude-extract come from npm)
RUN bun install --frozen-lockfile

# Stage 2: Build TypeScript
FROM deps AS build

# Copy source
COPY packages/ packages/
COPY tsconfig.base.json ./

# Build
RUN bun run build

# Stage 3: Production runtime
FROM oven/bun:1.2-debian AS runtime

# Install system dependencies for Patchright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules (includes magnitude-core from npm)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Copy ghosthands package (dist + source for bun direct execution)
COPY --from=build /app/packages/ghosthands/dist ./packages/ghosthands/dist
COPY --from=build /app/packages/ghosthands/src ./packages/ghosthands/src
COPY --from=build /app/packages/ghosthands/package.json ./packages/ghosthands/
# Note: bun hoists all dependencies to root node_modules/, so
# packages/ghosthands/node_modules/ typically doesn't exist.

# Install Patchright browser binaries (Chromium only)
RUN bunx patchright install chromium

# Create non-root user
RUN groupadd -r ghosthands && useradd -r -g ghosthands -m ghosthands
USER ghosthands

# Default: start API server
EXPOSE 3100
CMD ["bun", "packages/ghosthands/src/api/server.ts"]
