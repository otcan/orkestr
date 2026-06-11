FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim

ARG ORKESTR_CODEX_VERSION=0.134.0
ARG TARGETARCH=amd64
ENV NODE_ENV=production \
    ORKESTR_HOME=/data \
    CODEX_HOME=/data/codex \
    ORKESTR_HOST=0.0.0.0 \
    ORKESTR_PORT=3000 \
    PORT=3000 \
    ORKESTR_BROWSER_DESKTOP_MODE=browserctl \
    ORKESTR_BROWSERCTL_PATH=/app/scripts/browserctl.mjs \
    ORKESTR_CHROME_NO_SANDBOX=1 \
    ORKESTR_DOCKER=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    dbus-x11 \
    git \
    novnc \
    openbox \
    openssh-client \
    procps \
    ripgrep \
    sqlite3 \
    tmux \
    websockify \
    x11vnc \
    xauth \
    xvfb \
  && case "${TARGETARCH}" in \
    amd64) cloudflared_arch=amd64 ;; \
    arm64) cloudflared_arch=arm64 ;; \
    *) echo "unsupported TARGETARCH for cloudflared: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cloudflared_arch}" \
  && chmod +x /usr/local/bin/cloudflared \
  && cloudflared --version \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm install -g --omit=dev --no-audit --no-fund "@openai/codex@${ORKESTR_CODEX_VERSION}" \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh /app/scripts/browserctl.mjs \
  && mkdir -p /data/codex \
  && chmod 700 /data /data/codex

VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
