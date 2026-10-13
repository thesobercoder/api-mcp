import { expect, test } from 'bun:test';
import { type Api, compile, handle } from '../src/server';
import trakt from './fixtures/trakt.json';
import whoop from './fixtures/whoop.json';

const apis = new Map<string, Api>([
  ['trakt', compile(trakt, 'https://developer.trakt.tv/openapi.json')],
  ['whoop', compile(whoop, 'https://api.prod.whoop.com/developer/doc/openapi.json')],
]);
const rpc = async (api: string, method: string, params = {}, headers = {}) =>
  (await (await handle(apis, new Request(`http://x/${api}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json()).result;

test('every operation in the real specs becomes a tool with resolved schemas', async () => {
  expect((await rpc('trakt', 'tools/list')).tools.length).toBe(331);
  const tools = (await rpc('whoop', 'tools/list')).tools;
  expect(tools.length).toBe(22);
  expect(JSON.stringify(tools)).not.toContain('$ref');
});

test('tool calls build the request and pass on Bifrost credentials only', async () => {
  let seen: Request | undefined;
  globalThis.fetch = (async (url: URL, init: RequestInit) => { seen = new Request(url, init); return Response.json([{ id: 1 }]); }) as typeof fetch;
  const result = await rpc('trakt', 'tools/call', { name: 'getSearchQuery', arguments: { type: 'movie', query: 'Dune', limit: 2 } },
    { authorization: 'Bearer user', 'trakt-api-key': 'key', cookie: 'private' });
  expect(result).toEqual({ content: [{ type: 'text', text: '[{"id":1}]' }], isError: false });
  expect(seen?.url).toBe('https://api.trakt.tv/search/movie?query=Dune&limit=2');
  expect(seen?.headers.get('authorization')).toBe('Bearer user');
  expect(seen?.headers.get('trakt-api-key')).toBe('key');
  expect(seen?.headers.get('cookie')).toBeNull();

  await rpc('whoop', 'tools/call', { name: 'getRecoveryCollection', arguments: { limit: 5 } });
  expect(seen?.url).toBe('https://api.prod.whoop.com/developer/v2/recovery?limit=5');
});

test('errors come back as tool errors', async () => {
  globalThis.fetch = (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
  expect((await rpc('whoop', 'tools/call', { name: 'getProfileBasic' })).content[0].text).toBe('HTTP 401: denied');
  expect((await rpc('trakt', 'tools/call', { name: 'getSyncHistoryGet', arguments: { type: '..', id: '1' } })).isError).toBe(true);
  expect((await rpc('trakt', 'tools/call', { name: 'nope' })).isError).toBe(true);
});
