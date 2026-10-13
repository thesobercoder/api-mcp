import bundledConfig from '../config/apis.json';
import { version } from '../package.json';
import { createGateway } from './gateway';

function positive(name: string, fallback: number): number {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid numeric environment configuration: ${name}`);
  return value;
}

const silent = Bun.env.LOG_LEVEL === 'silent';
const log = (event: Record<string, unknown>) => {
  if (!silent) console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
};

// API definitions ship in the image; API_CONFIG can override them without a rebuild.
const config = Bun.env.API_CONFIG ? JSON.parse(Bun.env.API_CONFIG) : bundledConfig;
const gateway = createGateway(config, {
  env: Bun.env,
  requestBytes: positive('MAX_REQUEST_BYTES', 1048576),
  responseBytes: positive('MAX_RESPONSE_BYTES', 1048576),
  timeoutMs: positive('UPSTREAM_TIMEOUT_MS', 20000),
  log,
});

let ready = true;
const server = Bun.serve({
  hostname: Bun.env.HOST ?? '::',
  port: positive('PORT', 8080),
  maxRequestBodySize: gateway.limits.requestBytes,
  idleTimeout: 30,
  fetch: request => (ready ? gateway.handler(request) : new Response('Shutting down', { status: 503 })),
});
log({ event: 'started', service: 'api-mcp', version, bun: Bun.version, port: server.port, apis: [...gateway.services.keys()] });

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  ready = false;
  log({ event: 'stopping', service: 'api-mcp' });
  setTimeout(() => process.exit(1), 25000).unref();
  await server.stop(false);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
