// Scripted day talk, and a whole scripted game played through the api (src/game/api.js): what `npm run sim` plays.
//
// createScriptedTalk(seed) gives turn(game, seat): one seat's turn of a speaking round, through the api only. A seat in a room
// may first come back to the Square; a seat at the Square may, now and then, take someone to a room (#28): an evil seat an evil
// ally, a good seat the player it suspects most. Then it says a line where it is (or, rarely, passes). The talk draws from its
// own seeded RNG, apart from the engine's and from the scripted answers', so the talk never changes a decision: the same seed
// gives the same night choices, nominations, votes and winner with or without rooms.
//
// playScripted(game, seed) plays a game to its end through the api: the scripted answers (src/game/scripted.js) for every
// decision, the Storyteller's with a reason, and the scripted talk for every speaking round.
import {createRng, hashSeed} from './rng.js';
import {isEvilTeam} from './grimoire.js';
import {createScripted, suspicion} from './scripted.js';
import * as api from './api.js';

export const TALK = {goChance: 0.1, allyChance: 0.25, leaveChance: 0.35, passChance: 0.08};

export function createScriptedTalk(seed) {
  const rng = createRng((hashSeed(seed) ^ 0x7a1c7a1c) >>> 0);
  const evil = (game, i) => isEvilTeam(game.seats[i].team);
  const name = (game, i) => game.seats[i].name;

  // Take a partner to a room: the smallest room with space for two, one of them at random when several fit.
  function goWith(game, seat) {
    const w = api.where(game, seat), atSquare = w.square.filter(i => i !== seat && game.seats[i].alive);
    if (!w.open || !atSquare.length) return false;
    let partner = null;
    if (evil(game, seat)) {
      const allies = atSquare.filter(i => evil(game, i));
      if (allies.length && rng.chance(TALK.allyChance)) partner = rng.pick(allies);
    } else if (rng.chance(TALK.goChance)) {
      const s = suspicion(game);
      let best = -Infinity;
      for (const i of atSquare) {const v = s[i] + rng.next(); if (v > best) {best = v; partner = i}}
    }
    if (partner == null) return false;
    const fits = w.rooms.filter(r => r.free >= 2);
    if (!fits.length) return false;
    const small = fits.filter(r => r.size === Math.min(...fits.map(x => x.size)));
    api.invite(game, seat, partner, rng.pick(small).id);
    return true;
  }

  function lineFor(game, seat) {
    const w = api.where(game, seat), c = game.clock, at = `Day ${game.day}, round ${c.round}`;
    const s = suspicion(game), others = game.seats.filter(x => x.alive && x.index !== seat).map(x => x.index);
    let sus = null, best = -Infinity;
    for (const i of others) {const v = s[i] + rng.next() * 0.5; if (v > best) {best = v; sus = i}}
    if (w.place != null) {
      const room = w.rooms.find(r => r.id === w.place).name, mate = w.with.length ? name(game, rng.pick(w.with)) : null;
      if (evil(game, seat)) return `${at}, in ${room}: ${sus != null && !evil(game, sus) ? `we steer them toward ${name(game, sus)}` : 'we keep our heads down'}.`;
      return `${at}, in ${room}: ${mate ? `${mate}, tell me straight what you know` : 'nobody else here, so I think aloud'}${sus != null ? `; I doubt ${name(game, sus)}` : ''}.`;
    }
    return sus != null && rng.chance(0.6) ? `${at}: I have my eye on ${name(game, sus)}.` : `${at}: nothing new from me yet.`;
  }

  return function turn(game, seat) {
    if (api.where(game, seat).place != null && rng.chance(TALK.leaveChance)) api.leave(game, seat);
    else if (api.where(game, seat).place == null) goWith(game, seat);
    if (rng.chance(TALK.passChance)) return api.pass(game, seat);
    try {return api.say(game, seat, lineFor(game, seat))}
    catch (e) {if (e instanceof api.ApiError) return api.pass(game, seat); throw e}
  };
}

export const SCRIPTED_REASON_PREFIX = 'scripted';

// A whole game through the api. onDecision(pending, value, game) is called before each engine decision is answered.
export function playScripted(game, seed = game.config.seed, {onDecision, maxSteps = 50000} = {}) {
  const answerer = createScripted(seed), turn = createScriptedTalk(seed), ST = api.ST;
  for (let n = 0; n < maxSteps && !game.winner; n++) {
    api.pendingFor(game, ST); // brings the day clock up to date
    const p = game.pending;
    if (!p) throw new Error('no decision pending and no winner');
    if (p.seat === ST) {const v = answerer(game); onDecision?.(p, v, game); api.answer(game, ST, v, `${SCRIPTED_REASON_PREFIX} ${p.kind}`); continue}
    if (p.kind === 'choose') {const v = answerer(game); onDecision?.(p, v, game); api.answer(game, p.seat, v); continue}
    if (p.kind === 'vote') {const v = answerer(game); onDecision?.(p, v, game); for (const i of p.seats) api.vote(game, i, v[i]); continue}
    if (p.kind === 'nomination' && !game.clock.nominationsOpen) {
      const next = game.seats.find(s => s.alive && !game.clock.spoke.includes(s.index));
      turn(game, next.index);
      continue;
    }
    if (p.kind === 'nomination') {
      const v = answerer(game);
      onDecision?.(p, v, game);
      if (v === null) {for (const s of game.seats) if (game.phase === 'day' && game.pending === p && s.alive) api.pass(game, s.index); continue}
      if (v.ability) {(api.pendingFor(game, v.by)?.standing ? api.answer : api.dayAction)(game, v.by, v.target); continue}
      api.nominate(game, v.by, v.target);
      continue;
    }
    throw new Error(`no scripted answer for ${p.kind}`);
  }
  if (!game.winner) throw new Error(`no winner after ${maxSteps} steps`);
  return game;
}
