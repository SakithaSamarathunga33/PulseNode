FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS web-builder
ARG NEXT_PUBLIC_GO_API=/go
ENV NEXT_PUBLIC_GO_API=$NEXT_PUBLIC_GO_API
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=web-builder --chown=node:node /app/.next/standalone ./
COPY --from=web-builder --chown=node:node /app/.next/static ./.next/static
COPY --from=web-builder --chown=node:node /app/public ./public
# The web tier needs no privileges — run as the image's unprivileged user.
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=96", "server.js"]
