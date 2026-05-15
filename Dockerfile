FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV ORKESTR_HOME=/data
ENV ORKESTR_PORT=19812
ENV ORKESTR_HOST=0.0.0.0

COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
COPY examples ./examples
COPY schemas ./schemas

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 19812
CMD ["npm", "start"]
