import { ConfigError } from './errors';
import type { Parameter, RequestBody, Spec } from './types';

export const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LOCATIONS = new Set(['path', 'query', 'header', 'cookie']);
const MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_KEYS = new Set(['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems']);
const LIST_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const DROPPED_KEYS = new Set(['nullable', 'example', 'xml', 'discriminator']);
const BODY_MEDIA = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'application/octet-stream'];

function pointer(doc: Spec, ref: string): Spec {
  if (!ref.startsWith('#/')) throw new ConfigError('External $refs must be bundled into the OpenAPI document first.');
  let value = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (BAD_KEYS.has(key) || !value || !Object.hasOwn(value, key)) throw new ConfigError('Unresolved OpenAPI reference.');
    value = value[key];
  }
  return value;
}

export function resolve(doc: Spec, value: Spec, depth = 0): Spec {
  if (depth > 32) throw new ConfigError('OpenAPI reference nesting is too deep.');
  return value?.$ref ? resolve(doc, pointer(doc, value.$ref), depth + 1) : value;
}

/** Converts an OpenAPI schema into JSON Schema 2020-12, inlining local refs as $defs. */
function normalizeSchema(doc: Spec, value: Spec, defs: Record<string, Spec>, visiting = new Set<string>()): Spec {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => normalizeSchema(doc, v, defs, visiting));
  const out: Spec = {};
  for (const [key, v] of Object.entries<Spec>(value)) {
    if (BAD_KEYS.has(key)) throw new ConfigError('Invalid schema property name.');
    if (key === '$ref') {
      if (typeof v !== 'string' || !v.startsWith('#/')) throw new ConfigError('External $refs must be bundled before import.');
      const name = `ref_${Buffer.from(v).toString('hex')}`;
      out.$ref = `#/$defs/${name}`;
      if (!Object.hasOwn(defs, name) && !visiting.has(name)) {
        visiting.add(name);
        defs[name] = normalizeSchema(doc, pointer(doc, v), defs, visiting);
        visiting.delete(name);
      }
    } else if (MAP_KEYS.has(key)) {
      out[key] = {};
      for (const [k, child] of Object.entries<Spec>(v)) {
        if (BAD_KEYS.has(k)) throw new ConfigError('Invalid schema property name.');
        if (key === 'properties' && child?.readOnly) continue;
        out[key][k] = normalizeSchema(doc, child, defs, visiting);
      }
    } else if (SCHEMA_KEYS.has(key)) out[key] = normalizeSchema(doc, v, defs, visiting);
    else if (LIST_KEYS.has(key)) out[key] = v.map((child: Spec) => normalizeSchema(doc, child, defs, visiting));
    else if (!DROPPED_KEYS.has(key)) out[key] = structuredClone(v);
  }
  if (out.required && value.properties) out.required = out.required.filter((k: string) => !value.properties[k]?.readOnly);
  if (value.nullable) {
    if (!out.type) return { anyOf: [out, { type: 'null' }] };
    out.type = [...new Set([...(Array.isArray(out.type) ? out.type : [out.type]), 'null'])];
  }
  for (const [exclusive, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (typeof out[exclusive] !== 'boolean') continue;
    if (out[exclusive] && typeof out[bound] === 'number') { out[exclusive] = out[bound]; delete out[bound]; }
    else delete out[exclusive];
  }
  // Binary fields arrive as base64 strings over JSON-RPC.
  if (out.format === 'binary') { delete out.format; out.contentEncoding = 'base64'; }
  return out;
}

/** Builds the MCP input schema and request plan for one OpenAPI operation. */
export function schemaFor(doc: Spec, operation: Spec, pathItem: Spec) {
  const defs: Record<string, Spec> = {}, properties: Record<string, Spec> = {}, required: string[] = [], parameters: Parameter[] = [];
  const merged = new Map<string, Spec>();
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const p = resolve(doc, raw);
    if (!LOCATIONS.has(p.in)) throw new ConfigError('Unsupported parameter location.');
    merged.set(`${p.in}:${p.name}`, p);
  }
  for (const p of merged.values()) {
    if (p.content) throw new ConfigError('Parameter content schemas are not supported; use a parameter schema.');
    let arg: string = p['x-mcp-argument-name'] ?? p.name;
    if (Object.hasOwn(properties, arg) || arg === 'body') arg = `${p.in}_${p.name}`;
    if (BAD_KEYS.has(arg) || Object.hasOwn(properties, arg)) throw new ConfigError('Conflicting parameter names.');
    properties[arg] = normalizeSchema(doc, p.schema ?? { type: 'string' }, defs);
    if (p.description) properties[arg].description = p.description;
    if (p.required || p.in === 'path') required.push(arg);
    parameters.push({ ...p, argument: arg });
  }
  let body: RequestBody | null = null;
  if (operation.requestBody) {
    const rb = resolve(doc, operation.requestBody), content = rb.content ?? {};
    const media = Object.keys(content).find(k => k === 'application/json' || k.endsWith('+json')) ?? BODY_MEDIA.find(k => content[k]);
    if (!media) throw new ConfigError('Unsupported request body media type.');
    body = { media, originalSchema: resolve(doc, content[media].schema ?? { type: 'string' }) };
    properties.body = normalizeSchema(doc, body.originalSchema, defs);
    if (rb.required) required.push('body');
  }
  const inputSchema: Spec = { type: 'object', properties, required, additionalProperties: false };
  if (Object.keys(defs).length) inputSchema.$defs = defs;
  return { inputSchema, parameters, body };
}
