FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV TIMBER_WAL_DIR=/data/wal \
    PORT=7710 \
    NODE_ENV=production

# WAL dir must exist and be writable by the unprivileged user before USER drops root;
# VOLUME after chown so named volumes inherit the ownership on first mount.
RUN mkdir -p /data/wal && chown -R node:node /data
VOLUME /data/wal

EXPOSE 7710
USER node

HEALTHCHECK CMD wget -qO- http://127.0.0.1:7710/healthz || exit 1

CMD ["node", "src/server.js"]
