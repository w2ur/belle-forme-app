# Self-hosted Belle Forme: the static build + server.mjs (see compose.yaml for
# the database side). Secrets are NEVER baked in: they come from the
# environment at run time (compose reads them from .env).

# --- build: the static app in dist/ ------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- runtime: production deps, the server, the functions, the build ---------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# server.mjs listens on 127.0.0.1 by default; in a container that would refuse
# every connection from the port mapping. Expose the port on the host with care
# (compose binds it to the host's 127.0.0.1).
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
COPY netlify ./netlify
# The coach imports src/lib, and the catalog seed is src/data/catalogSeed.json.
COPY src ./src
COPY scripts/seed-catalog.mjs scripts/catalog-seed-lib.mjs ./scripts/
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8888
# GET /api/login answers 405 only once the functions are loaded.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8888)+'/api/login').then(r=>process.exit(r.status===405?0:1),()=>process.exit(1))"]
# The seed only ever fills an EMPTY catalog table, so it is safe on every start.
CMD ["sh", "-c", "node scripts/seed-catalog.mjs && exec node server.mjs"]
