FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY edge/package.json ./edge/package.json
RUN npm ci --workspace @inventory/edge

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY edge/package.json ./edge/package.json
RUN npm ci --workspace @inventory/edge
COPY edge ./edge
WORKDIR /app/edge
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S edgeuser
COPY --from=build /app/edge/.next/standalone ./
COPY --from=build /app/edge/.next/static ./edge/.next/static
COPY --from=build /app/edge/public ./edge/public
USER edgeuser
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "edge/server.js"]
