// Scripted answers for every decision the engine can wait for, so the seeded sim never waits. Players pick with a
// seeded RNG of their own (seeded from the game's seed, apart from the engine's, so a replay with recorded answers
// draws the same engine randomness); the Storyteller's default is true information, a registering trick one time in
// three, and the kinder of two options. A live game uses these only as a fallback the owner allows.
import {createRng, hashSeed} from './rng.js';
import {teamOf, isEvilTeam, findToken} from './grimoire.js';
import {PENDING_KINDS, optionKey} from './mechanics.js';

export function createScripted(seed) {
  const rng = createRng((hashSeed(seed) ^ 0x5eed5eed) >>> 0), memo = new Set();
  const answerFor = state => {
    const p = state.pending;
    if (!p) throw new Error('nothing pending');
    const f = KINDS[p.kind];
    if (!f) throw new Error(`no scripted answer for ${p.kind}`);
    return f(state, p, rng, memo);
  };
  return answerFor;
}

const evil = (state, i) => isEvilTeam(state.seats[i].team);
const knowsEvil = (state, i) => evil(state, i); // in Trouble Brewing the evil team know each other

// What the table suspects of each seat, from what has happened in the open and what the good information said.
export function suspicion(state) {
  const n = state.seats.length, score = Array(n).fill(0);
  for (const e of state.log) {
    if (e.type === 'nomination') score[e.target] += 1;
    if (e.type === 'told' && e.what === 'fortune-teller' && e.info === true) for (const p of e.picks) score[p] += 1.5;
    if (e.type === 'told' && e.what === 'empath' && e.info > 0) for (const p of e.neighbours) score[p] += 0.75 * e.info;
    if (e.type === 'told' && e.what === 'investigator' && e.info?.players) for (const p of e.info.players) score[p] += 1;
    if (e.type === 'told' && (e.what === 'undertaker' || e.what === 'ravenkeeper') && isEvilTeam(teamOf(state, e.info))) score[e.target] += 3;
  }
  for (const s of state.seats) if (!s.alive) score[s.index] = -1;
  return score;
}

const top = (rng, list, score) => {
  let best = null, bs = -Infinity;
  for (const x of list) {const v = score(x) + rng.next() * 1.5; if (v > bs) {bs = v; best = x}}
  return best;
};

const CHOOSE = {
  poisoner: (state, p, rng) => rng.pick(p.options.filter(x => !evil(state, x))) ?? rng.pick(p.options),
  imp: (state, p, rng) => rng.pick(p.options.filter(x => !evil(state, x))) ?? rng.pick(p.options),
  monk: (state, p, rng) => rng.pick(p.options),
  butler: (state, p, rng) => rng.pick(p.options),
  ravenkeeper: (state, p, rng) => {const s = suspicion(state); return top(rng, p.options.filter(x => x !== p.seat && state.seats[x].alive), x => s[x]) ?? rng.pick(p.options)},
  'fortune-teller': (state, p, rng) => {
    const s = suspicion(state), live = p.options.filter(x => x !== p.seat && state.seats[x].alive);
    const a = top(rng, live, x => s[x]) ?? p.options[0];
    const b = rng.pick(live.filter(x => x !== a)) ?? p.options.find(x => x !== a);
    return [a, b];
  },
  slayer: (state, p, rng) => {
    const s = suspicion(state), live = p.options.filter(x => x !== null && x !== p.seat);
    const t = top(rng, live, x => s[x]);
    return t != null && (s[t] >= 2.5 ? rng.chance(0.6) : rng.chance(0.1)) ? t : null;
  },
};

function dayAction(state, p, rng, memo, now) {
  if (!now) return null;
  for (const d of p.dayActions || []) {
    const k = `${state.day}:${d.by}:${d.ability}`;
    if (memo.has(k)) continue;
    memo.add(k);
    const f = CHOOSE[d.ability], v = f ? f(state, {seat: d.by, options: d.options}, rng) : null;
    if (v != null) return {by: d.by, ability: d.ability, target: v};
  }
  return null;
}

const KINDS = {
  'believed-role': (state, p, rng) => rng.pick(p.options),
  'red-herring': (state, p, rng) => rng.pick(p.options),
  'demon-bluffs': (state, p, rng) => rng.shuffle(p.options).slice(0, p.count),
  register: (state, p, rng) => (rng.chance(1 / 3) ? rng.pick(p.options.slice(1)) : p.options[0]),
  info: (state, p, rng) => {
    if (p.malfunctioning && rng.chance(0.5)) {
      const truth = new Set(p.truth.map(optionKey)), lies = p.options.filter(o => !truth.has(optionKey(o)));
      if (lies.length) return rng.pick(lies);
    }
    return rng.pick(p.truth.length ? p.truth : p.options);
  },
  'mayor-bounce': (state, p, rng) => (rng.chance(1 / 3) && p.options.length > 1 ? rng.pick(p.options.slice(1)) : p.options[0]),
  'star-pass': (state, p, rng) => rng.pick(p.options),
  choose: (state, p, rng) => {
    const f = CHOOSE[p.role];
    if (p.count) return f ? f(state, p, rng) : rng.shuffle(p.options).slice(0, p.count);
    return f ? f(state, p, rng) : rng.pick(p.options);
  },
  nomination: (state, p, rng, memo) => {
    const t = state.today, made = t.nominators.length;
    // a standing day action (the Slayer's shot) is weighed once a day: after the day's first vote, or before the day ends
    const shot = dayAction(state, p, rng, memo, t.votes.length > 0);
    if (shot) return shot;
    if (!rng.chance(made === 0 ? 0.9 : made === 1 ? 0.55 : 0.3)) return dayAction(state, p, rng, memo, true) ?? null;
    const live = p.options.filter(Boolean);
    const by = rng.pick([...new Set(live.map(o => o.by))]);
    const targets = live.filter(o => o.by === by && o.target !== by && state.seats[o.target].alive).map(o => o.target);
    if (!targets.length) return null;
    const s = suspicion(state);
    const target = knowsEvil(state, by) ? top(rng, targets.filter(x => !evil(state, x)), x => s[x]) ?? rng.pick(targets) : top(rng, targets, x => s[x]);
    return {by, target};
  },
  vote: (state, p, rng) => {
    const s = suspicion(state), out = {}, nomineeEvil = evil(state, p.nominee);
    const want = i => {
      if (i === p.nominee) return false;
      if (knowsEvil(state, i)) return nomineeEvil ? rng.chance(0.1) : rng.chance(0.75);
      const base = 0.35 + 0.15 * Math.max(0, s[p.nominee]);
      return rng.chance(Math.min(0.9, state.seats[i].alive ? base : base * 0.6));
    };
    for (const i of p.seats) out[i] = want(i);
    // a Butler follows the master's hand
    for (const i of p.seats) {
      const m = findToken(state, 'master', t => t.by === i);
      if (m && m.on in out) out[i] = out[m.on];
    }
    return out;
  },
};

export const SCRIPTED_KINDS = Object.keys(KINDS);
export const coversAllKinds = () => PENDING_KINDS.every(k => k in KINDS);
