// The tools the Storyteller agent uses to run the game. Pure data, shared by the relay's MCP server (scripts/relay-mcp.mjs,
// selected with X-Clocktower-Role: storyteller or /mcp?role=storyteller) and the local tool loop. Separate from the player tools:
// the Storyteller never plays a seat, and no player reaches these. Same shape as src/data/player-tools.js:
//   {name, desc, act, args: {argName: {type, desc, optional?, enum?}}, handler(args, ctx)}
//   ctx = {game, seat: {index: 'storyteller', name: 'Storyteller'}, api (src/game/api.js), log(type, data)}
// The engine is the law: every act goes through the api, which applies only a legal answer and refuses the rest with a
// message naming what is legal. The Storyteller reaches the players only through the game: night information by
// answering the engine's `info` decision (the engine tells the seat), and narration to the whole table. No tool here
// speaks to one player in private or changes a rule. Every call that decides something carries a reason, logged.
import {optionKey} from '../game/mechanics.js';
import {createScripted} from '../game/scripted.js';
import {
  describePending, valueWords, grimoireRows, grimoireLine, tableEvents, eventWords, clockWords, openVote, waitingOn,
  roleFromWord, seatFromWord, roleLabel, seatLabel, phaseOf, toolsNow, KIND_WORDS,
} from '../seats/storyteller.js';

const ME = 'storyteller';
const REASON = {type: 'string', desc: 'Why, in at least one full sentence (logged with the call and shown to the watcher, never to a player)'};
export const NARRATION_MAX = 600;

// A refusal: {ok: false, error}. An ApiError from the api passes through with its message.
const no = error => ({ok: false, error});
const tryApi = (f, extra = '') => {
  try {return f()} catch (e) {return no(String(e?.message || e) + extra)}
};

// A reason is at least one sentence: four words or more. Returns the error, or null.
export function reasonError(reason) {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) return 'Give a reason: one full sentence on why you make this call (the watcher reads it; no player does).';
  if (r.split(/\s+/).length < 4 || r.length < 15) return `"${r}" is too short for a reason: say in one full sentence why you make this call.`;
  return null;
}

// ---- reading an agent's answer into one of the pending's options ----
const sortPlayers = v => (v && typeof v === 'object' && Array.isArray(v.players) ? {...v, players: [...v.players].sort((a, b) => a - b)} : v);
const keyOf = v => optionKey(sortPlayers(v));

