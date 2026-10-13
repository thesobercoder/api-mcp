import type { ValidateFunction } from 'ajv';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { version } from '../package.json';
import { CallError, ConfigError } from './errors';
import { boundedBytes, encodeBody, pathValue, queryValue, simple } from './http';
import { resolve, schemaFor } from './openapi';
import { applySecurity } from './security';
import type { Api, ApiSource, Fetcher, Limits, Log, Operation, Parameter, Spec, Tool } from './types';

export { CallError, ConfigError };

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const READ = new Set(['get', 'head', 'options']);
const IDEMPOTENT = new Set(['get', 'put', 'delete', 'head', 'options']);
const PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL = '2025-03-26';
const ROUTE = /^\/([a-z][a-z0-9_]*)\/mcp$/;
const TRAILING_PARAM = /\/\{([^}/]+)\}$/;
const USER_AGENT = `api-mcp/${version}`;
const DEFAULT_INSTRUCTIONS = 'Tools come from this API OpenAPI specification. Authentication is managed by Bifrost. Tool annotations identify reads and writes.';
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const decoder = new TextDecoder();

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
const anyOf = (patterns: string[]) => (patterns.length ? new RegExp(patterns.map(p => glob(p).source).join('|'), 'i') : null);

/** Filters match an operationId, `tag:<name>` or `path:<path>`; `*` is a wildcard. */
function matcher(patterns: string[]) {
  const ids = patterns.filter(p => !/^(tag|path):/.test(p)).map(glob);
  const tags = patterns.filter(p => p.startsWith('tag:')).map(p => glob(p.slice(4)));
  const paths = patterns.filter(p => p.startsWith('path:')).map(p => glob(p.slice(5)));
  return (name: string, op: Spec, path: string) => ids.some(r => r.test(name)) || paths.some(r => r.test(path)) || (op.tags ?? []).some((t: string) => tags.some(r => r.test(t)));
}

