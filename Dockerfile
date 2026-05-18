# OASIS Agent Command Center — Next.js 15 standalone image.
# Multi-stage build → small final image, non-root, read-only rootfs compatible.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── Build ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Runtime ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 10001 -S nextjs \
 && adduser  -u 10001 -G nextjs -S -s /sbin/nologin nextjs \
 && mkdir -p /app/.next/cache \
 && chown -R nextjs:nextjs /app

WORKDIR /app

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static     ./.next/static

RUN mkdir -p /app/public
COPY --from=builder --chown=nextjs:nextjs /app/public           /app/public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
