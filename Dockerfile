FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --workspaces=false
COPY tsconfig.json ./
COPY src/ ./src/
COPY events/ ./events/
COPY read/ ./read/
COPY sync/migrations/ ./sync/migrations/
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S appuser

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# src/events/migrate.ts (compiled to dist/src/events/migrate.js) resolves its migration SQL
# sources relative to itself with '../../events/...' and '../../read/...' - i.e. dist/events and
# dist/read, not the repo-root events/ and read/ directories. tsc never copies these non-.ts
# assets on its own, so they are placed here explicitly; without this, `node dist/src/events/
# migrate.js` (the deploy path used by deploy/pipeline/deploy.sh) fails with ENOENT.
COPY --from=build /app/events ./dist/events
COPY --from=build /app/read ./dist/read
COPY --from=build /app/sync/migrations ./dist/sync/migrations
COPY package.json ./

USER appuser
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "dist/src/server.js"]
