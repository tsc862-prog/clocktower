// npm run storytellertoolcheck: the Storyteller's tool table, header and prompt against a fake api (src/game/api.js's
// contract, E:/clocktower-ops/briefs/slice3-contract.md) over real engine states on fixed deals: the setup decisions (the
// Drunk's false role, the red herring, the demon's bluffs), a player's own choice (not the Storyteller's: decide is
// refused), information with the ability working (only the truth is legal), information while drunk and while poisoned,
// a registering question, the Mayor's bounce, the star pass, a day with a vote open, and a game ended. Exit 1 on any failure.
import {newGame, answer as engineAnswer, playOut, grimoire, createScripted} from '../src/game/index.js';
import * as realApi from '../src/game/api.js';
import {SCRIPT} from '../src/data/script.js';
import {STORYTELLER_TOOLS, STORYTELLER_TOOL_NAMES, reasonError, reasonFactsError, resolveValue} from '../src/data/storyteller-tools.js';
import {storytellerHeader, HEADER_CAP, storytellerDue, toolsNow} from '../src/seats/storyteller.js';
import {DAWN_TOUCHES, DUSK_TOUCHES, touchFor, touchOrder} from '../src/data/colour.js';
import {STORYTELLER_SYSTEM, systemFor} from '../src/data/prompts.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)}};
const section = name => console.log(`- ${name}`);
const REASON = 'The table needs a real lead, so the truth serves it best.';

// ---- the fake api: the contract's functions over a live engine state ----
class ApiError extends Error {}
function fakeApi() {
  const rulings = [], events = new WeakMap(), notes = [];
  const evs = g => {if (!events.has(g)) events.set(g, []); return events.get(g)};
  const push = (g, e) => {const l = evs(g); l.push({id: l.length + 1, day: g.day, night: g.night, ...e})};
  const pendingFor = (g, seat) => {
    const p = g.pending;
    if (!p) return null;
    if (seat === 'storyteller') return p.seat === 'storyteller' ? p : null;
    return p.seat === seat ? p : null;
  };
  const toEngine = (g, v) => {
    try {engineAnswer(g, v)} catch (e) {throw new ApiError(`Not legal: ${e.message}. Legal: ${(g.pending?.options || []).length} options.`)}
  };
  const api = {
    ApiError, notes,
    pendingFor,
    answer(g, seat, value, reason) {
      const p = pendingFor(g, seat);
      if (!p) throw new ApiError('Nothing waits on you.');
      if (seat === 'storyteller' && !(typeof reason === 'string' && reason.trim())) throw new ApiError('A Storyteller answer needs a reason.');
      toEngine(g, value);
      if (seat === 'storyteller') rulings.push({type: 'ruling', kind: p.kind, value, reason});
    },
    grimoire: g => grimoire(g),
    nightOrder(g) {
      const order = g.night === 1 ? SCRIPT.firstNight : SCRIPT.otherNights, at = order.indexOf(g.step);
      const out = [];
      order.forEach((id, k) => {
        const seats = g.seats.filter(s => s.believed === id).map(s => s.index);
        if (SCRIPT.tellings.includes(id)) out.push({role: id, seat: null, acted: k < at});
        for (const s of seats) out.push({role: id, seat: s, acted: k < at});
      });
      return out;
    },
    events: (g, seat, since = 0) => evs(g).filter(e => e.id > since),
    narrate: (g, text) => push(g, {type: 'narration', text}),
    openNominations(g) {g.clock = {...(g.clock || {}), nominationsOpen: true}},
    closeVote(g, reason) {
      const p = g.pending;
      if (!p || p.kind !== 'vote') throw new ApiError('No vote is open.');
      const ballot = g.ballot?.votes || {};
      toEngine(g, Object.fromEntries(p.seats.map(s => [s, ballot[s] === true])));
      g.ballot = {};
      rulings.push({type: 'ruling', kind: 'close-vote', reason});
    },
    endDay(g, reason) {
      if (g.pending?.kind !== 'nomination') throw new ApiError('The day cannot end now.');
      toEngine(g, null);
      rulings.push({type: 'ruling', kind: 'end-day', reason});
    },
    rulings: () => rulings,
    _push: push,
    _say: (g, seat, text) => push(g, {type: 'say', seat, text}),
    _whisper: (g, from, to, text) => {push(g, {type: 'whisper', from, to, text}); push(g, {type: 'whisper-seen', from, to})},
  };
  return api;
}

const TOOL = Object.fromEntries(STORYTELLER_TOOLS.map(t => [t.name, t]));
function ctxOf(game, api) {
  const logged = [];
  return {ctx: {game, api, seat: {index: 'storyteller', name: 'Storyteller'}, log: (type, data) => logged.push({type, ...data})}, logged};
}
const call = (game, api, name, args = {}) => TOOL[name].handler(args, ctxOf(game, api).ctx);
const header = (game, api) => storytellerHeader(game, api);

// Quiet answers for what a case does not script: true information, no tricks, no nominations, every vote no.
function quiet(state) {
  const p = state.pending;
  switch (p.kind) {
    case 'vote': return Object.fromEntries(p.seats.map(s => [s, false]));
    case 'nomination': return null;
    case 'demon-bluffs': return p.options.slice(0, p.count);
    case 'info': return (p.truth.length ? p.truth : p.options)[0];
    case 'choose':
      if (p.count) return p.options.filter(x => x !== p.seat).slice(0, p.count);
      if (p.options.includes(null)) return null;
      return p.options.find(x => x !== p.seat) ?? p.options[0];
    default: return p.options[0];
  }
}
// The Poisoner poisons the Chef (seat 4) unless a case says otherwise, so the demon's kill works.
const spare = p => (p.kind === 'choose' && p.role === 'poisoner' ? 4 : undefined);
const until = (g, pred, override = spare) => playOut(g, quiet, {until: pred, override, maxDays: 10});
const headerOk = (g, api, what, must = []) => {
  const h = header(g, api);
  ok(h.length <= HEADER_CAP, `${what}: header under ${HEADER_CAP} characters (${h.length})`);
  for (const m of must) ok(h.includes(m), `${what}: header carries "${m}"\n${h}`);
  return h;
};

