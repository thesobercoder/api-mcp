// @ts-nocheck -- compact fixtures; behaviour is what's under test.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import trakt from './fixtures/trakt.json';
import whoop from './fixtures/whoop.json';
import { readSources } from '../src/config';
import { compileApi, ConfigError, createGateway } from '../src/gateway';

const rpcRequest = (api, method, params = {}, headers = {}) => new Request(`http://api-mcp.internal/${api}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
async function call(gateway, api, name, args = {}, headers = {}, fetcher) {
  return (await (await gateway.handler(rpcRequest(api, 'tools/call', { name, arguments: args }, headers), fetcher)).json()).result;
}
const parameter = (name, location, schema, extra = {}) => ({ name, in: location, schema, ...extra });
/** Builds a gateway the way the server does: sources from env, specs compiled at runtime. */
function gatewayFor(specs, env = {}, options = {}) {
  const names = Object.keys(specs);
  const sources = readSources({ OPENAPI_SPECS: names.map(n => `${n}=https://specs.example/${n}.json`).join(','), ...env });
  const gateway = createGateway(names, options);
  for (const source of sources) gateway.setApi(compileApi(source, structuredClone(specs[source.name])));
  return gateway;
}
function crmSpec() {
  return {
    openapi: '3.1.0', info: { title: 'Another API', version: '1' }, servers: [{ url: 'https://crm.example/v1' }],
    components: { schemas: {
      Entity: { type: 'object', properties: { id: { type: 'integer', readOnly: true }, title: { type: 'string', minLength: 1 }, nullable: { type: ['string','null'] } }, required: ['id', 'title'], additionalProperties: false },
      Node: { type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } } },
    } },
    paths: {
      '/entities/{id}': { parameters: [parameter('id', 'path', { type: 'string' }, { required: true })],
        get: { operationId: 'getEntity', parameters: [parameter('tags','query',{type:'array',items:{type:'string'}},{explode:true}),parameter('filter','query',{type:'object',additionalProperties:{type:'string'}},{style:'deepObject'})], responses:{} },
        put: { operationId: 'replaceEntity', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Entity' } } } }, responses:{} },
        patch: { operationId: 'patchEntity', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Entity' } } } }, responses:{} },
        delete: { operationId: 'deleteEntity', responses:{} },
      },
      '/entities': { post: { operationId:'createEntity',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Entity'}}}},responses:{} } },
      '/nodes': { post: { operationId:'createNode',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Node'}}}},responses:{} } },
      '/form': { post: { operationId:'submitForm',requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:{type:'object',properties:{title:{type:'string'},tags:{type:'array',items:{type:'string'}}},required:['title']}}}},responses:{} } },
      '/text': { get: { operationId:'readText', responses:{} } },
      '/empty': { delete: { operationId:'removeEmpty', responses:{} } },
      '/{id}': { get: { operationId:'baseBoundary', parameters:[parameter('id','path',{type:'string'},{required:true})],responses:{} } },
    },
  };
}

const TRAKT_ENV = { TRAKT_CLIENT_ID: 'public-client-id', API_TRAKT_HEADERS: '{"trakt-api-key":"${TRAKT_CLIENT_ID}","trakt-api-version":"2"}', API_TRAKT_READ_ONLY: 'true', API_TRAKT_OPTIONAL_TRAILING_PATH_PARAMS: 'true' };

test('OPENAPI_SPECS and API_<NAME>_* settings come only from the environment', () => {
  const [a, b] = readSources({ OPENAPI_SPECS: 'trakt=https://developer.trakt.tv/openapi.json,\n whoop=https://api.prod.whoop.com/developer/doc/openapi.json', ...TRAKT_ENV, API_WHOOP_EXCLUDE: 'tag:Partner*' });
  assert.equal(a.name, 'trakt'); assert.equal(b.url, 'https://api.prod.whoop.com/developer/doc/openapi.json');
  assert.deepEqual(a.options.headers, [['trakt-api-key', 'public-client-id'], ['trakt-api-version', '2']]);
  assert.equal(a.options.readOnly, true); assert.deepEqual(b.options.exclude, ['tag:Partner*']);
  for (const env of [{}, { OPENAPI_SPECS: 'Bad=https://x' }, { OPENAPI_SPECS: 'a=https://x,a=https://y' }, { OPENAPI_SPECS: 'a=ftp://x' }, { OPENAPI_SPECS: 'a=https://x', API_A_HEADERS: '{"k":"${MISSING}"}' }]) {
    assert.throws(() => readSources(env), ConfigError);
  }
});

test('the official Trakt spec becomes read-only tools; optional trailing path segments and pagination headers work', async () => {
  const gateway = gatewayFor({ trakt }, TRAKT_ENV);
  const api = gateway.services.get('trakt');
  assert.ok(api.tools.length > 100);
  assert.ok(api.tools.every(t => t.annotations.readOnlyHint));
  const history = api.tools.find(t => t.name === 'getSyncHistoryGet');
  assert.deepEqual(history.inputSchema.required, []);
  const reply = await call(gateway, 'trakt', 'getSyncHistoryGet', { limit: 3 }, { Authorization: 'Bearer private-token' }, async (url, init) => {
    assert.equal(url.href, 'https://api.trakt.tv/sync/history?limit=3');
    assert.equal(init.headers.get('trakt-api-key'), 'public-client-id');
    assert.equal(init.headers.get('authorization'), 'Bearer private-token');
    return Response.json([{ id: 1 }], { headers: { 'x-pagination-page-count': '2', 'x-other': 'hidden' } });
  });
  assert.equal(reply.isError, false);
  assert.deepEqual(reply.structuredContent, { data: [{ id: 1 }], headers: { 'x-pagination-page-count': '2' } });
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  const typed = await call(gateway, 'trakt', 'getSyncHistoryGet', { type: 'movies' }, { Authorization: 'Bearer t' }, async url => {
    assert.equal(url.pathname, '/sync/history/movies'); return Response.json([]);
  });
  assert.equal(typed.isError, false);
  const gap = await call(gateway, 'trakt', 'getSyncHistoryGet', { id: '1' }, {}, () => { throw Error('must not fetch'); });
  assert.equal(gap.isError, true);
});

test('public Trakt search needs only the app key; WHOOP filters partner tools and requires OAuth', async () => {
  const gateway = gatewayFor({ trakt, whoop }, { ...TRAKT_ENV, API_WHOOP_EXCLUDE: 'tag:Partner* path:/v2/partner/*' });
  const search = await call(gateway, 'trakt', 'getSearchQuery', { type: 'movie', query: 'Dune' }, {}, async (url, init) => {
    assert.equal(url.pathname, '/search/movie'); assert.equal(init.headers.get('authorization'), null); return Response.json([]);
  });
  assert.equal(search.isError, false);
  const tools = gateway.services.get('whoop').tools.map(t => t.name);
  assert.ok(tools.includes('getRecoveryCollection')); assert.ok(!tools.some(t => /Partner|LabRequisition|addTestData/.test(t)));
  const denied = await call(gateway, 'whoop', 'getProfileBasic', {}, {}, () => { throw Error('must not fetch'); });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /Authentication/);
  const recovery = await call(gateway, 'whoop', 'getRecoveryCollection', { limit: 5 }, { Authorization: 'Bearer w' }, async url => {
    assert.equal(url.href, 'https://api.prod.whoop.com/developer/v2/recovery?limit=5'); return Response.json({ records: [] });
  });
  assert.deepEqual(recovery.structuredContent, { records: [] });
});

