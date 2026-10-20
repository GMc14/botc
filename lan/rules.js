/**
 * rules.js — Blood on the Clocktower played nearby (no internet): the Storyteller's phone holds the
 * game, and this is the pure part of it. No DOM, no network: ./storyteller.js runs it on a LanRoom
 * hub (../../common/lan/room.js) and ../nearby.njk draws it. See docs/adr/0001-nearby-storyteller.md.
 *
 * Two halves, and only the first is ever broadcast:
 *   room    what every phone gets: the script, seats, alive/dead and ghost votes, phase and day,
 *           today's nominations with their public votes (hands are public in BotC), the public log,
 *           and every true character only once the game is over. Never a character while it runs.
 *   secret  the Storyteller's alone (the grimoire): each player's true character and what they
 *           think they are (the Drunk thinks a Townsfolk), the demon bluffs, reminder tokens, the
 *           asks the Storyteller has sent, every answer, the evil team's first-night info and the
 *           notes sent to each player.
 * What one player may see is privateFor(room, secret, clientId, lib): the character they think
 * they are, their evil-team info if the Storyteller sent it, what they are asked now, what they
 * answered, and their notes.
 *
 * The app does not resolve abilities: the Storyteller reads the answers, decides what each player
 * learns (sent as a note) and who dies, as at a real table.
 *
 * Characters come in as `lib` (makeLib turns upstream's resources/data into it):
 *   { chars: { <id>: { id, name, team, edition, ability, reminders, remindersGlobal, setup,
 *                      firstNightReminder, otherNightReminder } },
 *     firstNight: [id...], otherNight: [id...] }   // nightsheet.json, with dusk/minioninfo/demoninfo/dawn
 */

export const GAME = 'botc';
export const EDITIONS = { tb: 'Trouble Brewing', bmr: 'Bad Moon Rising', snv: 'Sects & Violets' };
/** The teams a script deals from; Travellers and Fabled are not dealt (ADR 0001). */
export const DEALT = ['townsfolk', 'outsider', 'minion', 'demon'];
export const GOOD = new Set(['townsfolk', 'outsider']);
export const EVIL = new Set(['minion', 'demon']);
const MAX_NOTES = 30;

// ---------------------------------------------------------------- characters and scripts

export function makeLib(roles, nightsheet = {}) {
  const chars = {};
  for (const r of roles || []) if (r?.id) chars[r.id] = r;
  return { chars, firstNight: [...(nightsheet.firstNight || [])], otherNight: [...(nightsheet.otherNight || [])] };
}

/** Character ids as scripts spell them: "Fortune Teller", "fortune_teller" and "fortuneteller" are one. */
export const normId = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const byTeamThenName = lib => (a, b) => (DEALT.indexOf(lib.chars[a].team) - DEALT.indexOf(lib.chars[b].team))
  || lib.chars[a].name.localeCompare(lib.chars[b].name);

/** A base edition's script: every character of that edition the table can deal. */
export function editionScript(lib, edition) {
  const ids = Object.values(lib.chars).filter(c => c.edition === edition && DEALT.includes(c.team)).map(c => c.id);
  return { name: EDITIONS[edition] || edition, ids: ids.sort(byTeamThenName(lib)) };
}

/**
 * A pasted custom script (script-schema.json: an array of ids or { id } objects, with an optional
 * { id: '_meta', name }). Only released characters are used: homebrew ones, Travellers and Fabled
 * are listed in `skipped` and left out.
 */
