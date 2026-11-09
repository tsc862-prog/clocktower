// Queries and small mutations on the game state: seats, tokens (the grimoire), the log. No phase logic here.
import {EVIL, GOOD} from '../data/script.js';

export const roleOf = (state, id) => state.roleIndex[id] || null;
export const roleName = (state, id) => roleOf(state, id)?.name || id;
export const teamOf = (state, id) => roleOf(state, id)?.team || null;
export const isEvilTeam = team => EVIL.includes(team);
export const isGoodTeam = team => GOOD.includes(team);
export const seatName = (state, i) => state.seats[i]?.name ?? String(i);

export const alive = state => state.seats.filter(s => s.alive);
export const aliveCount = state => state.seats.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
export const rolesInPlay = state => state.seats.map(s => s.role);

// The nearest living seats on either side of seat i (the seat itself excluded); one seat when only one other lives.
export function livingNeighbours(state, i) {
  const n = state.seats.length, out = [];
  for (let d = 1; d < n; d++) {const j = (i - d + n) % n; if (state.seats[j].alive) {out.push(j); break}}
  for (let d = 1; d < n; d++) {const j = (i + d) % n; if (state.seats[j].alive) {if (!out.includes(j)) out.push(j); break}}
  return out;
}

// Tokens: {token, role, by, on, until?, active?, value?}. `by` is the seat that put it down (null for the Storyteller),
// `until` 'dawn' or 'dusk' clears it then, `active: false` marks a token whose ability had no effect (shown, not obeyed).
export function addToken(state, seatIndex, token) {
  const t = {active: true, by: null, ...token, on: seatIndex};
  state.seats[seatIndex].tokens.push(t);
  return t;
}
export const tokensOf = (state, i) => state.seats[i].tokens;
export const hasToken = (state, i, token, pred = () => true) => state.seats[i].tokens.some(t => t.token === token && pred(t));
export function removeTokens(state, pred) {
  for (const s of state.seats) s.tokens = s.tokens.filter(t => !pred(t, s));
}
export const findToken = (state, token, pred = () => true) => {
  for (const s of state.seats) for (const t of s.tokens) if (t.token === token && pred(t)) return t;
  return null;
};

// A seat's ability is off when it is the disguised outsider (the Drunk) or is poisoned by an active token.
export const isDrunk = (state, i) => !!roleOf(state, state.seats[i].role)?.disguise;
export const isPoisoned = (state, i) => hasToken(state, i, 'poisoned', t => t.active);
export const malfunctioning = (state, i) => isDrunk(state, i) || isPoisoned(state, i);

// Who may see a log entry: 'all' (the table), [seat indexes] (those seats alone), 'storyteller', or 'watcher' (the owner's page
// and the behavior log alone: a seat's night thought, #111; neither a seat nor the Storyteller ever reads it). Every entry carries one;
// src/game/api.js shows a seat only the entries whose audience includes it. A death by day happens in front of the table;
// a death by night is announced at dawn (the dawn entry), so the death itself is the Storyteller's.
export const PUBLIC_TYPES = ['night', 'dawn', 'nomination', 'vote', 'execution', 'no-execution', 'slayer-shot', 'virgin', 'win'];
export function audienceOf(state, type, data) {
  if (type === 'told') return [data.seat];
  if (PUBLIC_TYPES.includes(type)) return 'all';
  if (type === 'death' && state.phase === 'day') return 'all';
  return 'storyteller';
}

// One log entry. id (= n) increases by one with every entry; data.audience overrides the default audience.
export function log(state, type, data = {}) {
  const {audience, ...rest} = data;
  const e = {n: state.log.length, id: state.log.length, phase: state.phase, night: state.night, day: state.day, type, ...rest,
    audience: audience !== undefined ? audience : audienceOf(state, type, rest)};
  state.log.push(e);
  return e;
}

// What a seat is privately told: one log line addressed to that seat.
export const tell = (state, i, what, data = {}) => log(state, 'told', {seat: i, what, ...data});

// A plain copy of the grimoire for printing and for the Spy.
export function grimoire(state) {
  return state.seats.map(s => ({
    seat: s.index, name: s.name, role: s.role, believed: s.believed, alive: s.alive, ghostVote: s.ghostVote,
    tokens: s.tokens.map(t => ({token: t.token, role: t.role, ...(t.value != null ? {value: t.value} : {}), ...(t.active ? {} : {active: false})})),
  }));
}
