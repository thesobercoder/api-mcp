# api-mcp

A stateless gateway that turns OpenAPI documents into MCP servers **at runtime**. The image contains no API definitions. Give it a list of OpenAPI URLs; on startup it fetches each document and exposes every operation as an MCP tool. It re-fetches documents hourly, so API changes appear without a redeploy.

## Configure

Everything comes from environment variables.

```sh
OPENAPI_SPECS=trakt=https://developer.trakt.tv/openapi.json,whoop=https://api.prod.whoop.com/developer/doc/openapi.json
```

Each `name=url` pair is served at `http://<host>:8080/<name>/mcp`. Names are lowercase identifiers. Documents can be JSON or YAML (OpenAPI 3.0/3.1). External `$ref`s are fetched and inlined.

### Per-API settings (all optional)

Set `API_<NAME>_<SETTING>`, for example `API_TRAKT_READ_ONLY=true`. Write `${VAR}` to pull a value from another variable, so secrets stay in their own variables.

| Setting | Meaning |
|---|---|
| `HEADERS` | JSON object of headers sent on every call, e.g. `{"trakt-api-key":"${TRAKT_CLIENT_ID}"}` |
| `READ_ONLY` | `true` exposes only GET/HEAD/OPTIONS operations |
| `INCLUDE` / `EXCLUDE` | Space/comma-separated filters: an operationId, `tag:<name>` or `path:<path>`; `*` is a wildcard |
| `INCLUDE_DEPRECATED` | `true` keeps deprecated operations (dropped by default) |
| `OPTIONAL_TRAILING_PATH_PARAMS` | `true` lets trailing `/{param}` segments be omitted (for APIs like Trakt) |
| `BASE_URL` | Overrides the document's first server URL |
| `FORWARD_HEADERS` | Incoming headers passed upstream; default `authorization` (Bifrost supplies OAuth tokens) |
| `SECURITY_BINDINGS` | JSON mapping a security scheme to an incoming header, e.g. `{"key":{"sourceHeader":"x-api-key"}}` |
| `RESPONSE_HEADERS` | Response headers returned with the data; default `x-pagination-* link x-total-count` |
| `SPEC_HEADERS` | JSON headers used when fetching the document itself (private specs) |
| `INSTRUCTIONS` | MCP server instructions |

When a response carries matching headers, the result is `{"data": ..., "headers": {...}}`; otherwise it is the API's JSON.

### Service settings

| Variable | Default |
|---|---|
| `HOST` / `PORT` | `::` / `8080` |
| `LOG_LEVEL` | `info` (`silent` disables) |
| `MAX_REQUEST_BYTES` / `MAX_RESPONSE_BYTES` | 1 MiB |
| `UPSTREAM_TIMEOUT_MS` | 20000 |
| `SPEC_TIMEOUT_MS` / `MAX_SPEC_BYTES` | 30000 / 20 MiB |
| `SPEC_REFRESH_SECONDS` | 3600 (`0` disables refresh) |
| `SPEC_RETRY_SECONDS` | 30, for documents that failed to load |

## Runtime behaviour

- The server starts immediately; documents load in the background.
- `/health` returns 200 only when every listed API is loaded, and reports each API's tool count or error. Railway's health check therefore never replaces a working deployment with one that can't load its specs.
- A failed refresh keeps serving the last good version. Unchanged documents (by SHA-256) are not recompiled.
- Schemas are compiled and `tools/list` is serialised once per load. Upstream JSON is validated and passed through without re-serialising.

## Deploy

The Railway service is connected to this repository and deploys every push to `main`. Railway builds the `Dockerfile` on the latest Bun (`oven/bun:latest`), so each deploy picks up the newest Bun release. Tests and type checks run inside the build, so a failing change never deploys. The result is one compiled binary on distroless.

Railway auto-detects the `Dockerfile`; the health check (`/health`) and variables are set on the service. The service has no public domain; Bifrost reaches it at `http://api-mcp.railway.internal:8080/<name>/mcp` and handles OAuth.

## Development

TypeScript in `src/`, run directly by Bun: `bun install`, `bun test`, `bun run typecheck`, then `bun start` with `OPENAPI_SPECS` set. Tests use the real Trakt and WHOOP documents from `test/fixtures/`.
