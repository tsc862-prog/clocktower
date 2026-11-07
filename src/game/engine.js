// The phases: setup, first night, day (dawn, day actions, nominations and votes, dusk), night, ... until a winner.
// The game is a generator that stops at every decision (state.pending) and resumes with answer(state, value). It
// never chooses for a seat or the Storyteller; scripted.js does, for the sim. No role id appears in this file.
import {roleOf, alive, aliveCount, addToken, removeTokens, log, tell, grimoire} from './grimoire.js';
import {ask, execute, checkWin, optionKey} from './mechanics.js';
import {HOOKS, TELLINGS} from './abilities.js';
import {createState} from './state.js';

const live = new WeakMap();

// Start a fresh state's game; it runs to the first decision.
export function start(state) {
  const gen = run(state);
  live.set(state, gen);
  settle(state, gen.next());
  return state;
}

function settle(state, r) {
  state.pending = r.done ? null : r.value;
}

// Answer the pending decision. The value must be one of pending.options (or, with pending.count, an array of that
// many distinct options; for a vote, {seat: true|false} for every seat in pending.seats). Throws on anything else.
// Returns the live state: the same object, unless the state was copied (JSON) and had to be replayed.
export function answer(state, value) {
  if (!state.pending) throw new Error(state.winner ? 'the game is over' : 'no decision is pending');
  if (!live.has(state)) return answer(replay(state), value);
  const v = validate(state.pending, value);
  state.answers.push(v);
  settle(state, live.get(state).next(v));
  return state;
}

// Rebuild a live game from a plain copy: the same config and the same answers give the same game.
export function replay(copy, script) {
  const state = start(createState({seed: copy.config.seed, seats: copy.config.seats, roles: copy.config.roles, ...(script ? {script} : {})}));
  for (const a of copy.answers) answer(state, a);
  return state;
}

export function validate(p, value) {
  if (p.kind === 'vote') {
    if (!value || typeof value !== 'object') throw new Error('a vote is {seat: true|false} for every voter');
    const out = {};
    for (const s of p.seats) {
      if (typeof value[s] !== 'boolean') throw new Error(`vote: ${s} has no yes or no`);
      out[s] = value[s];
    }
    return out;
  }
  const keys = new Map(p.options.map(o => [optionKey(norm(o)), o]));
  const pick = v => {
    const k = optionKey(norm(v));
    if (!keys.has(k)) throw new Error(`${p.kind}${p.role ? ' (' + p.role + ')' : ''}: ${optionKey(v)} is not an option`);
    return keys.get(k);
  };
  if (p.count) {
    if (!Array.isArray(value) || value.length !== p.count) throw new Error(`${p.kind}: pick exactly ${p.count}`);
    const out = value.map(pick);
    if (new Set(out.map(optionKey)).size !== out.length) throw new Error(`${p.kind}: the picks must differ`);
    return out;
  }
  return pick(value === undefined ? undefined : value);
}

// Two named players in either order are the same statement.
const norm = v => (v && typeof v === 'object' && Array.isArray(v.players) ? {...v, players: [...v.players].sort((a, b) => a - b)} : v);

function* run(state) {
  yield* setup(state);
  while (!state.winner) {
    yield* night(state);
    if (state.winner) break;
    yield* day(state);
  }
  state.phase = 'end';
  state.step = null;
  log(state, 'game-over', {winner: state.winner});
}

function* setup(state) {
  state.phase = 'setup';
  state.step = 'deal';
  log(state, 'deal', {roles: state.seats.map(s => s.role)});
  // A disguised role (the Drunk) is told it is a role of its disguise team that is not in play.
  for (const s of state.seats) {
    const r = roleOf(state, s.role);
    if (!r.disguise) continue;
    const taken = new Set(state.seats.flatMap(x => [x.role, x.believed]));
    const options = state.script.roles.filter(x => x.team === r.disguise && !taken.has(x.id)).map(x => x.id);
    const v = yield ask(state, {kind: 'believed-role', seat: 'storyteller', subject: s.index, role: s.role, options,
      question: `${s.name} is the ${r.name}: which ${r.disguise} role do they believe they are?`});
    s.believed = v;
    addToken(state, s.index, {token: `is-the-${s.role}`, role: s.role, value: v, keep: true});
  }
  for (const s of state.seats) {
    const h = HOOKS[s.believed]?.setup;
    if (h) yield* h(state, s.index);
  }
  for (const s of state.seats) tell(state, s.index, 'role', {role: s.believed});
}

