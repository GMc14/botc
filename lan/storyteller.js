/**
 * storyteller.js — the Storyteller's phone running a nearby Blood on the Clocktower game on a LanRoom
 * hub (../../common/lan/room.js). The hub broadcasts the public room; this keeps the grimoire, the
 * secret half of ./rules.js, in memory and sends each player their own payload with hub.setPrivate,
 * which goes to that player's connection only and again whenever they reconnect. Players answer with
 * peer.send({ t: 'act', id, choice }), which reaches hub.onMessage and nobody else.
 * See docs/adr/0001-nearby-storyteller.md (the same split as Werewolf's nearby moderator).
 *
 *   const st = new NearbyStoryteller(hub, lib);
 *   st.onChange(() => draw(st.room, st.secret));
 *   await st.setScript(script); await st.deal(ids); await st.start(); st.ask(id, spec); ...
 *
 * The grimoire lives only in this page: if it closes, the game ends (as any LAN table does when its
 * host leaves; Continue as host is GMC-2054).
 */

import * as R from './rules.js?v=20261020';

/** A player's side: answer a prompt (choice null clears the answer). */
export const act = (peer, id, choice) => peer.send({ t: 'act', id, choice });

export class NearbyStoryteller {
  constructor(hub, lib, { rng = Math.random } = {}) {
    this.hub = hub;
    this.lib = lib;
    this.rng = rng;
    this.secret = R.newSecret();
    this.sent = new Map();          // clientId -> the JSON last sent, so unchanged payloads are not resent
    this.listeners = new Set();
    this.refused = [];              // [{ clientId, why }] the last few refused answers, for the Storyteller
    hub.onMessage((clientId, msg) => this.receive(clientId, msg));
    hub.subscribe(() => this.publish());
  }

  get room() { return this.hub.room; }

  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  changed() { this.listeners.forEach(cb => cb(this)); }

  /** Send every seated player their payload if it changed; drop payloads of players who left. */
  publish() {
    const room = this.room;
    const seated = new Set((room?.players || []).map(p => p.clientId));
    for (const id of [...this.sent.keys()]) if (!seated.has(id)) { this.sent.delete(id); this.hub.setPrivate(id, null); }
    for (const id of seated) {
      const payload = R.privateFor(room, this.secret, id, this.lib);
      const json = JSON.stringify(payload);
      if (this.sent.get(id) === json) continue;
      this.sent.set(id, json);
      this.hub.setPrivate(id, payload);
    }
    this.changed();
  }

  receive(clientId, msg) {
    if (!msg || msg.t !== 'act') return;
    const next = R.submit(this.room, this.secret, clientId, msg, this.lib);
    if (typeof next === 'string') {
      this.refused = [...this.refused, { clientId, why: next }].slice(-5);
      this.changed();
      return;
    }
    this.secret = next;
    this.publish();
  }

  /** Change the grimoire and resend whatever payloads that changes. */
  update(fn) {
    this.secret = fn(this.secret);
    this.publish();
  }

  commit(fn) { return this.hub.tx(fn); }

  setScript(script) { return this.commit(r => R.setScript(r, script)); }

  /** Deal ids to the seated players at random and tell each what they think they are (still in the lobby). */
  deal(ids) {
    this.secret = R.deal(this.room, ids, this.lib, this.rng);
    this.publish();
  }

  setCharacter(clientId, character, thinks) { this.update(s => R.setCharacter(s, clientId, character, thinks)); }
  setThinks(clientId, thinks) { this.update(s => R.setThinks(s, clientId, thinks)); }
  setBluffs(ids) { this.update(s => R.setBluffs(s, ids)); }
  addReminder(clientId, character, token) { this.update(s => R.addReminder(s, clientId, character, token)); }
  removeReminder(index) { this.update(s => R.removeReminder(s, index)); }
  ask(clientId, spec) { this.update(s => R.addAsk(this.room, s, clientId, spec)); }
  cancelAsk(askId) { this.update(s => R.cancelAsk(s, askId)); }
  note(clientId, text) { this.update(s => R.addNote(s, clientId, text)); }
  evilInfo(which) { this.update(s => R.sendEvilInfo(this.room, s, this.lib, which)); }

  start() { return this.commit(r => R.startGame(r)); }
  night() { return this.commit(r => R.startNight(r)); }
  day(deadIds) { return this.commit(r => R.startDay(r, deadIds)); }
  setAlive(clientId, alive) { return this.commit(r => R.setAlive(r, clientId, alive)); }
  setGhost(clientId, ghost) { return this.commit(r => R.setGhost(r, clientId, ghost)); }
  remove(clientId) { return this.commit(r => R.removePlayer(r, clientId)); }
  move(clientId, by) { return this.commit(r => R.moveSeat(r, clientId, by)); }
  nominate(nominator, nominee) { return this.commit(r => R.openNomination(r, nominator, nominee)); }
  closeVote() { return this.commit(r => R.closeNomination(r, this.secret)); }
  execute(clientId) { return this.commit(r => R.execute(r, clientId)); }
  end(winner) { return this.commit(r => R.endGame(r, this.secret, winner)); }

  steps() { return R.nightSteps(this.room, this.secret, this.lib); }
  collected() { return R.collected(this.room, this.secret, this.lib); }
}
