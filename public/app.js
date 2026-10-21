// TasteBridge web demo. Renders only data returned by the server (which only relays Qloo data).
const $ = id => document.getElementById(id);
const form = $('form');
const results = $('results');
const statusEl = $('status');

const EXAMPLES = [
  {a: ['Alex', 'Amelie\nDaft Punk\nbook: Dune'], b: ['Sam', 'Blade Runner\nInterstellar'], category: 'movies', location: ''},
  {a: ['Maya', 'Pride and Prejudice\nThe Night Circus\nmovie: Little Women'], b: ['Leo', 'The Martian\nDune\nmovie: Arrival'], category: 'books', location: ''},
  {a: ['Ana', 'Amelie\nNorah Jones\nThe Grand Budapest Hotel'], b: ['Tom', 'Anthony Bourdain: Parts Unknown\nArctic Monkeys'], category: 'places', location: 'Lisbon'},
  {a: ['Kim', 'podcast: Radiolab\nThe Office'], b: ['Jo', 'podcast: Hardcore History\nThe Martian'], category: 'podcasts', location: ''}
];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v; else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const typeLabel = t => String(t || '').replace('urn:entity:', '').replace('_', ' ');
const pct = x => Math.round((x || 0) * 100) + '%';

function syncLocation() {
  const places = $('category').value === 'places';
  $('locReq').hidden = !places;
  $('location').required = places;
  $('location').placeholder = places ? 'e.g. Lisbon' : 'optional, e.g. Lisbon';
}

function fillExample(i) {
  const ex = EXAMPLES[i];
  [$('aName').value, $('aFav').value] = ex.a;
  [$('bName').value, $('bFav').value] = ex.b;
  $('category').value = ex.category;
  $('location').value = ex.location;
  syncLocation();
}

function readForm() {
  const favs = v => v.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return {
    people: [{name: $('aName').value.trim(), favorites: favs($('aFav').value)}, {name: $('bName').value.trim(), favorites: favs($('bFav').value)}],
    category: $('category').value,
    location: $('location').value.trim() || undefined,
    count: Number($('count').value)
  };
}

function showFormError(msg) {
  $('formError').textContent = msg || '';
  $('formError').hidden = !msg;
}

function card(title, ...children) {
  return el('section', {class: 'card'}, el('h2', {}, title), ...children);
}

function planCard(r) {
  const steps = el('ol', {class: 'steps'}, r.plan.steps.map(s => el('li', {},
    el('strong', {}, s.id), ' ', s.endpoint ? el('span', {class: 'ep'}, s.endpoint) : null, ' - ', s.why)));
  return card('Agent plan', el('p', {class: 'hint'}, r.plan.goal + '.'), steps);
}

function peopleCard(r) {
  const cols = (r.people || []).map((p, i) => el('div', {},
    el('div', {class: 'who ' + (i ? 'b' : 'a')}, p.name),
    el('ul', {class: 'ents'}, p.resolved.map(x => el('li', {}, x.name, x.disambiguation ? ` (${x.disambiguation})` : '', el('span', {class: 'badge'}, typeLabel(x.type))))),
    p.unresolved.length ? el('p', {class: 'miss'}, 'Not found in Qloo: ' + p.unresolved.join(', ')) : null));
  return card('How Qloo read your favorites', el('div', {class: 'grid2'}, cols));
}

function tagRow(list, cls) {
  return el('div', {class: 'tags'}, list.length ? list.map(t => el('span', {class: 't ' + cls}, t.name)) : el('span', {class: 'miss'}, 'none returned'));
}

function commonCard(r) {
  const [A, B] = r.plan.people.map(p => p.name);
  const cg = r.commonGround;
  return card('Your common ground',
    el('p', {class: 'hint'}, 'From Qloo\'s taste comparison of both sets of favorites.'),
    el('div', {class: 'who'}, 'Shared by both'), tagRow(cg.shared, 'both'),
    el('div', {class: 'grid2'},
      el('div', {}, el('div', {class: 'who a'}, 'Only ' + A), tagRow(cg.leans[0], 'a')),
      el('div', {}, el('div', {class: 'who b'}, 'Only ' + B), tagRow(cg.leans[1], 'b'))));
}

