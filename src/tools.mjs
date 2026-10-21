// The five TasteBridge tools. Exposed over MCP by server.mjs and unit-tested directly.
import * as z from 'zod/v4';
import {CATEGORIES, parseFavorite, toEntity} from './qloo.mjs';
import {AgentInputError, findCommonGround, resolveFavorites, summarizeCompare} from './agent.mjs';

const ID = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'Qloo entity ID expected');
const IDS = z.array(ID).min(1).max(10);
const CATEGORY = z.enum(Object.keys(CATEGORIES));
const round = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const TAG_PRIORITY = ['urn:tag:genre', 'urn:tag:subgenre', 'urn:tag:style', 'urn:tag:theme', 'urn:tag:plot', 'urn:tag:archetype', 'urn:tag:character', 'urn:tag:audience', 'urn:tag:keyword'];
const tagRank = t => {
  const i = TAG_PRIORITY.findIndex(p => String(t.type || '').startsWith(p));
  return i === -1 ? TAG_PRIORITY.length : i;
};

function requireLocation(category, location) {
  if (CATEGORIES[category].needsLocation && !location) {
    throw new AgentInputError('LOCATION_REQUIRED_FOR_PLACES', 'Places need a city or area, for example "Lisbon".');
  }
}

async function resolveEntities(client, {names}) {
  const trace = [];
  const {resolved, unresolved} = await resolveFavorites(client, names.map(parseFavorite), trace);
  return {resolved, unresolved, trace};
}

async function recommend(client, {category, entityIds, location, take = 5}) {
  requireLocation(category, location);
  const cat = CATEGORIES[category];
  const trace = [];
  const params = {'filter.type': cat.type, 'signal.interests.entities': entityIds, 'filter.exclude.entities': entityIds, 'feature.explainability': 'true', take};
  if (location) params['filter.location.query'] = location;
  const r = await client.insights(params, {trace});
  const recommendations = r.entities.map(toEntity).filter(e => e.id && e.name).map(e => ({
    id: e.id, name: e.name, type: e.type, disambiguation: e.disambiguation, year: e.year, city: e.city,
    affinity: round(e.affinity), contributions: e.explain.map(x => ({entityId: x.id, score: round(x.score)}))
  }));
  return {category, filterType: cat.type, location: location || null, count: recommendations.length, recommendations, trace};
}

async function compareTastes(client, {aEntityIds, bEntityIds}) {
  const trace = [];
  const s = summarizeCompare(await client.compare(aEntityIds, bEntityIds, {take: 10, trace}), 10, 8);
  return {shared: s.shared, onlyA: s.leans[0], onlyB: s.leans[1], trace};
}

async function explainMatch(client, {category, seedEntityIds, candidateEntityId}) {
  const cat = CATEGORIES[category];
  const trace = [];
  const r = await client.insights({'filter.type': cat.type, 'signal.interests.entities': seedEntityIds, 'filter.results.entities': candidateEntityId, 'feature.explainability': 'true', take: 1}, {trace});
  const scored = r.entities.map(toEntity).find(e => e.id === candidateEntityId) || null;
  const details = (await client.entities([...new Set([...seedEntityIds, candidateEntityId])], {trace})).map(toEntity);
  const byId = new Map(details.map(d => [d.id, d]));
  const cand = byId.get(candidateEntityId) || scored;
  if (!cand) return {found: false, summary: 'Qloo returned no data for this candidate ID.', trace};
  const candTags = new Set((cand.tags.length ? cand.tags : scored?.tags || []).map(t => t.id));
  const perSeed = seedEntityIds.map(id => {
    const seed = byId.get(id);
    const contrib = scored?.explain.find(x => x.id === id);
    const shared = (seed?.tags || []).filter(t => candTags.has(t.id)).sort((x, y) => tagRank(x) - tagRank(y) || x.name.localeCompare(y.name));
    return {entityId: id, name: seed?.name || null, contribution: contrib ? round(contrib.score) : null, sharedTagCount: shared.length, sharedTags: shared.slice(0, 8).map(t => t.name)};
  }).sort((x, y) => (y.contribution ?? -1) - (x.contribution ?? -1) || y.sharedTagCount - x.sharedTagCount);
  const top = perSeed[0];
  let summary;
  if (scored) {
    summary = `Qloo scores "${cand.name}" at affinity ${round(scored.affinity, 2)} for these favorites.`;
    if (top?.name) summary += ` Biggest driver: ${top.name}${top.contribution !== null ? ` (${Math.round(top.contribution * 100)}% of the signal)` : ''}`;
    if (top?.sharedTags.length) summary += `, sharing ${top.sharedTagCount} taste tags such as ${top.sharedTags.slice(0, 3).join(', ')}`;
    summary += '.';
  } else {
    summary = `Qloo did not return "${cand.name}" as a ${cat.label.toLowerCase()} match for these favorites.`;
  }
  return {found: Boolean(scored), candidate: {id: cand.id, name: cand.name, type: cand.type, disambiguation: cand.disambiguation}, affinity: scored ? round(scored.affinity) : null, perSeed, summary, trace};
}

