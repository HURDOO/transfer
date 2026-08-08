# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.15.0-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY index.html tsconfig.app.json tsconfig.server.json tsconfig.server.build.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY src ./src
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV STORAGE_DIR=/data
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