function pickCard(p, names) {
  const img = p.image ? el('img', {src: p.image, alt: '', loading: 'lazy', width: 76, height: 108}) : el('div', {class: 'ph', 'aria-hidden': 'true'});
  const meta = [typeLabel(p.type), p.disambiguation || p.year, p.city].filter(Boolean).join(' · ');
  let balance = null;
  if (p.split) {
    const sa = el('span', {class: 'sa'});
    const sb = el('span', {class: 'sb'});
    sa.style.width = pct(p.split[0].share);
    sb.style.width = pct(p.split[1].share);
    balance = el('div', {},
      el('div', {class: 'bar', role: 'img', 'aria-label': `${names[0]} ${pct(p.split[0].share)}, ${names[1]} ${pct(p.split[1].share)}`}, sa, sb),
      el('div', {class: 'barlbl'}, el('span', {}, `${names[0]} ${pct(p.split[0].share)}`), el('span', {}, `${names[1]} ${pct(p.split[1].share)}`)));
  }
  return el('article', {class: 'pick'}, img, el('div', {},
    el('h3', {}, el('span', {class: 'rank'}, '#' + p.rank), p.name),
    el('div', {class: 'meta'}, meta, p.affinity !== null ? ` · Qloo affinity ${p.affinity.toFixed(2)}` : ''),
    balance,
    el('ul', {class: 'reasons'}, p.reasons.map(x => el('li', {}, x)))));
}

function traceCard(r) {
  const rows = r.trace.map(t => el('tr', {}, el('td', {}, t.endpoint), el('td', {}, String(t.status) + (t.cached ? ' (cache)' : '')), el('td', {class: 'num'}, t.ms + ' ms')));
  return card('Qloo API calls',
    el('p', {class: 'hint'}, `${r.trace.length} calls${r.meta ? `, ${r.meta.elapsedMs} ms total, ${r.meta.candidatesFromQloo} candidates scored by Qloo` : ''}.`),
    el('div', {class: 'scroll'}, el('table', {class: 'trace'}, el('thead', {}, el('tr', {}, el('th', {}, 'Endpoint'), el('th', {}, 'Status'), el('th', {}, 'Latency'))), el('tbody', {}, rows))));
}

function render(r) {
  const names = r.plan.people.map(p => p.name);
  const parts = [planCard(r)];
  if (r.people?.length) parts.push(peopleCard(r));
  if (!r.ok) {
    parts.push(card('The agent stopped', el('p', {class: 'error'}, r.message)));
  } else {
    parts.push(commonCard(r));
    parts.push(card(`Picks for ${names[0]} and ${names[1]}`,
      el('p', {class: 'hint'}, 'Ranked by Qloo affinity, adjusted for how evenly both people\'s favorites drive each pick.'),
      (r.warnings || []).map(w => el('p', {class: 'miss'}, w)),
      el('div', {class: 'picks'}, r.picks.map(p => pickCard(p, names)))));
  }
  parts.push(traceCard(r));
  results.replaceChildren(...parts);
  results.hidden = false;
}

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  showFormError('');
  const body = readForm();
  if (!body.people[0].favorites.length || !body.people[1].favorites.length) return showFormError('Add at least one favorite for each person.');
  if (body.category === 'places' && !body.location) return showFormError('Places need a city or area, for example Lisbon.');
  $('go').disabled = true;
  statusEl.textContent = 'Running the agent: resolving favorites, comparing tastes, asking Qloo for candidates...';
  try {
    const res = await fetch('/api/common-ground', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const data = await res.json();
    if (!res.ok || !data.plan) {
      showFormError(data.message || data.error || 'Request failed (' + res.status + ').');
      statusEl.textContent = '';
      return;
    }
    render(data);
    statusEl.textContent = data.ok ? `Done: ${data.picks.length} picks from ${data.meta.candidatesFromQloo} Qloo candidates.` : 'The agent stopped early; see details below.';
    results.firstElementChild?.scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch {
    showFormError('Network error: is the local server still running?');
    statusEl.textContent = '';
  } finally {
    $('go').disabled = false;
  }
});

document.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => fillExample(Number(b.dataset.example))));
$('category').addEventListener('change', syncLocation);
fillExample(0);
fetch('/health').then(r => r.json()).then(h => { $('keyBanner').hidden = Boolean(h.qlooKeyConfigured); }).catch(() => {});