// ---- the table's shape ----
section('the table');
{
  ok(Array.isArray(STORYTELLER_TOOLS) && STORYTELLER_TOOLS.length > 0, 'STORYTELLER_TOOLS is a list');
  ok(new Set(STORYTELLER_TOOL_NAMES).size === STORYTELLER_TOOLS.length, 'tool names are unique');
  const want = {look: false, grimoire: false, night_order: false, what_is_asked: false, talk: false, rulings: false, day_state: false,
    decide: true, narrate: true, open_nominations: true, close_vote: true, end_day: true, fallback: true};
  for (const [n, act] of Object.entries(want)) ok(TOOL[n] && TOOL[n].act === act, `${n} is there with act: ${act}`);
  for (const t of STORYTELLER_TOOLS) {
    ok(typeof t.desc === 'string' && t.desc.length > 20 && t.desc.length <= 1024, `${t.name} has a description (<= 1024 characters)`);
    ok(typeof t.handler === 'function', `${t.name} has a handler`);
    for (const [k, a] of Object.entries(t.args || {})) {
      ok(['string', 'integer', 'number', 'array', 'object'].includes(a.type), `${t.name}.${k} has a type`);
      ok(typeof a.desc === 'string' && a.desc.length > 5, `${t.name}.${k} has a description`);
    }
  }
  ok(['decide', 'fallback', 'close_vote', 'end_day'].every(n => TOOL[n].args.reason && !TOOL[n].args.reason.optional), 'decide, fallback, close_vote and end_day require a reason');
  ok(!STORYTELLER_TOOLS.some(t => /whisper|tell_seat|private|set_role|revive|resurrect/.test(t.name)), 'no tool speaks to one player or changes a rule');
  const stub = TOOL.look.handler({}, {seat: {id: 0, name: 'Storyteller'}});
  ok(stub.ok && stub.phase === 'no game yet', 'look answers plainly with no game behind the relay');
  ok(TOOL.decide.handler({value: 'x', reason: REASON}, {}).ok === false, 'an act with no game is refused');
}

section('the prompt');
{
  ok(systemFor('storyteller') === STORYTELLER_SYSTEM, 'systemFor(storyteller) is the Storyteller\'s prompt');
  ok(/Storyteller of/.test(STORYTELLER_SYSTEM), 'the prompt keeps "Storyteller of" (the mock providers know the turn by it)');
  for (const n of STORYTELLER_TOOL_NAMES) ok(new RegExp(`\\b${n}\\b`).test(STORYTELLER_SYSTEM), `the prompt names ${n}`);
  ok(/reason/i.test(STORYTELLER_SYSTEM) && /never play a seat/i.test(STORYTELLER_SYSTEM), 'the prompt asks for reasons and keeps the Storyteller off the seats');
  ok(systemFor('player', 'Bram').includes('Bram'), 'the player prompt is untouched in shape');
}

section('reasons');
{
  ok(reasonError('') && reasonError(undefined) && reasonError('because'), 'an empty or one-word reason is refused');
  ok(reasonError(REASON) === null, 'a sentence is a reason');
}

// ---- game A: the Drunk, the Fortune Teller, the Poisoner, a Recluse for the Investigator ----
// seats: 0 Odette imp, 1 Bram drunk, 2 Ines fortune-teller, 3 Corwin empath, 4 Thea poisoner, 5 Fitch investigator, 6 Yusuf recluse
section('setup: the Drunk\'s false role');
const api = fakeApi();
const A = newGame({seed: 3, roles: ['imp', 'drunk', 'fortune-teller', 'empath', 'poisoner', 'investigator', 'recluse']});
{
  ok(A.pending?.kind === 'believed-role', 'game A opens on the Drunk\'s false role');
  headerOk(A, api, 'believed-role', ['Waiting on you', 'Drunk', 'Bram', 'decide']);
  const w = call(A, api, 'what_is_asked');
  ok(w.ok && w.pending.kind === 'believed-role' && w.pending.about === 'Bram' && w.pending.options.some(o => /Chef/.test(o)), 'what_is_asked names the kind, the seat and the options');
  ok(!w.pending.options.some(o => /Empath|Fortune Teller|Investigator/.test(o)), 'roles in play are not offered');
  const r1 = call(A, api, 'decide', {value: 'Chef'});
  ok(!r1.ok && /reason/i.test(r1.error), 'decide refuses a missing reason');
  const r2 = call(A, api, 'decide', {value: 'Chef', reason: 'ok'});
  ok(!r2.ok && /too short/.test(r2.error), 'decide refuses a reason that is not a sentence');
  const r3 = call(A, api, 'decide', {value: 'Empath', reason: REASON});
  ok(!r3.ok && /not an option/.test(r3.error) && /Legal/.test(r3.error) && /Chef/.test(r3.error), 'decide refuses an illegal value and names the legal ones');
  const r4 = call(A, api, 'decide', {value: 'Wizard', reason: REASON});
  ok(!r4.ok && /neither/.test(r4.error), 'decide refuses a word it cannot read');
  ok(A.pending?.kind === 'believed-role', 'nothing changed after the refusals');
  const {ctx, logged} = ctxOf(A, api);
  const r5 = TOOL.decide.handler({value: 'chef', reason: 'A Chef claim gives the Drunk something to share on day one.'}, ctx);
  ok(r5.ok && r5.answer === 'Chef' && A.seats[1].believed === 'chef', 'decide answers with a legal value (any case)');
  ok(api.rulings().at(-1)?.reason === 'A Chef claim gives the Drunk something to share on day one.', 'the reason passes through to the api');
  ok(logged.some(l => l.type === 'storyteller-call' && l.reason && l.kind === 'believed-role'), 'the call is logged with its reason');
}

section('setup: the red herring');
{
  ok(A.pending?.kind === 'red-herring', 'then the red herring');
  headerOk(A, api, 'red-herring', ['red herring', 'Ines']);
  const bad = call(A, api, 'decide', {value: 'Odette', reason: REASON});
  ok(!bad.ok && /not an option/.test(bad.error), 'an evil seat cannot be the red herring');
  const r = call(A, api, 'decide', {option: 3, reason: 'Corwin talks a lot, so a false ping on him keeps the day lively.'});
  ok(r.ok && A.seats[3].tokens.some(t => t.token === 'red-herring'), 'decide by option number (#3 is Corwin)');
}

