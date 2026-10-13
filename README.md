# api-mcp

A private, stateless OpenAPI-to-MCP gateway for Bifrost. The engine has no service-specific routes. Each API supplies a bundled OpenAPI 3.0/3.1 document in configuration; every HTTP operation in that document becomes an MCP tool, including writes.

## Add another API

Add an entry to the `apis` array in the `API_CONFIG` environment variable:

```json
{
  "name": "another_api",
  "baseUrl": "https://api.example.com/v1",
  "forwardHeaders": ["authorization"],
  "spec": {
    "openapi": "3.1.0",
    "info": {"title": "Example", "version": "1"},
    "paths": {
      "/items": {
        "get": {"operationId": "listItems", "responses": {"200": {"description": "Items"}}},
        "post": {
          "operationId": "createItem",
          "requestBody": {"required": true, "content": {"application/json": {"schema": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}}}},
          "responses": {"201": {"description": "Created"}}
        }
      }
    }
  }
}
```

Configure that API's MCP connection in Bifrost at `http://api-mcp.railway.internal:8080/another_api/mcp`. OAuth endpoints/client configuration are set in Bifrost; the adapter only forwards credentials to the configured API. Changing `API_CONFIG` creates a new release without editing/rebuilding the engine.

`config/apis.json` preserves the existing Trakt and WHOOP tool names and behavior. These are curated OpenAPI documents for the operations already connected; adding a fuller API document exposes its additional operations.

## Configuration

| Variable | Meaning |
|---|---|
| `API_CONFIG` | Required JSON API definitions; not embedded in application code |
| `TRAKT_CLIENT_ID` | Public Trakt app identifier referenced by the existing API configuration |
| `HOST` | Listen address; production uses `::` for Railway private IPv6 networking |
| `PORT` | Listen port; production uses `8080` |
| `NODE_ENV` | Production uses `production` |
| `LOG_LEVEL` | `info` or `silent` |
| `MAX_REQUEST_BYTES` | Maximum JSON-RPC request size; default 1 MiB |
| `MAX_RESPONSE_BYTES` | Maximum API response size; default 1 MiB |
| `UPSTREAM_TIMEOUT_MS` | Per-request timeout; default 20 seconds |

Secrets are not stored in the API definitions. Header values can reference an environment variable with `{"env":"NAME"}`. `securityBindings` can map a named API security scheme to an incoming Bifrost header. Optional `responseHeaders`, `responseHeadersKey`, and `wrapResponse` preserve APIs that paginate through response headers.

## Supported request shapes

Path/query/header/cookie parameters; JSON, URL-encoded, multipart, text, and binary request bodies; JSON, text, binary, and no-content responses; local schema references, recursive objects, enums, defaults, date-time formats and OpenAPI nullable fields.

Schemas with external `$ref` URLs must first be bundled into one document. Parameter `content` schemas and nested `deepObject` query values are explicitly rejected. API server URLs with template variables must be resolved using `baseUrl`. GraphQL and SOAP need their own HTTP/OpenAPI descriptions or adapters.

`operationId` defines the tool name. `x-mcp-tool-name` overrides it; `x-mcp-argument-name` resolves parameter naming conflicts. The optional `x-mcp-omit-path-values` parameter extension supports optional path segments such as Trakt's unfiltered history endpoint.

## Deployment and twelve-factor design

- One version-controlled codebase, with locked dependencies and a pinned Bun 1.4.0 Docker runtime.
- API definitions, hostnames, limits and credentials supplied through environment configuration.
- Stateless processes; no local account/token/data storage or persistent volume.
- Reproducible build artifact, release configuration and run phase are separate.
- Port binding on private networking; scale replicas without sticky adapter sessions.
- Health endpoint, bounded upstream timeouts, graceful shutdown and structured stdout logs.
- Logs contain tool names, success state and duration; no request/response bodies or credentials.
- Tests exercise an unrelated API's reads and writes as well as compatibility with the existing APIs.

Railway has no public domain or TCP proxy for this service. Bifrost connects over the same project's private network. Bifrost's public, authenticated MCP gateway remains the agent-facing entry point.

## Development

Use the pinned Bun runtime and `bun install --frozen-lockfile`. Run `bun test test/engine.test.mjs`; the pure engine tests also support `npm test`. Set the environment variables above to run `bun src/server.mjs`. `/health` reports configured API names and tool counts.
