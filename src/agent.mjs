// TasteBridge agent: a deterministic plan -> resolve -> compare -> recommend -> rank -> explain loop.
// No LLM is involved. Every title shown to the user comes from a Qloo API response.
import {CATEGORIES, QlooError, parseFavorite, pickBestMatch, toEntity, toTag} from './qloo.mjs';

export class AgentInputError extends Error {
  constructor(code, message) {
    super(code);
    this.code = code;
    this.userMessage = message;
  }
}

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

export function validateInput(input = {}) {
  const people = Array.isArray(input.people) ? input.people : [];
  if (people.length !== 2) throw new AgentInputError('TWO_PEOPLE_REQUIRED', 'Provide exactly two people.');
  const normPeople = people.map((p, i) => {
    const name = clean(p?.name).slice(0, 40) || (i === 0 ? 'Person A' : 'Person B');
    const list = Array.isArray(p?.favorites) ? p.favorites : String(p?.favorites ?? '').split(/\r?\n|;/);
    const seen = new Set();
    const favorites = [];
    for (const raw of list) {
      const text = clean(raw);
      if (!text) continue;
      if (text.length < 2 || text.length > 100) throw new AgentInputError('FAVORITE_INVALID', `Each favorite must be 2-100 characters (${name}).`);
      if (seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      favorites.push(parseFavorite(text));
    }
    if (!favorites.length) throw new AgentInputError('FAVORITES_REQUIRED', `Add at least one favorite for ${name}.`);
    if (favorites.length > 5) throw new AgentInputError('TOO_MANY_FAVORITES', `Use at most 5 favorites for ${name}.`);
    return {name, favorites};
  });
  const category = clean(input.category || 'movies').toLowerCase();
  if (!CATEGORIES[category]) throw new AgentInputError('CATEGORY_UNSUPPORTED', 'Unsupported category: ' + category);
  const location = clean(input.location).slice(0, 80) || null;
  if (CATEGORIES[category].needsLocation && !location) {
    throw new AgentInputError('LOCATION_REQUIRED_FOR_PLACES', 'Places need a city or area, for example "Lisbon".');
  }
  const count = input.count === undefined || input.count === null || input.count === '' ? 5 : Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new AgentInputError('COUNT_INVALID', 'Count must be an integer from 1 to 10.');
  return {people: normPeople, category, location, count};
}

export function makePlan(input) {
  const v = validateInput(input);
  const cat = CATEGORIES[v.category];
  const pool = Math.min(30, Math.max(15, v.count * 3));
  const favCount = v.people.reduce((n, p) => n + p.favorites.length, 0);
  const recParams = ['filter.type=' + cat.type, 'signal.interests.entities=<all resolved IDs>', 'filter.exclude.entities=<same IDs>', 'feature.explainability=true', 'take=' + pool];
  if (v.location) recParams.push('filter.location.query=' + v.location);
  return {
    goal: `Find ${cat.label.toLowerCase()} that both ${v.people[0].name} and ${v.people[1].name} will enjoy`,
    ...v,
    categoryLabel: cat.label,
    filterType: cat.type,
    candidatePool: pool,
    steps: [
      {id: 'resolve', endpoint: 'GET /search', calls: favCount, why: 'Map each favorite name to a Qloo entity ID; skip result types Insights cannot use.'},
      {id: 'compare', endpoint: 'GET /v2/insights/compare', calls: 1, why: 'Find taste tags both people share and where they differ.'},
      {id: 'recommend', endpoint: 'GET /v2/insights', calls: 1, params: recParams, why: 'Get candidates with affinity scores and per-favorite explainability.'},
      {id: 'rank', endpoint: null, calls: 0, why: 'Re-rank for fairness: group score = affinity x (0.6 + 0.4 x balance), balance from explainability shares.'},
      {id: 'explain', endpoint: null, calls: 0, why: 'Explain each pick using only Qloo data: affinity, per-person contribution and shared tags.'}
    ]
  };
}

export async function resolveFavorites(client, favorites, trace) {
  const resolved = [];
  const unresolved = [];
  for (const fav of favorites) {
    const results = await client.search(fav.query, {types: fav.hintType || undefined, take: 5, trace});
    const best = pickBestMatch(results, fav.hintType);
    if (best) resolved.push({query: fav.query, id: best.id, name: best.name, type: best.type, disambiguation: best.disambiguation, image: best.image});
    else unresolved.push(fav.query);
  }
  return {resolved, unresolved};
}

const round = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

// Splits Qloo compare output into shared tags and each person's distinctive leanings.
// Qloo can return the same label under different tag IDs (e.g. a theme and a genre both named "Drama"),
// so tags are de-duplicated by ID and by normalized name.
export const tagKey = t => String(t.name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || t.id;
function uniqueTags(list) {
  const seen = new Set();
  return list.filter(t => {
    if (!t.id || !t.name || seen.has(t.id) || seen.has(tagKey(t))) return false;
    seen.add(t.id);
    seen.add(tagKey(t));
    return true;
  });
}

export function summarizeCompare(cmp, sharedTake = 8, leanTake = 6) {
  const shared = uniqueTags((cmp?.shared || []).map(toTag));
  const a = uniqueTags((cmp?.a || []).map(toTag));
  const b = uniqueTags((cmp?.b || []).map(toTag));
  const sharedKeys = new Set(shared.flatMap(t => [t.id, tagKey(t)]));
  const lean = (mine, other) => {
    const otherKeys = new Set(other.flatMap(t => [t.id, tagKey(t)]));
    return mine.filter(t => !otherKeys.has(t.id) && !otherKeys.has(tagKey(t)) && !sharedKeys.has(t.id) && !sharedKeys.has(tagKey(t)))
      .sort((x, y) => (y.count ?? 0) - (x.count ?? 0) || (y.popularity ?? 0) - (x.popularity ?? 0) || x.name.localeCompare(y.name))
      .slice(0, leanTake);
  };
  return {shared: shared.slice(0, sharedTake), leans: [lean(a, b), lean(b, a)]};
}

// Deterministic fairness re-ranking of Qloo candidates.
export function rankCandidates(rawEntities, ownerOf, personCount, count) {
  const rows = [];
  for (const raw of rawEntities || []) {
    const e = toEntity(raw);
    if (!e.id || !e.name) continue;
    const shares = new Array(personCount).fill(0);
    for (const {id, score} of e.explain) {
      const owners = ownerOf.get(id);
      if (!owners || !owners.size) continue;
      for (const p of owners) shares[p] += score / owners.size;
    }
    const total = shares.reduce((s, x) => s + x, 0);
    const split = total > 0 ? shares.map(s => s / total) : null;
    const balance = split ? 1 - (Math.max(...split) - Math.min(...split)) : null;
    const groupScore = (e.affinity ?? 0) * (0.6 + 0.4 * (balance ?? 0.5));
    rows.push({...e, split, balance, groupScore});
  }
  rows.sort((x, y) => y.groupScore - x.groupScore || (y.affinity ?? 0) - (x.affinity ?? 0) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
  return rows.slice(0, count);
}

export function explainPick(pick, people, seedsById, ownerOf, common) {
  const reasons = [];
  if (typeof pick.affinity === 'number') reasons.push(`Qloo affinity ${pick.affinity.toFixed(2)} for the combined taste of ${people[0].name} and ${people[1].name}.`);
  if (pick.split) {
    const parts = people.map((p, i) => {
      const mine = pick.explain.filter(x => ownerOf.get(x.id)?.has(i)).sort((x, y) => y.score - x.score);
      const top = mine.length ? seedsById.get(mine[0].id) : null;
      return `${Math.round(pick.split[i] * 100)}% from ${p.name}'s favorites${top ? ` (strongest: ${top.name})` : ''}`;
    });
    reasons.push(`Taste balance: ${parts.join(', ')}.`);
  } else {
    reasons.push('Qloo returned no per-favorite explainability for this pick, so balance is treated as neutral.');
  }
  const carried = new Set(pick.tags.filter(t => t.name).flatMap(t => [t.id, tagKey(t)]));
  const has = t => carried.has(t.id) || carried.has(tagKey(t));
  const shared = common.shared.filter(has).slice(0, 4).map(t => t.name);
  if (shared.length) reasons.push(`Carries taste tags you both share: ${shared.join(', ')}.`);
  people.forEach((p, i) => {
    const side = (common.leans[i] || []).filter(has).slice(0, 3).map(t => t.name);
    if (side.length) reasons.push(`Also speaks to ${p.name}'s side: ${side.join(', ')}.`);
  });
  return {reasons, sharedTags: shared};
}

export async function findCommonGround(client, input) {
  const plan = makePlan(input);
  const trace = [];
  const started = Date.now();
  const fail = (stage, error, message, extra = {}) => ({ok: false, stage, error, message, plan, trace, ...extra});
  const people = [];
  try {
    for (const p of plan.people) people.push({name: p.name, ...(await resolveFavorites(client, p.favorites, trace))});
  } catch (err) {
    if (err instanceof QlooError) return fail('resolve', err.code, 'Qloo search failed: ' + err.code, {people});
    throw err;
  }
  const empty = people.find(p => !p.resolved.length);
  if (empty) return fail('resolve', 'NO_MATCH_FOR_PERSON', `Qloo found no usable match for ${empty.name}'s favorites. Try more specific names or a "movie:", "book:", "artist:" prefix.`, {people});
  const ownerOf = new Map();
  const seedsById = new Map();
  people.forEach((p, i) => p.resolved.forEach(r => {
    if (!ownerOf.has(r.id)) ownerOf.set(r.id, new Set());
    ownerOf.get(r.id).add(i);
    seedsById.set(r.id, r);
  }));
  const idsOf = i => [...new Set(people[i].resolved.map(r => r.id))];
  const allIds = [...seedsById.keys()];
  const warnings = [];
  let common = {shared: [], leans: [[], []]};
  try {
    common = summarizeCompare(await client.compare(idsOf(0), idsOf(1), {take: 10, trace}));
  } catch (err) {
    if (!(err instanceof QlooError)) throw err;
    warnings.push('Taste comparison unavailable (' + err.code + '); recommendations still use both people\'s favorites.');
  }
  let rec;
  try {
    const params = {'filter.type': plan.filterType, 'signal.interests.entities': allIds, 'filter.exclude.entities': allIds, 'feature.explainability': 'true', take: plan.candidatePool};
    if (plan.location) params['filter.location.query'] = plan.location;
    rec = await client.insights(params, {trace});
  } catch (err) {
    if (err instanceof QlooError) return fail('recommend', err.code, 'Qloo insights request failed: ' + err.code + (err.detail ? ' - ' + err.detail : ''), {people, commonGround: common});
    throw err;
  }
  const ranked = rankCandidates(rec.entities, ownerOf, 2, plan.count);
  if (!ranked.length) return fail('recommend', 'NO_CANDIDATES', 'Qloo returned no candidates for this combination. Try another category, location or favorites.', {people, commonGround: common});
  const picks = ranked.map((r, i) => {
    const {reasons, sharedTags} = explainPick(r, plan.people, seedsById, ownerOf, common);
    return {
      rank: i + 1, id: r.id, name: r.name, type: r.type, disambiguation: r.disambiguation, year: r.year, city: r.city, image: r.image,
      affinity: round(r.affinity), balance: round(r.balance), groupScore: round(r.groupScore),
      split: r.split ? plan.people.map((p, k) => ({person: p.name, share: round(r.split[k])})) : null,
      sharedTags, reasons
    };
  });
  return {
    ok: true, plan, people, commonGround: common, picks, warnings, trace,
    meta: {source: 'Qloo Taste AI API (hackathon environment)', candidatesFromQloo: rec.entities.length, elapsedMs: Date.now() - started}
  };
}
