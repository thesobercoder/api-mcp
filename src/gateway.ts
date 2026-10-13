import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { version } from '../package.json';
import { CallError, ConfigError } from './errors';
import { boundedBytes, encodeBody, pathValue, queryValue, simple } from './http';
import { BAD_KEYS, resolve, schemaFor } from './openapi';
import { applySecurity } from './security';
import type { Api, ApiDefinition, Env, Fetcher, Limits, Log, Operation, Tool } from './types';

export { CallError, ConfigError };

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const READ = new Set(['get', 'head', 'options']);
const IDEMPOTENT = new Set(['get', 'put', 'delete', 'head', 'options']);
const PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL = '2025-03-26';
const ROUTE = /^\/([a-z][a-z0-9_]*)\/mcp$/;
const USER_AGENT = `api-mcp/${version}`;
const DEFAULT_INSTRUCTIONS = 'Tools come from this API OpenAPI specification. Authentication is managed by Bifrost. Tool annotations identify reads and writes.';
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const decoder = new TextDecoder();

export interface GatewayOptions extends Partial<Limits> {
  env?: Env;
  log?: Log;
  fetcher?: Fetcher;
}

function readHeader(value: unknown, env: Env): string {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'env')) {
    const name = (value as { env: unknown }).env;
    if (typeof name !== 'string' || !env[name]) throw new ConfigError('Missing configured environment variable.');
    return env[name];
  }
  if (typeof value !== 'string') throw new ConfigError('Configured header values must be strings or environment references.');
  return value;
}

function baseUrl(raw: unknown): URL {
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new ConfigError('Invalid API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError('API base URLs must be HTTP(S), without credentials, queries or fragments.');
  }
  return url;
}

function compileApi(raw: ApiDefinition, env: Env, ajv: Ajv): Api {
  const spec = raw.spec;
  if (!/^3\.[01]\./.test(spec?.openapi ?? '')) throw new ConfigError('Supply a bundled OpenAPI 3.0 or 3.1 document.');
  const headers = Object.entries(raw.headers ?? {}).map(([k, v]): [string, string] => [k, readHeader(v, env)]);
  const headerNames = new Set(headers.map(([k]) => k.toLowerCase()));
  const base = baseUrl(raw.baseUrl ?? spec.servers?.[0]?.url);
  const operations = new Map<string, Operation>(), tools: Tool[] = [];
  for (const [path, rawPath] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new ConfigError('OpenAPI paths must be absolute API paths.');
    const pathItem = resolve(spec, rawPath);
    for (const [method, op] of Object.entries<Record<string, unknown> & { [k: string]: any }>(pathItem)) {
      if (!METHODS.has(method)) continue;
      const name: string = op['x-mcp-tool-name'] ?? op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || operations.has(name)) throw new ConfigError('Tool names must be unique identifiers; set operationId or x-mcp-tool-name.');
      const plan = schemaFor(spec, op, pathItem);
      for (const p of plan.parameters) {
        if (p.in === 'header' && (p.name.toLowerCase() === 'authorization' || headerNames.has(p.name.toLowerCase()))) {
          throw new ConfigError('Authentication headers belong in securitySchemes, not tool parameters.');
        }
      }
      if (plan.body && (method === 'get' || method === 'head')) throw new ConfigError('GET/HEAD request bodies are not supported.');
      // Compile validators up front so the first call is as fast as the rest.
      operations.set(name, { name, path, method: method.toUpperCase(), security: op.security, parameters: plan.parameters, body: plan.body, validate: ajv.compile(plan.inputSchema) });
      tools.push({
        name,
        description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
        inputSchema: plan.inputSchema,
        annotations: { readOnlyHint: READ.has(method), destructiveHint: !READ.has(method), idempotentHint: IDEMPOTENT.has(method), openWorldHint: true },
      });
    }
  }
  if (!tools.length) throw new ConfigError('An API has no operations.');
  const wrapHeaders = Object.entries(raw.responseHeaders ?? {});
  return {
    name: raw.name,
    base,
    basePath: base.pathname.replace(/\/$/, ''),
    headers,
    forwardHeaders: raw.forwardHeaders ?? ['authorization'],
    securityBindings: raw.securityBindings ?? {},
    securitySchemes: spec.components?.securitySchemes ?? {},
    defaultSecurity: spec.security ?? [],
    wrap: raw.wrapResponse || raw.responseHeaders ? { key: raw.responseHeadersKey ?? 'headers', headers: wrapHeaders } : null,
    operations,
    tools,
    toolsJson: JSON.stringify({ tools }),
    instructions: raw.instructions ?? DEFAULT_INSTRUCTIONS,
  };
}

