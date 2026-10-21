import test from 'node:test';
import assert from 'node:assert/strict';
import {getTool, TOOLS} from '../src/tools.mjs';
import {AgentInputError, rankCandidates, summarizeCompare, validateInput} from '../src/agent.mjs';
import {FIXTURE_NAMES, IDS, RECS, makeClient} from './fixtures.mjs';

const json = (status, body) => () => new Response(JSON.stringify(body), {status});
const run = (name, client, args) => getTool(name).run(client, getTool(name).inputSchema.parse(args));
const INPUT = {people: [{name: 'Alex', favorites: ['Fixture Film One', 'Fixture Band']}, {name: 'Sam', favorites: ['Fixture Film Two', 'Unknown Thing']}], category: 'movies', count: 3};

test('exactly five tools are defined, all read-only', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['qloo_resolve_entities', 'qloo_recommend', 'qloo_compare_tastes', 'qloo_explain_match', 'tastebridge_common_ground']);
  for (const t of TOOLS) assert.equal(t.annotations.readOnlyHint, true);
});

test('qloo_resolve_entities: picks Insights-compatible matches and reports misses', async () => {
  const {client, calls} = makeClient();
  const r = await run('qloo_resolve_entities', client, {names: ['Fixture Film One', 'artist: Fixture Band', 'Unknown Thing']});
  assert.deepEqual(r.resolved.map(x => [x.id, x.type]), [[IDS.a1, 'urn:entity:movie'], [IDS.a2, 'urn:entity:artist']]);
  assert.deepEqual(r.unresolved, ['Unknown Thing']);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url.searchParams.get('types'), 'urn:entity:artist');
});

test('qloo_recommend: GET /v2/insights with signals, exclusions and explainability; only Qloo names', async () => {
  const {client, calls} = makeClient();
  const r = await run('qloo_recommend', client, {category: 'movies', entityIds: [IDS.a1, IDS.b1], take: 3});
  const p = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, '/v2/insights');
  assert.equal(p.get('filter.type'), 'urn:entity:movie');
  assert.equal(p.get('signal.interests.entities'), `${IDS.a1},${IDS.b1}`);
  assert.equal(p.get('filter.exclude.entities'), `${IDS.a1},${IDS.b1}`);
  assert.equal(p.get('feature.explainability'), 'true');
  assert.equal(r.count, 3, 'entity without a name is dropped');
  for (const rec of r.recommendations) assert.ok(FIXTURE_NAMES.has(rec.name));
  assert.deepEqual(r.recommendations[0].contributions, [{entityId: IDS.a1, score: 0.9}, {entityId: IDS.b1, score: 0.1}]);
});

test('qloo_recommend: places require a location, which is sent as filter.location.query', async () => {
  const {client, calls} = makeClient();
  await assert.rejects(run('qloo_recommend', client, {category: 'places', entityIds: [IDS.a1]}), err => err instanceof AgentInputError && err.code === 'LOCATION_REQUIRED_FOR_PLACES');
  assert.equal(calls.length, 0);
  await run('qloo_recommend', client, {category: 'places', entityIds: [IDS.a1], location: 'Fixture City'});
  assert.equal(calls[0].url.searchParams.get('filter.type'), 'urn:entity:place');
  assert.equal(calls[0].url.searchParams.get('filter.location.query'), 'Fixture City');
});

test('qloo_compare_tastes: shared tags plus each side\'s distinctive tags', async () => {
  const {client, calls} = makeClient();
  const r = await run('qloo_compare_tastes', client, {aEntityIds: [IDS.a1], bEntityIds: [IDS.b1]});
  assert.equal(calls[0].url.pathname, '/v2/insights/compare');
  assert.equal(calls[0].url.searchParams.get('a.signal.interests.entities'), IDS.a1);
  assert.equal(calls[0].url.searchParams.get('b.signal.interests.entities'), IDS.b1);
  assert.deepEqual(r.shared.map(t => t.name), ['Fixture Shared Genre']);
  assert.deepEqual(r.onlyA.map(t => t.name), ['Fixture A Style']);
  assert.deepEqual(r.onlyB.map(t => t.name), ['Fixture B Style']);
});

test('qloo_explain_match: affinity, per-seed contribution and shared tags from Qloo data', async () => {
  const {client, calls} = makeClient();
  const r = await run('qloo_explain_match', client, {category: 'movies', seedEntityIds: [IDS.a1, IDS.b1], candidateEntityId: IDS.r1});
  assert.equal(calls[0].url.searchParams.get('filter.results.entities'), IDS.r1);
  assert.equal(calls[1].url.pathname, '/entities');
  assert.equal(r.found, true);
  assert.equal(r.candidate.name, 'Fixture Pick Balanced');
  assert.deepEqual(r.perSeed.map(s => [s.name, s.contribution]), [['Fixture Film Two', 0.5], ['Fixture Film One', 0.3]]);
  assert.deepEqual(r.perSeed[0].sharedTags, ['Fixture B Style']);
  assert.match(r.summary, /Fixture Pick Balanced.*Biggest driver: Fixture Film Two \(50% of the signal\)/);
  const missing = await run('qloo_explain_match', client, {category: 'movies', seedEntityIds: [IDS.a1], candidateEntityId: 'FFFFFFFF-0000-4000-8000-00000000000F'});
  assert.equal(missing.found, false);
});

