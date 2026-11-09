// npm run playertoolcheck: the player seat's tools, header and prompt (slice 3 of issue #1). Every tool runs against a
// fake api with the contract's shapes (E:/clocktower-ops/briefs/slice3-contract.md) that plants secrets wherever a
// careless game side could leak them: another seat's role, a grimoire token, a Storyteller's reason, a whisper between
// two others, another seat's night information. In each usual state (night with a choice pending, day with talk, a vote
// open, dead with a ghost vote, dead without, nominations open, the game over) every answer and every header must carry
// none of them; refusals must name what is legal; the header stays under its length cap and names the decision waiting.
// Also: every tool's args have a type and a description, TOOL_NAMES matches the table, the system prompt names every
// tool, the no-repeating rule's message comes through, and nothing under src/ imports node:. Exit 1 on any failure.
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLAYER_TOOLS, TOOL_NAMES, ATTEMPT_INVITE} from '../src/data/player-tools.js';
import {PLAYER_TOOL_LINES, systemFor} from '../src/data/prompts.js';
import {playerHeader, whatsNew, useApi} from '../src/seats/player.js';
import * as api from '../src/game/api.js';
import {newGame, createScripted} from '../src/game/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)}};
const section = name => console.log(`- ${name}`);
const SECRET = /SECRET/;
const HEADER_CAP = 700;

// ---- the fake api ----
const NAMES = ['Odette', 'Bram', 'Ines', 'Corwin', 'Thea', 'Fitch', 'Yusuf'];
class ApiError extends Error {constructor(m) {super(`${m} You may look around.`); this.name = 'ApiError'}}
const say = (by, text, day = 1) => ({type: 'say', seat: by, text, day, audience: 'all', role: 'SECRET-ROLE-of-speaker'});

// A fake game in one of the usual states. me is seat 0 (Odette, the Fortune Teller).
function fakeGame(state) {
  const g = {state, phase: 'day', day: 1, night: 1, clock: {round: 2, roundsBeforeNominations: 3, nominationsOpen: false},
    seats: NAMES.map((name, index) => ({index, name, alive: true, ghostVote: true, role: index === 3 ? 'SECRET-ROLE-imp' : 'SECRET-ROLE-other'})),
    events: [], notes: {}, lines: {}, pending: {}, nominated: [], winner: null, calls: []};
  const ev = e => g.events.push({id: g.events.length, ...e});
  ev({type: 'phase', night: 1, text: 'Night falls.'});
  ev({type: 'told', seat: 0, night: 1, text: 'You are the Fortune Teller.'});
  ev({type: 'told', seat: 3, night: 1, text: 'SECRET-TOLD-OTHER: you are the Imp; your minion is Bram.'});
  ev({type: 'ruling', seat: 'storyteller', text: 'red herring', reason: 'SECRET-REASON-red-herring'});
  ev({type: 'token', seat: 2, token: 'SECRET-TOKEN-poisoned'});
  ev({type: 'phase', day: 1, text: 'Day breaks.'});
  ev({type: 'dawn', day: 1, text: 'Nobody died in the night.'});
  ev(say(1, 'Good morning. I am the Chef and I got a zero.'));
  ev(say(4, 'Fitch, you were quiet last night; why?'));
  ev({type: 'whisper', from: 2, to: 3, text: 'SECRET-WHISPER: I am the Poisoner, protect me', day: 1, audience: [2, 3]});
  ev({type: 'whisper-seen', from: 2, to: 3, day: 1, audience: 'all', text: 'SECRET-WHISPER leaked into the mark'});
  ev({type: 'whisper', from: 5, to: 0, text: 'Odette, I trust you. I am the Monk.', day: 1, audience: [5, 0]});
  if (state === 'night') {
    Object.assign(g, {phase: 'night', night: 2});
    ev({type: 'phase', night: 2, text: 'Night falls.'});
    g.pending[0] = {id: 9, kind: 'choose', seat: 0, role: 'fortune-teller', options: [0, 1, 2, 3, 4, 5, 6], count: 2,
      question: 'Odette (Fortune Teller): pick two players: is either the demon?', truth: 'SECRET-TRUTH-Corwin-is-the-demon', why: 'SECRET-REASON-why', redHerring: 'SECRET-TOKEN-red-herring'};
  }
  if (state === 'nominations') {
    g.clock = {round: 3, roundsBeforeNominations: 3, nominationsOpen: true};
    for (const i of [0, 1, 2, 3, 4, 5, 6]) g.pending[i] = {kind: 'nomination', targets: [0, 1, 2, 3, 4, 5, 6], options: [{by: 3, target: 0, why: 'SECRET-REASON-imp-plan'}]};
  }
  if (state === 'vote' || state === 'dead-ghost' || state === 'dead-spent') {
    g.clock = {round: 3, roundsBeforeNominations: 3, nominationsOpen: true};
    ev({type: 'nomination', by: 4, target: 5, day: 1, text: 'Thea nominates Fitch.'});
    for (const i of [0, 1, 2, 3, 4, 5, 6]) g.pending[i] = {kind: 'vote', nominee: 5, nominator: 4, voted: [4], mine: i === 4 ? true : null, seats: [0, 1, 2, 3, 4, 5, 6], truth: 'SECRET-TRUTH-Fitch-is-good'};
  }
  if (state === 'dead-ghost' || state === 'dead-spent') {
    g.day = 2; g.seats[0].alive = false; g.seats[0].ghostVote = state === 'dead-ghost';
    ev({type: 'dawn', day: 2, text: 'Odette died in the night.'});
  }
  if (state === 'ended') {
    Object.assign(g, {phase: 'ended', winner: {team: 'good', reason: 'SECRET-REASON-how', text: 'good wins'}});
    ev({type: 'execution', day: 1, target: 3, text: 'Corwin is executed.', role: 'SECRET-ROLE-imp'});
  }
  return g;
}

