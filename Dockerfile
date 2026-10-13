# syntax=docker/dockerfile:1
# Always build on the newest Bun release; CI rebuilds weekly to pick up updates.
FROM oven/bun:latest AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN bun test && bun run typecheck \
 && bun build src/server.ts --compile --minify --sourcemap --bytecode --outfile /out/api-mcp

# Single self-contained binary on a minimal, shell-less base. No API definitions are baked in:
# OPENAPI_SPECS (and optional API_<NAME>_* variables) are read at runtime.
FROM gcr.io/distroless/cc-debian12:nonroot
ARG SOURCE_URL=https://github.com/thesobercoder/api-mcp
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.title="api-mcp" \
      org.opencontainers.image.description="Turns OpenAPI documents listed in OPENAPI_SPECS into MCP servers at runtime"
WORKDIR /app
COPY --from=build /out/api-mcp /app/api-mcp
ENV NODE_ENV=production HOST=:: PORT=8080
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/api-mcp"]
