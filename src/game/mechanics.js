// The rules every phase and ability shares: asking for a decision, registering, telling, dying, the demon's death
// and its heir, the demon's kill, execution and the win check. Generators: `yield ask(...)` stops the game at a
// decision and resumes with the validated answer.
import {roleOf, roleName, teamOf, alive, aliveCount, addToken, hasToken, removeTokens, malfunctioning, log, tell} from './grimoire.js';
import {HOOKS} from './abilities.js';

// Every kind of decision the engine can wait for. scripted.js answers each one.
export const PENDING_KINDS = ['believed-role', 'red-herring', 'demon-bluffs', 'choose', 'info', 'register', 'mayor-bounce', 'star-pass', 'nomination', 'vote'];

// pending = {id, kind, seat, question, options, count?, seats?, role?, subject?, truth?, malfunctioning?, ...}
//   seat: a seat index (that seat answers), 'storyteller', or 'table' (the table's turn: a nomination, a vote)
//   options: the legal answers; count: pick that many distinct options (an array); seats: who answers a vote
export function ask(state, spec) {
  return {id: state.answers.length, phase: state.phase, night: state.night, day: state.day, ...spec};
}

export const seatLabel = (state, i) => `${state.seats[i].name} (${roleName(state, state.seats[i].believed)})`;

// A seat's own night or day choice.
export function choose(state, i, role, options, what, extra = {}) {
  return ask(state, {kind: 'choose', seat: i, role, options, question: `${seatLabel(state, i)}: ${what}`, ...extra});
}

// For each seat in `seats`, the role it registers as to this ability. A working Spy or Recluse is asked about only
// when its answer could change what `question(roleId)` returns; everyone else registers as their own role.
export function* perceive(state, seats, question, why) {
  const out = {};
  for (const i of seats) {
    const s = state.seats[i], r = roleOf(state, s.role);
    out[i] = s.role;
    if (!r.misregisters || malfunctioning(state, i)) continue;
    const options = [s.role, ...state.script.roles.filter(x => r.misregisters.includes(x.team)).map(x => x.id)];
    if (new Set(options.map(id => JSON.stringify(question(id) ?? null))).size < 2) continue;
    const v = yield ask(state, {kind: 'register', seat: 'storyteller', subject: i, role: s.role, options, why,
      question: `${s.name} is the ${r.name}: does it register as itself ${why}, or as another role?`});
    out[i] = v;
    if (v !== s.role) {
      addToken(state, i, {token: 'registers-as', role: s.role, value: v, until: state.phase === 'night' ? 'dawn' : 'dusk'});
      log(state, 'registered', {seat: i, as: v, why});
    }
  }
  return out;
}

const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k2 => [k2, x[k2]])) : x);
export const sameAnswer = (a, b) => canon(a) === canon(b);
export const optionKey = canon;
const uniq = arr => {const seen = new Set(); return arr.filter(x => {const k = canon(x); if (seen.has(k)) return false; seen.add(k); return true})};

// What an information role is told. A working ability's options are the true statements (the Storyteller picks
// one); a drunk or poisoned one may be told anything the ability could say, true or false.
export function* inform(state, i, role, {truth, all, question, about = {}}) {
  const bad = malfunctioning(state, i);
  truth = uniq(truth);
  const options = bad || !truth.length ? uniq([...truth, ...all]) : truth;
  const v = yield ask(state, {kind: 'info', seat: 'storyteller', subject: i, role, options, truth, malfunctioning: bad,
    question: `What does ${seatLabel(state, i)} learn? ${question}`});
  tell(state, i, role, {info: v, ...about});
  return v;
}

// A death. Tokens the dead seat put down stop working (the Poisoner's poison ends at once).
export function kill(state, i, cause, by = null) {
  const s = state.seats[i];
  if (!s.alive) return false;
  s.alive = false;
  removeTokens(state, t => t.by === i && !t.keep);
  if (state.phase === 'night') state.diedTonight.push(i);
  state.lastDeath = {seat: i, role: s.role, cause, by, phase: state.phase, night: state.night, day: state.day};
  log(state, 'death', {seat: i, role: s.role, cause, by});
  return true;
}

// A death that may be the demon's: the heir (the Scarlet Woman) or the star pass hands the demon on.
export function* die(state, i, cause, by = null, {starPass = false} = {}) {
  const before = aliveCount(state);
  if (!kill(state, i, cause, by)) return false;
  if (state.seats[i].team === 'demon') yield* demonDied(state, i, before, {starPass});
  return true;
}

