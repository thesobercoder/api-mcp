FROM oven/bun:latest AS build
WORKDIR /app
COPY . .
RUN bun test && bun build src/server.ts --compile --minify --outfile /api-mcp

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /api-mcp /api-mcp
EXPOSE 8080
ENTRYPOINT ["/api-mcp"]
