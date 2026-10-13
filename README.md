# api-mcp

Turns OpenAPI documents into MCP servers for [Bifrost](https://github.com/maximhq/bifrost), so Bifrost's OAuth can be used with plain REST APIs.

```sh
OPENAPI_SPECS=trakt=https://developer.trakt.tv/openapi.json,whoop=https://api.prod.whoop.com/developer/doc/openapi.json
```

Each API is served at `/<name>/mcp`; every operation becomes a tool. Specs load at startup (restart to pick up changes).

Bifrost does everything else:

- **Sign-in:** connect the server in Bifrost with OAuth; its `Authorization` header is passed to the API.
- **API keys:** add them as static headers in Bifrost. Headers named by the spec's `apiKey` security schemes are passed on (e.g. `trakt-api-key`).
- **Which tools are allowed:** Bifrost's tool allow-list.

Railway builds the `Dockerfile` on the latest Bun and deploys every push to `main`. `bun test` runs against the real Trakt and WHOOP specs in `test/fixtures/`.
