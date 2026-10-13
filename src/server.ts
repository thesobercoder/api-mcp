// Serves any OpenAPI document as an MCP server: POST /mcp?spec=<https URL of the document>.
// No configuration. Authentication comes from the caller; this only turns MCP tool calls into HTTP requests.
// It fetches whatever spec URL it is given, so keep it on a private network.

type Json = any;
interface Op { method: string; path: string; params: { name: string; in: string }[] }
export interface Api { base: string; forward: string[]; tools: Json[]; ops: Map<string, Op> }

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const READ = ['get', 'head', 'options'];

/** Inlines local `#/...` references so every tool schema is self-contained. */
function deref(doc: Json, node: Json, seen: string[] = []): Json {
  if (Array.isArray(node)) return node.map(n => deref(doc, n, seen));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.includes(node.$ref)) return {}; // recursive schema: stop expanding
    const target = node.$ref.slice(2).split('/').reduce((o: Json, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return deref(doc, target, [...seen, node.$ref]);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(doc, v, seen)]));
}

export function compile(doc: Json, specUrl: string): Api {
  const server = doc.servers?.[0];
  const base = new URL((server?.url ?? '/').replace(/\{(\w+)\}/g, (_: string, v: string) => server.variables?.[v]?.default ?? ''), specUrl).href.replace(/\/$/, '');
  // Pass on the caller's Authorization plus any API-key headers the document declares.
  const schemes = Object.values<Json>(doc.components?.securitySchemes ?? {});
  const forward = ['authorization', ...schemes.filter(s => s.type === 'apiKey' && s.in === 'header').map(s => s.name.toLowerCase())];
  const tools: Json[] = [], ops = new Map<string, Op>();
  for (const [path, item] of Object.entries<Json>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const name = (op.operationId ?? `${method}_${path}`).replace(/[^a-zA-Z0-9_]+/g, '_');
      const params = deref(doc, [...(item.parameters ?? []), ...(op.parameters ?? [])]);
      const properties: Json = {}, required: string[] = [];
      for (const p of params) {
        properties[p.name] = { ...p.schema, description: p.description };
        if (p.required || p.in === 'path') required.push(p.name);
      }
      const body = deref(doc, op.requestBody);
      if (body) {
        properties.body = Object.values<Json>(body.content ?? {})[0]?.schema ?? {};
        if (body.required) required.push('body');
      }
      ops.set(name, { method: method.toUpperCase(), path, params });
      tools.push({
        name,
        description: [op.summary, op.description].filter(Boolean).join('\n\n') || `${method.toUpperCase()} ${path}`,
        inputSchema: { type: 'object', properties, required },
        annotations: { readOnlyHint: READ.includes(method), destructiveHint: !READ.includes(method) },
      });
    }
  }
  return { base, forward, tools, ops };
}

async function call(api: Api, name: string, args: Json, incoming: Headers): Promise<{ text: string; isError: boolean }> {
  const op = api.ops.get(name);
  if (!op) return { text: `Unknown tool: ${name}`, isError: true };
  const path = op.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = String(args[key] ?? '');
    if (!value || value === '.' || value === '..') throw new Error(`Missing or invalid path parameter: ${key}`);
    return encodeURIComponent(value);
  });
  const url = new URL(api.base + path);
  const headers = new Headers({ accept: 'application/json' });
  for (const h of api.forward) if (incoming.has(h)) headers.set(h, incoming.get(h) as string);
  for (const p of op.params) {
    const value = args[p.name];
    if (value === undefined || p.in === 'path') continue;
    if (p.in === 'query') for (const v of [value].flat()) url.searchParams.append(p.name, String(v));
    if (p.in === 'header') headers.set(p.name, String(value));
  }
  if (args.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(url, {
    method: op.method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  const text = await response.text();
  return response.ok ? { text: text || `HTTP ${response.status}`, isError: false } : { text: `HTTP ${response.status}: ${text.slice(0, 1000)}`, isError: true };
}

const cache = new Map<string, Promise<Api>>();

/** Loads and compiles a spec once per process; failures are retried on the next request. */
function api(spec: string): Promise<Api> {
  let entry = cache.get(spec);
  if (!entry) {
    entry = load(spec).then(doc => compile(doc, spec));
    entry.catch(() => cache.delete(spec));
    cache.set(spec, entry);
  }
  return entry;
}

/** Handles MCP JSON-RPC over plain HTTP POST (stateless Streamable HTTP). */
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('ok');
  if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const spec = url.searchParams.get('spec') ?? '';
  if (!spec.startsWith('https://')) return new Response('Add ?spec=<https URL of an OpenAPI document>', { status: 400 });
  const { id, method, params = {} } = await request.json().catch(() => ({}));
  if (id === undefined) return new Response(null, { status: 202 }); // notification
  const reply = (result: Json) => Response.json({ jsonrpc: '2.0', id, result });
  const fail = (message: string) => Response.json({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  let target: Api;
  try { target = await api(spec); } catch (e) { return fail(`Could not load the OpenAPI document: ${(e as Error).message}`); }
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'api-mcp', version: '4.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: target.tools });
    case 'tools/call': {
      const result = await call(target, params.name, params.arguments ?? {}, request.headers).catch((e: Error) => ({ text: e.message, isError: true }));
      return reply({ content: [{ type: 'text', text: result.text }], isError: result.isError });
    }
    default: return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

export async function load(url: string): Promise<Json> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return Bun.YAML.parse(text); }
}

if (import.meta.main) {
  Bun.serve({ hostname: '::', port: Number(Bun.env.PORT ?? 8080), fetch: handle });
  console.log(JSON.stringify({ event: 'started', bun: Bun.version }));
}