const need = (cond, text) => {if (!cond) throw new ApiError(text)};
const isDay = g => need(g.phase === 'day', 'It is night: nobody talks at night. Wait for the day.');
const fakeApi = {
  view(g, seat) {
    g.calls.push('view');
    const s = g.seats[seat];
    return {name: s.name, index: seat, role: {id: 'fortune-teller', name: 'Fortune Teller', team: 'townsfolk', ability: 'Each night, pick two players: you learn whether either is the demon.'},
      alive: s.alive, ghostVote: s.ghostVote, phase: g.phase, night: g.night, day: g.day, clock: {...g.clock},
      told: [{night: 1, what: 'role', text: 'You are the Fortune Teller.', why: 'SECRET-REASON-told'}],
      seats: g.seats.map(x => ({index: x.index, name: x.name, alive: x.alive, role: x.role, tokens: ['SECRET-TOKEN-x']})),
      today: {nominations: g.state === 'vote' ? [{by: 4, target: 5, yes: 1, needed: 4, result: null, why: 'SECRET-REASON-nom'}] : [], executed: null},
      dead: g.seats.filter(x => !x.alive).map(x => x.name), winner: g.winner, grimoire: 'SECRET-GRIMOIRE', bluffs: ['SECRET-BLUFF']};
  },
  pendingFor(g, seat) {g.calls.push('pendingFor'); return g.pending[seat] || null},
  events(g, seat, since = 0) {g.calls.push('events'); return g.events.filter(e => e.id > since)}, // ids from 0, like the api
  say(g, seat, text) {
    g.calls.push('say'); isDay(g);
    need(text && text.trim(), 'Say something: an empty line is not a line.');
    need(text.length <= 600, 'That is too long: keep it under 600 characters.');
    const mine = g.lines[seat] || (g.lines[seat] = []);
    need(!mine.slice(-3).includes(text), 'You said that already; say something new or pass.');
    mine.push(text);
    g.events.push({id: g.events.length, type: 'say', seat, text, day: g.day, audience: 'all'});
  },
  whisper(g, seat, to, text) {
    g.calls.push('whisper'); isDay(g);
    g.events.push({id: g.events.length, type: 'whisper', from: seat, to, text, day: g.day, audience: [seat, to]});
  },
  pass(g) {g.calls.push('pass')},
  nominate(g, seat, target) {
    g.calls.push('nominate');
    need(g.clock.nominationsOpen, 'Nominations are not open yet.');
    need(!g.nominated.includes(target), `${NAMES[target]} was nominated today already.`);
    g.nominated.push(target);
  },
  vote(g, seat, yes) {
    g.calls.push('vote');
    const s = g.seats[seat];
    need(s.alive || s.ghostVote, 'You are dead and your ghost vote is spent; you cannot vote. You may still speak by day.');
    g.pending[seat] = {...g.pending[seat], mine: yes};
  },
  answer(g, seat, value) {
    g.calls.push('answer');
    const p = g.pending[seat];
    need(p && p.kind === 'choose', 'Nothing is asked of you.');
    g.answered = value; delete g.pending[seat];
  },
  // the Slayer's standing shot (#37): g.shot[seat] while unspent
  dayActionFor(g, seat) {g.calls.push('dayActionFor'); return g.phase === 'day' && g.shot?.[seat] ? {...g.shot[seat]} : null},
  dayAction(g, seat, target) {
    g.calls.push('dayAction');
    need(g.shot?.[seat], 'You have no ability to use by day.');
    if (target === null) return {kept: true};
    delete g.shot[seat]; g.shotAt = target;
    g.events.push({id: g.events.length, type: 'slayer-shot', seat, target, day: g.day, audience: 'all', text: `${NAMES[seat]} claims the Slayer and shoots ${NAMES[target]}.`, truth: 'SECRET-TRUTH-not-the-demon'});
    return {used: 'slayer', target};
  },
  note(g, seat, text) {g.calls.push('note'); const n = g.notes[seat] || (g.notes[seat] = []); n.push({text, secret: 'SECRET-never-mind'}); if (n.length > 50) n.shift()},
  notes(g, seat) {g.calls.push('notes'); return [...(g.notes[seat] || [])]},
  // Storyteller only: a player's tool that calls these is a leak whatever it does with the answer
  grimoire(g) {g.calls.push('grimoire'); return 'SECRET-GRIMOIRE'},
  rulings(g) {g.calls.push('rulings'); return [{reason: 'SECRET-REASON'}]},
  nightOrder(g) {g.calls.push('nightOrder'); return ['SECRET-ORDER']},
};
const STORYTELLER_ONLY = ['grimoire', 'rulings', 'nightOrder'];
const ctxFor = (g, seat = 0) => ({game: g, seat: {index: seat, name: NAMES[seat]}, api: fakeApi, log: () => {}});
const tool = name => PLAYER_TOOLS.find(t => t.name === name);
const run = (g, name, args = {}, seat = 0) => tool(name).handler(args, ctxFor(g, seat));
const clean = (r, what) => ok(!SECRET.test(JSON.stringify(r)), `${what} carries no secret: ${JSON.stringify(r).slice(0, 300)}`);