test('tastebridge_common_ground: full loop, fairness re-ranking, explanations, no invented titles', async () => {
  const {client, calls} = makeClient();
  const r = await run('tastebridge_common_ground', client, INPUT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.trace.map(t => t.endpoint), ['GET /search', 'GET /search', 'GET /search', 'GET /search', 'GET /v2/insights/compare', 'GET /v2/insights']);
  assert.deepEqual(r.people[1].unresolved, ['Unknown Thing']);
  const rec = calls.at(-1).url.searchParams;
  assert.equal(rec.get('signal.interests.entities'), `${IDS.a1},${IDS.a2},${IDS.b1}`);
  assert.equal(rec.get('take'), '15');
  assert.deepEqual(r.picks.map(p => p.name), ['Fixture Pick Balanced', 'Fixture Pick Lopsided', 'Fixture Pick Unexplained']);
  for (const p of r.picks) assert.ok(FIXTURE_NAMES.has(p.name), 'every pick name comes from the (mocked) Qloo response');
  const top = r.picks[0];
  assert.deepEqual(top.split, [{person: 'Alex', share: 0.5}, {person: 'Sam', share: 0.5}]);
  assert.equal(top.image, 'https://images.qloo.com/i/fixture-r1.jpg');
  assert.equal(r.picks[1].image, null);
  assert.ok(top.reasons.some(x => x.includes('Fixture Shared Genre')));
  assert.ok(top.reasons.some(x => x.includes("Sam's side: Fixture B Style")));
  assert.ok(top.reasons.some(x => x.includes('strongest: Fixture Film One')));
});

test('rankCandidates is deterministic and penalizes one-sided picks', () => {
  const owners = new Map([[IDS.a1, new Set([0])], [IDS.a2, new Set([0])], [IDS.b1, new Set([1])]]);
  const once = rankCandidates(RECS, owners, 2, 3).map(x => [x.id, Math.round(x.groupScore * 1000)]);
  assert.deepEqual(once, [[IDS.r1, 900], [IDS.r2, 646], [IDS.r3, 640]]);
  assert.deepEqual(rankCandidates([...RECS].reverse(), owners, 2, 3).map(x => x.id), once.map(x => x[0]));
});

test('agent stops safely when a person has no usable match (no insights call)', async () => {
  const {client, calls} = makeClient();
  const r = await run('tastebridge_common_ground', client, {...INPUT, people: [{name: 'Alex', favorites: ['Unknown Thing']}, INPUT.people[1]]});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_MATCH_FOR_PERSON');
  assert.equal(calls.some(c => c.url.pathname.startsWith('/v2/')), false);
});

test('Qloo errors are reported per stage; compare failure is non-fatal', async () => {
  const forbidden = makeClient({overrides: {'/v2/insights': json(403, {message: 'no access'})}});
  const r1 = await run('tastebridge_common_ground', forbidden.client, INPUT);
  assert.equal(r1.ok, false);
  assert.equal(r1.stage, 'recommend');
  assert.equal(r1.error, 'QLOO_FORBIDDEN');
  const flaky = makeClient({overrides: {'/v2/insights/compare': json(500, {})}});
  const r2 = await run('tastebridge_common_ground', flaky.client, INPUT);
  assert.equal(r2.ok, true);
  assert.equal(r2.warnings.length, 1);
});

test('input validation rejects bad requests before any API call', () => {
  const codeOf = input => { try { validateInput(input); return 'OK'; } catch (e) { return e.code; } };
  assert.equal(codeOf({...INPUT, people: [INPUT.people[0]]}), 'TWO_PEOPLE_REQUIRED');
  assert.equal(codeOf({...INPUT, people: [{name: 'A', favorites: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']}, INPUT.people[1]]}), 'TOO_MANY_FAVORITES');
  assert.equal(codeOf({...INPUT, people: [{name: 'A', favorites: [' ']}, INPUT.people[1]]}), 'FAVORITES_REQUIRED');
  assert.equal(codeOf({...INPUT, category: 'cars'}), 'CATEGORY_UNSUPPORTED');
  assert.equal(codeOf({...INPUT, category: 'places'}), 'LOCATION_REQUIRED_FOR_PLACES');
  assert.equal(codeOf({...INPUT, count: 0}), 'COUNT_INVALID');
  assert.equal(codeOf(INPUT), 'OK');
});

test('compare summary de-duplicates tags that share a name across tag types', () => {
  const s = summarizeCompare({
    shared: [{tag_id: 'urn:tag:genre:media:drama', name: 'Drama'}, {tag_id: 'urn:tag:genre:qloo:drama', name: 'Drama'}],
    a: [{tag_id: 'urn:tag:theme:qloo:drama', name: 'drama', query: {count: '2'}}, {tag_id: 'urn:tag:x:only_a', name: 'Only A', query: {count: '1'}}],
    b: [{tag_id: 'urn:tag:x:only_b', name: 'Only B', query: {count: '1'}}]
  });
  assert.deepEqual(s.shared.map(t => t.name), ['Drama']);
  assert.deepEqual(s.leans[0].map(t => t.name), ['Only A']);
  assert.deepEqual(s.leans[1].map(t => t.name), ['Only B']);
});
