// What the page shows, worked out from what the relay sends (pure: no DOM, no network). The watch frame is the body of the
// watcher's route (GET /play/watch, asked of the backend; scripts/uifixture.mjs records frames of the same shape):
//   {seed, rounds, phase, night, day, clock, pending, ballot, grimoire: {seats, bluffs, pending, winner}, nightOrder, rulings, winner,
//    last, events: [log entries, each with the table's sentence as text, whispers with theirs]}
import {SCRIPT, EVIL} from '../data/script.js';

const ROLES = Object.fromEntries(SCRIPT.roles.map(r => [r.id, r]));
export const roleName = id => (ROLES[id] && ROLES[id].name) || String(id ?? '');
export const teamOf = id => (ROLES[id] && ROLES[id].team) || null;
export const isEvil = id => EVIL.includes(teamOf(id));

// Grimoire tokens as short words for the square, and a longer line for the grimoire panel.
const TOKEN_WORDS = {poisoned: 'poisoned', protected: 'protected', master: 'master', 'is-the-drunk': 'drunk', 'red-herring': 'red herring',
  executed: 'executed today', 'no-ability': 'ability used', 'registers-as': 'registers as', 'is-the-demon': 'now the demon', dead: 'dead'};
export const tokenWord = t => TOKEN_WORDS[t.token] || String(t.token).replace(/-/g, ' ');
export function tokenText(t, names = []) {
  let w = tokenWord(t);
  if (t.token === 'registers-as' && t.value != null) w += ' ' + (ROLES[t.value] ? roleName(t.value) : t.value);
  if (t.token === 'is-the-drunk' && t.value) w += ` (thinks ${roleName(t.value)})`;
  if (t.active === false) w += ', no effect';
  const by = t.by != null && names[t.by] ? names[t.by] : null;
  return w + (by ? ` · by ${by}` : t.role ? ` · ${roleName(t.role)}` : '');
}
// Tokens worth a word under a seat in the square: the ones that change what the seat can do tonight or today.
export const SQUARE_TOKENS = new Set(['poisoned', 'protected', 'master', 'is-the-drunk', 'red-herring', 'is-the-demon', 'registers-as']);

export const seatNames = w => (w && w.grimoire && w.grimoire.seats || []).map(s => s.name);

// The phase line for the game bar.
export function clockText(w) {
  if (!w) return 'no game';
  if (w.winner) return `game over: ${w.winner.text}`;
  if (w.phase === 'night') return `night ${w.night}`;
  if (w.phase === 'setup') return 'setting up';
  if (w.phase === 'day') {const c = w.clock || {}; return c.nominationsOpen ? `day ${w.day}, nominations open` : `day ${w.day}, round ${c.round} of ${c.roundsBeforeNominations}`}
  return String(w.phase || '');
}

// The vote in the square: the open one, else the day's last result. hands: seat -> true (raised), false (lowered), null (not yet).
export function voteView(w) {
  if (!w || !w.grimoire) return null;
  const seats = w.grimoire.seats, alive = seats.filter(s => s.alive).length, need = Math.ceil(alive / 2);
  const p = w.pending, today = (w.events || []).filter(e => e.type === 'vote' && e.day === w.day && w.phase === 'day');
  const block = today.length ? today.at(-1).block : null;
  if (p && p.kind === 'vote') {
    const votes = (w.ballot && w.ballot.votes) || {}, hands = {};
    for (const i of p.seats) hands[i] = i in votes ? !!votes[i] : null;
    const yes = Object.values(hands).filter(v => v === true).length;
    return {open: true, nominee: p.nominee, nominator: p.nominator, voters: [...p.seats], hands, yes, need, block,
      waiting: p.seats.filter(i => hands[i] === null), cast: p.seats.length - p.seats.filter(i => hands[i] === null).length};
  }
  const last = today.at(-1);
  if (!last) return null;
  const hands = {};
  for (const s of seats) hands[s.seat] = last.yes.includes(s.seat) ? true : null;
  return {open: false, nominee: last.target, nominator: last.by, voters: [], hands, yes: last.tally, need: last.needed ?? last.need, block, text: last.text};
}

