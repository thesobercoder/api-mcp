import { version } from '../package.json';
import { readSources } from './config';
import { createGateway } from './gateway';
import { startRuntime } from './runtime';

function number(name: string, fallback: number, min = 1): number {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid numeric environment configuration: ${name}`);
  return value;
}

const silent = Bun.env.LOG_LEVEL === 'silent';
const log = (event: Record<string, unknown>) => {
  if (!silent) console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
};

// Nothing about the APIs is baked into the image: OPENAPI_SPECS lists them, API_<NAME>_* tunes each one.
const sources = readSources(Bun.env);
const gateway = createGateway(sources.map(s => s.name), {
  requestBytes: number('MAX_REQUEST_BYTES', 1048576),
  responseBytes: number('MAX_RESPONSE_BYTES', 1048576),
  timeoutMs: number('UPSTREAM_TIMEOUT_MS', 20000),
  log,
});

let ready = true;
const server = Bun.serve({
  hostname: Bun.env.HOST ?? '::',
  port: number('PORT', 8080),
  maxRequestBodySize: gateway.limits.requestBytes,
  idleTimeout: 30,
  fetch: request => (ready ? gateway.handler(request) : new Response('Shutting down', { status: 503 })),
});
log({ event: 'started', service: 'api-mcp', version, bun: Bun.version, port: server.port, apis: sources.map(s => s.name) });

const runtime = startRuntime(gateway, sources, {
  log,
  timeoutMs: number('SPEC_TIMEOUT_MS', 30000),
  maxSpecBytes: number('MAX_SPEC_BYTES', 20 * 1048576),
  refreshMs: number('SPEC_REFRESH_SECONDS', 3600, 0) * 1000,
  retryMs: number('SPEC_RETRY_SECONDS', 30) * 1000,
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  ready = false;
  runtime.stop();
  log({ event: 'stopping', service: 'api-mcp' });
  setTimeout(() => process.exit(1), 25000).unref();
  await server.stop(false);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
