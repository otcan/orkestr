FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV CI=true

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
ENV NODE_ENV=production
ENV ORKESTR_HOME=/data
ENV ORKESTR_PORT=19812
ENV ORKESTR_HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
COPY examples ./examples
COPY schemas ./schemas
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 19812
CMD ["npm", "start"]
