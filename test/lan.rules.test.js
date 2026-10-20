// Run with: node --test test/*.test.js
//
// GMC-1658: nearby play's pure rules (lan/rules.js) on the real character data (resources/data):
// scripts, setup counts, dealing with the Drunk and bluffs, the night order, asks and answers,
// nominations with ghost votes, and what each player's private payload holds.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const data = f => require(path.join(__dirname, '..', 'resources', 'data', f));
const load = async () => {
    const R = await import('../lan/rules.js');
    return { R, lib: R.makeLib(data('roles.json'), data('nightsheet.json')) };
};

// rng that makes shuffle keep the order: deal() hands characters out in list order
const keep = () => 0.999999;

function table(R, names, script) {
    let room = R.newRoom('Sam');
    names.forEach((n, i) => { room = R.addPlayer(room, `p${i}`, n); });
    return R.setScript(room, script);
}

test('Trouble Brewing: the edition script and the rulebook counts', async () => {
    const { R, lib } = await load();
    const tb = R.editionScript(lib, 'tb');
    assert.strictEqual(tb.name, 'Trouble Brewing');
    assert.strictEqual(tb.ids.length, 22, '13 Townsfolk, 4 Outsiders, 4 Minions, 1 Demon; no Travellers');
    assert.ok(tb.ids.includes('imp') && tb.ids.includes('drunk') && !tb.ids.includes('thief'));
    assert.deepStrictEqual(R.setupCounts(5), { townsfolk: 3, outsider: 0, minion: 1, demon: 1 });
    assert.deepStrictEqual(R.setupCounts(9), { townsfolk: 5, outsider: 2, minion: 1, demon: 1 });
    assert.deepStrictEqual(R.setupCounts(12), { townsfolk: 7, outsider: 2, minion: 2, demon: 1 });
    assert.deepStrictEqual(R.setupCounts(15), { townsfolk: 9, outsider: 2, minion: 3, demon: 1 });
    const bag = R.suggestCharacters(lib, tb, 8, () => 0.3);
    assert.strictEqual(bag.length, 8);
    assert.deepStrictEqual(R.checkBag(lib, bag, 8).counts, { townsfolk: 5, outsider: 1, minion: 1, demon: 1 });
    const warn = R.checkBag(lib, ['baron', 'imp', 'chef', 'chef'], 5).warnings.join(' | ');
    assert.match(warn, /4 characters for 5 players/);
    assert.match(warn, /twice/);
    assert.match(warn, /Baron changes the setup/);
});

test('a pasted script: ids in any spelling, _meta name, unknowns and Travellers skipped', async () => {
    const { R, lib } = await load();
    const s = R.parseScript(lib, JSON.stringify([{ id: '_meta', name: 'Tiny' }, 'Fortune Teller', { id: 'fortune_teller' }, 'imp', 'poisoner', 'thief', 'my_homebrew']));
    assert.strictEqual(s.name, 'Tiny');
    assert.deepStrictEqual(s.ids, ['fortuneteller', 'poisoner', 'imp']);
    assert.deepStrictEqual(s.skipped, ['thief', 'my_homebrew']);
    assert.throws(() => R.parseScript(lib, '["chef"]'), /no Demon/);
    assert.throws(() => R.parseScript(lib, 'nope'), /not script JSON/);
});