// ---- the table ----
section('the table');
{
  const TYPES = ['string', 'integer', 'number', 'array', 'object'];
  ok(JSON.stringify(TOOL_NAMES) === JSON.stringify(PLAYER_TOOLS.map(t => t.name)), 'TOOL_NAMES is the table in order');
  ok(new Set(TOOL_NAMES).size === TOOL_NAMES.length, 'tool names are unique');
  const want = ['look', 'my_role', 'read_talk', 'my_whispers', 'my_notes', 'what_is_asked', 'who_voted', 'note', 'speak', 'whisper', 'nominate', 'vote', 'night_choice', 'slay', 'pass'];
  for (const n of want) ok(TOOL_NAMES.includes(n), `the table has ${n}`);
  const acts = ['speak', 'whisper', 'nominate', 'vote', 'night_choice', 'slay', 'pass'];
  for (const t of PLAYER_TOOLS) {
    ok(typeof t.act === 'boolean' && t.act === acts.includes(t.name), `${t.name}: act is ${acts.includes(t.name)}`);
    ok(typeof t.handler === 'function', `${t.name}: has a handler`);
    ok(typeof t.desc === 'string' && t.desc.length > 20 && t.desc.length <= 220 && (t.desc.match(/[.!?](\s|$)/g) || []).length <= 2, `${t.name}: a description of one or two sentences (${t.desc.length} chars)`);
    for (const [k, a] of Object.entries(t.args || {})) ok(TYPES.includes(a.type) && typeof a.desc === 'string' && a.desc.length > 3, `${t.name}.${k}: has a type and a description`);
    ok(PLAYER_TOOL_LINES.includes(t.name), `the system prompt names ${t.name}`);
  }
  ok(TOOL_NAMES.every(n => ATTEMPT_INVITE.includes(n)), 'the unknown-tool message lists the tools');
  const sys = systemFor('player', 'Odette');
  ok(sys.includes('Odette') && !/\{(name|tools)\}/.test(sys) && sys.includes('night_choice'), 'the player system prompt names the seat and the tools');
  ok(/never claim|Never claim/.test(sys) && /bluff/.test(sys) && /new/.test(sys), 'the system prompt carries: no claimed knowledge, know your bluff, say something new');
  ok(!systemFor('storyteller').includes('{'), "the Storyteller's prompt is untouched by the player's placeholders");
  const stub = tool('look').handler({}, {seat: {id: 1, name: 'Odette'}});
  ok(stub.ok && stub.phase === 'no game yet' && Array.isArray(stub.seats), 'with no game behind the relay, look answers "no game yet"');
  const stub2 = tool('speak').handler({text: 'hi'}, {seat: {id: 1, name: 'Odette'}});
  ok(stub2.ok === false && /No game yet/.test(stub2.error), 'with no game, an act says there is no game yet');
}

// ---- every tool in every state ----
const STATES = ['night', 'day', 'vote', 'dead-ghost', 'dead-spent', 'nominations', 'ended'];
const SAMPLE = {
  look: {}, my_role: {}, read_talk: {}, my_whispers: {}, my_notes: {}, what_is_asked: {}, who_voted: {}, note: {text: 'Bram claims Chef.'},
  speak: {text: 'I have a reading for tonight.'}, whisper: {to: 'Fitch', text: 'I believe you.'}, nominate: {target: 'Corwin'},
  vote: {yes: 'yes'}, night_choice: {pick: ['Bram', 'Corwin']}, slay: {target: 'Corwin'}, pass: {},
};
section('every tool in every state: no secret in any answer');
for (const st of STATES) {
  for (const t of PLAYER_TOOLS) {
    const g = fakeGame(st);
    const r = run(g, t.name, SAMPLE[t.name]);
    ok(r && typeof r.ok === 'boolean', `${st}/${t.name}: answers {ok}`);
    ok(r.ok || (typeof r.error === 'string' && /Open to you now|what_is_asked|You may/.test(r.error)), `${st}/${t.name}: a refusal names what is open: ${r.error}`);
    clean(r, `${st}/${t.name}`);
    ok(!g.calls.some(c => STORYTELLER_ONLY.includes(c)), `${st}/${t.name}: calls no Storyteller-only api function`);
  }
}

section('the header in every state');
for (const st of STATES) {
  const g = fakeGame(st);
  const h = playerHeader(g, 0, fakeApi);
  clean(h, `${st}: the header`);
  ok(h.length < HEADER_CAP, `${st}: the header is under ${HEADER_CAP} characters (${h.length})`);
  ok(/^You are Odette, the Fortune Teller \(townsfolk, good\)/.test(h), `${st}: the header's first line says who I am`);
  ok(/Useful now: \w+/.test(h), `${st}: the header names the useful tools`);
  const waits = {night: /\*\*WAITING ON YOU: As the Fortune Teller: pick two players.*Bram/, vote: /\*\*WAITING ON YOU: Vote on Thea's nomination of Fitch/,
    'dead-ghost': /\*\*WAITING ON YOU: Vote.*ghost vote/, 'dead-spent': /\*\*WAITING ON YOU: Vote/, nominations: /\*\*WAITING ON YOU: Nominations are open/};
  if (waits[st]) ok(waits[st].test(h), `${st}: the header names the decision in bold: ${h}`);
  else ok(!/WAITING ON YOU/.test(h), `${st}: nothing waits, nothing is said to: ${h}`);
  if (st === 'day') console.log(h.split('\n').map(l => '    | ' + l).join('\n'));
}
{
  const g = fakeGame('day');
  useApi(fakeApi);
  const w = whatsNew(g, 0);
  ok(w.said === 2 && w.whispers === 1 && w.seen === 1 && w.told === 1, `whatsNew counts what this seat may know (2 lines, 1 whisper to me, 1 seen, 1 told): ${JSON.stringify(w)}`);
  run(g, 'read_talk');
  ok(whatsNew(g, 0).total === 0, 'after read_talk nothing is new');
  run(g, 'speak', {text: 'A fresh thought.'});
  ok(whatsNew(g, 0).said === 0, 'my own line is not news to me');
  run(g, 'speak', {text: 'Bram, say more.'}, 1);
  ok(whatsNew(g, 0).said === 1 && /1 line at the table/.test(playerHeader(g, 0)), "another seat's line is news, and the header counts it");
  useApi(null);
}