export function* demonDied(state, i, aliveBefore, {starPass = false} = {}) {
  const demonRole = state.seats[i].role;
  let next = null;
  const heirs = alive(state).filter(s => {const h = roleOf(state, s.role).heir; return h && aliveBefore >= h.minAlive && !malfunctioning(state, s.index)});
  if (heirs.length) next = heirs[0].index;
  else if (starPass) {
    const minions = alive(state).filter(s => s.team === 'minion').map(s => s.index);
    if (minions.length === 1) next = minions[0];
    else if (minions.length > 1) next = yield ask(state, {kind: 'star-pass', seat: 'storyteller', subject: i, options: minions,
      question: `The ${roleName(state, demonRole)} killed itself: which minion becomes the ${roleName(state, demonRole)}?`});
  }
  if (next == null) return;
  const s = state.seats[next], was = s.role;
  s.role = demonRole; s.believed = demonRole; s.team = teamOf(state, demonRole);
  addToken(state, next, {token: 'is-the-demon', role: was, keep: true});
  log(state, 'new-demon', {seat: next, was, role: demonRole, how: heirs.length ? 'heir' : 'star-pass'});
  tell(state, next, 'became-demon', {role: demonRole, was});
}

// The demon's kill on a target: shields (the Monk's protection, the Soldier) stop it; a redirect (the Mayor) may
// send it to someone else, once.
export function* demonKill(state, by, target, {bounced = false} = {}) {
  const t = state.seats[target];
  if (!t.alive) {log(state, 'no-death', {seat: target, why: 'already dead'}); return false}
  if (hasToken(state, target, 'protected', x => x.active && x.shields === 'demon')) {log(state, 'no-death', {seat: target, why: 'protected'}); return false}
  const h = HOOKS[t.believed];
  if (h?.safeFromDemon?.(state, target)) {log(state, 'no-death', {seat: target, why: roleName(state, t.believed)}); return false}
  if (!bounced && h?.onDemonTarget) {
    const to = yield* h.onDemonTarget(state, target, by);
    if (to !== target) {log(state, 'bounce', {from: target, to}); return yield* demonKill(state, by, to, {bounced: true})}
  }
  return yield* die(state, target, 'demon', by);
}

// An execution: the day's one. The executed role's own rule (the Saint) runs first, then the demon's death, then the win.
export function* execute(state, i, how) {
  const s = state.seats[i];
  if (state.today) state.today.executed = i;
  state.executed.push({day: state.day, seat: i, role: s.role, how});
  log(state, 'execution', {seat: i, role: s.role, how});
  const before = aliveCount(state);
  kill(state, i, 'execution');
  const h = HOOKS[s.believed]?.onExecuted;
  if (h) yield* h(state, i);
  if (state.winner) return;
  if (s.team === 'demon') yield* demonDied(state, i, before);
  checkWin(state);
}

const WHEN = state => state.phase === 'night' ? `night ${state.night}` : `day ${state.day}`;

export function win(state, team, reason, text) {
  if (state.winner) return true;
  state.winner = {team, reason, phase: state.phase, night: state.night, day: state.day, alive: aliveCount(state), text};
  log(state, 'win', {team, reason, text});
  return true;
}

// The demon is dead (good wins), or two players are left with the demon among them (evil wins).
export function checkWin(state) {
  if (state.winner) return true;
  const d = state.lastDeath;
  const demon = state.script.roles.find(r => r.team === 'demon');
  const dname = d ? roleName(state, d.role) : demon?.name || 'demon';
  if (!alive(state).some(s => s.team === 'demon')) {
    const how = !d ? 'the demon is gone'
      : d.cause === 'execution' ? `execution of the ${dname} on day ${d.day}`
      : d.cause === 'slayer' ? `the Slayer's shot at the ${dname} on day ${d.day}`
      : d.cause === 'star-pass' ? `the ${dname} killing itself with no minion left on night ${d.night}`
      : `the death of the ${dname} (${d.cause}) on ${WHEN(state)}`;
    return win(state, 'good', 'demon-dead', `good wins by ${how}`);
  }
  if (aliveCount(state) <= 2) return win(state, 'evil', 'two-alive', `evil wins with two players left on ${WHEN(state)}`);
  return false;
}

