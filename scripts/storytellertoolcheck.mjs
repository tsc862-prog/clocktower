// npm run storytellertoolcheck: the Storyteller's tool table, header and prompt against a fake api (src/game/api.js's
// contract, E:/clocktower-ops/briefs/slice3-contract.md) over real engine states on fixed deals: the setup decisions (the
// Drunk's false role, the red herring, the demon's bluffs), a player's own choice (not the Storyteller's: decide is
// refused), information with the ability working (only the truth is legal), information while drunk and while poisoned,
// a registering question, the Mayor's bounce, the star pass, a day with a vote open, and a game ended. Exit 1 on any failure.
import {newGame, answer as engineAnswer, playOut, grimoire, createScripted} from '../src/game/index.js';
import {SCRIPT} from '../src/data/script.js';
import {STORYTELLER_TOOLS, STORYTELLER_TOOL_NAMES, reasonError, resolveValue} from '../src/data/storyteller-tools.js';
import {storytellerHeader, HEADER_CAP} from '../src/seats/storyteller.js';
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
      const ballot = g.ballot || {};
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
  ok(no.ok && no.order.length && no.order.find(o => o.next)?.role === 'Poisoner', 'night_order names who is next');
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
  headerOk(C, api3, 'star-pass', ['which minion becomes the demon', 'Legal (one option): #1 Ines; #2 Corwin']);
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
  ok(!call(D, api4, 'night_order').ok, 'no night order by day');
  ok(!call(D, api4, 'close_vote', {reason: REASON}).ok, 'close_vote with no vote open is refused');
  engineAnswer(D, {by: 1, target: 2});
  ok(D.pending?.kind === 'vote', 'a vote is open');
  D.ballot = {0: true, 1: true};
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