section('game 1 fixes: no doubled names, a voice per seat, a useful first day, the stakes, honest wait text');
{
  // #33: the seat's own name in front of a line is dropped; another name, or the name inside the line, is kept
  let g = fakeGame('day');
  let r = run(g, 'speak', {text: 'Odette: Odette: Bram, what did you see?'});
  ok(r.ok && r.said === 'Bram, what did you see?' && g.events.at(-1).text === 'Bram, what did you see?', `speak drops a doubled own name: ${JSON.stringify(r)}`);
  r = run(g, 'speak', {text: 'odette (ghost): I still have a vote.'});
  ok(r.ok && r.said === 'I still have a vote.', `speak drops "Name (ghost):": ${JSON.stringify(r)}`);
  r = run(g, 'speak', {text: '**Odette:** Fitch, answer me.'});
  ok(r.ok && r.said === 'Fitch, answer me.', `speak drops a bold name: ${JSON.stringify(r)}`);
  r = run(g, 'speak', {text: 'Bram: that is what you said.'});
  ok(r.ok && r.said === 'Bram: that is what you said.', 'another seat\'s name in front is kept');
  r = run(g, 'speak', {text: 'Odette here, no night role worth telling.'});
  ok(r.ok && r.said.startsWith('Odette here'), 'a name inside the line is kept');
  r = run(g, 'speak', {text: 'Odette: '});
  ok(!r.ok && /without your name/.test(r.error), `a line that was only the name is refused: ${r.error}`);
  r = run(g, 'whisper', {to: 'Fitch', text: 'Odette: keep this between us.'});
  ok(r.ok && r.said === 'keep this between us.', 'whisper drops the own name too');
  ok(/without your name in front/.test(tool('speak').args.text.desc), 'the speak tool says not to sign the line');
  ok(/own name in front|your own name/.test(systemFor('player', 'Odette')), 'the system prompt says not to sign the line');
  ok(/Speak without your name in front/.test(playerHeader(fakeGame('day'), 0, fakeApi)), 'the header says not to sign when speak is useful');

  // #32: a manner per seat, distinct, in the system prompt; and the own-voice line
  const manners = NAMES.map(n => (systemFor('player', n).match(/Your manner at the table is ([^.]+)\./) || [])[1]);
  ok(manners.every(Boolean), `every seat has a manner line: ${manners.map((m, i) => `${NAMES[i]}=${m ? m.split(':')[0] : '-'}`).join(', ')}`);
  ok(new Set(manners.map(m => m && m.split(':')[0])).size === NAMES.length, 'the seven manners are distinct');
  ok(!/manner/.test(systemFor('player', 'Stranger')) && !/\{manner\}/.test(systemFor('player', 'Stranger')), 'an unknown seat name gets no manner line and no placeholder');
  ok(/own voice/.test(systemFor('player', 'Bram')) && /echo the table/.test(systemFor('player', 'Bram')), 'the prompt asks for an own voice and no echo');

  // #31: the first day and the empty nomination
  const sys = systemFor('player', 'Thea');
  ok(/first day/i.test(sys) && /question by name/.test(sys) && /soft claim/.test(sys) && /nominate someone anyway/.test(sys) && /given to the demon/.test(sys),
    'the prompt carries the first-day guidance: speak or ask, a soft claim, nominate anyway');
  ok(/First day: say something about yourself or ask a player a question/.test(playerHeader(fakeGame('day'), 0, fakeApi)), 'the day-1 header nudges a seat to speak');
  ok(/nominate someone anyway/.test(playerHeader(fakeGame('nominations'), 0, fakeApi)), 'the header with nominations open and none made says to nominate anyway');
  ok(!/First day|nominate someone anyway/.test(playerHeader(fakeGame('night'), 0, fakeApi)), 'no nudge at night');

  // #38: the stakes line at four alive or fewer, by day only
  const withAlive = (st, n) => {const x = fakeGame(st); x.seats.forEach((s, i) => {s.alive = i < n}); return x};
  const h4 = playerHeader(withAlive('day', 4), 0, fakeApi), h3 = playerHeader(withAlive('day', 3), 0, fakeApi), h5 = playerHeader(withAlive('day', 5), 0, fakeApi);
  ok(/Stakes: 4 alive; the demon kills one a night; evil wins at 2\. A wrong execution today: 3 left, 2 after tonight, evil wins\. Wrong executions to spare: none\./.test(h4), `the stakes at 4 alive: ${h4}`);
  ok(/Stakes: 3 alive.*2 left, evil wins at once/.test(h3), 'the stakes at 3 alive');
  ok(!/Stakes/.test(h5), 'no stakes line at 5 alive');
  ok(!/Stakes/.test(playerHeader(withAlive('night', 4), 0, fakeApi)), 'no stakes line at night');
  for (const h of [h4, h3]) ok(h.length < HEADER_CAP, `the header with the stakes stays under ${HEADER_CAP} (${h.length})`);

  // #29: a seat that has had its turn this round is told so plainly and offered reads only
  const READS = PLAYER_TOOLS.filter(t => !t.act).map(t => t.name);
  const usefulOf = h => (h.match(/Useful now: ([^.]+)\./) || [])[1]?.split(', ') || [];
  g = fakeGame('day'); g.clock.toSpeak = [1, 2, 3, 4, 5, 6];
  let h = playerHeader(g, 0, fakeApi);
  ok(/You have had your turn this round; nothing to do until round 3; reading is fine\./.test(h), `the wait text from the clock: ${h}`);
  ok(usefulOf(h).length && usefulOf(h).every(n => READS.includes(n)), `waiting, the useful tools are reads only: ${usefulOf(h)}`);
  ok(!/First day/.test(h), 'a waiting seat gets no nudge to speak');
  g.clock.round = 3;
  ok(/nothing to do until nominations open/.test(playerHeader(g, 0, fakeApi)), 'in the last round the wait is until nominations open');
  r = run(g, 'what_is_asked');
  ok(/nothing to do until nominations open/.test(r.text) && r.useful.every(n => READS.includes(n)), `what_is_asked says the same: ${r.text}`);
  g.clock.toSpeak = [0, 1];
  h = playerHeader(g, 0, fakeApi);
  ok(!/nothing to do/.test(h) && usefulOf(h).includes('speak'), 'a seat whose turn is still to come is not told to wait');
  // the game's own canAct and nextTurnText, when it has them, decide
  const told = {...fakeApi, canAct: () => false, nextTurnText: () => 'until round 3 begins'};
  g = fakeGame('day'); g.clock.toSpeak = [0];
  h = playerHeader(g, 0, told);
  ok(/You have had your turn this round; nothing to do until round 3 begins; reading is fine\./.test(h) && usefulOf(h).every(n => READS.includes(n)), `canAct false and nextTurnText from the game: ${h}`);
  ok(/nothing to do until round 4/.test(playerHeader(g, 0, {...told, nextTurnText: () => 'round 4'})), 'a bare phrase from the game reads right');
  ok(!/nothing to do/.test(playerHeader(fakeGame('day'), 0, {...fakeApi, canAct: () => true})), 'canAct true: no wait text');
  ok(!/nothing to do/.test(playerHeader(fakeGame('vote'), 0, told)), 'a vote waiting on the seat outranks the wait text');
}

