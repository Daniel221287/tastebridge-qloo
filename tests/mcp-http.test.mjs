import test from 'node:test';
import assert from 'node:assert/strict';
import {startApp, stopApp} from '../server.mjs';
import {FIXTURE_NAMES, IDS, makeClient} from './fixtures.mjs';

const PEOPLE = [{name: 'Alex', favorites: ['Fixture Film One', 'Fixture Band']}, {name: 'Sam', favorites: ['Fixture Film Two']}];

async function withApp(fn, opts = {}) {
  const {client, calls} = makeClient();
  const app = await startApp({port: 0, client, ...opts});
  const base = 'http://127.0.0.1:' + app.http.address().port;
  try { await fn({base, calls}); } finally { await stopApp(app); }
}

async function rpc(base, method, params, id) {
  const r = await fetch(base + '/mcp', {method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'
  }, body: JSON.stringify({jsonrpc: '2.0', id, method, params})});
  const raw = await r.text();
  assert.equal(r.status, 200, raw.slice(0, 300));
  const data = (r.headers.get('content-type') || '').includes('text/event-stream')
    ? (raw.split(/\r?\n/).find(x => x.startsWith('data: ')) || '').slice(6) : raw;
  const json = JSON.parse(data);
  assert.ok(!json.error, JSON.stringify(json.error));
  return json.result;
}

const call = async (base, name, args, id) => {
  const res = await rpc(base, 'tools/call', {name, arguments: args}, id);
  return {isError: res.isError === true, data: JSON.parse(res.content[0].text)};
};

test('HTTP: health, static demo files, unknown route, foreign Origin refused', async () => {
  await withApp(async ({base}) => {
    const h = await (await fetch(base + '/health')).json();
    assert.equal(h.ok, true);
    assert.equal(h.mcp, '/mcp');
    assert.equal(h.qlooKeyConfigured, true);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TasteBridge/);
    assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/images\.qloo\.com/);
    for (const f of ['/app.js', '/style.css', '/favicon.svg']) assert.equal((await fetch(base + f)).status, 200, f);
    assert.equal((await fetch(base + '/nope')).status, 404);
    assert.equal((await fetch(base + '/health', {headers: {Origin: 'https://attacker.example'}})).status, 403);
  });
});

test('MCP: initialize, tools/list (5 tools with schemas), tools/call for every tool', async () => {
  await withApp(async ({base}) => {
    const init = await rpc(base, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'tastebridge-test', version: '1.0.0'}}, 1);
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.equal(init.serverInfo.name, 'tastebridge-qloo');
    const list = await rpc(base, 'tools/list', {}, 2);
    assert.deepEqual(list.tools.map(t => t.name).sort(), ['qloo_compare_tastes', 'qloo_explain_match', 'qloo_recommend', 'qloo_resolve_entities', 'tastebridge_common_ground']);
    for (const t of list.tools) assert.equal(t.inputSchema.type, 'object', t.name);

    const resolved = await call(base, 'qloo_resolve_entities', {names: ['Fixture Film One']}, 3);
    assert.equal(resolved.data.resolved[0].id, IDS.a1);
    const recs = await call(base, 'qloo_recommend', {category: 'movies', entityIds: [IDS.a1, IDS.b1], take: 3}, 4);
    assert.ok(recs.data.recommendations.every(r => FIXTURE_NAMES.has(r.name)));
    const cmp = await call(base, 'qloo_compare_tastes', {aEntityIds: [IDS.a1], bEntityIds: [IDS.b1]}, 5);
    assert.equal(cmp.data.shared[0].name, 'Fixture Shared Genre');
    const why = await call(base, 'qloo_explain_match', {category: 'movies', seedEntityIds: [IDS.a1, IDS.b1], candidateEntityId: IDS.r1}, 6);
    assert.equal(why.data.found, true);
    const cg = await call(base, 'tastebridge_common_ground', {people: PEOPLE, category: 'movies', count: 2}, 7);
    assert.equal(cg.data.ok, true);
    assert.deepEqual(cg.data.picks.map(p => p.name), ['Fixture Pick Balanced', 'Fixture Pick Lopsided']);

    const err = await call(base, 'qloo_recommend', {category: 'places', entityIds: [IDS.a1]}, 8);
    assert.equal(err.isError, true);
    assert.equal(err.data.error, 'LOCATION_REQUIRED_FOR_PLACES');
  });
});

test('REST /api/common-ground: success, validation error, content-type guard', async () => {
  await withApp(async ({base}) => {
    const post = (body, type = 'application/json') => fetch(base + '/api/common-ground', {method: 'POST', headers: {'Content-Type': type}, body: JSON.stringify(body)});
    const ok = await post({people: PEOPLE, category: 'movies', count: 3});
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.ok, true);
    assert.equal(data.picks.length, 3);
    const bad = await post({people: [PEOPLE[0]], category: 'movies'});
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'TWO_PEOPLE_REQUIRED');
    assert.equal((await post({people: PEOPLE}, 'text/plain')).status, 415);
  });
});

test('rate limiter returns 429 after the per-minute budget; public binding needs ALLOWED_HOSTS', async () => {
  await withApp(async ({base}) => {
    const hit = () => fetch(base + '/api/common-ground', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    assert.equal((await hit()).status, 400);
    assert.equal((await hit()).status, 400);
    assert.equal((await hit()).status, 429);
  }, {rateLimit: 2});
  const {client} = makeClient();
  await assert.rejects(startApp({port: 0, host: '0.0.0.0', client}), /PUBLIC_BINDING_REQUIRES_ALLOWED_HOSTS/);
});
