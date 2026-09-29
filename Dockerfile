# syntax=docker/dockerfile:1

# ---- Build stage: compile the React UI and install production dependencies ----
FROM node:22-slim AS build
WORKDIR /app
# Electron is only needed for the desktop app; skip its ~100 MB binary in the container.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage: headless web server ----
FROM node:22-slim
# perl is required by exiftool-vendored to write EXIF data into the images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends perl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /config \
    && chown node:node /data /config

COPY --from=pkking/immich-go:latest /immich-go /usr/local/bin/immich-go

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.js core.js imageFileQueue.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    IMAGEPARSER_ROOT=/data \
    IMAGEPARSER_CONFIG_DIR=/config \
    HOME=/tmp

# Override with `user:` in docker-compose to match the owner of your TrueNAS dataset.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]