section('what each read shows');
{
  const g = fakeGame('day');
  const t = run(g, 'read_talk');
  const types = t.entries.map(e => e.type);
  ok(t.ok && types.includes('say') && types.includes('whisper-seen') && types.includes('whisper'), `read_talk shows talk, whisper marks and my whisper: ${types.join(',')}`);
  ok(!types.includes('ruling') && !types.includes('token'), 'read_talk drops rulings and tokens');
  ok(t.entries.filter(e => e.type === 'told').length === 1, "read_talk keeps my own night information and drops another seat's");
  ok(t.entries.every((e, i, a) => i === 0 || e.id > a[i - 1].id), 'read_talk is oldest first, with ids');
  ok(t.entries.find(e => e.type === 'say').from === 'Bram', 'a line names its speaker');
  const again = run(g, 'read_talk');
  ok(again.ok && again.entries.length === 0, 'a second read_talk shows only what is new');
  const from0 = run(g, 'read_talk', {since: 0});
  ok(from0.entries.length === t.entries.length, 'read_talk since=0 shows it all again');
  const w = run(g, 'my_whispers');
  ok(w.whispers.length === 1 && w.whispers[0].from === 'Fitch' && w.whispers[0].to === 'Odette', 'my_whispers shows only whispers I am party to');
  const r = run(g, 'my_role');
  ok(r.role === 'Fortune Teller' && r.side === 'good' && r.ability && r.told.length === 1, 'my_role: role, side, ability, what I was told');
  run(g, 'note', {text: 'Fitch claims Monk.'});
  ok(JSON.stringify(run(g, 'my_notes').notes) === '["Fitch claims Monk."]', 'a note comes back in my_notes, and only its text');
  ok(JSON.stringify(run(fakeGame('day'), 'my_notes', {}, 1).notes) === '[]', "another seat's notes are its own");
  const l = run(g, 'look');
  ok(l.alive.length === 7 && l.seats.every(s => Object.keys(s).join() === 'name,alive'), 'look: names and life only');
}

section('the acts, and refusals that name what is legal');
{
  let g = fakeGame('night');
  let r = run(g, 'speak', {text: 'hello'});
  ok(!r.ok && /night/.test(r.error) && /You may/.test(r.error), `speaking at night is refused by the game, its message passed through: ${r.error}`);
  r = run(g, 'vote', {yes: 'yes'});
  ok(!r.ok && /No vote is open/.test(r.error) && /Fortune Teller/.test(r.error), `vote with no vote open says what is open instead: ${r.error}`);
  r = run(g, 'night_choice', {pick: ['Bram']});
  ok(!r.ok && /Pick exactly 2/.test(r.error) && /Corwin/.test(r.error), `a choice of one where two are asked names the options: ${r.error}`);
  r = run(g, 'night_choice', {pick: ['Bram', 'Nobody-here']});
  ok(!r.ok && /not one of the choices/.test(r.error), 'an unknown name is refused with the choices');
  r = run(g, 'night_choice', {pick: 'bram, corwin'});
  ok(r.ok && JSON.stringify(g.answered) === '[1,3]' && JSON.stringify(r.chose) === '["Bram","Corwin"]', `night_choice takes names in any case, as a list or a comma string, and answers with seats: ${JSON.stringify(r)}`);
  ok(/Nothing is asked/.test(run(g, 'what_is_asked').text), 'after the choice nothing is asked');

  g = fakeGame('day');
  r = run(g, 'speak', {text: 'I will read Bram and Corwin tonight.'});
  ok(r.ok, 'speak by day');
  r = run(g, 'speak', {text: 'I will read Bram and Corwin tonight.'});
  ok(!r.ok && /You said that already; say something new or pass\./.test(r.error), `the no-repeating rule comes through: ${r.error}`);
  r = run(g, 'whisper', {to: 'fit', text: 'Are you really the Monk?'});
  ok(r.ok && r.to === 'Fitch', 'whisper finds a player by the start of the name');
  r = run(g, 'whisper', {to: 'Zed', text: 'hi'});
  ok(!r.ok && /Odette, Bram, Ines/.test(r.error), `whisper to nobody names the players: ${r.error}`);
  r = run(g, 'nominate', {target: 'Corwin'});
  ok(!r.ok && /not open yet/.test(r.error), `nominating before nominations open is refused: ${r.error}`);
  ok(run(g, 'pass').ok, 'pass');

  g = fakeGame('nominations');
  r = run(g, 'what_is_asked');
  ok(r.asked === 'nomination' && r.options.length === 7, 'what_is_asked: a nomination with its targets');
  r = run(g, 'nominate', {target: 'Corwin'});
  ok(r.ok && r.nominated === 'Corwin', 'nominate');
  r = run(g, 'nominate', {target: 'Corwin'}, 1);
  ok(!r.ok && /nominated today already/.test(r.error), `a second nomination of the same player is refused by the game: ${r.error}`);

  g = fakeGame('vote');
  r = run(g, 'who_voted');
  ok(r.ok && r.nominee === 'Fitch' && JSON.stringify(r.voted) === '["Thea"]' && r.waiting.includes('Odette'), 'who_voted: who is up, who voted, who has not');
  g.pending[0].seats = [0, 1, 2, 4, 5]; g.pending[0].voted = [4, 5];
  r = run(g, 'who_voted');
  ok(r.waiting.join() === 'Odette,Bram,Ines', `who_voted uses the api's seats when present: waiting ${r.waiting}`);
  g.pending[0].seats = [0, 1, 2, 3, 4, 5, 6]; g.pending[0].voted = [4];
  r = run(g, 'vote', {yes: 'maybe'});
  ok(!r.ok && /"yes"/.test(r.error), 'a vote that is neither yes nor no is refused');
  r = run(g, 'vote', {yes: 'YES'});
  ok(r.ok && r.voted === 'yes', 'vote yes');
  r = run(g, 'vote', {yes: 'no'});
  ok(!r.ok && /already voted yes/.test(r.error), 'a second vote is refused');

  g = fakeGame('dead-ghost');
  ok(run(g, 'vote', {yes: 'yes'}).ok, 'the dead vote with their ghost vote');
  g = fakeGame('dead-spent');
  r = run(g, 'vote', {yes: 'yes'});
  ok(!r.ok && /ghost vote is spent/.test(r.error), `the dead without a ghost vote are refused by the game: ${r.error}`);
  r = run(g, 'nominate', {target: 'Corwin'});
  ok(!r.ok && /dead cannot nominate/.test(r.error), 'the dead cannot nominate');
}

