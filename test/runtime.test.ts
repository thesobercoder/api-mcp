// @ts-nocheck -- compact fixtures; behaviour is what's under test.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readSources } from '../src/config';
import { createGateway } from '../src/gateway';
import { loadSpec } from '../src/loader';
import { startRuntime } from '../src/runtime';

const yamlRoot = `openapi: 3.1.0
info: {title: Split, version: "1"}
servers: [{url: /v1}]
paths:
  /items:
    get:
      operationId: listItems
      parameters:
        - $ref: 'parts/params.json#/limit'
      responses: {}
`;
const params = { limit: { name: 'limit', in: 'query', schema: { $ref: '#/schemas/Limit' } }, schemas: { Limit: { type: 'integer', maximum: 10 } } };

function server(files) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: url.href, auth: init?.headers?.get?.('authorization') });
    const body = files[url.href];
    if (body instanceof Error) throw body;
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body));
  };
  return { fetcher, calls };
}

test('YAML specs with relative external $refs are fetched and inlined at runtime', async () => {
  const { fetcher, calls } = server({ 'https://specs.example/api/root.yaml': yamlRoot, 'https://specs.example/api/parts/params.json': params });
  const { spec, fingerprint } = await loadSpec('https://specs.example/api/root.yaml', { headers: [['Authorization', 'token spec']], fetcher, timeoutMs: 1000, maxBytes: 1e6 });
  assert.equal(spec.paths['/items'].get.parameters[0].$ref, '#/x-mcp-external/d0/limit');
  assert.equal(spec['x-mcp-external'].d0.limit.schema.$ref, '#/x-mcp-external/d0/schemas/Limit');
  assert.equal(fingerprint.length, 64);
  assert.ok(calls.every(c => c.auth === 'token spec'));
});

test('the runtime loads specs, reports health, retries failures and keeps the last good version', async () => {
  const files = { 'https://specs.example/api/root.yaml': new Error('offline'), 'https://specs.example/api/parts/params.json': params };
  const { fetcher } = server(files);
  const sources = readSources({ OPENAPI_SPECS: 'split=https://specs.example/api/root.yaml' });
  const gateway = createGateway(['split']);
  const logs = [];
  const runtime = startRuntime(gateway, sources, { fetcher, log: e => logs.push(e), timeoutMs: 1000, maxSpecBytes: 1e6, refreshMs: 20, retryMs: 10 });
  await runtime.ready;
  assert.equal((await gateway.handler(new Request('http://x/health'))).status, 503);
  assert.equal((await gateway.handler(new Request('http://x/split/mcp', { method: 'POST' }))).status, 503);

  files['https://specs.example/api/root.yaml'] = yamlRoot;
  await Bun.sleep(40);
  const health = await (await gateway.handler(new Request('http://x/health'))).json();
  assert.equal(health.ok, true); assert.equal(health.apis.split.tools, 1);
  assert.equal(gateway.services.get('split').base.href, 'https://specs.example/v1');

  files['https://specs.example/api/root.yaml'] = 'not: [valid';
  await Bun.sleep(40);
  runtime.stop();
  assert.equal(gateway.services.get('split').tools.length, 1);
  assert.ok(logs.some(e => e.event === 'api_load_failed'));
  assert.equal(logs.filter(e => e.event === 'api_loaded').length, 1);
});
