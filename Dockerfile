# --- Build stage: compile native addons ---
FROM node:20-alpine@sha256:f598378b5240225e6beab68fa9f356db1fb8efe55173e6d4d8153113bb8f333c AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime stage: lean image ---
FROM node:20-alpine@sha256:f598378b5240225e6beab68fa9f356db1fb8efe55173e6d4d8153113bb8f333c

RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json index.js db.js admin.js admin.html index.html logs.html ./

RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://127.0.0.1:8787/health || exit 1

CMD ["node", "index.js"]
