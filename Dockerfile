# Development and testing convenience image.
#
# The primary deployment target is a stdio process launched directly from an MCP
# client's configuration file. This image exists so the server can be built and
# exercised in a clean environment, not as a hosting mechanism.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Never run as root; the server needs no privileges beyond outbound HTTPS.
USER node

# stdio transport: the container's stdin/stdout carry MCP JSON-RPC, and all logging
# goes to stderr. Run with `docker run -i --rm ...` so stdin stays open.
ENTRYPOINT ["node", "dist/index.js"]