// ---- the Slayer's standing shot (#37) ----
section("the Slayer's standing shot: an honest header line, slay, night_choice's fallback, the refusals, the hold");
{
  const SHOT = /Your shot is unspent: slay <name> any time today, or hold it\./;
  const useOf = h => ((h.match(/Useful now: ([^.]+)\./) || [])[1] || '').split(', ');
  const shoot = g => {g.shot = {0: {by: 0, ability: 'slayer', options: [0, 1, 2, 3, 4, 5, 6], question: 'your shot is unspent'}}; return g};
  // the header with and without the shot, by day before nominations and with nominations open
  for (const st of ['day', 'nominations']) {
    const plain = playerHeader(fakeGame(st), 0, fakeApi), withShot = playerHeader(shoot(fakeGame(st)), 0, fakeApi);
    ok(!SHOT.test(plain), `${st}: no shot, no shot line`);
    ok(SHOT.test(withShot), `${st}: an unspent shot is said in the header: ${withShot}`);
    ok(!/WAITING ON YOU: .*shot/i.test(withShot) && (st === 'nominations') === /WAITING ON YOU/.test(withShot), `${st}: the shot is a may, never "WAITING ON YOU" (only a real decision is)`);
    ok(JSON.stringify(useOf(withShot)) === JSON.stringify([...useOf(plain), 'slay']), `${st}: the useful tools are unchanged by the shot, slay added: ${useOf(plain)} -> ${useOf(withShot)}`);
    ok(withShot.length < HEADER_CAP, `${st}: the header with a shot is under ${HEADER_CAP} (${withShot.length})`);
  }
  {const gd = shoot(fakeGame('day')); run(gd, 'read_talk'); // nothing new: pass is offered beside speak and whisper
    ok(['speak', 'whisper', 'pass', 'slay'].every(n => useOf(playerHeader(gd, 0, fakeApi)).includes(n)), 'by day the shot keeps speak, whisper and pass in the useful tools')}
  ok(['nominate', 'pass'].every(n => useOf(playerHeader(shoot(fakeGame('nominations')), 0, fakeApi)).includes(n)), 'with nominations open it keeps nominate and pass');
  ok(!SHOT.test(playerHeader(shoot(fakeGame('night')), 0, fakeApi)), 'at night there is no shot line');
  // the fake: slay, the hold, night_choice's fallback, what_is_asked
  let g = shoot(fakeGame('day'));
  let r = run(g, 'what_is_asked');
  ok(r.ok && r.asked === 'standing' && r.tool === 'slay' && r.options.includes('Corwin') && r.options.includes('hold'), `what_is_asked shows the standing shot, answered with slay: ${JSON.stringify(r)}`);
  r = run(g, 'slay', {target: 'hold'});
  ok(r.ok && r.held && g.shot[0] && g.shotAt === undefined, `slay "hold" keeps the shot: ${JSON.stringify(r)}`);
  r = run(g, 'night_choice', {pick: ['nobody']});
  ok(r.ok && r.held && g.shot[0], `night_choice "nobody" on a standing shot keeps it too: ${JSON.stringify(r)}`);
  r = run(g, 'slay', {});
  ok(!r.ok && /needs a target/.test(r.error) && /slay/.test(r.error), `slay with no target is refused, naming slay as open: ${r.error}`);
  r = run(g, 'slay', {target: 'Storyteller'});
  ok(!r.ok && /no player "Storyteller"/.test(r.error), 'slay at someone not at the table is refused with the names');
  r = run(g, 'night_choice', {pick: ['corw']});
  ok(r.ok && r.shot === 'Corwin' && g.shotAt === 3 && /still alive/.test(r.result) && r.public.some(x => /Odette claims the Slayer and shoots Corwin/.test(x)), `night_choice falls back to the shot: ${JSON.stringify(r)}`);
  clean(r, 'the shot\'s answer');
  ok(!SHOT.test(playerHeader(g, 0, fakeApi)), 'a spent shot leaves the header');
  r = run(g, 'slay', {target: 'Bram'});
  ok(!r.ok && /no ability/.test(r.error), `a second shot is refused with the reason: ${r.error}`);

  // a real game, seed 7: Thea (seat 4) is dealt the Slayer, Bram (1) the Imp, Fitch (5) the Scarlet Woman
  const toDay = (game, sc) => {
    for (let n = 0; n < 500 && !(game.phase === 'day' && game.step === 'nominations' && game.pending?.kind === 'nomination'); n++) {
      const p = game.pending;
      if (p.seat === api.ST) api.answer(game, api.ST, sc(game), 'scripted'); else api.answer(game, p.seat, sc(game));
    }
  };
  const real = (seed = 7) => {
    const game = newGame({seed, rounds: 1}), sc = createScripted(seed);
    const ctx = i => ({game, seat: {index: i, name: game.seats[i].name}, api: api.forSeat(i), log: () => {}});
    return {game, sc, ctx, call: (i, name, args = {}) => tool(name).handler(args, ctx(i))};
  };
  {
    const {game, sc, call} = real();
    const nightTry = call(4, 'slay', {target: 'Bram'});
    ok(!nightTry.ok && /by day/.test(nightTry.error), `at night the shot is refused with the reason: ${nightTry.error}`);
    toDay(game, sc);
    ok(api.dayActionFor(game, 4)?.ability === 'slayer', 'seed 7, day 1: the shot stands open to Thea');
    const h = playerHeader(game, 4);
    call(4, 'read_talk');
    const h1 = playerHeader(game, 4);
    ok(SHOT.test(h) && !/WAITING ON YOU/.test(h) && ['speak', 'whisper', 'pass', 'slay'].every(n => useOf(h1).includes(n)), `Thea's header says the shot as a may and keeps her tools: ${h}`);
    ok(!/shot/i.test(playerHeader(game, 0)) && !/shot/i.test(JSON.stringify(call(0, 'what_is_asked'))), "nobody else's header or what_is_asked mentions a shot");
    let r = call(0, 'slay', {target: 'Bram'});
    ok(!r.ok && /no ability to use by day/.test(r.error), `a seat that is not the Slayer is refused with the reason: ${r.error}`);
    r = call(4, 'slay', {target: 'hold'});
    ok(r.ok && r.held && api.dayActionFor(game, 4), 'Thea holds: the shot is kept');
    r = call(4, 'speak', {text: 'I am holding something back for now.'});
    ok(r.ok && SHOT.test(playerHeader(game, 4)), 'after her line the shot is still offered');
    const wa = call(4, 'what_is_asked');
    ok(wa.asked === 'standing' && wa.tool === 'slay', `once her turn is taken what_is_asked shows the standing shot: ${JSON.stringify(wa)}`);
    const h2 = playerHeader(game, 4);
    ok(/nothing else to do/.test(h2) && SHOT.test(h2) && useOf(h2).includes('slay'), `a Slayer who has had her turn is told she has nothing else to do, and the shot: ${h2}`);
    r = call(4, 'night_choice', {pick: ['nobody']});
    ok(r.ok && r.held && api.dayActionFor(game, 4), 'night_choice "nobody" on the standing shot holds it');
    r = call(4, 'slay', {target: 'Odette'});
    ok(r.ok && r.shot === 'Odette' && /Odette is still alive/.test(r.result) && r.public.some(x => /Thea claims the Slayer and shoots Odette/.test(x)), `Thea shoots Odette, a townsfolk: ${JSON.stringify(r)}`);
    ok(!api.dayActionFor(game, 4) && !SHOT.test(playerHeader(game, 4)), 'the shot is spent and leaves her header');
    r = call(4, 'slay', {target: 'Bram'});
    ok(!r.ok && /spent/.test(r.error), `a spent shot is refused with the reason: ${r.error}`);
    for (const i of [0, 1, 2, 3, 5, 6]) ok(/Thea claims the Slayer and shoots Odette/.test(JSON.stringify(call(i, 'read_talk', {since: 0}))), `${game.seats[i].name} hears the shot in public`);
  }
  {
    const {game, sc, call} = real();
    toDay(game, sc);
    // nominations open, a vote on someone: the shot waits for the vote to end
    for (const s of game.seats) if (!game.clock.nominationsOpen) call(s.index, 'pass');
    const hn = playerHeader(game, 4);
    ok(/WAITING ON YOU: Nominations are open/.test(hn) && SHOT.test(hn) && ['nominate', 'pass', 'slay'].every(n => useOf(hn).includes(n)), `with nominations open Thea is asked to nominate, and told of her shot: ${hn}`);
    ok(call(0, 'nominate', {target: 'Yusuf'}).ok && game.pending?.kind === 'vote', 'Odette nominates Yusuf: a vote is open');
    let r = call(4, 'slay', {target: 'Bram'});
    ok(!r.ok && /vote is open/.test(r.error), `during a vote the shot is refused with the reason: ${r.error}`);
    ok(!SHOT.test(playerHeader(game, 4)), 'and the header does not offer it during the vote');
    // a dead Slayer
    game.seats[4].alive = false;
    r = call(4, 'slay', {target: 'Bram'});
    ok(!r.ok && /dead/.test(r.error), `a dead Slayer is refused with the reason: ${r.error}`);
    game.seats[4].alive = true;
  }
  {
    const {game, sc, call} = real();
    toDay(game, sc);
    const r = call(4, 'night_choice', {pick: ['Bram']});
    ok(r.ok && r.shot === 'Bram' && r.result === 'Bram dies.' && !game.seats[1].alive, `through night_choice Thea shoots Bram, the Imp, and he dies: ${JSON.stringify(r)}`);
    ok(!JSON.stringify(r).match(/imp|scarlet|demon/i), 'the answer names no role: only what the table saw');
  }
}

