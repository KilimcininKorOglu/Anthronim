# --- Build stage: compile native addons ---
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime stage: lean image ---
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json index.js db.js admin.js admin.html index.html ./

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "index.js"]
