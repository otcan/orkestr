FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV CI=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json angular.json tsconfig.json ./
COPY tsconfig.server.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
COPY examples ./examples
COPY schemas ./schemas

RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/otcan/orkestr"
LABEL org.opencontainers.image.description="Local-first Orkestr agent workstation with Codex runtime"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
ENV ORKESTR_HOME=/data
ENV ORKESTR_PORT=19812
ENV ORKESTR_HOST=0.0.0.0
ENV ORKESTR_DOCKER=1
ENV CODEX_HOME=/data/codex
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV WA_CHROME_PATH=/usr/bin/chromium
ENV ORKESTR_CHROME_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    git \
    openssh-client \
    procps \
    ripgrep \
    tmux \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm install -g @openai/codex@0.130.0 \
  && npm cache clean --force

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
COPY examples ./examples
COPY schemas ./schemas
COPY --from=build /app/dist ./dist

RUN chmod +x /app/apps/cli/bin/orkestr-oss.js \
  && ln -sf /app/apps/cli/bin/orkestr-oss.js /usr/local/bin/orkestr \
  && ln -sf /app/apps/cli/bin/orkestr-oss.js /usr/local/bin/orkestr-oss

RUN mkdir -p /data/codex && chown -R node:node /data /app
USER node

EXPOSE 19812
CMD ["npm", "start"]