// The decision the game waits on, in words, and who it waits on.
export function waitsOn(w) {
  const p = w && w.pending, names = seatNames(w);
  if (!p) return w && w.winner ? 'nothing: the game is over' : 'nothing';
  if (p.seat === 'storyteller') return `the Storyteller: ${p.question || p.kind}`;
  if (p.kind === 'vote') {const v = voteView(w); return `${v.waiting.length} of ${p.seats.length} voters on ${names[p.nominee]} (${v.waiting.map(i => names[i]).join(', ') || 'none'})`}
  if (p.kind === 'nomination') return w.clock && w.clock.nominationsOpen ? 'the living: nominate or pass' : 'the table: the speaking rounds';
  if (typeof p.seat === 'number') return `${names[p.seat]} (${roleName(p.role)}): ${p.question || p.kind}`;
  return p.question || p.kind;
}

// Runner states the agents panel shows: claimed, warming, ready, playing, stopped, gone (and none when nothing sits there).
// runner: the supervisor's view of the seat's runner (GET /play/runner), link and ready: the relay's (WebSocket /play links).
export function seatState(runner, link, ready) {
  if (runner && !['stopped', 'crashed'].includes(runner.state)) {
    if (runner.state === 'stopping') return 'stopping';
    if (runner.state === 'starting') return 'claimed';
    const r = ready && (ready.state || ready);
    if (r === 'warming') return 'warming';
    if (r === 'failed') return 'gone';
    if (link === 'connected') return 'playing';
    return r === 'ready' ? 'ready' : 'claimed';
  }
  if (runner && runner.state === 'crashed') return 'gone';
  if (runner && runner.state === 'stopped') return 'stopped';
  if (link === 'connected' || link === 'waiting') return link === 'connected' ? 'playing' : 'claimed'; // a runner started elsewhere
  return 'none';
}

export const money = v => v == null || !Number.isFinite(Number(v)) ? '-' : '$' + Number(v).toFixed(2);
export const ago = s => s == null ? '' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 360) / 10} h ago`;

// Merge a newer frame from the route (events since the last one) into the one the page holds.
export function mergeFrame(old, next) {
  if (!old || !next || next.seed !== old.seed || (next.events.length && next.events[0].id === 0)) return next;
  const seen = new Set(old.events.map(e => e.id));
  return {...next, events: [...old.events, ...next.events.filter(e => !seen.has(e.id))].sort((a, b) => a.id - b.id)};
}

// A push from the relay's socket ({type: 'watch', seed, last, events, clock, pending, ballot, phase, day, night, winner}: the watch
// body's fields without the grimoire, the rulings and the night order) merged into the frame the page holds. Events are deduped by
// id and kept in id order. -> {frame, fresh: number of new events, full: true when the page must read the whole game again (no frame
// yet, another seed, or a new game starting again from event 0)}.
export function mergePush(old, push) {
  const events = Array.isArray(push && push.events) ? push.events : [];
  // a push from event 0 that is not a replay of what the page holds: a new game began
  // (an event's clip, which the watch body carries once the relay has made it and the push never does, is no difference)
  const same = e => JSON.stringify({...e, clip: undefined});
  const byId = old ? new Map(old.events.map(e => [e.id, same(e)])) : null;
  const replay = byId && events.every(e => byId.get(e.id) === same(e));
  if (!old || !push || push.seed !== old.seed || (events.length && events[0].id === 0 && old.events.length && !replay)) return {frame: old, fresh: 0, full: true};
  const seen = new Set(old.events.map(e => e.id)), fresh = events.filter(e => !seen.has(e.id));
  const {type, ...rest} = push;
  const frame = {...old, ...rest, last: Math.max(old.last ?? -1, push.last ?? -1),
    events: fresh.length ? [...old.events, ...fresh].sort((a, b) => a.id - b.id) : old.events};
  return {frame, fresh: fresh.length, full: false};
}

// The pace knob on the game bar: how far apart a runner's turns are. minGap: the least real seconds between two turns of one seat
// (scripts/pacing.mjs --min-gap); heartbeat: game minutes of quiet before a seat takes a turn anyway (--heartbeat). Urgent turns (a
// vote, a night choice) still come at once. "fast" is the runners' own default; the page starts on "readable".
export const PACES = {
  fast: {label: 'fast', minGap: 20, heartbeat: 120, about: 'a seat speaks every 20 s or so'},
  readable: {label: 'readable', minGap: 60, heartbeat: 360, about: 'about a minute between a seat\'s turns'},
  slow: {label: 'slow', minGap: 150, heartbeat: 720, about: 'two and a half minutes between a seat\'s turns'},
};
export const DEFAULT_PACE = 'readable';
// The gap a running runner plays at, from its pacing line ("... at least 20 s apart"), or null when it has not said.
export const runnerGap = r => {const m = /at least (\d+) s apart/.exec((r && r.pace) || ''); return m ? Number(m[1]) : null};