function* night(state) {
  state.night++;
  state.phase = 'night';
  state.diedTonight = [];
  log(state, 'night', {});
  const first = state.night === 1;
  for (const id of first ? state.script.firstNight : state.script.otherNights) {
    state.step = id;
    if (TELLINGS[id]) {yield* TELLINGS[id](state); continue}
    const h = HOOKS[id], act = h && (first ? h.firstNight : h.otherNight);
    if (!act) continue;
    const wakers = state.seats.filter(s => s.believed === id && (h.wakeIf ? h.wakeIf(state, s.index) : s.alive)).map(s => s.index);
    for (const i of wakers) {
      log(state, 'wake', {seat: i, role: id});
      yield* act(state, i);
      if (state.winner) return;
    }
  }
}

function* day(state) {
  state.day++;
  state.phase = 'day';
  state.step = 'dawn';
  log(state, 'dawn', {deaths: [...state.diedTonight], grimoire: grimoire(state)});
  removeTokens(state, t => t.until === 'dawn');
  if (checkWin(state)) return;
  const t = state.today = {day: state.day, nominators: [], nominees: [], votes: [], block: null, executed: null};

  state.step = 'day-actions';
  for (const i of alive(state).filter(s => HOOKS[s.believed]?.dayAction).map(s => s.index)) {
    if (!state.seats[i].alive) continue;
    yield* HOOKS[state.seats[i].believed].dayAction(state, i);
    if (state.winner) return;
  }

  state.step = 'nominations';
  while (true) {
    const options = nominationOptions(state);
    if (!options.length) break;
    const nom = yield ask(state, {kind: 'nomination', seat: 'table', options: [...options, null],
      question: 'Who nominates whom? Each living player nominates at most once a day; each player is nominated at most once a day. null ends the nominations.'});
    if (nom === null) break;
    const {by, target} = nom;
    t.nominators.push(by); t.nominees.push(target);
    log(state, 'nomination', {by, target});
    const h = state.seats[target].alive && HOOKS[state.seats[target].believed]?.onNominated;
    if (h) {
      const r = yield* h(state, target, by);
      if (state.winner) return;
      if (r?.endDay) break;
    }
    const voters = state.seats.filter(s => s.alive || s.ghostVote).map(s => s.index);
    const votes = yield ask(state, {kind: 'vote', seat: 'table', seats: voters, nominee: target, nominator: by, options: [true, false],
      question: `${state.seats[by].name} nominates ${state.seats[target].name}. Every voter at once: yes or no?`});
    tally(state, by, target, voters, votes);
  }

  state.step = 'dusk';
  if (t.executed == null && t.block?.seat != null) yield* execute(state, t.block.seat, 'vote');
  if (t.executed == null) log(state, 'no-execution', {block: t.block});
  removeTokens(state, x => x.until === 'dusk');
  if (state.winner) return;
  for (const s of alive(state)) {
    const h = HOOKS[s.believed]?.endOfDay;
    if (h) yield* h(state, s.index, {executed: t.executed});
    if (state.winner) return;
  }
  checkWin(state);
}

function nominationOptions(state) {
  const t = state.today, out = [];
  for (const b of alive(state)) {
    if (t.nominators.includes(b.index)) continue;
    for (const s of state.seats) if (!t.nominees.includes(s.index)) out.push({by: b.index, target: s.index});
  }
  return out;
}

// Count a vote: a yes counts unless the voter's own rule says not (the Butler without the master's yes); a dead
// voter's counted yes spends their ghost vote. The highest tally at or above half the living goes on the block; a
// tie with it clears the block (nobody is executed unless a later nomination beats the tie).
function tally(state, by, target, voters, votes) {
  const t = state.today, yes = [], voided = [];
  for (const i of voters) {
    if (!votes[i]) continue;
    const h = HOOKS[state.seats[i].believed]?.voteCounts;
    if (h && !h(state, i, votes)) {voided.push(i); continue}
    yes.push(i);
  }
  for (const i of yes) if (!state.seats[i].alive) state.seats[i].ghostVote = false;
  const need = Math.ceil(aliveCount(state) / 2), n = yes.length;
  if (n >= need) {
    if (!t.block || n > t.block.votes) t.block = {seat: target, votes: n};
    else if (n === t.block.votes) t.block = {seat: null, votes: n};
  }
  t.votes.push({by, target, yes, voided, tally: n, need});
  log(state, 'vote', {by, target, yes, voided, tally: n, need, block: t.block ? {...t.block} : null});
}