// One word of an answer: '#3' (an option number), a seat's name, a role, yes/no, none, a number.
function wordValue(game, w) {
  const s = String(w).trim().replace(/^["']|["']$/g, '');
  const ref = s.match(/^(?:#|option\s*)(\d+)$/i);
  if (ref) return {ref: Number(ref[1])};
  if (/^(yes|true)$/i.test(s)) return {v: true};
  if (/^(no|false)$/i.test(s)) return {v: false};
  if (/^(none|no outsiders|nobody|null)$/i.test(s)) return {none: true};
  const seat = seatFromWord(game, s);
  if (seat != null) return {seat};
  const role = roleFromWord(game, s);
  if (role) return {role};
  if (/^-?\d+$/.test(s)) return {n: Number(s)};
  return {bad: s};
}

// The option the agent means: {value} (the pending's own option) or {error}. `value` is text (from a local loop it may
// be a raw value or JSON); `option` an option number as what_is_asked lists it.
export function resolveValue(game, p, value, option) {
  const opts = p.options || [];
  const at = n => (Number.isInteger(n) && n >= 1 && n <= opts.length ? {value: opts[n - 1]} : {error: `There is no option #${n}; the options are #1 to #${opts.length}.`});
  const match = v => {const k = keyOf(v); const o = opts.find(x => keyOf(x) === k); return o === undefined ? null : {value: o}};
  if (option != null && option !== '') {
    if (p.count) return {error: `Pick ${p.count}: give them in value, like "#1, #2${p.count > 2 ? ', #3' : ''}".`};
    return at(Number(option));
  }
  if (value === undefined || value === null || value === '') return {error: 'Name your answer in value (or give an option number).'};
  if (typeof value !== 'string') {
    if (p.count && Array.isArray(value)) {
      const out = value.map(match);
      return out.every(Boolean) ? {value: out.map(x => x.value)} : {error: 'One of those picks is not an option.'};
    }
    return match(value) || {error: `${JSON.stringify(value)} is not an option.`};
  }
  const s = value.trim();
  if (/^[[{]/.test(s)) {try {return resolveValue(game, p, JSON.parse(s))} catch {/* read it as words */}}
  const words = s.split(/\s*(?:,|;|\band\b|\bor\b)\s*/i).filter(Boolean).map(w => wordValue(game, w));
  const bad = words.find(w => w.bad);
  if (bad) return {error: `"${bad.bad}" is neither a player, a role, yes or no, nor an option number.`};
  const single = w => {
    if (w.ref != null) return at(w.ref);
    if (w.none) return match({none: true}) || {error: '"none" is not an option here.'};
    const v = w.seat ?? w.role ?? w.v ?? w.n;
    return match(v) || {error: `${valueWords(game, p, v)} is not an option here.`};
  };
  if (p.count) {
    if (words.length !== p.count) return {error: `Pick exactly ${p.count}, separated by commas.`};
    const out = [];
    for (const w of words) {const r = single(w); if (r.error) return r; out.push(r.value)}
    if (new Set(out.map(keyOf)).size !== out.length) return {error: 'The picks must differ.'};
    return {value: out};
  }
  const statements = opts.some(o => o && typeof o === 'object' && Array.isArray(o.players));
  if (statements && words.length > 1) {
    const seats = words.filter(w => w.seat != null).map(w => w.seat), role = words.find(w => w.role)?.role;
    if (seats.length !== 2 || !role) return {error: 'Name two players and a role, like "Bram, Ines, Washerwoman".'};
    return match({players: seats, role}) || {error: `"${valueWords(game, p, {players: seats, role})}" is not an option here.`};
  }
  if (words.length !== 1) return {error: 'Give one answer.'};
  return single(words[0]);
}

// The legal options in a refusal: a short list the agent can pick from.
function legalList(game, p, max = 12) {
  const opts = (p.options || []).map((v, k) => `#${k + 1} ${valueWords(game, p, v)}`);
  return opts.length > max ? `${opts.slice(0, max).join('; ')}; and ${opts.length - max} more (what_is_asked)` : opts.join('; ');
}

// Nothing waits on the Storyteller: say what the game waits on instead.
const notYours = game => no(`Nothing waits on you: the game waits on ${waitingOn(game)}. ${phaseOf(game) === 'day' ? 'Read talk or day_state.' : 'Read night_order or grimoire.'}`);

// One scripted answerer per live game (seeded from the game's seed): the fallback is the sim's own default.
const scripted = new WeakMap();
function scriptedFor(game) {
  if (!scripted.has(game)) scripted.set(game, createScripted(game.config?.seed ?? 1));
  return scripted.get(game);
}

const needDay = (game, what) => (phaseOf(game) !== 'day' ? no(`${what} only by day; it is ${clockWords(game).toLowerCase()}.`) : null);
const reasonOf = r => (typeof r === 'string' ? r.trim() : '');

// The pending decision for the Storyteller, or a refusal.
function mine(game, api) {
  const p = tryApi(() => api.pendingFor(game, ME));
  if (p && p.ok === false) return {refusal: p};
  if (!p) return {refusal: notYours(game)};
  return {p};
}

const TOOLS = [
  // ---- reads ----
  {name: 'look', act: false, args: {},
    desc: 'Where the game stands in one glance: the phase and the clock, who is alive, and what the game waits on.',
    handler: (args, {game, api}) => {
      const p = tryApi(() => api.pendingFor(game, ME)), yours = !!(p && p.ok !== false);
      return {ok: true, phase: clockWords(game), seats: (game.seats || []).map(s => ({name: s.name, alive: s.alive})),
        waitingOn: yours ? 'you: ' + (KIND_WORDS[p.kind] || p.kind) : waitingOn(game), useful: toolsNow(game, yours)};
    }},
  {name: 'grimoire', act: false, args: {},
    desc: 'The grimoire: every seat with its name, true role, the role it believes it is when different (the Drunk), alive or dead, ghost vote, and the tokens on it with who placed them; the demon\'s bluffs.',
    handler: (args, {game, api}) => tryApi(() => {
      const rows = grimoireRows(game, api);
      return {ok: true, phase: clockWords(game), seats: rows.map(r => ({
        name: r.name, role: roleLabel(game, r.role), ...(r.believed && r.believed !== r.role ? {believes: roleLabel(game, r.believed)} : {}),
        alive: r.alive, ghostVote: r.ghostVote, tokens: (r.tokens || []).map(t => ({token: t.token, role: roleLabel(game, t.role),
          ...(t.value != null ? {value: typeof t.value === 'string' ? roleLabel(game, t.value) : t.value} : {}),
          ...(t.by != null ? {placedBy: seatLabel(game, t.by)} : {}), ...(t.active === false ? {noEffect: true} : {})})),
      })), lines: rows.map(r => grimoireLine(game, r)), bluffs: (game.bluffs || []).map(id => roleLabel(game, id))};
    })},
  {name: 'night_order', act: false, args: {},
    desc: 'The night\'s waking order (tonight\'s, or by day the coming night\'s): each role in turn, the seat that wakes for it, whether it will wake, who has already acted and who is now.',
    handler: (args, {game, api}) => tryApi(() => {
      if (phaseOf(game) === 'ended') return no(`There is no night order: ${clockWords(game).toLowerCase()}.`);
      const order = api.nightOrder(game) || [];
      const now = order.find(o => o.status === 'now') || (phaseOf(game) === 'night' ? order.find(o => !o.acted) : null);
      return {ok: true, night: order[0]?.night ?? game.night, order: order.map(o => ({
        role: o.seat == null ? String(o.role ?? o.id).replace(/-/g, ' ') : roleLabel(game, o.role ?? o.id), seat: o.seat != null ? seatLabel(game, o.seat) : null,
        status: o.status || (o.acted ? 'done' : 'to come'), ...(o.wakes === false ? {wakes: false} : {}),
        ...(o === now ? {now: true} : {}),
      }))};
    })},
  {name: 'what_is_asked', act: false, args: {},
    desc: 'The decision waiting on you in plain words: what kind, which seat it concerns, the truth, every legal option numbered, why it is asked, and whether the ability malfunctions (drunk or poisoned). When nothing waits on you, says what the game waits on.',
    handler: (args, {game, api}) => tryApi(() => {
      const p = api.pendingFor(game, ME);
      if (!p) return {ok: true, pending: null, waitingOn: waitingOn(game)};
      return {ok: true, pending: describePending(game, p, {max: 400})};
    })},
  {name: 'talk', act: false,
    args: {since: {type: 'integer', optional: true, desc: 'Only what came after this event id (default: everything today)'}},
    desc: 'What was said at the table: every public line, nominations, votes and narration, with event ids. Whispers show only as "A whispers to B"; you never hear their words.',
    handler: ({since}, {game, api}) => tryApi(() => {
      const from = Number.isInteger(since) ? since : 0;
      let evs = tableEvents(game, api, from);
      if (!Number.isInteger(since)) evs = evs.filter(e => e.day === game.day);
      evs = evs.slice(-80);
      return {ok: true, day: game.day, events: evs.map(e => ({id: e.id, type: e.type, line: eventWords(game, e)})), last: evs.length ? evs.at(-1).id : from};
    })},
  {name: 'rulings', act: false, args: {},
    desc: 'Every call made this game (yours and the scripted fallback\'s), with its reason, oldest first.',
    handler: (args, {game, api}) => tryApi(() => ({ok: true, rulings: api.rulings(game) || []}))},
  {name: 'day_state', act: false, args: {},
    desc: 'The day: the clock (round, rounds before nominations, whether nominations are open), today\'s nominations and their votes, the vote open now, who is on the block, who was executed.',
    handler: (args, {game}) => {
      const t = game.today || {}, c = game.clock || {};
      return {ok: true, phase: clockWords(game),
        clock: {round: c.round ?? null, roundsBeforeNominations: c.roundsBeforeNominations ?? null, nominationsOpen: !!c.nominationsOpen},
        nominations: (t.votes || []).map(v => ({by: seatLabel(game, v.by), target: seatLabel(game, v.target), yes: (v.yes || []).map(i => seatLabel(game, i)), tally: v.tally, needed: v.need})),
        voteOpen: openVote(game), block: t.block?.seat != null ? {seat: seatLabel(game, t.block.seat), votes: t.block.votes} : null,
        executed: t.executed != null ? seatLabel(game, t.executed) : null, waitingOn: waitingOn(game), useful: toolsNow(game, false)};
    }},

  // ---- acts ----
  {name: 'decide', act: true,
    args: {
      value: {type: 'string', optional: true, desc: 'Your answer: a player\'s name, a role, yes or no, a number, "none", or an option number like "#2"; several picks separated by commas; a statement as "Name, Name, Role"'},
      option: {type: 'integer', optional: true, desc: 'Instead of value, for one pick: the option\'s number as what_is_asked lists it'},
      reason: REASON,
    },
    desc: 'Answer the decision waiting on you (the Drunk\'s false role, the red herring, the demon\'s bluffs, night information, how a role registers, the Mayor\'s bounce, the star pass). Only a legal option is accepted; night information reaches the seat through the game, never from you directly.',
    handler: ({value, option, reason}, {game, api, log}) => {
      const {p, refusal} = mine(game, api); if (refusal) return refusal;
      const r = reasonError(reason); if (r) return no(r);
      const v = resolveValue(game, p, value, option);
      if (v.error) return no(`${v.error} Legal for ${KIND_WORDS[p.kind] || p.kind}: ${legalList(game, p)}.`);
      const why = reasonOf(reason);
      const res = tryApi(() => {api.answer(game, ME, v.value, why); return null}, ` Legal: ${legalList(game, p)}.`);
      if (res) return res;
      const words = valueWords(game, p, v.value);
      log('storyteller-call', {tool: 'decide', kind: p.kind, value: v.value, words, reason: why});
      return {ok: true, decided: KIND_WORDS[p.kind] || p.kind, answer: words, reason: why, next: waitingOn(game)};
    }},
  {name: 'fallback', act: true, args: {reason: REASON},
    desc: 'Answer the decision waiting on you with the scripted default (true information, the plain choice), logged as a ruling that says so. For when you have no better call to make.',
    handler: ({reason}, {game, api, log}) => {
      const {p, refusal} = mine(game, api); if (refusal) return refusal;
      const r = reasonError(reason); if (r) return no(r);
      const v = tryApi(() => ({value: scriptedFor(game)(game)}));
      if (v.ok === false) return v;
      const why = `Scripted default: ${reasonOf(reason)}`;
      const res = tryApi(() => {api.answer(game, ME, v.value, why); return null});
      if (res) return res;
      const words = valueWords(game, p, v.value);
      log('storyteller-call', {tool: 'fallback', kind: p.kind, value: v.value, words, reason: why});
      return {ok: true, decided: KIND_WORDS[p.kind] || p.kind, answer: words, reason: why, scripted: true, next: waitingOn(game)};
    }},
  {name: 'narrate', act: true,
    args: {text: {type: 'string', desc: `What the whole table hears from you, at most ${NARRATION_MAX} characters: the dawn's deaths, a vote's result, the end`}},
    desc: 'Speak to the whole table as the Storyteller: who died in the night, how a vote went, who is executed, how the game ended. Plain and a little dry. While the game runs, never name a role in play: the table learns roles from the players, not from you.',
    handler: ({text}, {game, api, log}) => {
      const t = typeof text === 'string' ? text.trim() : '';
      if (!t) return no('Say something: narrate needs text.');
      if (t.length > NARRATION_MAX) return no(`That is ${t.length} characters; narrate at most ${NARRATION_MAX}.`);
      if (phaseOf(game) !== 'ended') {
        const inPlay = new Set((game.seats || []).flatMap(s => [s.role, s.believed]));
        const named = [...inPlay].map(id => roleLabel(game, id)).filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t));
        if (named.length) return no(`While the game runs the table learns roles only from the players: leave out ${named.join(', ')} and say what happened.`);
      }
      const res = tryApi(() => {api.narrate(game, t); return null});
      if (res) return res;
      log('storyteller-call', {tool: 'narrate', text: t});
      return {ok: true, narrated: t};
    }},
  {name: 'open_nominations', act: true, args: {reason: {...REASON, optional: true, desc: 'Why now, before the rounds are done (optional; logged)'}},
    desc: 'Open nominations now, before the day\'s speaking rounds are done (a slow day, a table ready to act).',
    handler: ({reason}, {game, api, log}) => {
      const d = needDay(game, 'Nominations open'); if (d) return d;
      if (game.clock?.nominationsOpen) return no('Nominations are already open; end_day when the day is done.');
      const res = tryApi(() => {api.openNominations(game); return null});
      if (res) return res;
      log('storyteller-call', {tool: 'open_nominations', reason: reasonOf(reason)});
      return {ok: true, nominationsOpen: true};
    }},
  {name: 'close_vote', act: true, args: {reason: REASON},
    desc: 'Close the open vote now: every voter who has not voted counts as no. Use it when the table stalls, never to steer a result.',
    handler: ({reason}, {game, api, log}) => {
      const d = needDay(game, 'A vote closes'); if (d) return d;
      if (game.pending?.kind !== 'vote') return no(`No vote is open; the game waits on ${waitingOn(game)}.`);
      const r = reasonError(reason); if (r) return no(r);
      const v = openVote(game);
      const res = tryApi(() => {api.closeVote(game, reasonOf(reason)); return null});
      if (res) return res;
      log('storyteller-call', {tool: 'close_vote', vote: v, reason: reasonOf(reason)});
      return {ok: true, closed: v, reason: reasonOf(reason)};
    }},
  {name: 'end_day', act: true, args: {reason: REASON},
    desc: 'End the day: no more nominations; whoever is on the block is executed at dusk, and night falls.',
    handler: ({reason}, {game, api, log}) => {
      const d = needDay(game, 'The day ends'); if (d) return d;
      if (game.pending?.kind === 'vote') return no('A vote is open: let it finish, or close_vote first.');
      const r = reasonError(reason); if (r) return no(r);
      const res = tryApi(() => {api.endDay(game, reasonOf(reason)); return null});
      if (res) return res;
      log('storyteller-call', {tool: 'end_day', reason: reasonOf(reason)});
      return {ok: true, ended: `day ${game.day}`, reason: reasonOf(reason), now: clockWords(game)};
    }},
];

// With no game behind the relay (the stub backend), look answers plainly and every other tool says there is none yet.
const NO_GAME = {ok: true, phase: 'no game yet', seats: []};
export const STORYTELLER_TOOLS = TOOLS.map(t => ({...t, handler: (args, ctx = {}) => {
  if (!ctx.game) return t.name === 'look' ? NO_GAME : no('No game yet: nothing to run.');
  return t.handler(args || {}, {log: () => {}, ...ctx});
}}));
export const STORYTELLER_TOOL_NAMES = STORYTELLER_TOOLS.map(t => t.name);
