// Live smoke test of the Qloo hackathon API. Records only HTTP status, result counts and latency
// (no titles, no response bodies, never the key) to logs/smoke-live.json.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDotEnv} from '../src/env.mjs';
import {QLOO_BASE_URL, QlooClient} from '../src/qloo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(resolve(root, '.env'));
const client = new QlooClient({apiKey: process.env.QLOO_API_KEY, cacheTtlMs: 0});
const report = {startedAt: new Date().toISOString(), baseUrl: QLOO_BASE_URL, keyConfigured: client.configured, checks: []};
const ids = {};

async function check(name, fn) {
  const trace = [];
  try {
    const count = await fn(trace);
    report.checks.push({name, ok: true, status: trace.at(-1)?.status ?? null, count, ms: trace.reduce((s, t) => s + (t.ms || 0), 0)});
  } catch (err) {
    report.checks.push({name, ok: false, status: err.status || null, error: err.code || 'ERROR', ms: trace.reduce((s, t) => s + (t.ms || 0), 0)});
  }
}

await check('GET /search (movie)', async trace => {
  const r = await client.search('Blade Runner', {types: 'urn:entity:movie', take: 3, trace});
  ids.a = r[0]?.entity_id;
  return r.length;
});
await check('GET /search (artist)', async trace => {
  const r = await client.search('Daft Punk', {types: 'urn:entity:artist', take: 3, trace});
  ids.b = r[0]?.entity_id;
  return r.length;
});
await check('GET /v2/insights (movie recs + explainability)', async trace =>
  (await client.insights({'filter.type': 'urn:entity:movie', 'signal.interests.entities': [ids.a, ids.b], 'feature.explainability': 'true', take: 10}, {trace})).entities.length);
await check('GET /v2/insights (taste tags)', async trace =>
  (await client.insights({'filter.type': 'urn:tag', 'signal.interests.entities': [ids.a], 'filter.parents.types': 'urn:entity:movie', take: 10}, {trace})).tags.length);
await check('GET /v2/insights/compare', async trace => (await client.compare([ids.a], [ids.b], {take: 10, trace})).shared.length);
await check('GET /entities', async trace => (await client.entities([ids.a, ids.b], {trace})).length);

report.finishedAt = new Date().toISOString();
report.allOk = report.checks.every(c => c.ok && c.count > 0);
mkdirSync(resolve(root, 'logs'), {recursive: true});
writeFileSync(resolve(root, 'logs', 'smoke-live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.allOk ? 0 : 1;
