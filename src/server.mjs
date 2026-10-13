import { createGateway } from './engine.mjs';

function positive(name, fallback) {
  const value = Number(Bun.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid numeric environment configuration: ' + name);
  return value;
}
if (!Bun.env.API_CONFIG) throw new Error('API_CONFIG is required.');
const level = Bun.env.LOG_LEVEL ?? 'info';
const log = event => { if (level !== 'silent') console.log(JSON.stringify({ time: new Date().toISOString(), ...event })); };
const gateway = createGateway(JSON.parse(Bun.env.API_CONFIG), {
  env: Bun.env, requestBytes: positive('MAX_REQUEST_BYTES', 1048576), responseBytes: positive('MAX_RESPONSE_BYTES', 1048576), timeoutMs: positive('UPSTREAM_TIMEOUT_MS', 20000), log,
});
let ready = true;
const server = Bun.serve({
  hostname: Bun.env.HOST ?? '::', port: positive('PORT', 8080), maxRequestBodySize: gateway.limits.requestBytes, idleTimeout: 30,
  fetch: req => ready ? gateway.handler(req) : new Response('Shutting down', { status: 503 }),
});
log({ event: 'started', service: 'api-mcp', port: server.port, apis: [...gateway.services.keys()] });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; ready = false;
  log({ event: 'stopping', service: 'api-mcp' });
  const timeout = setTimeout(() => process.exit(1), 25000); timeout.unref();
  await server.stop(false); clearTimeout(timeout); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