export function parseScript(lib, input) {
  let list = input;
  if (typeof input === 'string') {
    try { list = JSON.parse(input); } catch { throw new Error('That is not script JSON.'); }
  }
  if (!Array.isArray(list)) throw new Error('A script is a JSON array of characters.');
  let name = 'Custom script';
  const ids = [], skipped = [];
  const known = Object.fromEntries(Object.keys(lib.chars).map(id => [normId(id), id]));
  for (const item of list) {
    const raw = typeof item === 'string' ? item : item?.id;
    if (raw === '_meta') { if (item.name) name = String(item.name).slice(0, 60); continue; }
    const id = known[normId(raw)];
    if (!id || !DEALT.includes(lib.chars[id].team)) { if (raw) skipped.push(String(raw)); continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.some(id => lib.chars[id].team === 'demon')) throw new Error('The script has no Demon this app knows.');
  return { name, ids: ids.sort(byTeamThenName(lib)), skipped };
}

/** The rulebook's character counts for n players (5-15; Travellers aside). Fewer than 5: a Demon and Townsfolk, for testing. */
export function setupCounts(n) {
  if (n < 5) return { townsfolk: Math.max(0, n - 1), outsider: 0, minion: 0, demon: n > 0 ? 1 : 0 };
  const k = Math.min(n, 15);
  const minion = k >= 13 ? 3 : k >= 10 ? 2 : 1;
  const outsider = k <= 6 ? k - 5 : (k - 7) % 3;
  return { townsfolk: k - outsider - minion - 1, outsider, minion, demon: 1 };
}

/** Fisher-Yates with an injected rng (Math.random in the page, a seeded one in tests). */
export function shuffle(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** A random bag for n players from the script, at the rulebook's counts (setup abilities like the Baron's are the Storyteller's to apply). */
export function suggestCharacters(lib, script, n, rng = Math.random) {
  const want = setupCounts(n);
  const bag = [];
  for (const team of DEALT) bag.push(...shuffle(script.ids.filter(id => lib.chars[id]?.team === team), rng).slice(0, want[team]));
  return bag;
}

/** How a bag compares with the rulebook: counts per team, expected counts, and warnings to show. */
export function checkBag(lib, ids, n) {
  const counts = Object.fromEntries(DEALT.map(t => [t, 0]));
  const warnings = [];
  for (const id of ids) if (lib.chars[id]) counts[lib.chars[id].team]++;
  const expected = setupCounts(n);
  if (ids.length !== n) warnings.push(`${ids.length} characters for ${n} players: they must match.`);
  if (new Set(ids).size !== ids.length) warnings.push('A character is in the bag twice.');
  if (!counts.demon) warnings.push('There is no Demon.');
  for (const id of ids) if (lib.chars[id]?.setup) warnings.push(`${lib.chars[id].name} changes the setup: ${lib.chars[id].ability}`);
  return { counts, expected, warnings };
}

// ---------------------------------------------------------------- room and seats

/** A new nearby room: the lobby players join before the Storyteller deals. */
export function newRoom(storytellerName, code = 'BOTC') {
  return { code, game: GAME, status: 'lobby', storyteller: storytellerName, script: null, phase: null, day: 0, phaseId: null,
    players: [], nom: null, today: null, log: [], reveal: null, winner: null };
}

export function newSecret() {
  return { grim: {}, bluffs: [], reminders: [], asks: [], answers: {}, info: {}, notes: {}, seq: 0 };
}

/**
 * A player takes a seat (or renames theirs) while the room is in its lobby; a player already seated
 * once the game has started keeps their seat (a reconnect). undefined: nothing to change, as tx wants.
 */
export function addPlayer(room, clientId, name) {
  if (!room) return undefined;
  name = String(name || '').trim().slice(0, 24) || 'Player';
  const seat = room.players.find(p => p.clientId === clientId);
  if (seat) return seat.name === name || room.status !== 'lobby' ? undefined
    : { ...room, players: room.players.map(p => (p === seat ? { ...p, name } : p)) };
  if (room.status !== 'lobby') return undefined;
  return { ...room, players: [...room.players, { clientId, name, alive: true, ghost: true }] };
}

export function removePlayer(room, clientId) {
  if (room.status !== 'lobby') return room;
  return { ...room, players: room.players.filter(p => p.clientId !== clientId) };
}

/** The Storyteller moves a seat one place round the circle (seats are the table's order: neighbours matter). */
export function moveSeat(room, clientId, by) {
  const i = room.players.findIndex(p => p.clientId === clientId), j = i + by;
  if (i < 0 || j < 0 || j >= room.players.length) return room;
  const players = [...room.players];
  [players[i], players[j]] = [players[j], players[i]];
  return { ...room, players };
}

export function setScript(room, script) {
  if (room.status !== 'lobby') return room;
  return { ...room, script: { name: script.name, ids: [...script.ids] } };
}

export const nameOf = (room, id) => room.players.find(p => p.clientId === id)?.name ?? '?';
const living = room => room.players.filter(p => p.alive);
const logged = (room, line) => ({ ...room, log: [...room.log, line].slice(-80) });
const charName = (lib, id) => lib.chars[id]?.name ?? id;

// ---------------------------------------------------------------- dealing and the grimoire

/** Characters that are told they are someone else, and who to tell them by default. */
function defaultThinks(lib, scriptIds, character, used, rng) {
  const notInPlay = team => shuffle(scriptIds.filter(id => lib.chars[id]?.team === team && !used.has(id)), rng);
  if (character === 'drunk' || character === 'marionette') return notInPlay('townsfolk')[0] ?? character;
  if (character === 'lunatic') return shuffle(scriptIds.filter(id => lib.chars[id]?.team === 'demon'), rng)[0] ?? character;
  return character;
}

/**
 * Deal `ids` (one character per seated player) at random. Returns the grimoire half of a fresh
 * secret: { grim: { clientId: { character, thinks } }, bluffs } with the Drunk, Marionette and
 * Lunatic told a character they are not, and three not-in-play good characters as Demon bluffs.
 */
export function deal(room, ids, lib, rng = Math.random) {
  if (ids.length !== room.players.length) throw new Error(`${ids.length} characters for ${room.players.length} players`);
  for (const id of ids) if (!lib.chars[id]) throw new Error(`unknown character ${id}`);
  const scriptIds = room.script?.ids || ids;
  const dealt = shuffle(ids, rng);
  const used = new Set(ids);
  const grim = {};
  room.players.forEach((p, i) => {
    const thinks = defaultThinks(lib, scriptIds, dealt[i], used, rng);
    if (thinks !== dealt[i]) used.add(thinks);
    grim[p.clientId] = { character: dealt[i], thinks };
  });
  const bluffs = shuffle(scriptIds.filter(id => GOOD.has(lib.chars[id]?.team) && !used.has(id)), rng).slice(0, 3);
  return { ...newSecret(), grim, bluffs };
}

/** The Storyteller changes a player's character (an Imp's star-pass, a Pit-Hag); by default they are told it. */
export function setCharacter(secret, clientId, character, thinks = character) {
  if (!secret.grim[clientId]) return secret;
  return { ...secret, grim: { ...secret.grim, [clientId]: { character, thinks } } };
}

/** What a player is told they are, without changing what they are. */
export function setThinks(secret, clientId, thinks) {
  const g = secret.grim[clientId];
  if (!g) return secret;
  return { ...secret, grim: { ...secret.grim, [clientId]: { ...g, thinks } } };
}

export function setBluffs(secret, ids) { return { ...secret, bluffs: ids.filter(Boolean).slice(0, 3) }; }

/** Reminder tokens the grimoire can place: each character on the script's own, plus the global ones (Is The Drunk). */
export function reminderOptions(lib, ids) {
  const out = [];
  for (const id of ids) {
    const c = lib.chars[id];
    if (!c) continue;
    for (const token of [...new Set([...(c.reminders || []), ...(c.remindersGlobal || [])])]) if (token) out.push({ character: id, token });
  }
  return out;
}

export function addReminder(secret, clientId, character, token) {
  return { ...secret, reminders: [...secret.reminders, { on: clientId, character, token }] };
}

export function removeReminder(secret, index) {
  return { ...secret, reminders: secret.reminders.filter((_, i) => i !== index) };
}

/** What a player is told about themself: the character they think they are, with its ability. */
export function told(secret, clientId, lib) {
  const g = secret.grim[clientId];
  if (!g) return null;
  const c = lib.chars[g.thinks] || { id: g.thinks, name: g.thinks, team: '', ability: '' };
  return { id: c.id, name: c.name, team: c.team, edition: c.edition, ability: c.ability || '' };
}

// ---------------------------------------------------------------- phases

export function startGame(room) {
  if (room.status !== 'lobby') return room;
  return startNight(logged({ ...room, status: 'playing' }, `The game starts with ${room.players.length} players.`));
}

export function startNight(room) {
  if (room.status !== 'playing') return room;
  const n = room.day + 1;
  return logged({ ...room, phase: 'night', phaseId: `n${n}`, nom: null, today: null }, `Night ${n} falls.`);
}

/** Dawn: the players the Storyteller says died in the night die, and the day count goes up. */
export function startDay(room, deadIds = []) {
  if (room.status !== 'playing') return room;
  const day = room.day + 1;
  const dead = new Set(deadIds);
  const names = room.players.filter(p => dead.has(p.clientId) && p.alive).map(p => p.name);
  const next = { ...room, phase: 'day', day, phaseId: `d${day}`, nom: null,
    today: { n: 0, nominators: [], nominees: [], top: 0, block: null, executed: null },
    players: room.players.map(p => (dead.has(p.clientId) ? { ...p, alive: false } : p)) };
  return logged(next, `Day ${day}: ${names.length ? `${names.join(', ')} died in the night` : 'nobody died in the night'}.`);
}

/** A player dies or comes back; one who comes back has their ghost vote again. */
export function setAlive(room, clientId, alive) {
  const p = room.players.find(x => x.clientId === clientId);
  if (!p || p.alive === alive) return room;
  return logged({ ...room, players: room.players.map(x => (x === p ? { ...x, alive, ghost: true } : x)) },
    alive ? `${p.name} is alive again.` : `${p.name} dies.`);
}

/** The Storyteller gives back or takes a dead player's ghost vote. */
export function setGhost(room, clientId, ghost) {
  return { ...room, players: room.players.map(p => (p.clientId === clientId ? { ...p, ghost } : p)) };
}

// ---------------------------------------------------------------- nominations and votes

/** Votes needed to put someone on the block: half the living, rounded up. */
export const needed = room => Math.ceil(living(room).length / 2);

/** Why this nomination is not allowed today, or null. Each living player nominates once a day; each player is nominated once. */
export function nominationProblem(room, nominator, nominee) {
  if (room.status !== 'playing' || room.phase !== 'day' || !room.today) return 'Nominations happen by day.';
  if (room.nom?.open) return 'A vote is still open.';
  const a = room.players.find(p => p.clientId === nominator), b = room.players.find(p => p.clientId === nominee);
  if (!a || !b) return 'Pick two players.';
  if (!a.alive) return `${a.name} is dead and cannot nominate.`;
  if (room.today.nominators.includes(nominator)) return `${a.name} has already nominated today.`;
  if (room.today.nominees.includes(nominee)) return `${b.name} has already been nominated today.`;
  return null;
}

export function openNomination(room, nominator, nominee) {
  const why = nominationProblem(room, nominator, nominee);
  if (why) throw new Error(why);
  const n = room.today.n + 1;
  const today = { ...room.today, n, nominators: [...room.today.nominators, nominator], nominees: [...room.today.nominees, nominee] };
  const nom = { id: `${room.phaseId}v${n}`, nominator, nominee, open: true, needed: needed(room), yes: null, votes: null };
  return logged({ ...room, today, nom }, `${nameOf(room, nominator)} nominates ${nameOf(room, nominee)}.`);
}

/** Who may vote on the open nomination: the living, and the dead who still have their ghost vote. */
export const voters = room => (room.nom?.open ? room.players.filter(p => p.alive || p.ghost) : []);

/**
 * The vote closes: the yes votes become public, a dead player who voted yes spends their ghost
 * vote, and the nominee goes on the block if they beat today's best (a tie frees the block).
 */
export function closeNomination(room, secret) {
  const nom = room.nom;
  if (!nom?.open) return room;
  const ballots = secret.answers[nom.id] || {};
  const yes = voters(room).filter(p => ballots[p.clientId]?.yes === true).map(p => p.clientId);
  const spent = new Set(yes.filter(id => !room.players.find(p => p.clientId === id).alive));
  const votes = yes.length;
  let { top, block } = room.today;
  let outcome;
  if (votes >= nom.needed && votes > top) { top = votes; block = nom.nominee; outcome = `${nameOf(room, nom.nominee)} is about to die`; }
  else if (votes >= nom.needed && votes === top) { block = null; outcome = 'a tie: nobody is about to die'; }
  else outcome = votes < nom.needed ? `not enough (needs ${nom.needed})` : `fewer than ${top}`;
  const next = { ...room, nom: { ...nom, open: false, yes, votes }, today: { ...room.today, top, block },
    players: room.players.map(p => (spent.has(p.clientId) ? { ...p, ghost: false } : p)) };
  return logged(next, `${votes} vote${votes === 1 ? '' : 's'} to execute ${nameOf(room, nom.nominee)}${yes.length ? ` (${yes.map(id => nameOf(room, id)).join(', ')})` : ''}: ${outcome}.`);
}

/** The Storyteller executes a player (the one on the block, or anyone a ruling says). */
export function execute(room, clientId) {
  if (room.phase !== 'day' || !room.today || room.today.executed) return room;
  const p = room.players.find(x => x.clientId === clientId);
  if (!p) return room;
  return logged({ ...room, nom: room.nom?.open ? { ...room.nom, open: false } : room.nom, today: { ...room.today, executed: clientId },
    players: room.players.map(x => (x === p ? { ...x, alive: false } : x)) }, `${p.name} is executed${p.alive ? '' : ' (already dead)'}.`);
}

/** Game over: every true character becomes public. winner: 'good', 'evil' or ''. */
export function endGame(room, secret, winner = '') {
  const reveal = Object.fromEntries(room.players.map(p => [p.clientId, secret.grim[p.clientId] ? { ...secret.grim[p.clientId] } : null]));
  return logged({ ...room, status: 'over', phase: null, phaseId: null, nom: null, reveal, winner: winner || null },
    winner ? `Game over: ${winner} wins.` : 'Game over.');
}

// ---------------------------------------------------------------- the night order

/**
 * What a night step asks for, read from its reminder text: "chooses 2 players", "chooses a living
 * player", "chooses a player & a character", "(not yourself)" in the ability. null: nothing to
 * choose (an info step, or a step the Storyteller runs alone).
 */
export function parseAsk(text, ability = '') {
  const t = String(text || '').replace(/\*[^*]*\*/g, m => m.toLowerCase());
  const m = t.match(/\bchooses?\b([^.:]*)/i);
  if (!m) return null;
  const what = m[1].toLowerCase();
  const pm = what.match(/\b(a|an|1|2|3|two|three)\s+(alive |living |dead )?players?\b/);
  const word = { a: 1, an: 1, two: 2, three: 3 };
  const players = pm ? (word[pm[1]] || Number(pm[1])) : 0;
  const who = pm?.[2]?.startsWith('dead') ? 'dead' : pm?.[2] ? 'alive' : 'any';
  const character = /\bcharacter\b/.test(what);
  if (!players && !character) return null;
  const team = /\bdemon character\b/.test(what) ? 'demon' : /\bgood character\b/.test(what) ? 'good' : null;
  return { players, who, character, team, yesno: false, excludeSelf: /\(not yourself\)/i.test(ability) };
}

/**
 * Tonight's steps in night order, for the characters in play: [{ step, name, text, players,
 * ask }] where players are the clientIds who wake as that character (as what they think they are,
 * and as what they truly are) and ask the suggested prompt. Dusk, minion info, demon info (7 or more
 * players, first night) and dawn are steps too.
 */
export function nightSteps(room, secret, lib) {
  if (room.phase !== 'night') return [];
  const first = room.phaseId === 'n1';
  const order = first ? lib.firstNight : lib.otherNight;
  const key = first ? 'firstNightReminder' : 'otherNightReminder';
  const who = id => room.players.filter(p => { const g = secret.grim[p.clientId]; return g && (g.thinks === id || g.character === id); }).map(p => p.clientId);
  const steps = [];
  for (const id of order) {
    if (id === 'dusk') steps.push({ step: id, name: 'Dusk', text: 'Everyone closes their eyes.', players: [], ask: null });
    else if (id === 'dawn') steps.push({ step: id, name: 'Dawn', text: 'Wake everyone.', players: [], ask: null });
    else if (id === 'minioninfo' || id === 'demoninfo') {
      if (!first || room.players.length < 7) continue;
      const team = id === 'minioninfo' ? 'minion' : 'demon';
      const players = room.players.filter(p => lib.chars[secret.grim[p.clientId]?.character]?.team === team).map(p => p.clientId);
      steps.push({ step: id, name: id === 'minioninfo' ? 'Minion info' : 'Demon info',
        text: id === 'minioninfo' ? 'The Minions learn who the Demon is and each other.' : 'The Demon learns the Minions and three not-in-play characters to bluff.',
        players, ask: null });
    } else {
      const players = who(id);
      if (!players.length) continue;
      const c = lib.chars[id];
      steps.push({ step: id, name: c?.name || id, text: c?.[key] || '', players, ask: parseAsk(c?.[key], c?.ability) });
    }
  }
  return steps;
}

/** The first-night info for the evil team, as each of them is sent it (a snapshot: later bluff changes are not resent). */
export function sendEvilInfo(room, secret, lib, which) {
  const team = id => lib.chars[secret.grim[id]?.character]?.team;
  const ids = room.players.map(p => p.clientId);
  const demons = ids.filter(id => team(id) === 'demon'), minions = ids.filter(id => team(id) === 'minion');
  const info = { ...secret.info };
  if (which === 'minion') for (const id of minions) info[id] = { ...info[id], demons: demons.map(d => nameOf(room, d)), minions: minions.filter(m => m !== id).map(m => nameOf(room, m)) };
  if (which === 'demon') for (const id of demons) info[id] = { ...info[id], minions: minions.map(m => nameOf(room, m)), bluffs: [...secret.bluffs] };
  return { ...secret, info };
}

// ---------------------------------------------------------------- asks, answers, notes

/**
 * The Storyteller asks one player something now (a night step's choice, or anything else):
 * spec { title, text, players: 0-3, who: 'any'|'alive'|'dead', character, team, yesno, excludeSelf }.
 * It is open until the phase changes or the Storyteller cancels it.
 */
export function addAsk(room, secret, clientId, spec) {
  if (!room.phaseId || !room.players.some(p => p.clientId === clientId)) return secret;
  const seq = secret.seq + 1;
  const ask = { id: `${room.phaseId}.${seq}`, phaseId: room.phaseId, clientId, title: String(spec.title || 'The Storyteller asks').slice(0, 80),
    text: String(spec.text || '').slice(0, 300), players: Math.max(0, Math.min(3, Number(spec.players) || 0)), who: spec.who || 'any',
    character: !!spec.character, team: spec.team || null, yesno: !!spec.yesno, excludeSelf: !!spec.excludeSelf };
  if (!ask.players && !ask.character && !ask.yesno) ask.yesno = true;
  return { ...secret, seq, asks: [...secret.asks, ask] };
}

export function cancelAsk(secret, askId) { return { ...secret, asks: secret.asks.filter(a => a.id !== askId) }; }

const playerChoices = (room, clientId, who, excludeSelf) => room.players
  .filter(p => (who === 'alive' ? p.alive : who === 'dead' ? !p.alive : true) && !(excludeSelf && p.clientId === clientId))
  .map(p => ({ value: p.clientId, label: p.name }));

const characterChoices = (room, lib, team) => (room.script?.ids || [])
  .filter(id => !team || (team === 'good' ? GOOD.has(lib.chars[id]?.team) : lib.chars[id]?.team === team))
  .map(id => ({ value: id, label: charName(lib, id) }));

/**
 * What clientId is asked right now: [{ id, kind, title, text, players, character, yesno,
 * playerChoices, characterChoices }]. The Storyteller's asks for this phase; by day, the vote on an
 * open nomination (the living, and the dead with a ghost vote) and, while no vote is open, a
 * nomination of their own (the living who have not nominated today).
 */
export function promptsFor(room, secret, clientId, lib) {
  if (room?.status !== 'playing' || !secret.grim[clientId]) return [];
  const me = room.players.find(p => p.clientId === clientId);
  if (!me) return [];
  const out = [];
  for (const a of secret.asks) {
    if (a.clientId !== clientId || a.phaseId !== room.phaseId) continue;
    out.push({ id: a.id, kind: 'ask', title: a.title, text: a.text, players: a.players, character: a.character, yesno: a.yesno,
      playerChoices: a.players ? playerChoices(room, clientId, a.who, a.excludeSelf) : [],
      characterChoices: a.character ? characterChoices(room, lib, a.team) : [] });
  }
  if (room.phase === 'day' && room.today) {
    if (room.nom?.open) {
      if (me.alive || me.ghost) out.push({ id: room.nom.id, kind: 'vote', title: `Execute ${nameOf(room, room.nom.nominee)}?`,
        text: `${nameOf(room, room.nom.nominator)} nominated ${nameOf(room, room.nom.nominee)}. ${room.nom.needed} votes put them on the block.${me.alive ? '' : ' You are dead: voting yes spends your ghost vote.'}`,
        players: 0, character: false, yesno: true, playerChoices: [], characterChoices: [] });
    } else if (me.alive && !room.today.nominators.includes(clientId)) {
      const choices = room.players.filter(p => !room.today.nominees.includes(p.clientId)).map(p => ({ value: p.clientId, label: p.name }));
      if (choices.length) out.push({ id: `${room.phaseId}:nominate`, kind: 'nominate', title: 'Nominate', text: 'Ask the Storyteller to put a player up for execution. You may nominate once today.',
        players: 1, character: false, yesno: false, playerChoices: choices, characterChoices: [] });
    }
  }
  return out;
}

/**
 * A player's answer ({ id, choice } with choice { players?, character?, yes? }, or null to clear),
 * checked against what they are asked now. Returns the new secret, or a string saying why it was
 * refused. A player may change an answer while the prompt is open.
 */
export function submit(room, secret, clientId, { id, choice } = {}, lib) {
  const prompts = promptsFor(room, secret, clientId, lib);
  if (!prompts.length) return 'nothing to answer now';
  const p = prompts.find(x => x.id === id);
  if (!p) return 'that question is closed';
  let clean = null;
  if (choice != null) {
    if (typeof choice !== 'object') return 'not an answer';
    clean = {};
    if (p.players) {
      const picks = Array.isArray(choice.players) ? choice.players : [];
      if (picks.length !== p.players || new Set(picks).size !== picks.length) return `pick ${p.players} player${p.players === 1 ? '' : 's'}`;
      if (!picks.every(v => p.playerChoices.some(c => c.value === v))) return 'not one of the choices';
      clean.players = [...picks];
    }
    if (p.character) {
      if (!p.characterChoices.some(c => c.value === choice.character)) return 'not one of the characters';
      clean.character = choice.character;
    }
    if (p.yesno) {
      if (typeof choice.yes !== 'boolean') return 'answer yes or no';
      clean.yes = choice.yes;
    }
  }
  const forId = { ...(secret.answers[id] || {}) };
  if (clean) forId[clientId] = clean; else delete forId[clientId];
  return { ...secret, answers: { ...secret.answers, [id]: forId } };
}

/** An answer in words, for the Storyteller's screen. */
export function answerLabel(room, lib, choice) {
  if (!choice) return null;
  const parts = [];
  if (choice.players) parts.push(choice.players.map(id => nameOf(room, id)).join(' & '));
  if (choice.character) parts.push(charName(lib, choice.character));
  if (typeof choice.yes === 'boolean') parts.push(choice.yes ? 'Yes' : 'No');
  return parts.join(', ');
}

/** The Storyteller sends one player a private note: what they learn, a ruling, anything. */
export function addNote(secret, clientId, text) {
  text = String(text || '').trim().slice(0, 300);
  if (!text) return secret;
  return { ...secret, notes: { ...secret.notes, [clientId]: [...(secret.notes[clientId] || []), text].slice(-MAX_NOTES) } };
}

/** The private payload for one player: hub.setPrivate sends it to their phone alone. */
export function privateFor(room, secret, clientId, lib) {
  if (!room?.players.some(p => p.clientId === clientId)) return null;
  const prompts = promptsFor(room, secret, clientId, lib);
  const info = secret.info[clientId];
  return {
    you: told(secret, clientId, lib),
    evil: info ? { demons: info.demons || null, minions: info.minions || null,
      bluffs: info.bluffs ? info.bluffs.map(id => ({ id, name: charName(lib, id), ability: lib.chars[id]?.ability || '' })) : null } : null,
    prompts,
    chosen: Object.fromEntries(prompts.filter(p => secret.answers[p.id]?.[clientId]).map(p => [p.id, secret.answers[p.id][clientId]])),
    notes: secret.notes[clientId] || [],
  };
}

/**
 * The Storyteller's view of what is open: each ask with its answer, the open vote's ballots so far,
 * and the nominations players have asked for (still valid ones only).
 */
export function collected(room, secret, lib) {
  const asks = secret.asks.filter(a => a.phaseId === room.phaseId).map(a => {
    const c = secret.answers[a.id]?.[a.clientId] || null;
    return { id: a.id, clientId: a.clientId, name: nameOf(room, a.clientId), title: a.title, choice: c, label: answerLabel(room, lib, c) };
  });
  let vote = null;
  if (room.nom?.open) {
    const ballots = secret.answers[room.nom.id] || {};
    const vs = voters(room);
    vote = { yes: vs.filter(p => ballots[p.clientId]?.yes === true).map(p => p.name), no: vs.filter(p => ballots[p.clientId]?.yes === false).map(p => p.name),
      waiting: vs.filter(p => typeof ballots[p.clientId]?.yes !== 'boolean').map(p => p.name) };
  }
  const requests = [];
  if (room.phase === 'day' && room.today && !room.nom?.open) {
    for (const [id, c] of Object.entries(secret.answers[`${room.phaseId}:nominate`] || {})) {
      const nominee = c.players?.[0];
      if (nominee && !nominationProblem(room, id, nominee)) requests.push({ nominator: id, nominee, label: `${nameOf(room, id)} nominates ${nameOf(room, nominee)}` });
    }
  }
  return { asks, vote, requests };
}
