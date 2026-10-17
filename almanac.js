// The character almanac on index.njk: every released character from upstream's
// resources/data, filterable by edition and team, with a detail dialog (ability, night order,
// reminders, jinxes). Icons are resources/characters/<edition>/<id>[_g|_e].webp.

const V = '20261017b';
const BASE = '/games/botc/resources';
const EDITIONS = { tb: 'Trouble Brewing', bmr: 'Bad Moon Rising', snv: 'Sects & Violets', carousel: 'Experimental', fabled: 'Fabled', loric: 'Loric' };
const TEAMS = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric' };
const TEAM_ORDER = Object.keys(TEAMS);
const EVIL = new Set(['minion', 'demon']);

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Upstream ships plain, _g (good) and _e (evil) icons, not every one for every character:
// try the team's own alignment first, then the others.
function iconUrls(r) {
  const order = EVIL.has(r.team) ? ['_e', '', '_g'] : ['_g', '', '_e'];
  return order.map(s => `${BASE}/characters/${r.edition}/${r.id}${s}.webp`);
}
function iconImg(r, size) {
  const [first, ...rest] = iconUrls(r);
  const img = document.createElement('img');
  img.src = first;
  img.alt = '';
  img.width = img.height = size;
  img.loading = 'lazy';
  img.dataset.next = rest.join(' ');
  img.addEventListener('error', () => {
    const [n, ...more] = (img.dataset.next || '').split(' ').filter(Boolean);
    if (!n) return;
    img.dataset.next = more.join(' ');
    img.src = n;
  });
  return img;
}

async function json(path) {
  const res = await fetch(`${BASE}/data/${path}?v=${V}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const state = { edition: '', team: '', q: '' };
let roles = [], byId = {}, jinxes = {}, night = { firstNight: [], otherNight: [] };

function matches(r) {
  if (state.edition && r.edition !== state.edition) return false;
  if (state.team && r.team !== state.team) return false;
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return r.name.toLowerCase().includes(q) || (r.ability || '').toLowerCase().includes(q);
}

function draw() {
  const list = roles.filter(matches);
  const grid = $('botc-grid');
  grid.replaceChildren(...list.map(r => {
    const li = document.createElement('li');
    li.className = `botc-card botc-team-${r.team}`;
    const b = document.createElement('button');
    b.type = 'button';
    b.title = r.ability || '';
    b.append(iconImg(r, 72));
    const name = document.createElement('span');
    name.className = 'botc-name';
    name.textContent = r.name;
    const team = document.createElement('span');
    team.className = 'botc-team';
    team.textContent = TEAMS[r.team] || r.team;
    b.append(name, team);
    b.addEventListener('click', () => open(r));
    li.append(b);
    return li;
  }));
  $('botc-count').textContent = `${list.length} of ${roles.length} characters`;
}

function nightPos(key, id) {
  const i = night[key].indexOf(id);
  return i < 0 ? null : i + 1;
}

function open(r) {
  const icon = $('botc-d-icon');
  const fresh = iconImg(r, 96);
  fresh.id = 'botc-d-icon';
  icon.replaceWith(fresh);
  $('botc-d-name').textContent = r.name;
  $('botc-d-meta').textContent = `${TEAMS[r.team] || r.team} · ${EDITIONS[r.edition] || r.edition}`;
  $('botc-d-ability').textContent = r.ability || '';
  $('botc-d-flavor').textContent = r.flavor || '';
  $('botc-d-flavor').hidden = !r.flavor;
  const facts = [];
  const fn = nightPos('firstNight', r.id), on = nightPos('otherNight', r.id);
  if (fn) facts.push(['First night', `#${fn} of ${night.firstNight.length}${r.firstNightReminder ? ` — ${r.firstNightReminder}` : ''}`]);
  if (on) facts.push(['Other nights', `#${on} of ${night.otherNight.length}${r.otherNightReminder ? ` — ${r.otherNightReminder}` : ''}`]);
  if (r.setup) facts.push(['Setup', 'Changes the setup (shown in brackets in the ability)']);
  const rem = [...(r.reminders || []), ...(r.remindersGlobal || [])];
  if (rem.length) facts.push(['Reminder tokens', rem.join(', ')]);
  const jx = jinxes[r.id] || [];
  for (const j of jx) facts.push([`Jinx: ${byId[j.id]?.name || j.id}`, j.reason]);
  // Upstream's reminder text marks tokens as *TOKEN* and "place a reminder" as :reminder:
  const fmt = v => esc(v).replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/\s*:reminder:/g, ' <span class="botc-rem" title="Place a reminder token">◉</span>');
  $('botc-d-facts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmt(v)}</dd>`).join('');
  $('botc-dialog').showModal();
}

function wireChips(groupId, key) {
  const group = $(groupId);
  group.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = b.dataset[key];
    for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    draw();
  });
}

async function main() {
  try {
    const [r, j, n] = await Promise.all([json('roles.json'), json('jinxes.json'), json('nightsheet.json')]);
    roles = r.slice().sort((a, b) => (TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team)) || a.name.localeCompare(b.name));
    byId = Object.fromEntries(roles.map(x => [x.id, x]));
    // jinxes.json lists each pair once, under one of the two characters: index it both ways
    for (const { id, jinx } of j) for (const { id: other, reason } of jinx || []) {
      (jinxes[id] ||= []).push({ id: other, reason });
      (jinxes[other] ||= []).push({ id, reason });
    }
    night = { firstNight: n.firstNight || [], otherNight: n.otherNight || [] };
  } catch (err) {
    console.error('botc almanac', err);
    $('botc-count').textContent = 'The character list could not be loaded.';
    $('botc-grid').replaceChildren();
    return;
  }
  wireChips('botc-editions', 'edition');
  wireChips('botc-teams', 'team');
  const search = $('botc-search');
  search.addEventListener('input', () => { state.q = search.value.trim(); draw(); });
  for (const el of document.querySelectorAll('.botc-filters [disabled]')) el.disabled = false;
  const dlg = $('botc-dialog');
  $('botc-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  draw();
}

main();