test('include filters and health reflect what is loaded', async () => {
  const gateway = gatewayFor({ whoop }, { API_WHOOP_INCLUDE: 'getProfile* tag:Recovery' });
  assert.deepEqual(gateway.services.get('whoop').tools.map(t => t.name).sort(), ['getProfileBasic', 'getRecoveryCollection', 'getRecoveryForCycle']);
  const health = await (await gateway.handler(new Request('http://x/health'))).json();
  assert.equal(health.ok, true); assert.equal(health.apis.whoop.tools, 3);
  assert.throws(() => gatewayFor({ whoop }, { API_WHOOP_INCLUDE: 'nothingMatches' }), ConfigError);
});

test('adding an unrelated OpenAPI API exposes all read/write operations without engine edits', async () => {
  const gateway=gatewayFor({ crm: crmSpec() });
  const tools=gateway.services.get('crm').tools;
  assert.ok(tools.some(t=>t.name==='createEntity'&&!t.annotations.readOnlyHint));
  assert.ok(tools.some(t=>t.name==='deleteEntity'&&t.annotations.destructiveHint));
  for (const [name,args,method,path] of [
    ['createEntity',{body:{title:'Created',nullable:null}},'POST','/v1/entities'],
    ['replaceEntity',{id:'a/b',body:{title:'Replaced'}},'PUT','/v1/entities/a%2Fb'],
    ['patchEntity',{id:'one',body:{title:'Patched'}},'PATCH','/v1/entities/one'],
    ['deleteEntity',{id:'one'},'DELETE','/v1/entities/one'],
  ]) {
    const r=await call(gateway,'crm',name,args,{},async (url,init)=>{
      assert.equal(url.pathname,path);assert.equal(init.method,method);assert.equal(init.redirect,'error');
      if(args.body)assert.deepEqual(JSON.parse(init.body),args.body);
      return Response.json({ok:true});
    });
    assert.equal(r.isError,false);
  }
});
test('schema refs, recursive objects, readonly required fields and property names are handled correctly',async()=>{
  const gateway=gatewayFor({ crm: crmSpec() });
  const result=await call(gateway,'crm','createNode',{body:{name:'root',child:{name:'child'}}},{},async()=>Response.json({ok:true}));
  assert.equal(result.isError,false);
  const invalid=await call(gateway,'crm','createEntity',{body:{}},{},()=>{throw Error('must not fetch');});
  assert.equal(invalid.isError,true);
  const valid=await call(gateway,'crm','createEntity',{body:{title:'valid',nullable:null}},{},async()=>Response.json({ok:true}));
  assert.equal(valid.isError,false);
});
test('array and deepObject query serialization and form bodies work for another API',async()=>{
  const gateway=gatewayFor({ crm: crmSpec() });
  const r=await call(gateway,'crm','getEntity',{id:'one',tags:['a','b'],filter:{status:'open'}},{},async(url)=>{
    assert.deepEqual(url.searchParams.getAll('tags'),['a','b']);assert.equal(url.searchParams.get('filter[status]'),'open');return Response.json({});
  });assert.equal(r.isError,false);
  const f=await call(gateway,'crm','submitForm',{body:{title:'two words',tags:['a','b']}},{},async(url,init)=>{
    assert.equal(init.headers.get('content-type'),'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(init.body).get('title'),'two words');assert.deepEqual(new URLSearchParams(init.body).getAll('tags'),['a','b']);return Response.json({});
  });assert.equal(f.isError,false);
});
test('API-key query security comes from Bifrost headers and cannot change destinations',async()=>{
  const spec=crmSpec();spec.components.securitySchemes={key:{type:'apiKey',in:'query',name:'api_key'}};spec.security=[{key:[]}];
  const gateway=gatewayFor({ crm: spec },{API_CRM_SECURITY_BINDINGS:'{"key":{"sourceHeader":"x-api-key"}}'});
  const r=await call(gateway,'crm','getEntity',{id:'one'},{'X-API-Key':'private-key','X-Untrusted':'ignored'},async(url,init)=>{
    assert.equal(url.origin,'https://crm.example');assert.equal(url.searchParams.get('api_key'),'private-key');assert.equal(init.headers.get('x-untrusted'),null);return Response.json({});
  });assert.equal(r.isError,false);
});
test('validation failures, unknown tools and escaping the base prevent network calls',async()=>{
  const gateway=gatewayFor({ crm: crmSpec() });
  for(const [name,args] of [['getEntity',{}],['getEntity',{id:'one',unexpected:'x'}],['createEntity',{body:{title:42}}],['baseBoundary',{id:'..'}],['unknown',{}]]) {
    const r=await call(gateway,'crm',name,args,{},()=>{throw Error('must not fetch');});assert.equal(r.isError,true);
  }
});
test('upstream errors and structured logs never include response bodies or credentials',async()=>{
  const logs=[],gateway=gatewayFor({ crm: crmSpec() },{},{log:e=>logs.push(e)});
  const r=await call(gateway,'crm','getEntity',{id:'one'},{Authorization:'Bearer private-token'},async()=>new Response('SECRET RESPONSE',{status:401}));
  assert.equal(r.isError,true);assert.doesNotMatch(JSON.stringify(r),/SECRET RESPONSE|private-token/);assert.doesNotMatch(JSON.stringify(logs),/private-token/);
});
test('text and no-content API responses remain usable',async()=>{
  const gateway=gatewayFor({ crm: crmSpec() });
  const text=await call(gateway,'crm','readText',{}, {},async()=>new Response('Hello',{headers:{'content-type':'text/plain'}}));assert.equal(text.structuredContent.text,'Hello');
  const empty=await call(gateway,'crm','removeEmpty',{}, {},async()=>new Response(null,{status:204}));assert.equal(empty.structuredContent.status,204);
});
test('MCP protocol, body limits and configuration errors are explicit',async()=>{
  const gateway=gatewayFor({ crm: crmSpec() },{},{requestBytes:1000,responseBytes:100});
  const init=await(await gateway.handler(rpcRequest('crm','initialize',{protocolVersion:'2025-06-18'}))).json();assert.equal(init.result.protocolVersion,'2025-06-18');
  const huge=await call(gateway,'crm','readText',{}, {},async()=>new Response('x'.repeat(200),{headers:{'content-type':'text/plain'}}));assert.equal(huge.isError,true);
  const cross=await gateway.handler(rpcRequest('crm','tools/list',{}, {Origin:'https://evil.test'}));assert.equal(cross.status,403);
  const invalid=crmSpec();invalid.paths['/external']={get:{operationId:'external',parameters:[parameter('q','query',{$ref:'https://evil.test/schema'})],responses:{}}};assert.throws(()=>gatewayFor({ crm: invalid }),ConfigError);
  assert.throws(()=>gatewayFor({ crm: {openapi:'2.0',paths:{}} }),ConfigError);
});
