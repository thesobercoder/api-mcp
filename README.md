# api-mcp

Turn any OpenAPI document into an MCP server, at runtime, with no configuration.

Point an MCP client at the server with the address of an OpenAPI document. Every operation in the document becomes a tool, and each tool call becomes an HTTP request to the API.

```
http://localhost:8080/mcp?spec=https://petstore3.swagger.io/api/v3/openapi.json
```

## Run

With Docker:

```sh
docker build -t api-mcp .
docker run -p 8080:8080 api-mcp
```

With [Bun](https://bun.sh):

```sh
bun src/server.ts
```

`PORT` sets the port (default `8080`). There are no other settings.

## Connect

Add an MCP server using the Streamable HTTP transport with this address:

```
http://<host>:8080/mcp?spec=<https URL of an OpenAPI document>
```

Use one address per API. Documents can be JSON or YAML. Each is fetched on first use and cached until the server restarts.

## Authentication

The server holds no credentials. It forwards these headers from the MCP request to the API:

- `Authorization` (for example, an OAuth or bearer token)
- any header named by an `apiKey` security scheme in the document (for example, `X-API-Key`)

Configure these headers in your MCP client or gateway. Other headers are not forwarded.

## What it supports

- OpenAPI 3.x documents; the first entry in `servers` is the API's base URL
- Path, query and header parameters
- JSON request bodies (passed as the `body` argument)
- Local `$ref`s within the document
- Responses returned as text; non-2xx responses become tool errors

Not supported: Swagger 2.0, external `$ref`s, form and file uploads, cookie parameters, and MCP sessions, resources or prompts.

## Security

The server fetches whatever `https` document address it is given and calls the API that document describes. **Run it on a private network** or behind a gateway that controls who can reach it; never expose it directly to the internet.

## Development

```sh
bun test
```

Tests run against real-world OpenAPI documents in `test/fixtures/` and also run during the Docker build.

## License

[MIT](LICENSE)