test('deal: the Drunk is told a Townsfolk not in play, bluffs are good and not in play', async () => {
    const { R, lib } = await load();
    const room = table(R, ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'], R.editionScript(lib, 'tb'));
    const secret = R.deal(room, ['imp', 'poisoner', 'drunk', 'empath', 'chef'], lib, keep);
    assert.deepStrictEqual(secret.grim.p0, { character: 'imp', thinks: 'imp' });
    const drunk = secret.grim.p2;
    assert.strictEqual(drunk.character, 'drunk');
    assert.strictEqual(lib.chars[drunk.thinks].team, 'townsfolk');
    assert.ok(!['empath', 'chef'].includes(drunk.thinks), 'the Drunk thinks a character not in play');
    assert.strictEqual(secret.bluffs.length, 3);
    for (const b of secret.bluffs) {
        assert.ok(R.GOOD.has(lib.chars[b].team));
        assert.ok(!['drunk', 'empath', 'chef', drunk.thinks].includes(b), `${b} is not in play`);
    }
    assert.strictEqual(R.told(secret, 'p2', lib).id, drunk.thinks, 'the Drunk is told their Townsfolk');
    assert.throws(() => R.deal(room, ['imp'], lib), /1 characters for 5 players/);
});

test('the night order: first night steps for the characters in play, with suggested asks', async () => {
    const { R, lib } = await load();
    const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus'];
    let room = table(R, names, R.editionScript(lib, 'tb'));
    const secret = R.deal(room, ['imp', 'poisoner', 'fortuneteller', 'butler', 'empath', 'monk', 'chef'], lib, keep);
    room = R.startGame(room);
    assert.strictEqual(room.phaseId, 'n1');
    const steps = R.nightSteps(room, secret, lib);
    assert.deepStrictEqual(steps.map(s => s.step), ['dusk', 'minioninfo', 'demoninfo', 'poisoner', 'chef', 'empath', 'fortuneteller', 'butler', 'dawn'],
        'first night order; the Monk and the Imp do not wake on night 1');
    assert.deepStrictEqual(steps.find(s => s.step === 'minioninfo').players, ['p1']);
    assert.deepStrictEqual(steps.find(s => s.step === 'demoninfo').players, ['p0']);
    assert.deepStrictEqual(steps.find(s => s.step === 'fortuneteller').ask, { players: 2, who: 'any', character: false, team: null, yesno: false, excludeSelf: false });
    assert.strictEqual(steps.find(s => s.step === 'butler').ask.excludeSelf, true, 'the Butler cannot choose themself');
    assert.strictEqual(steps.find(s => s.step === 'chef').ask, null, 'info steps ask nothing');
    room = R.startNight(R.startDay(room));
    assert.deepStrictEqual(R.nightSteps(room, secret, lib).map(s => s.step), ['dusk', 'poisoner', 'monk', 'imp', 'empath', 'fortuneteller', 'butler', 'dawn']);
    assert.deepStrictEqual(R.parseAsk('The Cerenovus chooses a player & a character. :reminder:'), { players: 1, who: 'any', character: true, team: null, yesno: false, excludeSelf: false });
    assert.strictEqual(R.parseAsk('The Chambermaid chooses 2 living players.').who, 'alive');
    assert.strictEqual(R.parseAsk('The Summoner chooses a player & a demon character.').team, 'demon');
});

test('the Drunk wakes as the Townsfolk they think they are', async () => {
    const { R, lib } = await load();
    let room = table(R, ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'], R.editionScript(lib, 'tb'));
    let secret = R.deal(room, ['imp', 'poisoner', 'drunk', 'empath', 'chef'], lib, keep);
    secret = R.setThinks(secret, 'p2', 'fortuneteller');
    room = R.startGame(room);
    const ft = R.nightSteps(room, secret, lib).find(s => s.step === 'fortuneteller');
    assert.deepStrictEqual(ft.players, ['p2']);
});

test('asks: only the asked player sees them, answers are checked, and they close with the phase', async () => {
    const { R, lib } = await load();
    let room = R.startGame(table(R, ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'], R.editionScript(lib, 'tb')));
    let secret = R.deal(room, ['imp', 'poisoner', 'fortuneteller', 'butler', 'chef'], lib, keep);
    secret = R.addAsk(room, secret, 'p2', { title: 'Fortune Teller', players: 2 });
    secret = R.addAsk(room, secret, 'p3', { title: 'Butler', players: 1, excludeSelf: true });
    const ft = R.promptsFor(room, secret, 'p2', lib);
    assert.deepStrictEqual(ft.map(p => p.id), ['n1.1']);
    assert.strictEqual(ft[0].playerChoices.length, 5);
    assert.deepStrictEqual(R.promptsFor(room, secret, 'p0', lib), [], 'nobody else is asked');
    assert.ok(!R.promptsFor(room, secret, 'p3', lib)[0].playerChoices.some(c => c.value === 'p3'));

    assert.strictEqual(R.submit(room, secret, 'p2', { id: 'n1.1', choice: { players: ['p0'] } }, lib), 'pick 2 players');
    assert.strictEqual(R.submit(room, secret, 'p2', { id: 'n1.1', choice: { players: ['p0', 'p0'] } }, lib), 'pick 2 players');
    assert.strictEqual(R.submit(room, secret, 'p2', { id: 'n1.2', choice: { players: ['p0'] } }, lib), 'that question is closed', "the Butler's ask is not the Fortune Teller's");
    assert.strictEqual(R.submit(room, secret, 'p3', { id: 'n1.2', choice: { players: ['p3'] } }, lib), 'not one of the choices');
    assert.strictEqual(R.submit(room, secret, 'p0', { id: 'n1.1', choice: { players: ['p1', 'p2'] } }, lib), 'nothing to answer now');
    secret = R.submit(room, secret, 'p2', { id: 'n1.1', choice: { players: ['p0', 'p4'] } }, lib);
    assert.deepStrictEqual(secret.answers['n1.1'], { p2: { players: ['p0', 'p4'] } });
    assert.deepStrictEqual(R.collected(room, secret, lib).asks.map(a => [a.name, a.label]), [['Cat', 'Ann & Eve'], ['Dan', null]]);

    const withChar = R.addAsk(room, secret, 'p4', { title: 'Pick', character: true });
    const pc = R.promptsFor(room, withChar, 'p4', lib)[0];
    assert.ok(pc.characterChoices.some(c => c.value === 'washerwoman'));
    assert.strictEqual(R.submit(room, withChar, 'p4', { id: pc.id, choice: { character: 'vortox' } }, lib), 'not one of the characters', 'only characters on the script');

    room = R.startDay(room);
    assert.deepStrictEqual(R.promptsFor(room, secret, 'p2', lib).map(p => p.kind), ['nominate'], "night 1's ask is gone by day");
});

test('day: nominations, a public vote, ghost votes, the block and execution', async () => {
    const { R, lib } = await load();
    let room = R.startGame(table(R, ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'], R.editionScript(lib, 'tb')));
    let secret = R.deal(room, ['imp', 'poisoner', 'fortuneteller', 'butler', 'chef'], lib, keep);
    room = R.startDay(room, ['p4']);
    assert.strictEqual(room.players[4].alive, false);
    assert.strictEqual(room.players[4].ghost, true);
    assert.deepStrictEqual(R.promptsFor(room, secret, 'p4', lib), [], 'the dead do not nominate');

    // Ann asks to nominate Bob from her phone; the Storyteller opens it
    secret = R.submit(room, secret, 'p0', { id: 'd1:nominate', choice: { players: ['p1'] } }, lib);
    assert.deepStrictEqual(R.collected(room, secret, lib).requests.map(r => r.label), ['Ann nominates Bob']);
    room = R.openNomination(room, 'p0', 'p1');
    assert.strictEqual(room.nom.needed, 2, 'half of 4 living');
    assert.throws(() => R.openNomination(room, 'p2', 'p3'), /still open/);
    const vote = R.promptsFor(room, secret, 'p4', lib);
    assert.deepStrictEqual(vote.map(p => p.kind), ['vote'], 'a dead player with a ghost vote may vote');
    for (const [id, yes] of [['p0', true], ['p4', true], ['p2', false]]) secret = R.submit(room, secret, id, { id: room.nom.id, choice: { yes } }, lib);
    assert.deepStrictEqual(R.collected(room, secret, lib).vote, { yes: ['Ann', 'Eve'], no: ['Cat'], waiting: ['Bob', 'Dan'] });
    room = R.closeNomination(room, secret);
    assert.deepStrictEqual(room.nom.yes, ['p0', 'p4']);
    assert.strictEqual(room.today.block, 'p1');
    assert.strictEqual(room.players[4].ghost, false, 'Eve spent her ghost vote');

    assert.strictEqual(R.nominationProblem(room, 'p0', 'p2'), 'Ann has already nominated today.');
    assert.strictEqual(R.nominationProblem(room, 'p2', 'p1'), 'Bob has already been nominated today.');
    assert.strictEqual(R.nominationProblem(room, 'p4', 'p2'), 'Eve is dead and cannot nominate.');
    room = R.openNomination(room, 'p2', 'p3');
    assert.deepStrictEqual(R.promptsFor(room, secret, 'p4', lib), [], 'no ghost vote left: Eve cannot vote again');
    for (const id of ['p1', 'p2']) secret = R.submit(room, secret, id, { id: room.nom.id, choice: { yes: true } }, lib);
    room = R.closeNomination(room, secret);
    assert.strictEqual(room.today.block, null, 'a tie frees the block');
    assert.match(room.log.at(-1), /a tie/);

    room = R.execute(room, 'p1');
    assert.strictEqual(room.players[1].alive, false);
    assert.strictEqual(R.execute(room, 'p2'), room, 'one execution a day');
    room = R.endGame(room, secret, 'good');
    assert.deepStrictEqual(room.reveal.p0, { character: 'imp', thinks: 'imp' });
    assert.strictEqual(room.winner, 'good');
});

test('privateFor: your character, your evil info, your asks and notes, nobody else\'s', async () => {
    const { R, lib } = await load();
    const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus'];
    let room = table(R, names, R.editionScript(lib, 'tb'));
    let secret = R.deal(room, ['imp', 'poisoner', 'drunk', 'empath', 'chef', 'monk', 'saint'], lib, keep);
    room = R.startGame(room);
    secret = R.sendEvilInfo(room, secret, lib, 'minion');
    secret = R.sendEvilInfo(room, secret, lib, 'demon');
    secret = R.addNote(secret, 'p3', 'You learn 1.');
    secret = R.addReminder(secret, 'p3', 'poisoner', 'Poisoned');
    const imp = R.privateFor(room, secret, 'p0', lib);
    assert.strictEqual(imp.you.id, 'imp');
    assert.deepStrictEqual(imp.evil.minions, ['Bob']);
    assert.deepStrictEqual(imp.evil.bluffs.map(b => b.id), secret.bluffs);
    const pois = R.privateFor(room, secret, 'p1', lib);
    assert.deepStrictEqual(pois.evil, { demons: ['Ann'], minions: [], bluffs: null });
    const drunk = R.privateFor(room, secret, 'p2', lib);
    assert.notStrictEqual(drunk.you.id, 'drunk');
    assert.strictEqual(drunk.evil, null);
    const empath = R.privateFor(room, secret, 'p3', lib);
    assert.deepStrictEqual(empath.notes, ['You learn 1.']);
    assert.ok(!JSON.stringify(empath).includes('Poisoned'), 'reminder tokens stay in the grimoire');
    for (const id of ['p2', 'p3', 'p4', 'p5', 'p6']) {
        const s = JSON.stringify(R.privateFor(room, secret, id, lib));
        assert.ok(!s.includes('"id":"imp"') && !s.includes('"id":"poisoner"'), `${id} learns no evil character`);
        assert.ok(!s.includes('"bluffs":['), `${id} gets no bluffs`);
    }
    assert.strictEqual(R.privateFor(room, secret, 'nobody', lib), null);
    const pub = JSON.stringify({ ...room, script: null });
    assert.ok(!pub.includes('"character"') && !/imp|poisoner|drunk|empath/i.test(pub), 'the public room (the script aside) names no character while the game runs');
});
