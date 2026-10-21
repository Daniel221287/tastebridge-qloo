// Synthetic fixtures for offline tests. All names are deliberately fictional placeholders;
// they are NOT copies of Qloo responses (Qloo data must not be stored in a public repository).
import {QlooClient} from '../src/qloo.mjs';

export const IDS = Object.freeze({
  a1: 'AAAAAAAA-0000-4000-8000-000000000001',
  a2: 'AAAAAAAA-0000-4000-8000-000000000002',
  b1: 'BBBBBBBB-0000-4000-8000-000000000001',
  album: 'DDDDDDDD-0000-4000-8000-000000000001',
  r1: 'CCCCCCCC-0000-4000-8000-000000000001',
  r2: 'CCCCCCCC-0000-4000-8000-000000000002',
  r3: 'CCCCCCCC-0000-4000-8000-000000000003'
});

const SHARED_TAG = {tag_id: 'urn:tag:genre:media:fixture_shared', name: 'Fixture Shared Genre', subtype: 'urn:tag:genre:media', popularity: 0.9, query: {score: 0.7}};
const A_TAG = {tag_id: 'urn:tag:style:qloo:fixture_a', name: 'Fixture A Style', subtype: 'urn:tag:style:qloo', popularity: 0.8, query: {count: '2'}};
const B_TAG = {tag_id: 'urn:tag:style:qloo:fixture_b', name: 'Fixture B Style', subtype: 'urn:tag:style:qloo', popularity: 0.7, query: {count: '1'}};
const tagRef = t => ({id: t.tag_id, name: t.name, type: t.subtype});

export const SEARCH = Object.freeze({
  'Fixture Film One': [
    {name: 'Fixture Film One', entity_id: IDS.album, types: ['urn:entity:album']},
    {name: 'Fixture Film One', entity_id: IDS.a1, types: ['urn:entity:movie'], disambiguation: '2001', properties: {image: {url: 'https://images.qloo.com/i/fixture-a1.jpg'}}}
  ],
  'Fixture Band': [{name: 'Fixture Band', entity_id: IDS.a2, types: ['urn:entity:artist'], disambiguation: 'Fixture Band'}],
  'Fixture Film Two': [{name: 'Fixture Film Two', entity_id: IDS.b1, types: ['urn:entity:movie'], disambiguation: '1999', properties: {image: {url: 'https://evil.example/tracker.jpg'}}}]
});

export const RECS = Object.freeze([
  {name: 'Fixture Pick Lopsided', entity_id: IDS.r2, subtype: 'urn:entity:movie', disambiguation: '2010', properties: {release_year: 2010, image: {url: 'https://evil.example/x.jpg'}},
    tags: [tagRef(A_TAG)], query: {affinity: 0.95, explainability: {'signal.interests.entities': [{entity_id: IDS.a1, score: 0.9}, {entity_id: IDS.b1, score: 0.1}]}}},
  {name: 'Fixture Pick Balanced', entity_id: IDS.r1, subtype: 'urn:entity:movie', disambiguation: '2004', properties: {release_year: 2004, image: {url: 'https://images.qloo.com/i/fixture-r1.jpg'}},
    tags: [tagRef(SHARED_TAG), tagRef(B_TAG)], query: {affinity: 0.9, explainability: {'signal.interests.entities': [{entity_id: IDS.a1, score: 0.3}, {entity_id: IDS.a2, score: 0.2}, {entity_id: IDS.b1, score: 0.5}]}}},
  {name: 'Fixture Pick Unexplained', entity_id: IDS.r3, subtype: 'urn:entity:movie', properties: {}, tags: [], query: {affinity: 0.8}},
  {name: '', entity_id: 'EEEEEEEE-0000-4000-8000-000000000009', subtype: 'urn:entity:movie', query: {affinity: 0.99}}
]);

export const COMPARE = Object.freeze({results: {tags: [SHARED_TAG], a: [A_TAG, SHARED_TAG], b: [B_TAG, SHARED_TAG], matchEntities: []}});

export const ENTITIES = Object.freeze({
  [IDS.a1]: {name: 'Fixture Film One', entity_id: IDS.a1, types: ['urn:entity:movie'], tags: [tagRef(SHARED_TAG), tagRef(A_TAG)]},
  [IDS.b1]: {name: 'Fixture Film Two', entity_id: IDS.b1, types: ['urn:entity:movie'], tags: [tagRef(B_TAG)]},
  [IDS.r1]: {name: 'Fixture Pick Balanced', entity_id: IDS.r1, types: ['urn:entity:movie'], tags: [tagRef(SHARED_TAG), tagRef(B_TAG)]}
});

const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

// In-memory replacement for fetch: records every request and routes by path.
export function makeFakeFetch({overrides = {}} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({url: u, method: init.method, headers: init.headers || {}});
    if (overrides[u.pathname]) return overrides[u.pathname](u);
    if (u.pathname === '/search') return json(200, {results: SEARCH[u.searchParams.get('query')] || []});
    if (u.pathname === '/entities') return json(200, {results: (u.searchParams.get('entity_ids') || '').split(',').map(id => ENTITIES[id]).filter(Boolean)});
    if (u.pathname === '/v2/insights/compare') return json(200, COMPARE);
    if (u.pathname === '/v2/insights') {
      const only = u.searchParams.get('filter.results.entities');
      const entities = only ? RECS.filter(e => e.entity_id === only) : RECS;
      return json(200, {success: true, results: {entities}});
    }
    return json(404, {message: 'not found'});
  };
  return {fetchImpl, calls};
}

export function makeClient(opts = {}) {
  const {fetchImpl, calls} = makeFakeFetch(opts);
  return {client: new QlooClient({apiKey: 'test-key-not-real', fetchImpl, cacheTtlMs: 0}), calls};
}

export const FIXTURE_NAMES = new Set([...Object.values(SEARCH).flat(), ...RECS, ...Object.values(ENTITIES)].map(e => e.name).filter(Boolean));
