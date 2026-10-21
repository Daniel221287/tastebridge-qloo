// Qloo Taste AI API client (hackathon environment).
// GET requests only, API key sent in the X-Api-Key header, never logged or returned.

export const QLOO_BASE_URL = 'https://hackathon.api.qloo.com';

// Entity types accepted by GET /v2/insights (filter.type). Verified live on 2026-10-21:
// the hackathon API accepts `urn:entity:videogame` and rejects `urn:entity:video_game`.
export const INSIGHTS_TYPES = Object.freeze([
  'urn:entity:artist', 'urn:entity:book', 'urn:entity:brand', 'urn:entity:destination',
  'urn:entity:movie', 'urn:entity:person', 'urn:entity:place', 'urn:entity:podcast',
  'urn:entity:tv_show', 'urn:entity:videogame'
]);

export const CATEGORIES = Object.freeze({
  movies: {type: 'urn:entity:movie', label: 'Movies'},
  tv: {type: 'urn:entity:tv_show', label: 'TV shows'},
  books: {type: 'urn:entity:book', label: 'Books'},
  music: {type: 'urn:entity:artist', label: 'Music artists'},
  podcasts: {type: 'urn:entity:podcast', label: 'Podcasts'},
  games: {type: 'urn:entity:videogame', label: 'Video games'},
  places: {type: 'urn:entity:place', label: 'Places (restaurants, bars, venues)', needsLocation: true},
  destinations: {type: 'urn:entity:destination', label: 'Travel destinations'},
  brands: {type: 'urn:entity:brand', label: 'Brands'}
});

// Optional "hint:" prefixes for favorites, e.g. "book: Dune" or "movie: Dune".
const HINTS = Object.freeze({
  movie: 'urn:entity:movie', film: 'urn:entity:movie',
  tv: 'urn:entity:tv_show', show: 'urn:entity:tv_show', series: 'urn:entity:tv_show',
  book: 'urn:entity:book', novel: 'urn:entity:book',
  artist: 'urn:entity:artist', music: 'urn:entity:artist', band: 'urn:entity:artist', musician: 'urn:entity:artist',
  podcast: 'urn:entity:podcast',
  game: 'urn:entity:videogame', videogame: 'urn:entity:videogame',
  place: 'urn:entity:place', restaurant: 'urn:entity:place', bar: 'urn:entity:place', venue: 'urn:entity:place',
  destination: 'urn:entity:destination', city: 'urn:entity:destination',
  brand: 'urn:entity:brand', person: 'urn:entity:person'
});

export class QlooError extends Error {
  constructor(code, status = 0, detail = '') {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = String(detail || '').slice(0, 300);
  }
}

export function parseFavorite(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/^([a-z]+)\s*:\s*(.+)$/i);
  if (m && HINTS[m[1].toLowerCase()]) return {query: m[2].trim(), hintType: HINTS[m[1].toLowerCase()]};
  return {query: raw, hintType: null};
}

function safeImage(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'images.qloo.com' ? u.href : null;
  } catch {
    return null;
  }
}

function primaryType(e) {
  if (e.subtype && INSIGHTS_TYPES.includes(e.subtype)) return e.subtype;
  const types = Array.isArray(e.types) ? e.types : [];
  return types.find(t => INSIGHTS_TYPES.includes(t)) || e.subtype || types[0] || null;
}

// Normalizes one entity object from /search, /entities or /v2/insights.
export function toEntity(e) {
  const p = e?.properties || {};
  const explain = e?.query?.explainability?.['signal.interests.entities'];
  return {
    id: String(e?.entity_id || ''),
    name: String(e?.name || ''),
    type: primaryType(e || {}),
    disambiguation: typeof e?.disambiguation === 'string' ? e.disambiguation : '',
    year: p.release_year || p.publication_year || null,
    city: p.geocode?.city || null,
    image: safeImage(p.image?.url),
    popularity: typeof e?.popularity === 'number' ? e.popularity : null,
    affinity: typeof e?.query?.affinity === 'number' ? e.query.affinity : null,
    explain: Array.isArray(explain) ? explain.map(x => ({id: String(x.entity_id), score: Number(x.score) || 0})) : [],
    tags: Array.isArray(e?.tags) ? e.tags.map(t => ({id: String(t.id || t.tag_id || ''), name: String(t.name || '').trim(), type: t.type || t.subtype || ''})) : []
  };
}

