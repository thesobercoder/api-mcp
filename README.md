# api-mcp

Turns OpenAPI documents into MCP servers for [Bifrost](https://github.com/maximhq/bifrost), so Bifrost's OAuth can be used with plain REST APIs.

No configuration. Point an MCP connection at the adapter with the spec's address:

```
http://api-mcp.railway.internal:8080/mcp?spec=https://developer.trakt.tv/openapi.json
```

Every operation in the document becomes a tool. Each spec is fetched on first use and cached until restart. Only `https` spec URLs are accepted. The adapter fetches whatever spec it is given, so keep it on a private network.

Bifrost does everything else:

- **Sign-in:** connect the server in Bifrost with OAuth; its `Authorization` header is passed to the API.
- **API keys:** add them as static headers in Bifrost. Headers named by the spec's `apiKey` security schemes are passed on (e.g. `trakt-api-key`).
- **Which tools are allowed:** Bifrost's tool allow-list.

Railway builds the `Dockerfile` on the latest Bun and deploys every push to `main`. Adding an API needs no deploy, only a new Bifrost connection. `bun test` runs against the real Trakt and WHOOP specs in `test/fixtures/`.
