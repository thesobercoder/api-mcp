import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const READ = new Set(['get', 'head', 'options']);
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export class ConfigError extends Error {}
export class CallError extends Error {}

function pointer(doc, ref) {
  if (!ref.startsWith('#/')) throw new ConfigError('External $refs must be bundled into the OpenAPI document first.');
  let value = doc;
  for (const key of ref.slice(2).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (BAD_KEYS.has(key) || !value || !Object.hasOwn(value, key)) throw new ConfigError('Unresolved OpenAPI reference.');
    value = value[key];
  }
  return value;
}
function resolve(doc, value, depth = 0) {
  if (depth > 32) throw new ConfigError('OpenAPI reference nesting is too deep.');
  return value?.$ref ? resolve(doc, pointer(doc, value.$ref), depth + 1) : value;
}
function normalizeSchema(doc, value, defs, visiting = new Set()) {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => normalizeSchema(doc, v, defs, visiting));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (BAD_KEYS.has(key)) throw new ConfigError('Invalid schema property name.');
    if (key === '$ref') {
      if (!v.startsWith('#/')) throw new ConfigError('External $refs must be bundled before import.');
      const name = 'ref_' + Buffer.from(v).toString('hex');
      out.$ref = '#/$defs/' + name;
      if (!Object.hasOwn(defs, name) && !visiting.has(name)) {
        visiting.add(name); defs[name] = normalizeSchema(doc, pointer(doc, v), defs, visiting); visiting.delete(name);
      }
    } else if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) {
      out[key] = Object.fromEntries(Object.entries(v).filter(([k, child]) => {
        if (BAD_KEYS.has(k)) throw new ConfigError('Invalid schema property name.');
        return !(key === 'properties' && child?.readOnly);
      }).map(([k, child]) => [k, normalizeSchema(doc, child, defs, visiting)]));
    } else if (['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems'].includes(key)) {
      out[key] = normalizeSchema(doc, v, defs, visiting);
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      out[key] = v.map(child => normalizeSchema(doc, child, defs, visiting));
    } else if (!['nullable', 'example', 'xml', 'discriminator'].includes(key)) {
      out[key] = structuredClone(v);
    }
  }
  if (out.required && value.properties) out.required = out.required.filter(k => !value.properties[k]?.readOnly);
  if (value.nullable) {
    if (out.type) out.type = [...new Set([...(Array.isArray(out.type) ? out.type : [out.type]), 'null'])];
    else return { anyOf: [out, { type: 'null' }] };
  }
  for (const [exclusive, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (typeof out[exclusive] === 'boolean') {
      if (out[exclusive] && typeof out[bound] === 'number') { out[exclusive] = out[bound]; delete out[bound]; }
      else delete out[exclusive];
    }
  }
  // Binary form fields arrive as base64 strings over JSON-RPC.
  if (out.format === 'binary') { delete out.format; out.contentEncoding = 'base64'; }
  return out;
}
function readConfigValue(value, env) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'env')) {
    if (typeof value.env !== 'string' || !env[value.env]) throw new ConfigError('Missing configured environment variable.');
    return env[value.env];
  }
  if (typeof value !== 'string') throw new ConfigError('Configured header values must be strings or environment references.');
  return value;
}
function urlBase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ConfigError('Invalid API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ConfigError('API base URLs must be HTTP(S), without credentials, queries or fragments.');
  return url;
}
function schemaFor(doc, operation, pathItem) {
  const defs = {}, properties = {}, required = [], parameters = [];
  const merged = new Map();
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const p = resolve(doc, raw);
    if (!['path', 'query', 'header', 'cookie'].includes(p.in)) throw new ConfigError('Unsupported parameter location.');
    merged.set(p.in + ':' + p.name, p);
  }
  for (const p of merged.values()) {
    if (p.content) throw new ConfigError('Parameter content schemas are not supported; use a parameter schema.');
    let arg = p['x-mcp-argument-name'] ?? p.name;
    if (Object.hasOwn(properties, arg) || arg === 'body') arg = p.in + '_' + p.name;
    if (BAD_KEYS.has(arg) || Object.hasOwn(properties, arg)) throw new ConfigError('Conflicting parameter names.');
    properties[arg] = normalizeSchema(doc, p.schema ?? { type: 'string' }, defs);
    if (p.description) properties[arg].description = p.description;
    if (p.required || p.in === 'path') required.push(arg);
    parameters.push({ ...p, argument: arg });
  }
  let body = null;
  if (operation.requestBody) {
    const rb = resolve(doc, operation.requestBody), content = rb.content ?? {};
    const media = Object.keys(content).find(k => k === 'application/json' || k.endsWith('+json'))
      ?? ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'application/octet-stream'].find(k => content[k]);
    if (!media) throw new ConfigError('Unsupported request body media type.');
    body = { media, originalSchema: resolve(doc, content[media].schema ?? { type: 'string' }) };
    properties.body = normalizeSchema(doc, body.originalSchema, defs);
    if (rb.required) required.push('body');
  }
  const inputSchema = { type: 'object', properties, required, additionalProperties: false };
  if (Object.keys(defs).length) inputSchema.$defs = defs;
  return { inputSchema, parameters, body };
}
function simple(value, explode = false, encode = x => String(x)) {
  if (Array.isArray(value)) return value.map(encode).join(',');
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => explode ? encode(k) + '=' + encode(v) : encode(k) + ',' + encode(v)).join(',');
  return encode(value);
}
function pathValue(p, value) {
  if (p['x-mcp-omit-path-values']?.includes(value)) return '';
  const encoded = simple(value, p.explode ?? false, x => encodeURIComponent(String(x)));
  switch (p.style ?? 'simple') {
    case 'simple': return encoded;
    case 'label': return '.' + encoded.replace(/,/g, p.explode ? '.' : ',');
    case 'matrix': return ';' + encodeURIComponent(p.name) + '=' + encoded;
    default: throw new CallError('Unsupported path parameter style.');
  }
}
function queryValue(url, p, value) {
  const style = p.style ?? 'form', explode = p.explode ?? (style === 'form');
  if (style === 'deepObject') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CallError('deepObject requires an object.');
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') throw new CallError('Nested deepObject values are not supported.');
      url.searchParams.append(p.name + '[' + k + ']', String(v));
    }
  } else if (Array.isArray(value)) {
    if (style === 'form' && explode) for (const v of value) url.searchParams.append(p.name, String(v));
    else url.searchParams.append(p.name, value.join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
  } else if (value && typeof value === 'object') {
    if (style === 'form' && explode) for (const [k, v] of Object.entries(value)) url.searchParams.append(k, String(v));
    else url.searchParams.append(p.name, simple(value));
  } else url.searchParams.append(p.name, String(value));
}
function getSecurity(config, op, request, headers) {
  for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value);
  for (const name of config.forwardHeaders ?? ['authorization']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const security = op.security ?? config.spec.security ?? [];
  const injection = [];
  if (!security.length) return injection;
  for (const group of security) {
    const candidate = [];
    let valid = true;
    for (const name of Object.keys(group)) {
      const scheme = config.spec.components?.securitySchemes?.[name];
      if (!scheme) throw new ConfigError('Unknown security scheme.');
      const binding = config.securityBindings?.[name] ?? {};
      const source = binding.sourceHeader ?? (scheme.type === 'apiKey' ? scheme.name : 'authorization');
      let value = headers.get(source) ?? request.headers.get(source);
      if (!value) { valid = false; break; }
      if (binding.stripBearer) value = value.replace(/^Bearer\s+/i, '');
      if (scheme.type === 'apiKey') candidate.push({ location: scheme.in, name: scheme.name, value });
      else if (['oauth2', 'openIdConnect', 'http'].includes(scheme.type)) candidate.push({ location: 'header', name: 'Authorization', value });
      else throw new ConfigError('Unsupported security scheme.');
    }
    if (valid) return candidate;
  }
  throw new CallError('Authentication is required; connect this API in Bifrost.');
}
function encodeBody(body, value) {
  if (value === undefined) return {};
  if (body.media === 'application/json' || body.media.endsWith('+json')) return { contentType: body.media, payload: JSON.stringify(value) };
  if (body.media === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(value)) for (const item of Array.isArray(v) ? v : [v]) form.append(k, String(item));
    return { contentType: body.media, payload: form.toString() };
  }
  if (body.media === 'multipart/form-data') {
    const form = new FormData();
    for (const [k, value_] of Object.entries(value)) for (const v of Array.isArray(value_) ? value_ : [value_]) {
      const property = body.originalSchema.properties?.[k];
      if (property?.format === 'binary' || property?.contentEncoding === 'base64') form.append(k, new Blob([Buffer.from(v, 'base64')]), k);
      else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return { payload: form };
  }
  return { contentType: body.media, payload: body.media === 'application/octet-stream' ? Buffer.from(value, 'base64') : String(value) };
}
async function boundedBytes(response, max) {
  if (Number(response.headers.get('content-length')) > max) throw new CallError('Response exceeds the configured size limit.');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new CallError('Response exceeds the configured size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export function createGateway(input, options = {}) {
  const env = options.env ?? process.env;
  if (!input || !Array.isArray(input.apis) || !input.apis.length) throw new ConfigError('API_CONFIG must contain at least one API.');
  const limits = { requestBytes: options.requestBytes ?? 1048576, responseBytes: options.responseBytes ?? 1048576, timeoutMs: options.timeoutMs ?? 20000 };
  const services = new Map(), ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true, validateFormats: true });
  addFormats(ajv);
  for (const raw of input.apis) {
    if (!/^[a-z][a-z0-9_]*$/.test(raw.name) || services.has(raw.name)) throw new ConfigError('API names must be unique lowercase identifiers.');
    const config = { ...raw, headers: Object.fromEntries(Object.entries(raw.headers ?? {}).map(([k, v]) => [k, readConfigValue(v, env)])) };
    if (!/^3\.[01]\./.test(config.spec?.openapi ?? '')) throw new ConfigError('Supply a bundled OpenAPI 3.0 or 3.1 document.');
    config.base = urlBase(config.baseUrl ?? config.spec.servers?.[0]?.url);
    config.operations = new Map(); config.tools = [];
    for (const [path, rawPath] of Object.entries(config.spec.paths ?? {})) {
      if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new ConfigError('OpenAPI paths must be absolute API paths.');
      const pathItem = resolve(config.spec, rawPath);
      for (const [method, op] of Object.entries(pathItem)) {
        if (!METHODS.has(method)) continue;
        const name = op['x-mcp-tool-name'] ?? op.operationId ?? method + '_' + path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || config.operations.has(name)) throw new ConfigError('Tool names must be unique identifiers; set operationId or x-mcp-tool-name.');
        const parameters = schemaFor(config.spec, op, pathItem);
        for (const p of parameters.parameters) if (p.in === 'header' && (p.name.toLowerCase() === 'authorization' || Object.keys(config.headers).some(k => k.toLowerCase() === p.name.toLowerCase()))) throw new ConfigError('Authentication headers belong in securitySchemes, not tool parameters.');
        if (parameters.body && ['get', 'head'].includes(method)) throw new ConfigError('GET/HEAD request bodies are not supported.');
        const operation = { ...op, ...parameters, name, path, method, validator: null };
        config.operations.set(name, operation);
        config.tools.push({ name, description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`, inputSchema: parameters.inputSchema, annotations: { readOnlyHint: READ.has(method), destructiveHint: !READ.has(method), idempotentHint: ['get', 'put', 'delete', 'head', 'options'].includes(method), openWorldHint: true } });
      }
    }
    if (!config.tools.length) throw new ConfigError('An API has no operations.');
    services.set(config.name, config);
  }
  async function invoke(config, name, supplied, request, fetcher) {
    const operation = config.operations.get(name);
    if (!operation) throw new CallError('Unknown tool.');
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new CallError('Arguments must be an object.');
    const args = structuredClone(supplied);
    operation.validator ??= ajv.compile(operation.inputSchema);
    if (!operation.validator(args)) throw new CallError('Invalid arguments: ' + operation.validator.errors.map(e => e.instancePath + ' ' + e.message).join('; ').slice(0,500));
    let path = operation.path;
    const headers = new Headers({ Accept: 'application/json', 'User-Agent': 'api-mcp/1.0.0' });
    const auth = getSecurity(config, operation, request, headers);
    for (const p of operation.parameters) if (p.in === 'path') {
      path = path.replaceAll('{' + p.name + '}', pathValue(p, args[p.argument]));
    }
    path = path.replace(/\/$/, '');
    if (/\{[^}]+\}/.test(path)) throw new CallError('Unresolved path parameter.');
    const basePath = config.base.pathname.replace(/\/$/, '');
    const url = new URL(config.base.origin + basePath + path);
    if (url.origin !== config.base.origin || (basePath && !url.pathname.startsWith(basePath + '/'))) throw new CallError('Request would escape the configured API base.');
    const cookies = [];
    for (const p of operation.parameters) {
      const v = args[p.argument]; if (v === undefined || p.in === 'path') continue;
      if (p.in === 'query') queryValue(url, p, v);
      else if (p.in === 'header') headers.set(p.name, simple(v, p.explode));
      else cookies.push(encodeURIComponent(p.name) + '=' + encodeURIComponent(simple(v, p.explode)));
    }
    for (const item of auth) {
      if (item.location === 'header') headers.set(item.name, item.value);
      else if (item.location === 'query') url.searchParams.set(item.name, item.value);
      else if (item.location === 'cookie') cookies.push(encodeURIComponent(item.name) + '=' + encodeURIComponent(item.value));
      else throw new ConfigError('Invalid API key security location.');
    }
    if (cookies.length) headers.set('Cookie', cookies.join('; '));
    const body = operation.body ? encodeBody(operation.body, args.body) : {};
    if (body.contentType) headers.set('Content-Type', body.contentType);
    const response = await fetcher(url, { method: operation.method.toUpperCase(), headers, body: body.payload, redirect: 'error', signal: AbortSignal.timeout(limits.timeoutMs) });
    if (!response.ok) throw new CallError(`API returned HTTP ${response.status}${[401,403].includes(response.status) ? '; check the connection authentication in Bifrost' : response.status === 429 ? '; retry later' : ''}.`);
    const bytes = await boundedBytes(response, limits.responseBytes), contentType = response.headers.get('content-type') ?? '';
    let data;
    if (!bytes.length) data = { ok: true, status: response.status };
    else if (contentType.includes('json')) data = JSON.parse(new TextDecoder().decode(bytes));
    else if (contentType.startsWith('text/')) data = { text: new TextDecoder().decode(bytes), content_type: contentType };
    else data = { base64: Buffer.from(bytes).toString('base64'), content_type: contentType };
    if (config.wrapResponse || config.responseHeaders) {
      const extracted = {};
      for (const [key, header] of Object.entries(config.responseHeaders ?? {})) {
        const value = response.headers.get(header); if (value !== null) extracted[key] = value;
      }
      return { data, [config.responseHeadersKey ?? 'headers']: extracted };
    }
    return data;
  }
  function json(value, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
  const rpc = (id, result) => json({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  async function handler(request, fetcher = options.fetcher ?? fetch) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, version: '1.0.0', apis: [...services.keys()], tools: Object.fromEntries([...services].map(([k, v]) => [k, v.tools.length])) });
    const match = /^\/([a-z][a-z0-9_]*)\/mcp$/.exec(url.pathname), config = match ? services.get(match[1]) : null;
    if (!config) return json({ error: 'Unknown API endpoint.' }, 404);
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json({ error: 'Cross-origin requests are not supported.' }, 403);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(await boundedBytes(request, limits.requestBytes))); } catch { return fail(null, -32700, 'Invalid or oversized JSON request.'); }
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return fail(null, -32600, 'Invalid JSON-RPC request.');
    if (body.id === undefined) return new Response(null, { status: 202 });
    const { id, method, params = {} } = body;
    if (!['string', 'number'].includes(typeof id) || !params || typeof params !== 'object' || Array.isArray(params)) return fail(id, -32600, 'Invalid JSON-RPC request.');
    switch (method) {
      case 'initialize': return rpc(id, { protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: config.name, version: '1.0.0' }, instructions: config.instructions ?? 'Tools come from this API OpenAPI specification. Authentication is managed by Bifrost. Tool annotations identify reads and writes.' });
      case 'ping': return rpc(id, {});
      case 'tools/list': return rpc(id, { tools: config.tools });
      case 'tools/call': {
        const started = Date.now();
        try {
          const value = await invoke(config, params.name, params.arguments ?? {}, request, fetcher);
          options.log?.({ event: 'tool_call', api: config.name, tool: params.name, ok: true, duration_ms: Date.now() - started });
          return rpc(id, { content: [{ type: 'text', text: JSON.stringify(value) }], ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value } : {}), isError: false });
        } catch (e) {
          options.log?.({ event: 'tool_call', api: config.name, tool: params.name, ok: false, duration_ms: Date.now() - started });
          return rpc(id, { content: [{ type: 'text', text: e instanceof CallError ? e.message : 'The API request failed.' }], isError: true });
        }
      }
      default: return fail(id, -32601, 'Method not found.');
    }
  }
  return { handler, services, limits };
}