async function commonGround(client, args) {
  return findCommonGround(client, args);
}

const readOnly = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true};

export const TOOLS = Object.freeze([
  {
    name: 'qloo_resolve_entities', title: 'Resolve names to Qloo entities', annotations: readOnly, run: resolveEntities,
    description: 'Look up 1-10 names (movies, books, artists, places, destinations...) with Qloo GET /search and return the best match that the Insights API can use (entity ID, type, disambiguation). Optional prefixes such as "movie:", "book:", "artist:" or "place:" narrow the type.',
    inputSchema: z.object({names: z.array(z.string().min(2).max(100)).min(1).max(10)})
  },
  {
    name: 'qloo_recommend', title: 'Taste-based recommendations', annotations: readOnly, run: recommend,
    description: 'Recommend entities of one category from seed Qloo entity IDs using GET /v2/insights with feature.explainability. Seeds are excluded from results. Places require a location (city or area).',
    inputSchema: z.object({category: CATEGORY, entityIds: IDS, location: z.string().min(2).max(80).optional(), take: z.number().int().min(1).max(20).optional()})
  },
  {
    name: 'qloo_compare_tastes', title: 'Compare two tastes', annotations: readOnly, run: compareTastes,
    description: 'Compare two sets of Qloo entity IDs (person A vs person B) with GET /v2/insights/compare: shared taste tags plus tags distinctive to each side.',
    inputSchema: z.object({aEntityIds: IDS, bEntityIds: IDS})
  },
  {
    name: 'qloo_explain_match', title: 'Explain a match', annotations: readOnly, run: explainMatch,
    description: 'Explain why a candidate entity fits a set of seed entities: Qloo affinity and per-seed contribution (GET /v2/insights with filter.results.entities and feature.explainability) plus shared tags (GET /entities).',
    inputSchema: z.object({category: CATEGORY, seedEntityIds: IDS, candidateEntityId: ID})
  },
  {
    name: 'tastebridge_common_ground', title: 'Find common ground for two people', annotations: readOnly, run: commonGround,
    description: 'Run the full deterministic TasteBridge agent loop for two people: plan, resolve favorites (/search), compare tastes (/v2/insights/compare), get candidates (/v2/insights with explainability), re-rank for fairness and explain each pick. Every title comes from Qloo.',
    inputSchema: z.object({
      people: z.array(z.object({name: z.string().max(40).optional(), favorites: z.array(z.string().min(2).max(100)).min(1).max(5)})).length(2),
      category: CATEGORY.optional(),
      location: z.string().min(2).max(80).optional(),
      count: z.number().int().min(1).max(10).optional()
    })
  }
]);

export function getTool(name) {
  return TOOLS.find(t => t.name === name) || null;
}