section('first night: a player\'s own choice is not the Storyteller\'s');
{
  ok(A.pending?.kind === 'choose' && A.pending.seat === 4, 'the Poisoner chooses');
  const h = headerOk(A, api, 'choose', ['Waiting on Thea (Poisoner)', 'night_order']);
  ok(!/Waiting on you/.test(h), 'the header does not put a player\'s choice on the Storyteller');
  const r = call(A, api, 'decide', {value: 'Corwin', reason: REASON});
  ok(!r.ok && /Nothing waits on you/.test(r.error) && /Thea/.test(r.error), 'decide is refused and says who the game waits on');
  const f = call(A, api, 'fallback', {reason: REASON});
  ok(!f.ok && /Nothing waits on you/.test(f.error), 'fallback is refused too');
  const no = call(A, api, 'night_order');
  ok(no.ok && no.order.length && no.order.find(o => o.now)?.role === 'Poisoner', 'night_order names who is now');
  const g = call(A, api, 'grimoire');
  ok(g.ok && g.seats[1].role === 'Drunk' && g.seats[1].believes === 'Chef' && g.seats[3].tokens.some(t => t.token === 'red-herring'), 'grimoire shows true and believed roles and tokens');
  engineAnswer(A, 3); // Thea poisons Corwin, the Empath
  ok(call(A, api, 'grimoire').seats[3].tokens.some(t => t.token === 'poisoned' && t.placedBy === 'Thea'), 'the grimoire says who placed a token');
}

section('first night: the demon\'s bluffs');
{
  until(A, s => s.pending?.kind === 'demon-bluffs');
  ok(A.pending?.kind === 'demon-bluffs' && A.pending.count === 3, 'the demon\'s bluffs: pick three');
  headerOk(A, api, 'demon-bluffs', ['bluffs', 'exactly 3']);
  const r1 = call(A, api, 'decide', {value: '#1, #2', reason: REASON});
  ok(!r1.ok && /exactly 3/.test(r1.error), 'two picks are refused');
  const r2 = call(A, api, 'decide', {value: '#1, #1, #2', reason: REASON});
  ok(!r2.ok && /differ/.test(r2.error), 'a repeated pick is refused');
  const r3 = call(A, api, 'decide', {option: 2, reason: REASON});
  ok(!r3.ok && /Pick 3/.test(r3.error), 'one option number is refused for three picks');
  const [a, b, c] = A.pending.options.slice(0, 3).map(id => SCRIPT.roles.find(r => r.id === id).name);
  const r4 = call(A, api, 'decide', {value: `${a}, ${b}, ${c}`, reason: 'Three safe townsfolk give the demon room to hide.'});
  ok(r4.ok && A.bluffs.length === 3, `three roles by name (${r4.answer})`);
}

section('first night: a registering question');
{
  until(A, s => s.pending?.kind === 'register' || s.pending?.kind === 'info');
  ok(A.pending?.kind === 'register' && A.pending.subject === 6, 'the Recluse may register as a minion to the Investigator');
  headerOk(A, api, 'register', ['how a role registers', 'Yusuf', 'Truth: Recluse']);
  const w = call(A, api, 'what_is_asked');
  ok(w.pending.truth.startsWith('Recluse') && w.pending.why === 'to the Investigator', 'what_is_asked gives the truth and why it is asked');
  const r = call(A, api, 'decide', {value: 'Poisoner', reason: 'The Recluse showing as the Poisoner muddies a clean read.'});
  ok(r.ok && A.seats[6].tokens.some(t => t.token === 'registers-as'), 'the Recluse registers as the Poisoner');
}

section('first night: information with the ability working');
{
  ok(A.pending?.kind === 'info' && A.pending.role === 'investigator' && !A.pending.malfunctioning, 'the Investigator learns, ability working');
  ok(A.pending.options.length === A.pending.truth.length, 'only the true statements are legal');
  headerOk(A, api, 'info working', ['night information', 'Fitch', 'Truth:']);
  const lie = call(A, api, 'decide', {value: 'Ines, Corwin, Poisoner', reason: REASON});
  ok(!lie.ok && /not an option/.test(lie.error), 'a false statement is refused while the ability works');
  const t = A.pending.truth[0], names = [...t.players.map(i => A.seats[i].name), SCRIPT.roles.find(r => r.id === t.role).name];
  const r = call(A, api, 'decide', {value: names.join(', '), reason: 'Working ability, so a true ping with the Recluse in it.'});
  ok(r.ok && /one of .* is the/.test(r.answer), `a true statement in words (${r.answer})`);
}

section('first night: information while drunk, and the scripted fallback');
{
  until(A, s => s.pending?.kind === 'info');
  ok(A.pending?.role === 'chef' && A.pending.malfunctioning && A.pending.subject === 1, 'the Drunk believes it is the Chef and malfunctions');
  headerOk(A, api, 'info drunk', ['Bram is the Drunk']);
  const w = call(A, api, 'what_is_asked');
  ok(w.pending.malfunctioning && /any option is legal/.test(w.pending.note), 'what_is_asked says any option is legal');
  const expect = createScripted(A.config.seed)(A);
  const f1 = call(A, api, 'fallback', {});
  ok(!f1.ok && /reason/i.test(f1.error), 'fallback refuses a missing reason');
  const before = A.answers.length;
  const f = call(A, api, 'fallback', {reason: 'Nothing better to do with the Chef, so the default stands.'});
  ok(f.ok && f.scripted && A.answers[before] === expect, `fallback picks the scripted default (${expect})`);
  ok(/^Scripted default: /.test(api.rulings().at(-1).reason), 'the ruling says it was the scripted default');
}

section('first night: information while poisoned');
{
  until(A, s => s.pending?.kind === 'info');
  ok(A.pending?.role === 'empath' && A.pending.malfunctioning && A.pending.subject === 3, 'the Empath is poisoned');
  headerOk(A, api, 'info poisoned', ['Corwin is poisoned', 'Truth:']);
  const truth = A.pending.truth[0], lie = A.pending.options.find(o => o !== truth);
  const r = call(A, api, 'decide', {value: String(lie), reason: 'Poisoned, so a wrong count that points at the good neighbour.'});
  ok(r.ok && r.answer === String(lie), `a false count is legal while poisoned (${lie}, the truth is ${truth})`);
}

