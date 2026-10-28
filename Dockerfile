# syntax=docker/dockerfile:1

# ---- Build stage: compile the React UI and install production dependencies ----
FROM node:22-slim AS build
WORKDIR /app
# Electron is only needed for the desktop app; skip its ~100 MB binary in the container.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- immich-go stage: download and verify the official release binary ----
FROM debian:bookworm-slim AS immich-go
# Override with --build-arg IMMICH_GO_VERSION=x.y.z to pin a different official release.
ARG IMMICH_GO_VERSION=0.32.0
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/immich-go
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) arch=x86_64 ;; \
        arm64) arch=arm64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="immich-go_Linux_${arch}.tar.gz"; \
    base_url="https://github.com/simulot/immich-go/releases/download/v${IMMICH_GO_VERSION}"; \
    curl -fsSLO "${base_url}/${archive}"; \
    curl -fsSLO "${base_url}/checksums.txt"; \
    grep " ${archive}\$" checksums.txt | sha256sum -c -; \
    tar -xzf "${archive}" immich-go; \
    install -m 755 immich-go /immich-go

# ---- Runtime stage: headless web server ----
FROM node:22-slim
# perl is required by exiftool-vendored; gosu drops root after mounted-volume setup.
# ca-certificates lets immich-go (a Go binary that uses the system trust store) verify HTTPS Immich servers;
# tzdata gives it correct local time zones for photo dates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu perl tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /config \
    && chown node:node /data /config

COPY --from=immich-go /immich-go /usr/local/bin/immich-go
RUN immich-go version

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.js serverLogger.js core.js imageFileQueue.js previewCache.js auth.js pathAccess.js docker-entrypoint.sh ./
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && chmod 755 /app/docker-entrypoint.sh

# Set IMAGEPARSER_DEBUG=true (at build time with --build-arg, or at runtime with -e / compose) to stream
# server-side logs, including immich-go diagnostics, to the browser developer console.
ARG IMAGEPARSER_DEBUG=false

ENV NODE_ENV=production \
    PORT=8080 \
    IMAGEPARSER_ROOT=/data \
    IMAGEPARSER_CONFIG_DIR=/config \
    IMAGEPARSER_DEBUG=${IMAGEPARSER_DEBUG} \
    HOME=/tmp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
