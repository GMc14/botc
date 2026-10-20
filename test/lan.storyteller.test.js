// Run with: node --test test/*.test.js
//
// GMC-1658: a nearby Blood on the Clocktower game end to end over common/lan's LanRoom with an
// in-memory transport (as werewolf's test/lan.moderator.test.js does): the Storyteller's hub deals,
// each phone receives only the character it is told, the evil team gets its info, night asks go to
// the right phone and answers to the Storyteller alone, the day's nominations and votes run, a
// reconnecting phone gets everything back, and the end reveals all. Every message on each phone's
// wire is recorded to prove nothing private leaks. Needs the sibling common/ checkout
// (src/games/common), as the site does.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tick = () => new Promise(r => setTimeout(r, 5));
const data = f => require(path.join(__dirname, '..', 'resources', 'data', f));

// Two ends of one connection; messages arrive on a later task, like a network
function pair(log) {
    const ends = [{}, {}];
    let closed = false;
    ends.forEach((end, i) => {
        end.send = s => {
            if (closed) throw new Error('closed');
            if (i === 0) log.push(s);    // hub -> this phone
            setTimeout(() => { if (!closed) ends[1 - i].onmessage?.(s); }, 0);
        };
        end.close = () => { if (closed) return; closed = true; ends.forEach(e => e.onclose?.()); };
    });
    return ends;
}

