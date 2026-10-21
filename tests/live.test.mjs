// Live end-to-end test against the real Qloo hackathon API.
// Runs only when QLOO_API_KEY is set (environment or local .env); otherwise it is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDotEnv} from '../src/env.mjs';
import {QlooClient} from '../src/qloo.mjs';
import {findCommonGround} from '../src/agent.mjs';

loadDotEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));
const hasKey = Boolean(process.env.QLOO_API_KEY) && process.env.QLOO_LIVE !== '0';

test('LIVE: full agent loop against hackathon.api.qloo.com', {skip: hasKey ? false : 'QLOO_API_KEY not set', timeout: 60000}, async () => {
  const client = new QlooClient({apiKey: process.env.QLOO_API_KEY, cacheTtlMs: 0});
  const r = await findCommonGround(client, {
    people: [{name: 'Alex', favorites: ['Amelie', 'artist: Daft Punk']}, {name: 'Sam', favorites: ['Blade Runner', 'Interstellar']}],
    category: 'movies', count: 3
  });
  assert.equal(r.ok, true, r.message);
  assert.ok(r.trace.length >= 6);
  assert.ok(r.trace.every(t => t.status === 200), JSON.stringify(r.trace.map(t => t.status)));
  assert.equal(r.picks.length, 3);
  const seedIds = new Set(r.people.flatMap(p => p.resolved.map(x => x.id)));
  for (const p of r.picks) {
    assert.ok(p.name && p.id, 'pick has a Qloo name and ID');
    assert.equal(p.type, 'urn:entity:movie');
    assert.equal(seedIds.has(p.id), false, 'seeds are excluded from picks');
    assert.ok(p.affinity > 0 && p.affinity <= 1);
  }
});
