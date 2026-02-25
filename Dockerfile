# ──────────────────────────────────────────────────
# GhostHands Unified Dockerfile
# Multi-stage build: deps -> build -> kasm runtime
#
# Combines the production GH worker with Kasm desktop (KasmVNC)
# for built-in live-view capability on every worker container.
#
# Targets: API server, Worker (with VNC desktop), Deploy Server
#   API:    docker run ghosthands bun packages/ghosthands/src/api/server.ts
#   Worker: docker run ghosthands  (default — runs via kasm-startup.sh)
#   Deploy: docker run ghosthands bun scripts/deploy-server.ts
#
# Build:
#   docker build -t ghosthands:latest .
# ──────────────────────────────────────────────────

# Stage 1: Install dependencies + build TypeScript
FROM oven/bun:1.2-debian AS build

WORKDIR /app

# Copy workspace root files for dependency resolution
COPY package.json bun.lock turbo.json ./

# Copy package.json for workspace resolution
COPY packages/ghosthands/package.json packages/ghosthands/
COPY scripts/package.json scripts/

# Install dependencies (magnitude-core and magnitude-extract come from npm)
RUN bun install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY scripts/ scripts/
COPY tsconfig.base.json ./

# Build
RUN bun run build

# Stage 2: Kasm desktop runtime with GH worker
FROM kasmweb/core-ubuntu-noble:1.16.1

# Build metadata (set via --build-arg in CI)
ARG COMMIT_SHA="unknown"
ARG BUILD_TIME="unknown"
ARG IMAGE_TAG="unknown"
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV IMAGE_TAG=${IMAGE_TAG}

USER root

# Install system dependencies for Patchright/Chromium + unzip for bun installer
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    ca-certificates \
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
    libasound2t64 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-liberation \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install bun globally (to /usr/local/bin so all users can access it)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
ENV PATH="/usr/local/bin:$PATH"

# BAML runtime uses vendored OpenSSL (native-tls-vendored) via openssl-probe.
# The vendored OpenSSL's default OPENSSLDIR is /usr/local/ssl (from openssl-src
# crate), which does NOT exist in Debian images. We:
#   1. Set SSL_CERT_FILE/DIR env vars (openssl-probe reads these first)
#   2. Symlink /usr/local/ssl → Debian cert paths (belt-and-suspenders fallback)
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
RUN mkdir -p /usr/local/ssl && \
    ln -s /etc/ssl/certs/ca-certificates.crt /usr/local/ssl/cert.pem && \
    ln -s /etc/ssl/certs /usr/local/ssl/certs

# Copy built GH worker from build stage
COPY --from=build /app/node_modules /opt/ghosthands/node_modules
COPY --from=build /app/package.json /opt/ghosthands/
COPY --from=build /app/packages/ghosthands/dist /opt/ghosthands/packages/ghosthands/dist
COPY --from=build /app/packages/ghosthands/src /opt/ghosthands/packages/ghosthands/src
COPY --from=build /app/packages/ghosthands/package.json /opt/ghosthands/packages/ghosthands/
COPY --from=build /app/scripts /opt/ghosthands/scripts

# Make GH worker directory accessible to kasm-user (uid 1000)
RUN chown -R 1000:1000 /opt/ghosthands

# Create Patchright browser cache directory (kasm-user home may not have .cache)
RUN mkdir -p /home/kasm-user/.cache/ms-playwright && \
    chown -R 1000:1000 /home/kasm-user/.cache

# Install Patchright browser as kasm-user
USER 1000
RUN cd /opt/ghosthands && bunx patchright install chromium

# Copy custom startup script (Kasm runs this after desktop is ready)
USER root
COPY scripts/kasm-startup.sh /dockerstartup/custom_startup.sh
RUN chmod +x /dockerstartup/custom_startup.sh

# KasmVNC config
COPY config/kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml

# Generate snakeoil SSL cert for KasmVNC HTTPS (kasmvnc.yaml: protocol=https)
# Must chmod /etc/ssl/private so kasm-user (uid 1000) can read the key
RUN apt-get update && apt-get install -y --no-install-recommends ssl-cert \
    && rm -rf /var/lib/apt/lists/* \
    && make-ssl-cert generate-default-snakeoil \
    && chmod 755 /etc/ssl/private \
    && chmod 644 /etc/ssl/private/ssl-cert-snakeoil.key

# Expose ports: GH API, Worker status, KasmVNC web
EXPOSE 3100 3101 6901

# Run as kasm-user (uid 1000) — Kasm handles the entrypoint
# custom_startup.sh runs after desktop init
USER 1000

WORKDIR /opt/ghosthands
