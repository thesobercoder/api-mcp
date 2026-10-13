import { CallError } from './errors';
import type { Parameter, RequestBody } from './types';

type Encode = (value: unknown) => string;
const plain: Encode = String;
const uri: Encode = value => encodeURIComponent(String(value));

/** OpenAPI "simple" serialisation for arrays and objects. */
export function simple(value: unknown, explode = false, encode = plain): string {
  if (Array.isArray(value)) return value.map(encode).join(',');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => encode(k) + (explode ? '=' : ',') + encode(v)).join(',');
  }
  return encode(value);
}

export function pathValue(p: Parameter, value: unknown): string {
  if (p['x-mcp-omit-path-values']?.includes(value)) return '';
  const encoded = simple(value, p.explode ?? false, uri);
  switch (p.style ?? 'simple') {
    case 'simple': return encoded;
    case 'label': return `.${encoded.replace(/,/g, p.explode ? '.' : ',')}`;
    case 'matrix': return `;${encodeURIComponent(p.name)}=${encoded}`;
    default: throw new CallError('Unsupported path parameter style.');
  }
}

export function queryValue(url: URL, p: Parameter, value: unknown): void {
  const style = p.style ?? 'form', explode = p.explode ?? style === 'form', params = url.searchParams;
  if (style === 'deepObject') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CallError('deepObject requires an object.');
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') throw new CallError('Nested deepObject values are not supported.');
      params.append(`${p.name}[${k}]`, String(v));
    }
  } else if (Array.isArray(value)) {
    if (style === 'form' && explode) for (const v of value) params.append(p.name, String(v));
    else params.append(p.name, value.join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
  } else if (value && typeof value === 'object') {
    if (style === 'form' && explode) for (const [k, v] of Object.entries(value)) params.append(k, String(v));
    else params.append(p.name, simple(value));
  } else params.append(p.name, String(value));
}

const each = (value: unknown) => (Array.isArray(value) ? value : [value]);

export function encodeBody(body: RequestBody, value: unknown): { contentType?: string; payload?: RequestInit['body'] } {
  if (value === undefined) return {};
  const { media } = body;
  if (media === 'application/json' || media.endsWith('+json')) return { contentType: media, payload: JSON.stringify(value) };
  if (media === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(value as object)) for (const item of each(v)) form.append(k, String(item));
    return { contentType: media, payload: form.toString() };
  }
  if (media === 'multipart/form-data') {
    const form = new FormData();
    for (const [k, values] of Object.entries(value as object)) {
      const property = body.originalSchema.properties?.[k];
      const binary = property?.format === 'binary' || property?.contentEncoding === 'base64';
      for (const v of each(values)) {
        if (binary) form.append(k, new Blob([Buffer.from(String(v), 'base64')]), k);
        else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
    return { payload: form };
  }
  return { contentType: media, payload: media === 'application/octet-stream' ? Buffer.from(String(value), 'base64') : String(value) };
}

const TOO_LARGE = 'Response exceeds the configured size limit.';

/** Reads a body without buffering more than `max` bytes. */
export async function boundedBytes(message: Request | Response, max: number): Promise<Uint8Array> {
  const declared = message.headers.get('content-length');
  // Known, uncompressed length: one native read, no chunk bookkeeping.
  if (declared !== null && !message.headers.has('content-encoding')) {
    if (Number(declared) > max) throw new CallError(TOO_LARGE);
    const bytes = await message.bytes();
    if (bytes.byteLength > max) throw new CallError(TOO_LARGE);
    return bytes;
  }
  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new CallError(TOO_LARGE); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
