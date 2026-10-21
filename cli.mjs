// TasteBridge CLI: runs the same deterministic agent loop as the web demo and MCP tool.
import {parseArgs} from 'node:util';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDotEnv} from './src/env.mjs';
import {CATEGORIES, QlooClient, QlooError} from './src/qloo.mjs';
import {AgentInputError, findCommonGround, makePlan} from './src/agent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HELP = `TasteBridge CLI - common ground for two people, powered by the Qloo Taste AI API

Usage:
  node cli.mjs --a-name Alex --a "Amelie; Daft Punk" --b-name Sam --b "Blade Runner; book: Dune" [--category movies] [--count 5] [--location Lisbon] [--json] [--plan-only]

Categories: ${Object.keys(CATEGORIES).join(', ')}
Separate favorites with ";". Optional type prefixes: movie:, tv:, book:, artist:, podcast:, game:, place:, destination:, brand:
--plan-only prints the agent plan without calling Qloo (no API key needed).`;

function render(r) {
  const out = [`Goal: ${r.plan.goal}`, 'Plan:'];
  r.plan.steps.forEach((s, i) => out.push(`  ${i + 1}. [${s.id}] ${s.endpoint || 'local'} - ${s.why}`));
  for (const p of r.people || []) {
    const found = p.resolved.map(x => `${x.name}${x.disambiguation ? ` (${x.disambiguation})` : ''} [${String(x.type).replace('urn:entity:', '')}]`).join(', ');
    out.push(`${p.name}: ${found}${p.unresolved.length ? `  | not found: ${p.unresolved.join(', ')}` : ''}`);
  }
  if (!r.ok) {
    out.push(`Stopped at "${r.stage}": ${r.message}`);
  } else {
    if (r.commonGround.shared.length) out.push('Shared taste (Qloo compare): ' + r.commonGround.shared.map(t => t.name).join(', '));
    for (const p of r.picks) {
      out.push(`#${p.rank} ${p.name}${p.disambiguation ? ` (${p.disambiguation})` : ''}  affinity=${p.affinity} balance=${p.balance ?? 'n/a'} groupScore=${p.groupScore}`);
      p.reasons.forEach(x => out.push('     - ' + x));
    }
    (r.warnings || []).forEach(w => out.push('Warning: ' + w));
  }
  out.push('Qloo calls: ' + r.trace.map(t => `${t.endpoint} ${t.status} ${t.ms}ms${t.cached ? ' (cache)' : ''}`).join(' | '));
  return out.join('\n');
}

const {values} = parseArgs({
  options: {
    'a-name': {type: 'string', default: 'Person A'}, a: {type: 'string'},
    'b-name': {type: 'string', default: 'Person B'}, b: {type: 'string'},
    category: {type: 'string', default: 'movies'}, count: {type: 'string', default: '5'}, location: {type: 'string'},
    json: {type: 'boolean', default: false}, 'plan-only': {type: 'boolean', default: false}, help: {type: 'boolean', short: 'h', default: false}
  }
});

if (values.help || !values.a || !values.b) {
  console.log(HELP);
  process.exitCode = values.help ? 0 : 2;
} else {
  const input = {
    people: [{name: values['a-name'], favorites: values.a.split(';')}, {name: values['b-name'], favorites: values.b.split(';')}],
    category: values.category, count: Number(values.count), location: values.location
  };
  try {
    if (values['plan-only']) {
      console.log(JSON.stringify(makePlan(input), null, 2));
    } else {
      loadDotEnv(resolve(here, '.env'));
      const result = await findCommonGround(new QlooClient({apiKey: process.env.QLOO_API_KEY}), input);
      console.log(values.json ? JSON.stringify(result, null, 2) : render(result));
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (err) {
    if (err instanceof AgentInputError) {
      console.error('Input error: ' + err.userMessage);
      process.exitCode = 2;
    } else if (err instanceof QlooError) {
      console.error('Qloo error: ' + err.code + (err.code === 'QLOO_API_KEY_MISSING' ? ' (put QLOO_API_KEY=... in .env)' : ''));
      process.exitCode = 3;
    } else {
      throw err;
    }
  }
}