section('a long option list is grouped; the night count leaves out phase entries');
{
  const G = newGame({seed: 21, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  const api = fakeApi();
  const roles = SCRIPT.roles.filter(r => r.team === 'townsfolk').map(r => r.id);
  const options = [];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (const role of roles) options.push({players: [a, b], role});
  G.pending = {kind: 'info', seat: 'storyteller', role: 'washerwoman', subject: 3, malfunctioning: true, truth: [options[0]], options, question: 'Washerwoman: which two?'};
  const w = call(G, api, 'what_is_asked');
  ok(w.ok && w.pending.count === options.length && options.length > 24, `the long list is counted whole (${w.pending.count})`);
  ok(w.pending.options.length <= 7 && w.pending.options.every(l => /#\d+/.test(l)), `grouped by seat: ${w.pending.options.length} lines, option numbers kept`);
  ok(/^\S.*: .*\(with .* #\d+/.test(w.pending.options[0]) && /Washerwoman|Chef|Empath/.test(w.pending.options[0]), `by role inside a seat: ${w.pending.options[0].slice(0, 90)}`);
  ok(JSON.stringify(w.pending).length < JSON.stringify(call(G, api, 'what_is_asked', {full: true}).pending).length / 2, 'the grouped answer is less than half the length');
  const f = call(G, api, 'what_is_asked', {full: true});
  ok(f.pending.options.length === options.length && f.pending.options[0].startsWith('#1 '), 'full: true keeps the whole numbered list');
  ok(call(G, api, 'what_is_asked', {full: 'true'}).pending.options.length === options.length, 'full: "true" works too');
  const short = {...G.pending, options: options.slice(0, 24)};
  G.pending = short;
  ok(call(G, api, 'what_is_asked').pending.options.length === 24, 'a list of 24 or fewer stays numbered');
  G.pending = null;

  const N = newGame({seed: 22, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  const evs = [{id: 1, type: 'phase', text: 'Night falls.'}, {id: 2, type: 'dawn', text: 'x'}, {id: 3, type: 'say', seat: 0, text: 'hi'}];
  const napi = {...api, events: () => evs};
  N.phase = 'night'; N.night = 1;
  const h1 = header(N, napi);
  ok(/Since your last turn: 1 said, 0 whispers seen, 1 other events/.test(h1), `at night the phase entry is not counted: ${h1.split(String.fromCharCode(10)).find(l => /Since/.test(l))}`);
}

// ---- game B: the Mayor and a star pass ----
section('the Mayor\'s bounce');
{
  const api2 = fakeApi();
  const B = newGame({seed: 5, roles: ['imp', 'mayor', 'poisoner', 'spy', 'chef', 'empath', 'soldier']});
  until(B, s => s.pending?.kind === 'choose' && s.pending.role === 'imp');
  engineAnswer(B, 1);
  until(B, s => s.pending?.kind === 'mayor-bounce');
  ok(B.pending?.kind === 'mayor-bounce', 'the demon attacks the Mayor');
  headerOk(B, api2, 'mayor-bounce', ['Mayor', 'Truth: Bram dies']);
  const r = call(B, api2, 'decide', {value: 'Odette', reason: REASON});
  ok(!r.ok && /not an option/.test(r.error), 'the attacking demon is not a legal landing');
  const ok2 = call(B, api2, 'decide', {value: 'Fitch', reason: 'The Mayor living longer keeps good in the game.'});
  ok(ok2.ok && !B.seats[5].alive && B.seats[1].alive, 'the kill lands on Fitch instead');
}
section('the star pass');
{
  const api3 = fakeApi();
  const C = newGame({seed: 5, roles: ['imp', 'mayor', 'poisoner', 'spy', 'chef', 'empath', 'soldier']});
  until(C, s => s.pending?.kind === 'choose' && s.pending.role === 'imp');
  engineAnswer(C, 0);
  until(C, s => s.pending?.kind === 'star-pass');
  ok(C.pending?.kind === 'star-pass' && C.pending.options.length === 2, 'the Imp kills itself with two minions alive');
  headerOk(C, api3, 'star-pass', ['which minion becomes the demon', 'Legal (2 options offered, pick one): #1 Ines; #2 Corwin']);
  const r = call(C, api3, 'decide', {value: 'Thea', reason: REASON});
  ok(!r.ok, 'a townsfolk cannot take the star pass');
  const r2 = call(C, api3, 'decide', {value: 'Corwin', reason: 'The Spy as the demon keeps evil hidden longer.'});
  ok(r2.ok && C.seats[3].role === 'imp', 'the Spy becomes the Imp');
}

// ---- a day with talk and a vote ----
section('a day: talk, nominations and a vote');
{
  const api4 = fakeApi();
  const D = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  until(D, s => s.phase === 'day' && s.pending?.kind === 'nomination');
  D.clock = {round: 1, roundsBeforeNominations: 3, nominationsOpen: false};
  api4._say(D, 1, 'I am the Mayor and I trust nobody yet.');
  api4._whisper(D, 3, 4, 'secret plan XYZZY: I am the Washerwoman');
  api4._say(D, 2, 'Let us hear from everyone.');
  const h1 = headerOk(D, api4, 'day', ['Day 1', 'round 1 of 3', '2 said', '1 whispers seen', 'open_nominations']);
  ok(!h1.includes('XYZZY'), 'the header carries no whisper text');
  ok(/Since your last turn: 0 said/.test(header(D, api4)), 'the next header counts from the last one');
  const t = call(D, api4, 'talk');
  ok(t.ok && t.events.length === 3 && t.events.some(e => e.line === '(Corwin whispers to Thea)'), 'talk shows the whisper as a mark');
  ok(!JSON.stringify(t).includes('XYZZY'), 'talk carries no whisper text');
  ok(call(D, api4, 'talk', {since: 2}).events.length === 2, 'talk since an id');
  const n1 = call(D, api4, 'narrate', {text: 'The Mayor slept well.'});
  ok(!n1.ok && /Mayor/.test(n1.error), 'narration may not name a role in play while the game runs');
  const n2 = call(D, api4, 'narrate', {text: 'Morning on the Square. Nobody died in the night.'});
  ok(n2.ok && call(D, api4, 'talk').events.some(e => e.type === 'narration'), 'narration reaches the table');
  ok(!call(D, api4, 'narrate', {text: 'x'.repeat(601)}).ok && !call(D, api4, 'narrate', {text: '  '}).ok, 'narration too long or empty is refused');
  ok(call(D, api4, 'open_nominations', {reason: 'The talk has gone round twice.'}).ok && D.clock.nominationsOpen, 'open_nominations opens them');
  ok(!call(D, api4, 'open_nominations').ok, 'opening twice is refused');
  ok(call(D, api4, 'night_order').ok, "by day the night order is the coming night's");
  ok(!call(D, api4, 'close_vote', {reason: REASON}).ok, 'close_vote with no vote open is refused');
  engineAnswer(D, {by: 1, target: 2});
  ok(D.pending?.kind === 'vote', 'a vote is open');
  D.ballot = {id: D.pending.id, nominee: 2, votes: {0: true, 1: true}};
  headerOk(D, api4, 'vote', ['Vote on Ines (by Bram): 2 of 7 voted, 2 yes, 4 needed', 'close_vote']);
  const ds = call(D, api4, 'day_state');
  ok(ds.ok && ds.voteOpen?.nominee === 'Ines' && ds.clock.nominationsOpen, 'day_state shows the open vote and the clock');
  ok(!call(D, api4, 'end_day', {reason: REASON}).ok, 'end_day is refused while a vote is open');
  ok(!call(D, api4, 'close_vote', {}).ok, 'close_vote refuses a missing reason');
  const cv = call(D, api4, 'close_vote', {reason: 'Five seats have sat silent for two rounds.'});
  ok(cv.ok && D.pending?.kind === 'nomination' && D.today.votes.at(-1).tally === 2, 'close_vote counts the missing as no');
  const ds2 = call(D, api4, 'day_state');
  ok(ds2.nominations.length === 1 && ds2.nominations[0].yes.join() === 'Odette,Bram', 'day_state lists the nomination and its yes votes');
  ok(!call(D, api4, 'end_day', {}).ok, 'end_day refuses a missing reason');
  const ed = call(D, api4, 'end_day', {reason: 'Nobody else wants to nominate today.'});
  ok(ed.ok && D.phase === 'night', 'end_day ends the day');
  ok(!call(D, api4, 'open_nominations').ok, 'no nominations by night');
  const rl = call(D, api4, 'rulings');
  ok(rl.ok && rl.rulings.length >= 2 && rl.rulings.every(r => r.reason), 'rulings lists every call with its reason');
}

// ---- a game ended ----
section('a game ended');
{
  const api5 = fakeApi();
  const E = newGame({seed: 9, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  const s = createScripted(9);
  playOut(E, s, {maxDays: 30});
  ok(!!E.winner && !E.pending, `the game ends (${E.winner?.text})`);
  headerOk(E, api5, 'ended', ['The game is over', 'narrate']);
  ok(!call(E, api5, 'decide', {value: 'x', reason: REASON}).ok, 'decide is refused after the end');
  ok(call(E, api5, 'narrate', {text: 'Odette was the Imp all along. The town sleeps.'}).ok, 'at the end narration may name roles');
  ok(call(E, api5, 'look').ok && call(E, api5, 'grimoire').ok, 'the reads still answer');
}

// ---- refusals pass through ----
section('api refusals pass through');
{
  const g = newGame({seed: 3, roles: ['imp', 'drunk', 'fortune-teller', 'empath', 'poisoner', 'investigator', 'recluse']});
  const boom = {...fakeApi(), answer() {throw new ApiError('The engine says no: pick one of Chef, Mayor.')}, grimoire() {throw new ApiError('The grimoire is closed.')}};
  const r = call(g, boom, 'decide', {value: 'Chef', reason: REASON});
  ok(!r.ok && /The engine says no/.test(r.error) && /Legal/.test(r.error), 'an ApiError from answer comes back as {ok: false, error} with the legal options');
  const gr = call(g, boom, 'grimoire');
  ok(!gr.ok && gr.error === 'The grimoire is closed.', 'an ApiError from a read comes back as {ok: false, error}');
  ok(resolveValue(g, g.pending, '[1,2]').error, 'raw JSON that is not an option is refused');
}

// ---- integration: a real game through the real api, bound to the Storyteller ----
section('integration: a real newGame through src/game/api.js');
{
  const st = realApi.forSeat('storyteller');
  const G = newGame({seed: 3, roles: ['imp', 'drunk', 'fortune-teller', 'empath', 'poisoner', 'investigator', 'recluse']});
  const say = (r, what) => {ok(r && r.ok, `${what}${r && !r.ok ? ': ' + r.error : ''}`); return r};
  const h0 = storytellerHeader(G);
  ok(/Waiting on you: the Drunk's false role/.test(h0) && h0.length <= HEADER_CAP, 'the header with the real api (its default) names the decision');
  ok(!call(G, st, 'decide', {value: 'Chef'}).ok, 'the real api path: decide refuses a missing reason');
  say(call(G, st, 'decide', {value: 'Chef', reason: 'A Chef claim gives the Drunk something to share.'}), "the Drunk's false role through the real api");
  say(call(G, st, 'decide', {value: 'Corwin', reason: 'Corwin as the red herring keeps the Fortune Teller guessing.'}), 'the red herring through the real api');
  const blocked = call(G, st, 'decide', {value: 'Corwin', reason: REASON});
  ok(!blocked.ok && /Thea/.test(blocked.error), "the Poisoner's choice is not the Storyteller's");
  realApi.answer(G, 4, 3); // Thea poisons Corwin, as a player through the api
  const bl = G.pending.options.slice(0, 3).map(id => SCRIPT.roles.find(r => r.id === id).name).join(', ');
  say(call(G, st, 'decide', {value: bl, reason: 'Three plain townsfolk give the demon easy cover.'}), "the demon's bluffs through the real api");
  ok(G.pending?.kind === 'register', 'the Recluse register question waits');
  say(call(G, st, 'decide', {option: 1, reason: 'The Recluse registers as itself this time.'}), 'a registering answer by option number');
  ok(G.pending?.kind === 'info' && G.pending.role === 'investigator', "the Investigator's information waits");
  const wi = call(G, st, 'what_is_asked');
  ok(wi.ok && wi.pending.truth && !wi.pending.malfunctioning, 'what_is_asked shows the truth through the real api');
  say(call(G, st, 'decide', {option: 1, reason: 'A true ping for a working Investigator.'}), 'night information through the real api');
  ok(G.log.some(e => e.type === 'told' && e.what === 'investigator'), 'the engine told the Investigator');
  const no = call(G, st, 'night_order');
  ok(no.ok && no.order.some(o => o.status === 'done') && no.order.some(o => o.now), 'night_order reads the real order with its status');
  say(call(G, st, 'fallback', {reason: 'Nothing better for the Drunk tonight than the default.'}), 'the scripted fallback through the real api');
  while (G.pending && G.phase !== 'day') {
    if (G.pending.seat === 'storyteller') call(G, st, 'fallback', {reason: 'The rest of the first night runs on the default.'});
    else realApi.answer(G, G.pending.seat, G.pending.count ? G.pending.options.filter(x => x !== G.pending.seat).slice(0, G.pending.count) : G.pending.options.find(x => x !== G.pending.seat));
  }
  ok(G.phase === 'day' && G.day === 1, 'day one breaks');
  ok(!call(G, st, 'narrate', {text: 'The Empath slept badly.'}).ok, 'a dawn narration naming a role is refused');
  say(call(G, st, 'narrate', {text: 'Dawn on the Square. Everyone woke up, which is more than can be said for most weeks.'}), 'narrate at dawn');
  const hd = storytellerHeader(G);
  ok(/Day 1, round 1 of 3, nominations closed/.test(hd) && hd.length <= HEADER_CAP, 'the day header has the clock');
  const tk = call(G, st, 'talk');
  ok(tk.ok && tk.events.some(e => e.type === 'narration') && !tk.events.some(e => ['told', 'ruling', 'wake'].includes(e.type)), 'talk shows what the table heard and nothing private');
  say(call(G, st, 'open_nominations', {reason: 'A quiet table, so the vote comes early.'}), 'open_nominations');
  ok(G.clock.nominationsOpen, 'nominations are open');
  realApi.nominate(G, 0, 1); realApi.vote(G, 0, true); realApi.vote(G, 2, true);
  ok(G.pending?.kind === 'vote', 'a vote is open with two of seven cast');
  ok(/Vote on Bram \(by Odette\): 2 of 7 voted, 2 yes, 4 needed/.test(storytellerHeader(G)), 'the header counts the real ballot');
  ok(!call(G, st, 'end_day', {reason: REASON}).ok, 'end_day is refused while the vote is open');
  say(call(G, st, 'close_vote', {reason: 'Five players sat on their hands for too long.'}), 'close_vote');
  ok(G.pending?.kind === 'nomination', 'the vote is counted and nominations go on');
  say(call(G, st, 'end_day', {reason: 'Nobody else wants to nominate today.'}), 'end_day');
  ok(G.phase === 'night' && G.night === 2, 'night two falls');
  const rl = call(G, st, 'rulings').rulings;
  ok(rl.length >= 9 && rl.every(r => r.reason) && rl.some(r => r.kind === 'close-vote') && rl.some(r => r.kind === 'end-day'), `every call is a ruling with its reason (${rl.length})`);
  ok(rl.some(r => /^Scripted default: /.test(r.reason)), "the fallback's ruling says so");
  ok(!call(G, st, 'decide', {value: 'Bram', reason: REASON}).ok || G.pending?.seat === 'storyteller', 'decide is refused when nothing waits');
}

// ---- game 1 fixes (#34, #35, #36): the true clock, honest reasons, a narrated dawn ----
section('narration against the clock (#34)');
{
  const api = fakeApi();
  const D = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  until(D, s => s.phase === 'day' && s.pending?.kind === 'nomination');
  D.clock = {round: 2, roundsBeforeNominations: 3, nominationsOpen: false};
  const h = header(D, api);
  ok(/Clock fact for narration: nominations are CLOSED \(they open when round 3 is done; it is round 2\)/.test(h), `the header states the clock fact in words\n${h}`);
  const n1 = call(D, api, 'narrate', {text: 'Day 2 breaks over the square. Nominations are open.'});
  ok(!n1.ok && /CLOSED/.test(n1.error) && n1.error.length < 200, `"Nominations are open" while closed is refused, naming the truth (${n1.error})`);
  ok(call(D, api, 'narrate', {text: 'The tower holds its breath; nominations are not open yet.'}).ok, 'a line that says they are not open yet passes');
  D.clock.nominationsOpen = true;
  const open = header(D, api);
  ok(/nominations are OPEN/.test(open), 'the header says OPEN once they are');
  ok(!call(D, api, 'narrate', {text: 'Nominations are closed for now.'}).ok, 'a "closed" line while open is refused');
  ok(call(D, api, 'narrate', {text: 'The clerk opens the book: nominations are open.'}).ok, 'the true line passes');
  ok(/nominations are OPEN/.test(call(D, api, 'narrate', {text: 'The hour hangs.'}).clock), 'the narrate result carries the clock');
  // deaths and executions
  D.diedTonight = [2]; D.today = {...(D.today || {}), executed: null}; D.executed = [];
  const who = D.seats[2].name, other = D.seats[3].name;
  const d1 = call(D, api, 'narrate', {text: `Dawn comes grey. ${other} died in the night.`});
  ok(!d1.ok && d1.error.includes(who) && d1.error.length < 200, `a wrong death is refused, naming the truth (${d1.error})`);
  const d2 = call(D, api, 'narrate', {text: 'Dawn comes grey. Nobody died in the night.'});
  ok(!d2.ok && d2.error.includes(who), 'nobody died, when someone did, is refused');
  ok(call(D, api, 'narrate', {text: `Dawn comes grey, and ${who} died in the night.`}).ok, 'the true death passes');
  D.diedTonight = [];
  ok(call(D, api, 'narrate', {text: 'Dawn comes grey. Nobody died in the night.'}).ok, 'nobody died passes when so');
  D.executed = [{day: 1, seat: 3, role: 'chef', how: 'vote'}]; D.today = {...D.today, executed: 3};
  ok(!call(D, api, 'narrate', {text: `${who} was executed at dusk.`}).ok, 'a wrong execution is refused');
  ok(!call(D, api, 'narrate', {text: 'Nobody was executed at dusk.'}).ok, 'nobody executed, when someone was, is refused');
  ok(call(D, api, 'narrate', {text: `${other} was executed at dusk; the tower did not strike.`}).ok, 'the true execution passes');
}

section('reasons against the facts (#35)');
{
  const api = fakeApi();
  const W = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  until(W, s => s.pending?.kind === 'info' && s.pending.role === 'washerwoman');
  const p = W.pending;
  ok(p.options.length > 1 && !p.malfunctioning, `the Washerwoman has ${p.options.length} true options`);
  const h = header(W, api);
  ok(h.includes(`Legal (${p.options.length} options offered, pick one)`), `the header's Legal line says the count\n${h}`);
  ok(new RegExp(`${p.options.length} options offered`).test(call(W, api, 'what_is_asked').pending.offered), 'what_is_asked states the option count plainly');
  const r = call(W, api, 'decide', {option: 3, reason: 'The ability works, and this is the only legal option offered.'});
  ok(!r.ok && r.error.includes(`${p.options.length} options offered`), `"the only legal option" with several options is refused (${r.error})`);
  const r2 = call(W, api, 'decide', {option: 3, reason: 'The ability is poisoned, so I pick this one to mislead.'});
  ok(!r2.ok && /works/.test(r2.error), `"poisoned" when the ability works is refused (${r2.error})`);
  ok(W.pending === p, 'a refused reason changes nothing');
  const r3 = call(W, api, 'decide', {option: 3, reason: 'The ability works; this pair is a good decoy because Thea can bluff.'});
  ok(r3.ok, 'an honest reason passes');
  const one = {kind: 'info', options: ['x'], malfunctioning: false}, bad = {kind: 'info', options: ['x', 'y'], malfunctioning: true, subject: 3};
  ok(reasonFactsError(W, one, 'The only legal option offered, and the truth.') === null, 'the only option claim is fine for one option');
  ok(/works/.test(reasonFactsError(W, bad, 'The ability works so the truth is given.')), 'an "ability works" claim is refused when poisoned');
  ok(reasonFactsError(W, bad, 'Poisoned, so a plausible lie hurts the town.') === null, 'a "poisoned" claim passes when poisoned');
  ok(reasonFactsError(W, {kind: 'info', options: ['x', 'y'], malfunctioning: false}, 'The Empath is not poisoned, so the truth is given.') === null, '"not poisoned" passes when it works');
  ok(/only option/.test(STORYTELLER_SYSTEM) && /never say "the only option"/.test(STORYTELLER_SYSTEM), 'the prompt asks for true reasons');
}

section('a narrated dawn (#36)');
{
  const api = fakeApi();
  const D = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  until(D, s => s.phase === 'day' && s.pending?.kind === 'nomination');
  D.clock = {round: 1, roundsBeforeNominations: 3, nominationsOpen: false};
  api._push(D, {type: 'dawn', deaths: []});
  const h = header(D, api);
  ok(/^DAWN NOT YET NARRATED \(Day 1\): nobody died in the night/.test(h) && h.includes(touchFor(D.config.seed, 1)), `the header opens with the dawn call and a touch of the town\n${h}`);
  ok(/Now: narrate,/.test(h), 'the Now line puts narrate first at dawn');
  ok(h.length <= HEADER_CAP, `the dawn header is under the cap (${h.length})`);
  api._say(D, 1, 'Good morning.');
  ok(/DAWN NOT YET NARRATED/.test(header(D, api)), 'talk does not clear the flag');
  ok(call(D, api, 'narrate', {text: 'Grey light on the square, and the tower keeps its silence. Everyone is breathing.'}).ok, 'the dawn is narrated');
  const h2 = header(D, api);
  ok(!/DAWN NOT YET NARRATED/.test(h2), 'the flag clears once narrated');
  ok(/narrate/.test(STORYTELLER_SYSTEM) && /every dawn/.test(STORYTELLER_SYSTEM) && /Thistlewick/.test(STORYTELLER_SYSTEM) && /only reads/.test(STORYTELLER_SYSTEM), 'the prompt asks for a narrated dawn with colour and for acting turns');
}

section('a dawn with one touch of the town, acting first (#70)');
{
  // the colour table: seeded, never repeating within a game, different between seeds
  ok(DAWN_TOUCHES.length >= 12 && DUSK_TOUCHES.length >= 8, `a dozen dawn touches (${DAWN_TOUCHES.length}) and some dusk ones (${DUSK_TOUCHES.length})`);
  let repeats = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const dawns = DAWN_TOUCHES.map((_, k) => touchFor(seed, k + 1)), dusks = DUSK_TOUCHES.map((_, k) => touchFor(seed, k + 1, 'dusk'));
    if (new Set(dawns).size !== dawns.length || new Set(dusks).size !== dusks.length) repeats++;
  }
  ok(repeats === 0, 'no touch repeats within a game, dawn or dusk, over seeds 1-50');
  ok(touchFor(23, 2) === touchFor(23, 2) && touchFor(23, 2, 'dusk') === touchOrder(23, 'dusk')[1], 'the same seed and day give the same touch');
  const orders = new Set(Array.from({length: 20}, (_, k) => touchOrder(k + 1).join('|')));
  ok(orders.size >= 18, `the order differs by seed (${orders.size} orders over 20 seeds)`);
  ok(touchOrder(1).slice(0, 3).join('|') !== touchOrder(2).slice(0, 3).join('|'), 'seeds 1 and 2 open differently');
  ok(DAWN_TOUCHES.concat(DUSK_TOUCHES).every(t => !/thirteen|imp\b|demon|minion|poison|drunk/i.test(t)), 'no touch hints at a role or the rules');

  const api = fakeApi();
  const D = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  until(D, s => s.phase === 'day' && s.pending?.kind === 'nomination');
  D.clock = {round: 1, roundsBeforeNominations: 3, nominationsOpen: false, spoke: [], passedNominating: []};
  // a death dawn: the dead neighbour, the day, the touch, the two sentences
  D.diedTonight = [5];
  api._push(D, {type: 'dawn', deaths: [5]});
  const h = header(D, api), dead = D.seats[5].name;
  ok(h.startsWith(`DAWN NOT YET NARRATED (Day ${D.day}): ${dead} died in the night`), `the dawn call is the header's first line, with the death\n${h}`);
  ok(h.includes(touchFor(D.config.seed, D.day)) && /Exactly two sentences/.test(h), 'the makings carry the touch and ask for two sentences');
  ok(new RegExp(`sentence about the person: ${dead} as a neighbour`).test(h) && /never a role/.test(h), 'a death asks for a sentence about the person');
  ok(/Now: narrate, talk, open_nominations\. Act first: narrate is due/.test(h), 'the Now line leads with narrate at dawn');
  ok(storytellerDue(D, api)?.tool === 'narrate', 'storytellerDue names narrate at an unnarrated dawn');
  ok(call(D, api, 'look').useful[0] === 'narrate', 'look leads with narrate too');
  ok(call(D, api, 'narrate', {text: `${dead} was found by the pump at first light, coat buttoned wrong. The heron kept to the millpond and did not look round.`}).ok, 'the death dawn is narrated');
  // mid-day, nothing due
  const hq = header(D, api);
  ok(/Now: talk, open_nominations, end_day\. Nothing is due from you/.test(hq) && /only reads is wasted/.test(hq), `with nothing due the Now line says a reading turn is wasted\n${hq}`);
  ok(storytellerDue(D, api) === null, 'storytellerDue is null when nothing waits');
  // the day is done: every living seat nominated or passed
  D.clock.nominationsOpen = true; D.clock.passedNominating = D.seats.filter(x => x.alive).map(x => x.index);
  ok(/Now: end_day, day_state\. Act first: end_day is due/.test(header(D, api)), 'the Now line leads with end_day when every living seat has nominated or passed');
  ok(storytellerDue(D, api)?.tool === 'end_day', 'storytellerDue names end_day then');
  D.clock.passedNominating = [];
  // an execution not yet narrated, at night with a decision waiting
  const E = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  until(E, s => s.night === 2 && s.pending?.seat === 'storyteller');
  const eapi = fakeApi();
  E.executed = [{day: 1, seat: 3, role: 'washerwoman', how: 'vote'}];
  eapi._push(E, {type: 'execution', seat: 3, day: 1});
  const he = header(E, eapi);
  ok(he.startsWith(`EXECUTION NOT YET NARRATED: ${E.seats[3].name} was executed at dusk on Day 1`) && he.includes(touchFor(E.config.seed, 1, 'dusk')), `the execution call leads, with a dusk touch\n${he}`);
  ok(/Now: narrate, decide, what_is_asked\. Act first: narrate is due/.test(he), 'with a decision waiting too, narrate leads, then decide');
  ok(call(E, eapi, 'narrate', {text: `${E.seats[3].name} was executed at dusk, and the lamps on Lamp Row came on behind the crowd.`}).ok, 'the execution is narrated');
  const hd = header(E, eapi);
  ok(!/NOT YET NARRATED/.test(hd) && /Now: decide, what_is_asked, fallback\. Act first: decide is due/.test(hd), `then decide leads\n${hd}`);
  ok(toolsNow(E, true, false)[0] === 'decide', 'toolsNow leads with decide when asked');
  // the end
  const W = newGame({seed: 7, roles: ['imp', 'mayor', 'poisoner', 'washerwoman', 'chef', 'empath', 'soldier']});
  playOut(W, quiet, {override: spare, maxDays: 10});
  const wapi = fakeApi();
  if (W.winner) {
    wapi._push(W, {type: 'win', text: W.winner.text});
    const hw = header(W, wapi);
    ok(/^THE END NOT YET NARRATED/.test(hw) && /Now: narrate, rulings\. Act first/.test(hw), `the end is owed and narrate leads\n${hw}`);
    call(W, wapi, 'narrate', {text: 'That is the end of the week, and the tower kept its counsel.'});
    ok(/Nothing is due/.test(header(W, wapi)), 'once the end is narrated nothing is due');
  } else ok(false, 'the quiet game ends');
  // the prompt
  ok(/exactly two sentences/.test(STORYTELLER_SYSTEM) && /one touch of the town/.test(STORYTELLER_SYSTEM), 'the prompt asks for two sentences at dawn with one touch of the town');
  ok(/Every execution gets one sentence/.test(STORYTELLER_SYSTEM) && /end of the game\s+gets one sentence/.test(STORYTELLER_SYSTEM), 'the prompt gives executions and the end one sentence each');
  ok(/as a person/.test(STORYTELLER_SYSTEM) && /A turn that only reads is wasted/.test(STORYTELLER_SYSTEM) && /end_day/.test(STORYTELLER_SYSTEM), 'the prompt asks for the person in a death and for acting turns');
}

// ---- the header through the real api over whole seeded games: dawns and executions owed, the Now line kept ----
section('the header through the real api over seeds 1-20');
{
  let max = 0, owedSeen = 0, nowKept = true;
  for (let seed = 1; seed <= 20; seed++) {
    const g = newGame({seed}), sc = createScripted(seed);
    for (let n = 0; g.pending && n < 400; n++) {
      const h = storytellerHeader(g);
      if (/NOT YET NARRATED/.test(h)) owedSeen++;
      if (!/\nNow: [a-z_]+/.test(h)) nowKept = false;
      max = Math.max(max, h.length);
      engineAnswer(g, sc(g));
    }
  }
  ok(owedSeen > 0, `owed narrations appear in real games (${owedSeen} headers)`);
  ok(nowKept, 'every header ends with its Now line');
  ok(max > 0 && max <= HEADER_CAP, `the longest real header is ${max} characters (cap ${HEADER_CAP})`);
}

// ---- the header's length over whole seeded games ----
section('the header stays short over seeds 1-20');
{
  const quietApi = fakeApi();
  let max = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const g = newGame({seed}), sc = createScripted(seed);
    for (let n = 0; g.pending && n < 400; n++) {max = Math.max(max, header(g, quietApi).length); engineAnswer(g, sc(g))}
  }
  ok(max > 0 && max < HEADER_CAP, `the longest header is ${max} characters (cap ${HEADER_CAP})`);
}

console.log(fails ? `${fails} failed, ${passes} passed` : `all ${passes} checks pass`);
process.exit(fails ? 1 : 0);
