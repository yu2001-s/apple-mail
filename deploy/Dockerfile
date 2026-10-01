# Remote iCloud Mail MCP server. Build from the repository root:
#   docker build -f deploy/Dockerfile -t icloud-mail .
# The committed bundle carries its dependencies, so no install step is needed.
FROM node:22-alpine
WORKDIR /app
COPY plugins/icloud-mail/server/server.cjs plugins/icloud-mail/server/provenance.json ./
ENV NODE_ENV=production \
    ICLOUD_MAIL_TRANSPORT=http \
    ICLOUD_MAIL_HTTP_HOST=0.0.0.0 \
    ICLOUD_MAIL_HTTP_PORT=8787 \
    ICLOUD_MAIL_DATA_DIR=/data \
    APPLE_MAIL_MCP_CONFIG_FILE=/data/config.json
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server.cjs"]
