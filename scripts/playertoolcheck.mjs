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
  const want = ['look', 'my_role', 'read_talk', 'my_whispers', 'my_notes', 'what_is_asked', 'who_voted', 'note', 'speak', 'whisper', 'nominate', 'vote', 'night_choice', 'pass'];
  for (const n of want) ok(TOOL_NAMES.includes(n), `the table has ${n}`);
  const acts = ['speak', 'whisper', 'nominate', 'vote', 'night_choice', 'pass'];
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
  vote: {yes: 'yes'}, night_choice: {pick: ['Bram', 'Corwin']}, pass: {},
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
          const line = `${seats[i].name} here; I have a hunch about the night.`;
          if (call(i, 'speak', {text: line}).ok) done.say++;
          if (/You said that already/.test(call(i, 'speak', {text: line}).error || '')) done.repeat++;
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
