import test from 'node:test';
import assert from 'node:assert/strict';
import {QlooClient, QlooError, parseFavorite, pickBestMatch, toEntity} from '../src/qloo.mjs';
import {IDS, SEARCH, makeClient} from './fixtures.mjs';

const jsonRes = (status, body) => async () => new Response(JSON.stringify(body), {status});

test('client sends GET to the hackathon base URL with the X-Api-Key header', async () => {
  const {client, calls} = makeClient();
  const trace = [];
  const results = await client.search('Fixture Film One', {types: 'urn:entity:movie', take: 3, trace});
  assert.equal(results.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://hackathon.api.qloo.com/search');
  assert.equal(calls[0].url.searchParams.get('query'), 'Fixture Film One');
  assert.equal(calls[0].url.searchParams.get('types'), 'urn:entity:movie');
  assert.equal(calls[0].url.searchParams.get('take'), '3');
  assert.equal(calls[0].headers['X-Api-Key'], 'test-key-not-real');
  assert.equal(calls[0].url.searchParams.has('api_key'), false);
  assert.deepEqual(Object.keys(trace[0]).sort(), ['endpoint', 'ms', 'status']);
  assert.equal(trace[0].status, 200);
});

test('array params are comma-joined and empty params are dropped', () => {
  const client = new QlooClient({apiKey: 'k'});
  const url = client.buildUrl('/v2/insights', {'signal.interests.entities': [IDS.a1, IDS.b1], 'filter.location.query': '', take: 5});
  assert.equal(url.searchParams.get('signal.interests.entities'), `${IDS.a1},${IDS.b1}`);
  assert.equal(url.searchParams.has('filter.location.query'), false);
});

test('missing API key fails closed without any HTTP call', async () => {
  let called = 0;
  const client = new QlooClient({apiKey: '', fetchImpl: async () => { called++; }});
  await assert.rejects(client.search('x'), err => err instanceof QlooError && err.code === 'QLOO_API_KEY_MISSING');
  assert.equal(called, 0);
});

test('HTTP errors map to stable codes and keep the Qloo error message', async () => {
  for (const [status, code] of [[401, 'QLOO_UNAUTHORIZED'], [403, 'QLOO_FORBIDDEN'], [429, 'QLOO_RATE_LIMITED'], [500, 'QLOO_HTTP_500']]) {
    const client = new QlooClient({apiKey: 'k', fetchImpl: jsonRes(status, {message: 'nope'})});
    await assert.rejects(client.insights({'filter.type': 'urn:entity:movie'}), err => err.code === code && err.status === status);
  }
  const bad = new QlooClient({apiKey: 'k', fetchImpl: jsonRes(400, {errors: [{message: 'All of the provided signal.interests.entities were invalid.'}]})});
  await assert.rejects(bad.insights({}), err => err.code === 'QLOO_BAD_REQUEST' && /invalid/.test(err.detail));
});

test('network failures and timeouts become QLOO_NETWORK_ERROR / QLOO_TIMEOUT', async () => {
  const down = new QlooClient({apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); }});
  await assert.rejects(down.search('x'), err => err.code === 'QLOO_NETWORK_ERROR');
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))));
  const slow = new QlooClient({apiKey: 'k', fetchImpl: hang, timeoutMs: 30});
  await assert.rejects(slow.search('x'), err => err.code === 'QLOO_TIMEOUT');
});

test('successful responses are cached privately in memory', async () => {
  let n = 0;
  const client = new QlooClient({apiKey: 'k', fetchImpl: async () => { n++; return new Response(JSON.stringify({results: []}), {status: 200}); }});
  const trace = [];
  await client.search('same', {trace});
  await client.search('same', {trace});
  assert.equal(n, 1);
  assert.equal(trace[1].cached, true);
});

test('the API key never appears in serialized client state', () => {
  const client = new QlooClient({apiKey: 'super-secret-test-key'});
  assert.equal(JSON.stringify(client).includes('super-secret-test-key'), false);
  assert.equal(client.configured, true);
});

test('favorite parsing, best-match selection and image host filtering', () => {
  assert.deepEqual(parseFavorite('book: Dune'), {query: 'Dune', hintType: 'urn:entity:book'});
  assert.deepEqual(parseFavorite('Dune: Part Two'), {query: 'Dune: Part Two', hintType: null});
  assert.equal(pickBestMatch(SEARCH['Fixture Film One']).id, IDS.a1, 'album results are skipped');
  assert.equal(pickBestMatch(SEARCH['Fixture Film One'], 'urn:entity:book'), null, 'type hint is honored');
  assert.equal(toEntity(SEARCH['Fixture Film Two'][0]).image, null, 'non-Qloo image hosts are dropped');
  assert.equal(toEntity(SEARCH['Fixture Film One'][1]).image, 'https://images.qloo.com/i/fixture-a1.jpg');
});
