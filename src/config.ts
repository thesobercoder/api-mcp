import { ConfigError } from './errors';
import type { ApiOptions, ApiSource, Env, SecurityBinding } from './types';

const NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_RESPONSE_HEADERS = ['x-pagination-*', 'link', 'x-total-count'];

/** Replaces `${VAR}` with the environment value, so secrets stay in their own variables. */
export function expand(value: string, env: Env, variable: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (!resolved) throw new ConfigError(`${variable} references ${name}, which is not set.`);
    return resolved;
  });
}

const list = (value: string | undefined) => (value ?? '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
const flag = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '');

function jsonObject(env: Env, variable: string): Record<string, unknown> {
  const raw = env[variable];
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigError(`${variable} must be a JSON object.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError(`${variable} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function headers(env: Env, variable: string): [string, string][] {
  return Object.entries(jsonObject(env, variable)).map(([name, value]) => {
    if (typeof value !== 'string') throw new ConfigError(`${variable} values must be strings.`);
    return [name, expand(value, env, variable)];
  });
}

function options(name: string, env: Env): ApiOptions {
  const prefix = `API_${name.toUpperCase()}_`;
  const v = (key: string) => env[prefix + key];
  const forward = v('FORWARD_HEADERS');
  const responseHeaders = v('RESPONSE_HEADERS');
  return {
    baseUrl: v('BASE_URL') || undefined,
    headers: headers(env, `${prefix}HEADERS`),
    specHeaders: headers(env, `${prefix}SPEC_HEADERS`),
    forwardHeaders: forward === undefined ? ['authorization'] : list(forward).map(h => h.toLowerCase()),
    securityBindings: jsonObject(env, `${prefix}SECURITY_BINDINGS`) as Record<string, SecurityBinding>,
    readOnly: flag(v('READ_ONLY')),
    include: list(v('INCLUDE')),
    exclude: list(v('EXCLUDE')),
    includeDeprecated: flag(v('INCLUDE_DEPRECATED')),
    optionalTrailingPathParams: flag(v('OPTIONAL_TRAILING_PATH_PARAMS')),
    responseHeaders: responseHeaders === undefined ? DEFAULT_RESPONSE_HEADERS : list(responseHeaders),
    instructions: v('INSTRUCTIONS') || undefined,
  };
}

/**
 * Reads `OPENAPI_SPECS` ("name=url" pairs separated by commas or newlines)
 * plus each API's optional `API_<NAME>_*` settings.
 */
export function readSources(env: Env): ApiSource[] {
  const entries = list(env.OPENAPI_SPECS);
  if (!entries.length) throw new ConfigError('OPENAPI_SPECS must list at least one name=url pair.');
  const seen = new Set<string>();
  return entries.map(entry => {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at).trim(), url = entry.slice(at + 1).trim();
    if (at < 1 || !NAME.test(name) || seen.has(name)) throw new ConfigError('OPENAPI_SPECS names must be unique lowercase identifiers (name=url).');
    let parsed: URL;
    try { parsed = new URL(expand(url, env, 'OPENAPI_SPECS')); } catch (e) { throw e instanceof ConfigError ? e : new ConfigError(`OPENAPI_SPECS has an invalid URL for ${name}.`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ConfigError(`OPENAPI_SPECS URL for ${name} must be HTTP(S).`);
    seen.add(name);
    return { name, url: parsed.href, options: options(name, env) };
  });
}
