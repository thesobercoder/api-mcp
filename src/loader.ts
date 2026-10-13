import { boundedBytes } from './http';
import { ConfigError } from './errors';
import type { Fetcher, Spec } from './types';

const MAX_DOCUMENTS = 100;
const EXTERNAL = 'x-mcp-external';
const decoder = new TextDecoder();

export interface LoadOptions {
  headers: [string, string][];
  fetcher: Fetcher;
  timeoutMs: number;
  maxBytes: number;
}

export interface LoadedSpec {
  spec: Spec;
  /** Changes whenever any fetched document changes. */
  fingerprint: string;
}

function parse(text: string, url: string): Spec {
  try { return JSON.parse(text); } catch { /* fall through to YAML */ }
  try { return Bun.YAML.parse(text); } catch { throw new ConfigError(`OpenAPI document at ${new URL(url).origin} is not valid JSON or YAML.`); }
}

async function fetchDocument(url: string, options: LoadOptions): Promise<{ doc: Spec; text: string }> {
  const headers = new Headers({ Accept: 'application/json, application/yaml;q=0.9, */*;q=0.1', 'User-Agent': 'api-mcp' });
  for (const [name, value] of options.headers) headers.set(name, value);
  const response = await options.fetcher(new URL(url), { headers, signal: AbortSignal.timeout(options.timeoutMs) });
  if (!response.ok) throw new ConfigError(`OpenAPI document at ${new URL(url).origin} returned HTTP ${response.status}.`);
  const text = decoder.decode(await boundedBytes(response, options.maxBytes));
  return { doc: parse(text, url), text };
}

/**
 * Fetches an OpenAPI document and inlines any external `$ref` documents under
 * `x-mcp-external`, rewriting references so the result is self-contained.
 */
export async function loadSpec(url: string, options: LoadOptions): Promise<LoadedSpec> {
  const root = await fetchDocument(url, options);
  const keys = new Map<string, string>(), external: Record<string, Spec> = {};
  const hasher = new Bun.CryptoHasher('sha256').update(root.text);

  async function include(href: string): Promise<string> {
    const known = keys.get(href);
    if (known) return known;
    if (keys.size >= MAX_DOCUMENTS) throw new ConfigError('OpenAPI document references too many external documents.');
    const key = `d${keys.size}`;
    keys.set(href, key);
    const { doc, text } = await fetchDocument(href, options);
    hasher.update(text);
    external[key] = doc;
    await walk(doc, href, `#/${EXTERNAL}/${key}`);
    return key;
  }

  async function walk(node: Spec, baseUrl: string, prefix: string): Promise<void> {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) await walk(item, baseUrl, prefix); return; }
    if (typeof node.$ref === 'string') {
      const hash = node.$ref.indexOf('#');
      const target = hash === -1 ? node.$ref : node.$ref.slice(0, hash);
      const fragment = hash === -1 ? '' : node.$ref.slice(hash + 1);
      if (target) {
        const href = new URL(target, baseUrl);
        if (!['http:', 'https:'].includes(href.protocol)) throw new ConfigError('External $refs must use HTTP(S).');
        href.hash = '';
        node.$ref = `#/${EXTERNAL}/${await include(href.href)}${fragment}`;
      } else if (prefix !== '#') node.$ref = prefix + fragment;
    }
    for (const [key, value] of Object.entries(node)) if (key !== '$ref') await walk(value, baseUrl, prefix);
  }

  await walk(root.doc, url, '#');
  if (keys.size) root.doc[EXTERNAL] = external;
  return { spec: root.doc, fingerprint: hasher.digest('hex') };
}