/** Upstream result already serialised: `text` is valid JSON; `object` says whether it is a JSON object. */
interface Payload { text: string; object: boolean }

export function createGateway(input: { apis?: ApiDefinition[] }, options: GatewayOptions = {}) {
  const env = options.env ?? process.env;
  if (!input || !Array.isArray(input.apis) || !input.apis.length) throw new ConfigError('API_CONFIG must contain at least one API.');
  const limits: Limits = { requestBytes: options.requestBytes ?? 1048576, responseBytes: options.responseBytes ?? 1048576, timeoutMs: options.timeoutMs ?? 20000 };
  const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true, validateFormats: true });
  addFormats(ajv);
  const services = new Map<string, Api>();
  for (const raw of input.apis) {
    if (typeof raw?.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(raw.name) || services.has(raw.name)) throw new ConfigError('API names must be unique lowercase identifiers.');
    services.set(raw.name, compileApi(raw, env, ajv));
  }
  const tools = Object.fromEntries([...services].map(([k, v]) => [k, v.operations.size]));
  const healthJson = JSON.stringify({ ok: true, version, apis: [...services.keys()], tools });

  async function invoke(api: Api, name: unknown, args: unknown, request: Request, fetcher: Fetcher): Promise<Payload> {
    const op = typeof name === 'string' ? api.operations.get(name) : undefined;
    if (!op) throw new CallError('Unknown tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CallError('Arguments must be an object.');
    // `args` is freshly parsed request JSON, so Ajv may apply defaults in place.
    if (!op.validate(args)) {
      const detail = (op.validate.errors ?? []).map(e => `${e.instancePath} ${e.message}`).join('; ').slice(0, 500);
      throw new CallError(`Invalid arguments: ${detail}`);
    }
    const values = args as Record<string, unknown>;
    const headers = new Headers({ Accept: 'application/json', 'User-Agent': USER_AGENT });
    const credentials = applySecurity(api, op, request, headers);

    let path = op.path;
    for (const p of op.parameters) if (p.in === 'path') path = path.replaceAll(`{${p.name}}`, pathValue(p, values[p.argument]));
    path = path.replace(/\/$/, '');
    if (/\{[^}]+\}/.test(path)) throw new CallError('Unresolved path parameter.');
    const url = new URL(api.base.origin + api.basePath + path);
    if (url.origin !== api.base.origin || (api.basePath && !url.pathname.startsWith(`${api.basePath}/`))) throw new CallError('Request would escape the configured API base.');

    const cookies: string[] = [];
    for (const p of op.parameters) {
      const v = values[p.argument];
      if (v === undefined || p.in === 'path') continue;
      if (p.in === 'query') queryValue(url, p, v);
      else if (p.in === 'header') headers.set(p.name, simple(v, p.explode));
      else cookies.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(simple(v, p.explode))}`);
    }
    for (const c of credentials) {
      if (c.location === 'header') headers.set(c.name, c.value);
      else if (c.location === 'query') url.searchParams.set(c.name, c.value);
      else if (c.location === 'cookie') cookies.push(`${encodeURIComponent(c.name)}=${encodeURIComponent(c.value)}`);
      else throw new ConfigError('Invalid API key security location.');
    }
    if (cookies.length) headers.set('Cookie', cookies.join('; '));
    const body = op.body ? encodeBody(op.body, values.body) : {};
    if (body.contentType) headers.set('Content-Type', body.contentType);

    const response = await fetcher(url, { method: op.method, headers, body: body.payload, redirect: 'error', signal: AbortSignal.timeout(limits.timeoutMs) });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '; check the connection authentication in Bifrost' : response.status === 429 ? '; retry later' : '';
      throw new CallError(`API returned HTTP ${response.status}${hint}.`);
    }
    const bytes = await boundedBytes(response, limits.responseBytes);
    const contentType = response.headers.get('content-type') ?? '';
    let data: Payload;
    if (!bytes.length) data = { text: JSON.stringify({ ok: true, status: response.status }), object: true };
    else if (contentType.includes('json')) {
      // Validate once, then reuse the upstream text instead of re-serialising it.
      const text = decoder.decode(bytes).trim();
      const parsed = JSON.parse(text);
      data = { text, object: !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) };
    } else if (contentType.startsWith('text/')) data = { text: JSON.stringify({ text: decoder.decode(bytes), content_type: contentType }), object: true };
    else data = { text: JSON.stringify({ base64: Buffer.from(bytes).toString('base64'), content_type: contentType }), object: true };
    if (!api.wrap) return data;
    const extracted: Record<string, string> = {};
    for (const [key, header] of api.wrap.headers) {
      const value = response.headers.get(header);
      if (value !== null) extracted[key] = value;
    }
    return { text: `{"data":${data.text},${JSON.stringify(api.wrap.key)}:${JSON.stringify(extracted)}}`, object: true };
  }

  const respond = (body: string, status = 200) => new Response(body, { status, headers: HEADERS });
  const json = (value: unknown, status = 200) => respond(JSON.stringify(value), status);
  const rpc = (id: unknown, resultJson: string) => respond(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${resultJson}}`);
  const fail = (id: unknown, code: number, message: string) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const toolError = (message: string) => JSON.stringify({ content: [{ type: 'text', text: message }], isError: true });

  async function handler(request: Request, fetcher: Fetcher = options.fetcher ?? fetch): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return respond(healthJson);
    const match = ROUTE.exec(url.pathname);
    const api = match ? services.get(match[1] as string) : undefined;
    if (!api) return json({ error: 'Unknown API endpoint.' }, 404);
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-origin requests are not supported.' }, 403);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);

    let message: any;
    try { message = JSON.parse(decoder.decode(await boundedBytes(request, limits.requestBytes))); }
    catch { return fail(null, -32700, 'Invalid or oversized JSON request.'); }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fail(null, -32600, 'Invalid JSON-RPC request.');
    if (message.id === undefined) return new Response(null, { status: 202 });
    const { id, method, params = {} } = message;
    if (!['string', 'number'].includes(typeof id) || !params || typeof params !== 'object' || Array.isArray(params)) return fail(id, -32600, 'Invalid JSON-RPC request.');

    switch (method) {
      case 'initialize':
        return rpc(id, JSON.stringify({
          protocolVersion: PROTOCOLS.has(params.protocolVersion) ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: api.name, version },
          instructions: api.instructions,
        }));
      case 'ping': return rpc(id, '{}');
      case 'tools/list': return rpc(id, api.toolsJson);
      case 'tools/call': {
        const started = performance.now();
        const log = (ok: boolean) => options.log?.({ event: 'tool_call', api: api.name, tool: params.name, ok, duration_ms: Math.round(performance.now() - started) });
        try {
          const { text, object } = await invoke(api, params.name, params.arguments ?? {}, request, fetcher);
          log(true);
          return rpc(id, `{"content":[{"type":"text","text":${JSON.stringify(text)}}],${object ? `"structuredContent":${text},` : ''}"isError":false}`);
        } catch (error) {
          log(false);
          return rpc(id, toolError(error instanceof CallError ? error.message : 'The API request failed.'));
        }
      }
      default: return fail(id, -32601, 'Method not found.');
    }
  }

  return { handler, services, limits };
}
