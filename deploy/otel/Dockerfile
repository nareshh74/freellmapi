FROM freellmapi:rollback-pre-otel
USER root
WORKDIR /otel
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com && chown -R node:node /otel
COPY --chown=node:node preload.cjs ./
WORKDIR /app
ENV NODE_OPTIONS="--require=/otel/preload.cjs"
