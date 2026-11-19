# The API image. Built from the repository root (infra/compose/base.compose.yml:
# context ../.., dockerfile apps/api/Dockerfile). The platform comes from the
# registry like every other dependency: there is no package source here.
FROM node:24-alpine AS base
WORKDIR /app
# pg_dump/pg_restore for the database-backup slice once it is enabled.
RUN apk add --no-cache openssl postgresql17-client

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/cli/package.json ./apps/cli/
COPY packages/shared ./packages/shared/
# The SDK and the MCP Apps widgets are workspaces too: npm ci needs their manifests to match the lockfile.
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/mcp-ui/package.json ./apps/mcp-ui/
# The agent packages (E38.9) are workspace dependencies of the API: their manifests are needed to install, their sources to build.
COPY packages/hexactra-agent/package.json ./packages/hexactra-agent/
COPY packages/hexactra-browser-agent/package.json ./packages/hexactra-browser-agent/
RUN npm ci --workspace=api --include-workspace-root
# The PDF report (#543) runs pdfmake on Node only: drop the browser bundles,
# the bundled Roboto fonts and the source maps of pdfmake, pdfkit and fontkit,
# brotli's unused encoder, and unpdf (a test-only PDF reader). About 25 MB.
RUN rm -rf node_modules/pdfmake/build node_modules/pdfmake/src node_modules/pdfmake/fonts \
      node_modules/pdfkit/js/*.map node_modules/pdfkit/js/pdfkit.standalone.js node_modules/pdfkit/js/pdfkit.browser.* node_modules/pdfkit/js/pdfkit.old.js \
      node_modules/fontkit/dist/*.map node_modules/fontkit/dist/browser* node_modules/fontkit/src \
      node_modules/brotli/build node_modules/brotli/enc node_modules/unpdf
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/prisma.config.ts ./apps/api/
RUN cd apps/api && DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

# The MCP Apps widgets (apps/mcp-ui, #466): one self-contained HTML file each,
# served by the API as ui:// resources from /app/apps/mcp-ui/dist. Built in a
# stage of their own so Vite and Preact never reach the API image.
FROM base AS widgets
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/cli/package.json ./apps/cli/
COPY apps/mcp-ui/package.json ./apps/mcp-ui/
COPY packages/shared ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
RUN npm ci --workspace=mcp-ui --include-workspace-root --ignore-scripts
COPY apps/mcp-ui ./apps/mcp-ui
# The bundle check reads the tool names from the API's pinned manifest.
COPY apps/api/test/__snapshots__/mcp-tools.json ./apps/api/test/__snapshots__/
RUN npm run build --workspace=mcp-ui

FROM base AS development
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages/hexactra-agent ./packages/hexactra-agent
COPY packages/hexactra-browser-agent ./packages/hexactra-browser-agent
RUN npm run build:packages
COPY apps/api ./apps/api
COPY --from=widgets /app/apps/mcp-ui/dist ./apps/mcp-ui/dist
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./
# The API imports the packages' built output: harness first, then the browser toolset (npm run build:packages).
COPY packages/hexactra-agent ./packages/hexactra-agent
COPY packages/hexactra-browser-agent ./packages/hexactra-browser-agent
RUN npm run build:packages
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npm run build

FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/hexactra-agent/dist ./packages/hexactra-agent/dist
COPY --from=build /app/packages/hexactra-browser-agent/dist ./packages/hexactra-browser-agent/dist
# The seed (`npm run prisma:seed`) reads the permission catalog and settings
# registry from src/, so the image carries them with prisma/.
COPY apps/api ./apps/api
COPY --from=widgets /app/apps/mcp-ui/dist ./apps/mcp-ui/dist
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
