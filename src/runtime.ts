import { ConfigError } from './errors';
import { compileApi, type createGateway } from './gateway';
import { loadSpec } from './loader';
import type { ApiSource, Fetcher, Log } from './types';

export interface RuntimeOptions {
  fetcher?: Fetcher;
  log?: Log;
  timeoutMs: number;
  maxSpecBytes: number;
  /** Re-fetch every document this often; 0 disables refresh. */
  refreshMs: number;
  /** Retry a failed initial load this often. */
  retryMs: number;
}

/** Fetches every configured spec, keeps them current and retries failures, without blocking startup. */
export function startRuntime(gateway: ReturnType<typeof createGateway>, sources: ApiSource[], options: RuntimeOptions) {
  const fingerprints = new Map<string, string>();
  const timers = new Set<Timer>();
  const fetcher = options.fetcher ?? fetch;

  async function load(source: ApiSource): Promise<boolean> {
    const started = performance.now();
    try {
      const { spec, fingerprint } = await loadSpec(source.url, { headers: source.options.specHeaders, fetcher, timeoutMs: options.timeoutMs, maxBytes: options.maxSpecBytes });
      if (fingerprints.get(source.name) === fingerprint) return true;
      const api = compileApi(source, spec);
      gateway.setApi(api);
      const reload = fingerprints.has(source.name);
      fingerprints.set(source.name, fingerprint);
      options.log?.({ event: reload ? 'api_updated' : 'api_loaded', api: source.name, tools: api.tools.length, duration_ms: Math.round(performance.now() - started) });
      return true;
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : `Could not load the OpenAPI document: ${(error as Error).name}.`;
      gateway.setError(source.name, message);
      options.log?.({ event: 'api_load_failed', api: source.name, error: message });
      return false;
    }
  }

  function schedule(source: ApiSource, ok: boolean) {
    const delay = ok ? options.refreshMs : options.retryMs;
    if (!delay) return;
    const timer = setTimeout(async () => { timers.delete(timer); schedule(source, await load(source)); }, delay);
    timers.add(timer);
  }

  const ready = Promise.all(sources.map(async source => schedule(source, await load(source))));
  return { ready, stop: () => { for (const t of timers) clearTimeout(t); timers.clear(); } };
}