test('a nearby game: private characters, evil info and asks per phone, answers to the Storyteller alone', async () => {
    const { LanRoom } = await import('../../common/lan/room.js');
    const R = await import('../lan/rules.js');
    const { NearbyStoryteller, act } = await import('../lan/storyteller.js');
    const lib = R.makeLib(data('roles.json'), data('nightsheet.json'));

    const hub = LanRoom.host(R.newRoom('Sam'));
    const st = new NearbyStoryteller(hub, lib, { rng: () => 0.999999 });   // characters go out in list order
    const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus'];
    const phones = {};
    for (const name of names) {
        const id = name.toLowerCase();
        const wire = [];
        const [h, p] = pair(wire);
        hub.attach(h);
        const peer = LanRoom.join(p, { clientId: id });
        await peer.read();
        await peer.tx(r => R.addPlayer(r, id, name));
        peer.subscribePrivate(() => {});
        phones[id] = { peer, wire, h };
    }
    await tick();
    assert.deepStrictEqual(hub.room.players.map(p => p.name), names);

    await st.setScript(R.editionScript(lib, 'tb'));
    st.deal(['imp', 'poisoner', 'drunk', 'fortuneteller', 'empath', 'monk', 'butler']);
    await tick();
    const told = id => phones[id].peer.private.you;
    assert.strictEqual(told('ann').id, 'imp');
    assert.strictEqual(told('bob').id, 'poisoner');
    const drunkThinks = st.secret.grim.cat.thinks;
    assert.strictEqual(told('cat').id, drunkThinks, 'the Drunk is told their Townsfolk');
    assert.strictEqual(lib.chars[drunkThinks].team, 'townsfolk');
    assert.ok(phones.ann.wire.some(s => s.includes('"id":"imp"')), 'the wire check can see a character when one is sent');
    for (const id of ['bob', 'cat', 'dan', 'eve', 'fay', 'gus']) assert.ok(!phones[id].wire.some(s => s.includes('"id":"imp"')), `${id}'s phone never gets the Imp`);
    for (const id of names.map(n => n.toLowerCase())) assert.ok(!phones[id].wire.some(s => s.includes('"id":"drunk"') || s.includes('"character":"drunk"')), `${id}'s phone never learns there is a Drunk`);
    assert.ok(!phones.cat.wire.some(s => s.includes('"thinks"') || s.includes('"grim"')), 'no grimoire field reaches a phone');

    await st.start();
    await tick();
    assert.strictEqual(phones.ann.peer.room.phase, 'night');
    const steps = st.steps().map(s => s.step);
    assert.ok(steps.indexOf('minioninfo') < steps.indexOf('demoninfo') && steps.indexOf('demoninfo') < steps.indexOf('poisoner'));
    assert.ok(steps.includes(drunkThinks) || !lib.firstNight.includes(drunkThinks), 'the Drunk wakes as what they think they are');

    st.evilInfo('minion');
    st.evilInfo('demon');
    await tick();
    assert.deepStrictEqual(phones.bob.peer.private.evil.demons, ['Ann']);
    assert.deepStrictEqual(phones.ann.peer.private.evil.minions, ['Bob']);
    const bluffs = phones.ann.peer.private.evil.bluffs.map(b => b.id);
    assert.deepStrictEqual(bluffs, st.secret.bluffs);
    for (const id of ['cat', 'dan', 'eve', 'fay', 'gus']) {
        assert.strictEqual(phones[id].peer.private.evil, null);
        assert.ok(!phones[id].wire.some(s => s.includes('"bluffs":[')), `${id} never sees the bluffs`);
        assert.ok(!phones[id].wire.some(s => s.includes('"demons":["Ann"]')), `${id} never learns the Demon`);
    }

    // The Storyteller wakes the Fortune Teller and the Poisoner with their suggested asks
    const ftStep = st.steps().find(s => s.step === 'fortuneteller');
    st.ask('dan', { title: 'Fortune Teller', ...ftStep.ask });
    st.ask('bob', { title: 'Poisoner', ...st.steps().find(s => s.step === 'poisoner').ask });
    await tick();
    const ft = phones.dan.peer.private.prompts;
    assert.deepStrictEqual(ft.map(p => [p.title, p.players]), [['Fortune Teller', 2]]);
    assert.deepStrictEqual(phones.eve.peer.private.prompts, [], 'the Empath is asked nothing');
    act(phones.dan.peer, ft[0].id, { players: ['ann', 'eve'] });
    act(phones.bob.peer, phones.bob.peer.private.prompts[0].id, { players: ['dan'] });
    act(phones.eve.peer, ft[0].id, { players: ['ann', 'bob'] });    // not Eve's question: refused
    await tick();
    assert.deepStrictEqual(st.collected().asks.map(a => [a.name, a.label]), [['Dan', 'Ann & Eve'], ['Bob', 'Dan']]);
    assert.deepStrictEqual(st.refused.map(r => [r.clientId, r.why]), [['eve', 'nothing to answer now']]);
    assert.deepStrictEqual(phones.dan.peer.private.chosen[ft[0].id], { players: ['ann', 'eve'] }, 'the phone sees its own answer back');
    assert.ok(!phones.dan.wire.some(s => s.includes('"players":["dan"]')), "the Poisoner's target never reaches the target's phone");
    assert.ok(!phones.ann.wire.some(s => s.includes('"players":["ann","eve"]')), "nor the Fortune Teller's picks the Demon's");

    // What the Fortune Teller learns is the Storyteller's call, sent as a note to Dan alone
    st.note('dan', 'Yes: one of them is the Demon.');
    st.addReminder('dan', 'poisoner', 'Poisoned');
    await tick();
    assert.deepStrictEqual(phones.dan.peer.private.notes, ['Yes: one of them is the Demon.']);
    for (const id of ['ann', 'bob', 'cat', 'eve', 'fay', 'gus']) assert.ok(!phones[id].wire.some(s => s.includes('one of them is the Demon')));
    for (const id of names.map(n => n.toLowerCase())) assert.ok(!phones[id].wire.some(s => s.includes('Poisoned')), 'reminder tokens stay in the grimoire');

    // Day 1: Gus died in the night; Ann asks to nominate Fay; the Storyteller opens it; everyone votes
    await st.day(['gus']);
    await tick();
    assert.strictEqual(phones.dan.peer.private.prompts.some(p => p.kind === 'ask'), false, "last night's asks have closed");
    const nom = phones.ann.peer.private.prompts.find(p => p.kind === 'nominate');
    act(phones.ann.peer, nom.id, { players: ['fay'] });
    await tick();
    assert.deepStrictEqual(st.collected().requests.map(r => r.label), ['Ann nominates Fay']);
    await st.nominate('ann', 'fay');
    await tick();
    const vid = hub.room.nom.id;
    assert.ok(phones.gus.peer.private.prompts.some(p => p.kind === 'vote'), 'the dead Gus has a ghost vote');
    for (const id of ['ann', 'bob', 'gus', 'eve']) act(phones[id].peer, vid, { yes: true });
    act(phones.cat.peer, vid, { yes: false });
    await tick();
    assert.deepStrictEqual(st.collected().vote.yes, ['Ann', 'Bob', 'Eve', 'Gus']);
    assert.strictEqual(phones.cat.peer.room.nom.yes, null, 'votes are not shown before the vote closes');
    await st.closeVote();
    await tick();
    assert.deepStrictEqual(phones.cat.peer.room.nom.yes, ['ann', 'bob', 'eve', 'gus'], 'the vote is public once closed');
    assert.strictEqual(phones.cat.peer.room.today.block, 'fay');
    assert.strictEqual(phones.cat.peer.room.players.find(p => p.clientId === 'gus').ghost, false, 'Gus spent his ghost vote');
    await st.execute('fay');
    await tick();
    assert.strictEqual(phones.ann.peer.room.players.find(p => p.clientId === 'fay').alive, false);

    // A phone drops and comes back: it gets the room and everything private again
    phones.bob.h.close();
    await tick();
    const wire = [];
    const [h2, p2] = pair(wire);
    hub.attach(h2);
    phones.bob.peer.private = undefined;
    await phones.bob.peer.reconnect(p2);
    await tick();
    assert.strictEqual(phones.bob.peer.private.you.id, 'poisoner');
    assert.deepStrictEqual(phones.bob.peer.private.evil.demons, ['Ann']);

    // Nobody's wire held the grimoire while the game ran
    for (const id of names.map(n => n.toLowerCase())) assert.ok(!phones[id].wire.some(s => s.includes('"reveal":{')), 'no reveal before the end');

    await st.end('good');
    await tick();
    assert.deepStrictEqual(phones.cat.peer.room.reveal.ann, { character: 'imp', thinks: 'imp' });
    assert.deepStrictEqual(phones.eve.peer.room.reveal.cat, { character: 'drunk', thinks: drunkThinks });
    assert.strictEqual(phones.eve.peer.room.winner, 'good');
});
