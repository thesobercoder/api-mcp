import { afterEach, expect, test } from 'bun:test';
import { handle } from '../src/server';
import trakt from './fixtures/trakt.json';
import whoop from './fixtures/whoop.json';

const SPECS: Record<string, unknown> = {
  'https://developer.trakt.tv/openapi.json': trakt,
  'https://api.prod.whoop.com/developer/doc/openapi.json': whoop,
};
let seen: Request | undefined;
let upstream = () => Response.json([{ id: 1 }]);
globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
  const spec = SPECS[String(url)];
  if (spec) return Response.json(spec);
  seen = new Request(url, init);
  return upstream();
}) as typeof fetch;
afterEach(() => { upstream = () => Response.json([{ id: 1 }]); });

const rpc = async (spec: string, method: string, params = {}, headers = {}) =>
  (await (await handle(new Request(`http://x/mcp?spec=${encodeURIComponent(spec)}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json());
const TRAKT = 'https://developer.trakt.tv/openapi.json', WHOOP = 'https://api.prod.whoop.com/developer/doc/openapi.json';

test('any spec URL becomes an MCP server with resolved schemas', async () => {
  expect((await rpc(TRAKT, 'tools/list')).result.tools.length).toBe(331);
  const tools = (await rpc(WHOOP, 'tools/list')).result.tools;
  expect(tools.length).toBe(22);
  expect(JSON.stringify(tools)).not.toContain('$ref');
});

test('tool calls build the request and pass on Bifrost credentials only', async () => {
  const result = (await rpc(TRAKT, 'tools/call', { name: 'getSearchQuery', arguments: { type: 'movie', query: 'Dune', limit: 2 } },
    { authorization: 'Bearer user', 'trakt-api-key': 'key', cookie: 'private' })).result;
  expect(result).toEqual({ content: [{ type: 'text', text: '[{"id":1}]' }], isError: false });
  expect(seen?.url).toBe('https://api.trakt.tv/search/movie?query=Dune&limit=2');
  expect(seen?.headers.get('authorization')).toBe('Bearer user');
  expect(seen?.headers.get('trakt-api-key')).toBe('key');
  expect(seen?.headers.get('cookie')).toBeNull();
  await rpc(WHOOP, 'tools/call', { name: 'getRecoveryCollection', arguments: { limit: 5 } });
  expect(seen?.url).toBe('https://api.prod.whoop.com/developer/v2/recovery?limit=5');
});

test('errors come back as tool or protocol errors', async () => {
  upstream = () => new Response('denied', { status: 401 });
  expect((await rpc(WHOOP, 'tools/call', { name: 'getProfileBasic' })).result.content[0].text).toBe('HTTP 401: denied');
  expect((await rpc(TRAKT, 'tools/call', { name: 'getSyncHistoryGet', arguments: { type: '..', id: '1' } })).result.isError).toBe(true);
  expect((await rpc(TRAKT, 'tools/call', { name: 'nope' })).result.isError).toBe(true);
  expect((await rpc('https://missing.example/openapi.json', 'tools/list')).error.message).toContain('HTTP 401');
  expect((await handle(new Request('http://x/mcp?spec=http://insecure', { method: 'POST' }))).status).toBe(400);
});
