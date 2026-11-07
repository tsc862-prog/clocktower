// The game state and the deal. newGame() deals the roles and starts the engine, which stops at the first decision
// (state.pending). Every random draw comes from the game's seeded RNG.
import {SCRIPT, SEAT_NAMES} from '../data/script.js';
import {createRng} from './rng.js';
import {start} from './engine.js';

// The roles for n seats: the demon and minions first, their setup changes applied, then outsiders and townsfolk.
export function deal(script, n, rng) {
  const counts = script.setup[n];
  if (!counts) throw new Error(`${script.name} has no setup for ${n} seats`);
  const ids = team => script.roles.filter(r => r.team === team).map(r => r.id);
  const byId = Object.fromEntries(script.roles.map(r => [r.id, r]));
  const demon = rng.shuffle(ids('demon')).slice(0, counts.demon);
  const minions = rng.shuffle(ids('minion')).slice(0, counts.minions);
  let outsiders = counts.outsiders, townsfolk = counts.townsfolk;
  for (const id of [...demon, ...minions]) {
    const change = byId[id].setup?.outsiders || 0;
    const moved = Math.max(-outsiders, Math.min(change, townsfolk));
    outsiders += moved; townsfolk -= moved;
  }
  const out = rng.shuffle(ids('outsider')).slice(0, outsiders);
  const town = rng.shuffle(ids('townsfolk')).slice(0, townsfolk + (outsiders - out.length));
  return rng.shuffle([...town, ...out, ...minions, ...demon]);
}

const hidden = (o, k, v) => Object.defineProperty(o, k, {value: v, enumerable: false, writable: true, configurable: true});

// The day clock's default: speaking rounds before nominations open (src/game/api.js runs the clock).
export const DEFAULT_ROUNDS = 3;

// seats: an array of names or a count (default: the seven seat names). roles: a fixed deal, seat by seat (tests).
// rounds: the day's speaking rounds before nominations open.
export function createState({seed = 1, seats, script = SCRIPT, roles = null, rounds = DEFAULT_ROUNDS} = {}) {
  const names = Array.isArray(seats) ? [...seats]
    : Array.from({length: typeof seats === 'number' ? seats : (roles ? roles.length : 7)}, (_, i) => SEAT_NAMES[i] || `Seat ${i + 1}`);
  const rng = createRng(seed);
  const roleIndex = Object.fromEntries(script.roles.map(r => [r.id, r]));
  const dealt = roles ? [...roles] : deal(script, names.length, rng);
  if (dealt.length !== names.length) throw new Error(`${dealt.length} roles for ${names.length} seats`);
  for (const id of dealt) if (!roleIndex[id]) throw new Error(`unknown role ${id} in ${script.id}`);
  const state = {
    config: {seed, seats: names, roles: roles ? [...roles] : null, script: script.id, rounds},
    seats: names.map((name, i) => ({index: i, name, role: dealt[i], believed: dealt[i], team: roleIndex[dealt[i]].team, alive: true, ghostVote: true, tokens: []})),
    phase: 'setup', night: 0, day: 0, step: null,
    bluffs: [],
    today: null,          // the day's book: nominations, votes, who nominated, who was nominated, the block
    executed: [],         // [{day, seat, role}] every execution
    diedTonight: [],      // seats that died this night, announced at dawn
    lastDeath: null,      // {seat, role, cause, by, phase, night, day}: how the game ended, when a death ended it
    log: [], answers: [], pending: null, winner: null,
    // the table's side of the game, kept by src/game/api.js so a plain copy restores: the day clock, the open ballot, each
    // seat's notes, and every api call that changed the game (api.restore replays them)
    clock: {day: 0, round: 1, roundsBeforeNominations: rounds, nominationsOpen: false, spoke: [], passedNominating: []},
    ballot: null, notes: {}, actions: [],
  };
  hidden(state, 'script', script);
  hidden(state, 'roleIndex', roleIndex);
  hidden(state, 'rng', rng);
  return state;
}

// A new game, stopped at its first decision.
export function newGame(opts = {}) {
  return start(createState(opts));
}