export function toTag(t) {
  return {
    id: String(t?.tag_id || t?.id || ''),
    name: String(t?.name || '').trim(),
    subtype: String(t?.subtype || t?.type || ''),
    score: typeof t?.query?.score === 'number' ? t.query.score : (typeof t?.query?.affinity === 'number' ? t.query.affinity : null),
    count: t?.query?.count !== undefined ? Number(t.query.count) : null,
    popularity: typeof t?.popularity === 'number' ? t.popularity : null
  };
}

// Picks the first search hit whose type is usable as an Insights signal (skips albums, localities...).
export function pickBestMatch(results, hintType = null) {
  for (const r of Array.isArray(results) ? results : []) {
    const types = Array.isArray(r?.types) ? r.types : [r?.subtype].filter(Boolean);
    const usable = types.filter(t => INSIGHTS_TYPES.includes(t));
    if (!r?.entity_id || !usable.length) continue;
    if (hintType && !usable.includes(hintType)) continue;
    const ent = toEntity(r);
    ent.type = hintType || usable[0];
    return ent;
  }
  return null;
}

const STATUS_CODES = Object.freeze({400: 'QLOO_BAD_REQUEST', 401: 'QLOO_UNAUTHORIZED', 403: 'QLOO_FORBIDDEN', 404: 'QLOO_NOT_FOUND', 429: 'QLOO_RATE_LIMITED'});

export class QlooClient {
  constructor({apiKey = '', baseUrl = QLOO_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 20000, cacheTtlMs = 10 * 60 * 1000, now = () => Date.now()} = {}) {
    // Key kept in a non-enumerable field so it never appears in JSON.stringify or console output.
    Object.defineProperty(this, 'apiKey', {value: String(apiKey || '').trim(), enumerable: false});
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
  }

  get configured() {
    return this.apiKey.length > 0;
  }

  buildUrl(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    for (const key of Object.keys(params).sort()) {
      const v = params[key];
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(key, Array.isArray(v) ? v.join(',') : String(v));
    }
    return url;
  }

  async get(path, params = {}, {trace} = {}) {
    if (!this.configured) throw new QlooError('QLOO_API_KEY_MISSING', 0, 'Set QLOO_API_KEY in .env; no request was sent.');
    const url = this.buildUrl(path, params);
    const cacheKey = url.pathname + url.search;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > this.now()) {
      trace?.push({endpoint: 'GET ' + url.pathname, status: 200, ms: 0, cached: true});
      return hit.json;
    }
    const started = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, {method: 'GET', headers: {'X-Api-Key': this.apiKey, Accept: 'application/json'}, signal: ctrl.signal});
    } catch (err) {
      const code = err?.name === 'AbortError' ? 'QLOO_TIMEOUT' : 'QLOO_NETWORK_ERROR';
      trace?.push({endpoint: 'GET ' + url.pathname, status: code, ms: Math.round(performance.now() - started)});
      throw new QlooError(code, 0);
    } finally {
      clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - started);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    trace?.push({endpoint: 'GET ' + url.pathname, status: res.status, ms});
    if (!res.ok) {
      const detail = json?.errors?.[0]?.message || json?.message || json?.error || '';
      throw new QlooError(STATUS_CODES[res.status] || 'QLOO_HTTP_' + res.status, res.status, detail);
    }
    if (!json || typeof json !== 'object') throw new QlooError('QLOO_INVALID_JSON', res.status);
    if (this.cacheTtlMs > 0) this.cache.set(cacheKey, {json, expires: this.now() + this.cacheTtlMs});
    return json;
  }

  // GET /search: name -> entity candidates.
  async search(query, {types, take = 5, trace} = {}) {
    const json = await this.get('/search', {query, types, take}, {trace});
    return Array.isArray(json.results) ? json.results : [];
  }

  // GET /entities: entity details (incl. tags) by ID.
  async entities(ids, {trace} = {}) {
    const json = await this.get('/entities', {entity_ids: ids}, {trace});
    return Array.isArray(json.results) ? json.results : [];
  }

  // GET /v2/insights: recommendations (entity filter.type) or taste tags (filter.type=urn:tag).
  async insights(params, {trace} = {}) {
    const json = await this.get('/v2/insights', params, {trace});
    return {entities: json?.results?.entities || [], tags: json?.results?.tags || [], query: json?.query || {}};
  }

  // GET /v2/insights/compare: taste overlap between two groups of entities.
  async compare(aIds, bIds, {take = 10, trace} = {}) {
    const json = await this.get('/v2/insights/compare', {'a.signal.interests.entities': aIds, 'b.signal.interests.entities': bIds, take}, {trace});
    const r = json?.results || {};
    return {shared: r.tags || [], a: r.a || [], b: r.b || []};
  }
}