function baseUrl(source: ApiSource, spec: Spec): URL {
  const server = spec.servers?.[0];
  let raw: string | undefined = source.options.baseUrl ?? server?.url;
  if (!raw) throw new ConfigError(`${source.name}: the OpenAPI document has no server URL; set API_${source.name.toUpperCase()}_BASE_URL.`);
  if (!source.options.baseUrl) raw = raw.replace(/\{([^}]+)\}/g, (match, v: string) => server.variables?.[v]?.default ?? match);
  let url: URL;
  try { url = new URL(raw, source.url); } catch { throw new ConfigError(`${source.name}: invalid API base URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[{}]/.test(decodeURI(url.pathname))) {
    throw new ConfigError(`${source.name}: the API base URL must be HTTP(S) without credentials, queries, fragments or template variables.`);
  }
  return url;
}

function lazyValidator(ajv: Ajv, schema: Spec) {
  let compiled: ValidateFunction | undefined;
  return () => (compiled ??= ajv.compile(schema));
}

/** Turns a fetched OpenAPI document into MCP tools, applying the API's env-configured options. */
export function compileApi(source: ApiSource, spec: Spec): Api {
  if (!/^3\.[01]\./.test(spec?.openapi ?? '')) throw new ConfigError(`${source.name}: supply an OpenAPI 3.0 or 3.1 document.`);
  const { options } = source;
  const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true, validateFormats: true });
  addFormats(ajv);
  const included = options.include.length ? matcher(options.include) : () => true;
  const excluded = matcher(options.exclude);
  const fixedHeaders = new Set(options.headers.map(([k]) => k.toLowerCase()));
  const operations = new Map<string, Operation>(), tools: Tool[] = [];

  for (const [path, rawPath] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new ConfigError(`${source.name}: OpenAPI paths must be absolute API paths.`);
    const pathItem = resolve(spec, rawPath);
    for (const [method, op] of Object.entries<Spec>(pathItem)) {
      if (!METHODS.has(method)) continue;
      const name: string = op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      if ((options.readOnly && !READ.has(method)) || (op.deprecated && !options.includeDeprecated)) continue;
      if (!included(name, op, path) || excluded(name, op, path)) continue;
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(name) || operations.has(name)) throw new ConfigError(`${source.name}: tool names must be unique identifiers (operationId ${JSON.stringify(name)}).`);
      if (method === 'trace') continue;
      const plan = schemaFor(spec, op, pathItem);
      // Headers supplied by configuration or Bifrost are not tool arguments.
      plan.parameters = plan.parameters.filter(p => {
        if (p.in !== 'header') return true;
        const lower = p.name.toLowerCase();
        if (lower !== 'authorization' && !fixedHeaders.has(lower) && !options.forwardHeaders.includes(lower)) return true;
        delete plan.inputSchema.properties[p.argument];
        plan.inputSchema.required = plan.inputSchema.required.filter((r: string) => r !== p.argument);
        return false;
      });
      if (plan.body && (method === 'get' || method === 'head')) continue;
      const optionalTrailing: Parameter[] = [];
      if (options.optionalTrailingPathParams) {
        let rest = path;
        for (let m = TRAILING_PARAM.exec(rest); m; m = TRAILING_PARAM.exec(rest)) {
          const p = plan.parameters.find(x => x.in === 'path' && x.name === m?.[1]);
          if (!p) break;
          optionalTrailing.unshift(p);
          rest = rest.slice(0, m.index);
        }
        const optional = new Set(optionalTrailing.map(p => p.argument));
        plan.inputSchema.required = plan.inputSchema.required.filter((r: string) => !optional.has(r));
      }
      operations.set(name, { name, path, method: method.toUpperCase(), security: op.security, parameters: plan.parameters, optionalTrailing, body: plan.body, validator: lazyValidator(ajv, plan.inputSchema) });
      tools.push({
        name,
        description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
        inputSchema: plan.inputSchema,
        annotations: { readOnlyHint: READ.has(method), destructiveHint: !READ.has(method), idempotentHint: IDEMPOTENT.has(method), openWorldHint: true },
      });
    }
  }
  if (!tools.length) throw new ConfigError(`${source.name}: no operations left after filtering.`);
  const base = baseUrl(source, spec);
  return {
    name: source.name,
    base,
    basePath: base.pathname.replace(/\/$/, ''),
    options,
    responseHeaders: anyOf(options.responseHeaders),
    securitySchemes: spec.components?.securitySchemes ?? {},
    defaultSecurity: spec.security ?? [],
    operations,
    tools,
    toolsJson: JSON.stringify({ tools }),
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
  };
}

/** Upstream result already serialised: `text` is valid JSON; `object` says whether it is a JSON object. */
interface Payload { text: string; object: boolean }

export interface GatewayOptions extends Partial<Limits> {
  log?: Log;
  fetcher?: Fetcher;
}

export interface ApiStatus { tools?: number; loaded_at?: string; error?: string }

/** Serves MCP for whichever APIs are currently loaded; APIs can be swapped at runtime. */
export function createGateway(configured: string[], options: GatewayOptions = {}) {
  const limits: Limits = { requestBytes: options.requestBytes ?? 1048576, responseBytes: options.responseBytes ?? 1048576, timeoutMs: options.timeoutMs ?? 20000 };
  const services = new Map<string, Api>();
  const status = new Map<string, ApiStatus>(configured.map(name => [name, { error: 'Not loaded yet.' }]));
  let health = '';
  let healthy = false;
  const refreshHealth = () => {
    healthy = configured.every(name => services.has(name));
    health = JSON.stringify({ ok: healthy, version, apis: Object.fromEntries(status) });
  };
  refreshHealth();

  function setApi(api: Api) {
    services.set(api.name, api);
    status.set(api.name, { tools: api.tools.length, loaded_at: new Date().toISOString() });
    refreshHealth();
  }
  /** Records a load failure; a previously loaded version keeps serving. */
  function setError(name: string, message: string) {
    status.set(name, { ...status.get(name), error: message });
    refreshHealth();
  }

  async function invoke(api: Api, name: unknown, args: unknown, request: Request, fetcher: Fetcher): Promise<Payload> {
    const op = typeof name === 'string' ? api.operations.get(name) : undefined;
    if (!op) throw new CallError('Unknown tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CallError('Arguments must be an object.');
    // `args` is freshly parsed request JSON, so Ajv may apply defaults in place.
    const validate = op.validator();
    if (!validate(args)) {
      const detail = (validate.errors ?? []).map(e => `${e.instancePath} ${e.message}`).join('; ').slice(0, 500);
      throw new CallError(`Invalid arguments: ${detail}`);
    }
    const values = args as Record<string, unknown>;
    const headers = new Headers({ Accept: 'application/json', 'User-Agent': USER_AGENT });
    const credentials = applySecurity(api, op, request, headers);

    let path = op.path;
    const firstOmitted = op.optionalTrailing.findIndex(p => values[p.argument] === undefined);
    if (firstOmitted !== -1) {
      const later = op.optionalTrailing.slice(firstOmitted).find(p => values[p.argument] !== undefined);
      if (later) throw new CallError(`Provide ${op.optionalTrailing[firstOmitted]?.argument} when ${later.argument} is set.`);
      for (const _ of op.optionalTrailing.slice(firstOmitted)) path = path.replace(TRAILING_PARAM, '');
    }
    for (const p of op.parameters) {
      if (p.in === 'path' && values[p.argument] !== undefined) path = path.replaceAll(`{${p.name}}`, pathValue(p, values[p.argument]));
    }
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

    // Surface pagination-style response headers alongside the data.
    if (!api.responseHeaders) return data;
    const extracted: Record<string, string> = {};
    for (const [key, value] of response.headers) if (api.responseHeaders.test(key)) extracted[key] = value;
    if (!Object.keys(extracted).length) return data;
    return { text: `{"data":${data.text},"headers":${JSON.stringify(extracted)}}`, object: true };
  }

  const respond = (body: string, status = 200) => new Response(body, { status, headers: HEADERS });
  const json = (value: unknown, status = 200) => respond(JSON.stringify(value), status);
  const rpc = (id: unknown, resultJson: string) => respond(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${resultJson}}`);
  const fail = (id: unknown, code: number, message: string) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const toolError = (message: string) => JSON.stringify({ content: [{ type: 'text', text: message }], isError: true });

  async function handler(request: Request, fetcher: Fetcher = options.fetcher ?? fetch): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return respond(health, healthy ? 200 : 503);
    const match = ROUTE.exec(url.pathname);
    const name = match?.[1];
    const api = name ? services.get(name) : undefined;
    if (!api) return name && status.has(name) ? json({ error: 'API is still loading.' }, 503) : json({ error: 'Unknown API endpoint.' }, 404);
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

  return { handler, services, limits, setApi, setError };
}