// ---- one game through the real api ----
section('integration: a real game through the real api, every seat with its own bound api');
{
  const STR = 'ST-REASON-SECRET', WHISPER = 'WHISPER-SECRET-for-one-ear-only';
  const game = newGame({seed: 7, rounds: 1});
  const answerer = createScripted(7);
  const seats = game.seats.map(s => ({index: s.index, name: s.name}));
  const ctxs = seats.map(seat => ({game, seat, api: api.forSeat(seat.index), log: () => {}}));
  const out = seats.map(() => []); // everything each seat was shown
  const call = (i, name, args = {}) => {const r = tool(name).handler(args, ctxs[i]); out[i].push(JSON.stringify(r)); return r};
  const header = i => {const h = playerHeader(game, i); out[i].push(h); return h};
  const done = {say: 0, repeat: 0, whisper: 0, pass: 0, nominate: 0, vote: 0, choice: 0, headers: 0, bad: []};
  for (let step = 0; step < 2000 && !game.winner && game.day < 3; step++) {
    const p = game.pending;
    if (!p) break;
    if (p.seat === 'storyteller') {api.answer(game, 'storyteller', answerer(game), STR); continue}
    if (p.kind === 'choose') {
      const i = p.seat, h = header(i); done.headers++;
      if (!/WAITING ON YOU/.test(h)) done.bad.push(`no waiting line for a choice: ${h}`);
      const a = call(i, 'what_is_asked');
      const pick = a.options.includes('nobody') ? ['nobody'] : a.options.filter(o => o !== seats[i].name).slice(0, a.count || 1);
      const r = call(i, 'night_choice', {pick});
      if (r.ok) done.choice++; else done.bad.push(`night_choice ${JSON.stringify(pick)}: ${r.error}`);
      continue;
    }
    if (p.kind === 'vote') {
      for (const i of p.seats) {
        if (api.pendingFor(game, i)?.mine != null) continue;
        header(i); done.headers++;
        const r = call(i, 'vote', {yes: i % 2 ? 'no' : 'yes'});
        if (r.ok) done.vote++; else done.bad.push(`vote ${i}: ${r.error}`);
        if (game.pending !== p) break;
      }
      continue;
    }
    const v = api.view(game, 0);
    if (game.phase === 'day' && !v.clock.nominationsOpen) {
      for (const i of v.clock.toSpeak) {
        header(i); done.headers++;
        if (i === v.clock.toSpeak[0] && game.day === 1) {
          const line = `${seats[i].name}: ${seats[i].name} here; I have a hunch about the night.`; // signed twice, as in game 1
          if (call(i, 'speak', {text: line}).ok) done.say++;
          if (/You said that already/.test(call(i, 'speak', {text: line}).error || '')) done.repeat++;
          const said = game.log.filter(e => e.type === 'say' && e.seat === i).at(-1)?.text || '';
          done.signed = said.startsWith(`${seats[i].name}:`) ? said : null;
          // the round is still going and this seat has had its turn: the header says wait and offers reads only
          const h = header(i), use = (h.match(/Useful now: ([^.]+)\./) || [])[1] || '';
          done.waitText = /nothing to do until/.test(h) && /reading is fine/.test(h) && use.split(', ').every(n => !PLAYER_TOOLS.find(t => t.name === n)?.act) ? 'ok' : h;
          continue;
        }
        if (game.day === 1 && done.whisper === 0) {
          const to = seats.find(s => s.index !== i);
          if (call(i, 'whisper', {to: to.name, text: WHISPER}).ok) done.whisper++;
          done.whisperTo = to.index; done.whisperFrom = i;
        }
        if (call(i, 'pass').ok) done.pass++;
      }
      continue;
    }
    if (p.kind === 'nomination') {
      const asks = seats.map(s => ({i: s.index, q: api.pendingFor(game, s.index)})).filter(x => x.q?.kind === 'nomination');
      if (!asks.length) break;
      if (!game.today.nominators.length) {
        const i = asks[0].i, a = call(i, 'what_is_asked');
        const target = a.options.find(o => o !== seats[i].name);
        const r = call(i, 'nominate', {target});
        if (r.ok) done.nominate++; else {done.bad.push(`nominate: ${r.error}`); call(i, 'pass')}
      } else for (const {i} of asks) {call(i, 'pass'); done.pass++; if (game.pending !== p) break}
      continue;
    }
    break;
  }
  ok(!done.bad.length, `no tool refused a legal move: ${done.bad.join(' | ')}`);
  ok(done.say >= 1 && done.repeat >= 1, `speak, and the no-repeating rule from the real api (${done.say} said, ${done.repeat} repeats refused)`);
  ok(done.say >= 1 && done.signed === null, `the real game logs a signed line once, without the name: ${done.signed}`);
  ok(done.waitText === 'ok', `in the real game a seat that has had its turn is told to wait, reads only (${typeof api.canAct === 'function' ? "the game's canAct" : 'from the clock'}): ${done.waitText}`);
  ok(done.whisper === 1 && done.pass > 0 && done.nominate >= 1 && done.vote >= 3 && done.choice >= 1,
    `the game was played through the tools: ${JSON.stringify({whisper: done.whisper, pass: done.pass, nominate: done.nominate, vote: done.vote, choice: done.choice, headers: done.headers})}`);
  ok(game.day >= 2 || game.winner, `the game moved on (day ${game.day}${game.winner ? ', ' + game.winner.text : ''})`);
  const heard = call(done.whisperTo, 'my_whispers');
  ok(heard.whispers.some(w => w.text === WHISPER), 'the whisper reaches its listener');
  for (const s of seats) {
    if (s.index === done.whisperTo || s.index === done.whisperFrom) continue;
    call(s.index, 'read_talk', {since: 0}); call(s.index, 'my_whispers'); header(s.index);
    ok(!out[s.index].some(x => x.includes(WHISPER)), `${s.name} never sees the whisper between two others`);
  }
  for (const s of seats) ok(!out[s.index].some(x => x.includes(STR)), `${s.name} never sees a Storyteller reason`);
  for (const s of seats) {
    const h = header(s.index);
    ok(h.length < HEADER_CAP && h.startsWith(`You are ${s.name}, the `), `${s.name}'s header in the real game is under ${HEADER_CAP} (${h.length})`);
  }
  const BOUND = /only as yourself|Only the Storyteller/;
  const tryMsg = f => {try {f(); return null} catch (e) {return e.message}};
  ok(BOUND.test(tryMsg(() => ctxs[0].api.notes(game, 1)) || ''), "a seat's bound api refuses another seat's notes");
  ok(BOUND.test(tryMsg(() => ctxs[0].api.grimoire(game)) || ''), 'a seat has no grimoire');
  const talk = call(0, 'read_talk', {since: 0});
  console.log(`    | a real game, seed 7, to day ${game.day}: ${JSON.stringify({...done, bad: undefined})}; ${seats[0].name}'s header now:`);
  console.log(header(0).split('\n').map(l => '    | ' + l).join('\n'));
}


section('nothing under src/ imports node: or scripts/');
{
  const walk = d => readdirSync(d).flatMap(f => {const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(m?js)$/.test(f) ? [p] : []});
  for (const f of walk(join(ROOT, 'src'))) {
    const src = readFileSync(f, 'utf8');
    ok(!/from\s+['"]node:|require\(['"]node:|from\s+['"][./]*scripts\//.test(src), `${f.slice(ROOT.length + 1)} imports no node: and no scripts/`);
  }
}

console.log(`${fails ? 'FAIL' : 'ok'}: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
