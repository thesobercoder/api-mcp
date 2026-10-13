import { CallError, ConfigError } from './errors';
import type { Api, Operation } from './types';

export interface Credential { location: 'header' | 'query' | 'cookie'; name: string; value: string }

/** Applies static and forwarded headers, then picks the first satisfiable security requirement. */
export function applySecurity(api: Api, op: Operation, request: Request, headers: Headers): Credential[] {
  for (const [name, value] of api.options.headers) headers.set(name, value);
  for (const name of api.options.forwardHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const requirements = op.security ?? api.defaultSecurity;
  if (!requirements.length) return [];
  for (const group of requirements) {
    const candidate: Credential[] = [];
    let satisfied = true;
    for (const name of Object.keys(group)) {
      const scheme = api.securitySchemes[name];
      if (!scheme) throw new ConfigError('Unknown security scheme.');
      const binding = api.options.securityBindings[name] ?? {};
      const source = binding.sourceHeader ?? (scheme.type === 'apiKey' ? scheme.name : 'authorization');
      let value = headers.get(source) ?? request.headers.get(source);
      if (!value) { satisfied = false; break; }
      if (binding.stripBearer) value = value.replace(/^Bearer\s+/i, '');
      if (scheme.type === 'apiKey') candidate.push({ location: scheme.in, name: scheme.name, value });
      else if (['oauth2', 'openIdConnect', 'http'].includes(scheme.type)) candidate.push({ location: 'header', name: 'Authorization', value });
      else throw new ConfigError('Unsupported security scheme.');
    }
    if (satisfied) return candidate;
  }
  throw new CallError('Authentication is required; connect this API in Bifrost.');
}
