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
import {playerHeader, whatsNew, useApi, claimsInLine} from '../src/seats/player.js';
import * as api from '../src/game/api.js';
import {newGame, createScripted, playScripted} from '../src/game/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)}};
const section = name => console.log(`- ${name}`);
const SECRET = /SECRET/;
const HEADER_CAP = 900; // 700 before rooms (#28): the place line and the rooms line add about 180

// ---- the fake api ----
const NAMES = ['Odette', 'Bram', 'Ines', 'Corwin', 'Thea', 'Fitch', 'Yusuf'];
class ApiError extends Error {constructor(m) {super(`${m} You may look around.`); this.name = 'ApiError'}}
const say = (by, text, day = 1) => ({type: 'say', seat: by, text, day, audience: 'all', role: 'SECRET-ROLE-of-speaker'});

// A fake game in one of the usual states. me is seat 0 (Odette, the Fortune Teller).
function fakeGame(state) {
  const g = {state, phase: 'day', day: 1, night: 1, clock: {round: 2, roundsBeforeNominations: 3, nominationsOpen: false},
    seats: NAMES.map((name, index) => ({index, name, alive: true, ghostVote: true, role: index === 3 ? 'SECRET-ROLE-imp' : 'SECRET-ROLE-other'})),
    events: [], notes: {}, lines: {}, pending: {}, nominated: [], winner: null, calls: [], places: NAMES.map(() => null)};
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
  if (state === 'day') { // Ines and Corwin talk in the nook: the move is public, the line is theirs (a careless game hands it to everyone)
    g.places[2] = g.places[3] = 'nook';
    ev({type: 'move', seats: [2, 3], room: 'nook', from: null, by: 2, day: 1, audience: 'all', text: 'Ines and Corwin went to the nook.', why: 'SECRET-REASON-move'});
    ev({type: 'say', seat: 2, room: 'nook', text: 'SECRET-ROOM-LINE: you poison Thea tonight', day: 1, audience: [2, 3]});
  }
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
// the fake's places (#28): the rooms of src/data/rooms.js, open by day until nominations open
const FAKE_ROOMS = [{id: 'nook', name: 'the nook', size: 2}, {id: 'parlour', name: 'the parlour', size: 3}, {id: 'backroom', name: 'the back room', size: 4}];
const occupantsOf = (g, room) => g.seats.filter(s => g.places[s.index] === room).map(s => s.index);
const fakeRooms = g => FAKE_ROOMS.map(r => ({...r, seats: occupantsOf(g, r.id), free: r.size - occupantsOf(g, r.id).length}));
const roomsOpenOf = g => g.phase === 'day' && !g.clock.nominationsOpen && !g.winner;
const roomKey = x => String(x ?? '').trim().toLowerCase().replace(/^the\s+/, '');
const findFakeRoom = name => FAKE_ROOMS.find(r => r.id === roomKey(name) || roomKey(r.name) === roomKey(name)) || null;
const neighboursOf = (g, seat) => {
  const n = g.seats.length, out = [];
  for (const step of [-1, 1]) for (let k = 1; k < n; k++) {const j = (seat + step * k + n) % n; if (j !== seat && g.seats[j].alive) {out.push(j); break}}
  return [...new Set(out)];
};
const isDay = g => need(g.phase === 'day', 'It is night: nobody talks at night. Wait for the day.');
const fakeApi = {
  view(g, seat) {
    g.calls.push('view');
    const s = g.seats[seat];
    return {name: s.name, index: seat, role: {id: 'fortune-teller', name: 'Fortune Teller', team: 'townsfolk', ability: 'Each night, pick two players: you learn whether either is the demon.'},
      alive: s.alive, ghostVote: s.ghostVote, phase: g.phase, night: g.night, day: g.day, clock: {...g.clock},
      told: [{night: 1, what: 'role', text: 'You are the Fortune Teller.', why: 'SECRET-REASON-told'}],
      seats: g.seats.map(x => ({index: x.index, name: x.name, alive: x.alive, role: x.role, tokens: ['SECRET-TOKEN-x'], room: g.places[x.index]})),
      place: {room: g.places[seat], name: FAKE_ROOMS.find(r => r.id === g.places[seat])?.name ?? 'the Square', with: g.seats.filter(x => x.index !== seat && g.places[x.index] === g.places[seat]).map(x => x.index),
        neighbours: neighboursOf(g, seat), canWhisper: g.places[seat] != null ? [] : neighboursOf(g, seat).filter(j => g.places[j] == null), secret: 'SECRET-PLACE'},
      rooms: fakeRooms(g), roomsOpen: roomsOpenOf(g),
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
    const room = g.places[seat];
    g.events.push({id: g.events.length, type: 'say', seat, text, day: g.day, ...(room == null ? {audience: 'all'} : {room, audience: occupantsOf(g, room)})});
  },
  // places (#28), as src/game/api.js has them
  where(g, seat) {
    g.calls.push('where');
    const v = fakeApi.view(g, seat);
    return {place: v.place.room, placeName: v.place.name, with: v.place.with, square: occupantsOf(g, null), rooms: fakeRooms(g), open: roomsOpenOf(g),
      neighbours: v.place.neighbours, canWhisper: v.place.canWhisper, secret: 'SECRET-WHERE'};
  },
  go(g, seat, room) {
    g.calls.push('go'); isDay(g); need(roomsOpenOf(g), 'The rooms are closed: nominations are open and everyone is at the Square.');
    const r = findFakeRoom(room); need(r, `There is no room ${JSON.stringify(room)}: the rooms are nook, parlour, backroom.`);
    need(g.places[seat] !== r.id, `You are in ${r.name} already.`);
    need(occupantsOf(g, r.id).length < r.size, `${r.name} is full.`);
    const from = g.places[seat]; g.places[seat] = r.id;
    g.events.push({id: g.events.length, type: 'move', seats: [seat], room: r.id, from, by: seat, day: g.day, audience: 'all', text: `${NAMES[seat]} went to ${r.name}.`});
    return {place: r.id, with: occupantsOf(g, r.id).filter(i => i !== seat)};
  },
  invite(g, seat, other, room) {
    g.calls.push('invite'); isDay(g); need(roomsOpenOf(g), 'The rooms are closed: nominations are open and everyone is at the Square.');
    const from = g.places[seat];
    need(room != null || from != null, 'Name a room: nook, parlour, backroom.');
    const r = room == null ? FAKE_ROOMS.find(x => x.id === from) : findFakeRoom(room); need(r, `There is no room ${JSON.stringify(room)}.`);
    need(g.places[other] == null, `${NAMES[other]} is in another place; you may invite only someone at the Square.`);
    need(occupantsOf(g, r.id).length + (from === r.id ? 1 : 2) <= r.size, `${r.name} is full.`);
    g.places[seat] = r.id; g.places[other] = r.id;
    g.events.push({id: g.events.length, type: 'move', seats: from === r.id ? [other] : [seat, other], room: r.id, from, by: seat, day: g.day, audience: 'all',
      text: from === r.id ? `${NAMES[seat]} called ${NAMES[other]} into ${r.name}.` : `${NAMES[seat]} and ${NAMES[other]} went to ${r.name}.`});
    return {place: r.id, with: occupantsOf(g, r.id).filter(i => i !== seat)};
  },
  leave(g, seat) {
    g.calls.push('leave'); isDay(g);
    const from = g.places[seat]; need(from != null, 'You are at the Square already.');
    g.places[seat] = null;
    g.events.push({id: g.events.length, type: 'move', seats: [seat], room: null, from, by: seat, day: g.day, audience: 'all', text: `${NAMES[seat]} came back to the Square.`});
    return {place: null};
  },
  whisper(g, seat, to, text) {
    g.calls.push('whisper'); isDay(g);
    need(g.places[seat] == null, 'There are no whispers in a room.');
    need(neighboursOf(g, seat).includes(to), `At the Square you may whisper only to your nearest living neighbours: ${neighboursOf(g, seat).map(i => NAMES[i]).join(' and ')}.`);
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
  const want = ['look', 'my_role', 'read_talk', 'my_whispers', 'my_notes', 'what_is_asked', 'who_voted', 'note', 'where', 'claims', 'go', 'invite', 'leave', 'speak', 'whisper', 'nominate', 'vote', 'night_choice', 'slay', 'pass'];
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
  speak: {text: 'I have a reading for tonight.'}, whisper: {to: 'Bram', text: 'I believe you.'}, nominate: {target: 'Corwin'},
  vote: {yes: 'yes'}, night_choice: {pick: ['Bram', 'Corwin']}, slay: {target: 'Corwin'}, pass: {}, where: {}, go: {room: 'parlour'}, invite: {player: 'Bram', room: 'nook'}, leave: {},
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
  r = run(g, 'whisper', {to: 'Bram', text: 'Odette: keep this between us.'});
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
  r = run(g, 'whisper', {to: 'yus', text: 'Are you really the Monk?'});
  ok(r.ok && r.to === 'Yusuf', 'whisper finds a player by the start of the name');
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
  const noms = talk.entries.filter(e => e.type === 'nomination');
  ok(noms.length >= 1 && noms.every(e => e.text === `${e.by} (nominator) nominated ${e.target} (nominee).`), `in the real game each nomination names both parts (#89): ${JSON.stringify(noms[0])}`);
  console.log(`    | a real game, seed 7, to day ${game.day}: ${JSON.stringify({...done, bad: undefined})}; ${seats[0].name}'s header now:`);
  console.log(header(0).split('\n').map(l => '    | ' + l).join('\n'));
}

// ---- rooms (#28): where, go, invite, leave; speak says where the line went; whispers only between neighbours ----
section('rooms on the fake: where, go, invite, leave, the header, read_talk, whisper between neighbours');
{
  const useOf = h => ((h.match(/Useful now: ([^.]+)\./) || [])[1] || '').split(', ');
  // the day state: Ines and Corwin are in the nook, a line said there; Odette at the Square
  let g = fakeGame('day');
  let h = playerHeader(g, 0, fakeApi);
  ok(/You are at the Square; whisper only to your neighbours Yusuf and Bram\. Away: Ines and Corwin in the nook\./.test(h), `the header names my place, my neighbours and who is away: ${h}`);
  ok(/Rooms until nominations open: nook full, parlour 3 free, back room 4 free\./.test(h), 'the header names the rooms, what is free, and that they close at nominations');
  ok(/Moves: Ines and Corwin went to the nook\./.test(h), 'the header names who went off together since my last look');
  ok(useOf(h).includes('invite') && !useOf(h).includes('leave'), `at the Square with the rooms open, invite is useful: ${useOf(h)}`);
  let r = run(g, 'read_talk');
  ok(r.entries.some(e => e.type === 'move' && e.to === 'the nook' && JSON.stringify(e.seats) === '["Ines","Corwin"]' && e.by === 'Ines' && e.text === 'Ines and Corwin went to the nook.'), 'read_talk shows the move, with names and the room\'s name');
  ok(!JSON.stringify(r).includes('ROOM-LINE'), 'read_talk drops a room line said where I was not (its audience leaves me out)');
  ok(!/Moves:/.test(playerHeader(g, 0, fakeApi)), 'after read_talk the moves are not news');
  r = run(g, 'where');
  ok(r.ok && r.place === 'the Square' && r.with.length === 6 - 2 && JSON.stringify(r.neighbours) === '["Yusuf","Bram"]' && JSON.stringify(r.canWhisper) === '["Yusuf","Bram"]' && r.open === true,
    `where: my place, who is with me, my neighbours: ${JSON.stringify(r)}`);
  ok(JSON.stringify(r.rooms.find(x => x.id === 'nook')) === '{"id":"nook","name":"the nook","size":2,"free":0,"who":["Ines","Corwin"]}' && !r.square.includes('Ines'), 'where: each room with its seats and free places');
  clean(r, 'where');
  // whispers: only neighbours, only at the Square
  r = run(g, 'whisper', {to: 'Thea', text: 'Meet me later.'});
  ok(!r.ok && /only at the Square, and only to your neighbours at the table: Yusuf and Bram/.test(r.error) && /invite them to a room/.test(r.error), `a whisper to a non-neighbour is refused with the two names: ${r.error}`);
  ok(!g.events.some(e => e.type === 'whisper' && e.text === 'Meet me later.'), 'and nothing was whispered');
  // go, speak in the room, invite, leave
  r = run(g, 'go', {});
  ok(!r.ok && /go needs a room: nook \(the nook, for 2, full\), parlour/.test(r.error), `go with no room lists them: ${r.error}`);
  r = run(g, 'go', {room: 'the cellar'});
  ok(!r.ok && /There is no room/.test(r.error), `go to an unknown room is refused by the game: ${r.error}`);
  r = run(g, 'go', {room: 'nook'});
  ok(!r.ok && /full/.test(r.error), 'go to a full room is refused');
  r = run(g, 'go', {room: 'Parlour'});
  ok(r.ok && r.place === 'the parlour' && r.with.length === 0 && /Nobody else is here yet/.test(r.note) && /table saw you go/.test(r.note), `go: ${JSON.stringify(r)}`);
  h = playerHeader(g, 0, fakeApi);
  ok(/You are alone in the parlour: nobody hears you here; invite someone or leave\./.test(h) && useOf(h).includes('leave') && !useOf(h).includes('whisper'), `alone in a room the header says so, offers leave and no whisper: ${h}`);
  r = run(g, 'speak', {text: 'Is anyone there?'});
  ok(r.ok && r.heard === 'in the parlour, heard by nobody: you are alone there', `speak alone in a room says nobody heard: ${r.heard}`);
  r = run(g, 'invite', {player: 'Thea'});
  ok(r.ok && r.place === 'the parlour' && JSON.stringify(r.with) === '["Thea"]' && /Thea came with you/.test(r.note), `invite into my room: ${JSON.stringify(r)}`);
  r = run(g, 'invite', {player: 'Ines'});
  ok(!r.ok && /another place/.test(r.error), 'inviting a seat in another room is refused');
  r = run(g, 'speak', {text: 'Thea, I read Bram and Fitch last night.'});
  ok(r.ok && r.heard === 'in the parlour, heard by Thea', `speak in a room says who heard it: ${r.heard}`);
  r = run(g, 'whisper', {to: 'Bram', text: 'x'});
  ok(!r.ok && /no whispers in a room/.test(r.error) && /Yusuf and Bram/.test(r.error), `a whisper from a room is refused: ${r.error}`);
  const tt = run(g, 'read_talk', {}, 4);
  ok(tt.entries.some(e => e.type === 'say' && e.in === 'the parlour' && /read Bram and Fitch/.test(e.text)), 'Thea\'s read_talk shows the room line, marked with its place');
  ok(!JSON.stringify(run(g, 'read_talk', {since: 0}, 1)).includes('read Bram and Fitch'), 'Bram, outside, never reads the room line');
  ok(/Odette and Thea in the parlour/.test(playerHeader(g, 1, fakeApi)), "Bram's header says Odette and Thea are in the parlour");
  ok(/You are in the parlour with Thea: only you 2 hear what is said here/.test(playerHeader(g, 0, fakeApi)), 'my header names my room and who is with me');
  let wa = run(g, 'what_is_asked');
  ok(/You are in the parlour with Thea/.test(wa.place) && /rooms close when nominations open/.test(wa.place), `what_is_asked names my place and that the rooms close: ${wa.place}`);
  r = run(g, 'leave');
  ok(r.ok && r.place === 'the Square' && /whole table hears you again/.test(r.note), `leave: ${JSON.stringify(r)}`);
  r = run(g, 'leave');
  ok(!r.ok && /at the Square already/.test(r.error), 'leave at the Square is refused');
  r = run(g, 'invite', {player: 'Fitch'});
  ok(!r.ok && /Name a room to take Fitch to: nook/.test(r.error), `invite from the Square with no room asks for one: ${r.error}`);
  r = run(g, 'invite', {player: 'Fitch', room: 'back room'});
  ok(r.ok && r.place === 'the back room' && r.with.includes('Fitch'), 'invite from the Square to a named room takes us both');
  // the rooms close when nominations open: no room tools, no rooms line
  g = fakeGame('nominations');
  h = playerHeader(g, 0, fakeApi);
  ok(/You are at the Square; whisper only to your neighbours Yusuf and Bram\./.test(h) && !/Rooms,/.test(h) && !useOf(h).includes('invite'), `with nominations open: my place, no rooms: ${h}`);
  r = run(g, 'go', {room: 'nook'});
  ok(!r.ok && /rooms are closed/.test(r.error), `go with nominations open is refused: ${r.error}`);
  ok(!/You are at the Square|Rooms,/.test(playerHeader(fakeGame('night'), 0, fakeApi)), 'at night the header names no place');
  ok(/at night/.test(run(fakeGame('night'), 'where').text), 'where at night says nobody moves');
}

section('rooms in a real game: a line in a room stays in the room, the moves are public, whispers only to neighbours, rooms close at nominations');
{
  const LINE = 'ROOM-SECRET-only-the-parlour-hears-this';
  const game = newGame({seed: 7, rounds: 1}), sc = createScripted(7);
  const out = game.seats.map(() => []);
  const ctx = i => ({game, seat: {index: i, name: game.seats[i].name}, api: api.forSeat(i), log: () => {}});
  const call = (i, name, args = {}) => {const r = tool(name).handler(args, ctx(i)); out[i].push(JSON.stringify(r)); return r};
  const header = i => {const h = playerHeader(game, i); out[i].push(h); return h};
  for (let n = 0; n < 500 && !(game.phase === 'day' && api.roomsOpen(game)); n++) {
    const p = game.pending;
    if (p.seat === api.ST) api.answer(game, api.ST, sc(game), 'scripted'); else api.answer(game, p.seat, sc(game));
  }
  const nm = i => game.seats[i].name, [O, T, I] = [0, 4, 2], PARLOUR = api.where(game, 0).rooms.find(x => x.id === 'parlour').name; // the lore-keeper's name for it
  ok(api.roomsOpen(game) && game.seats.every(s => s.alive), `seed 7, day 1: the talk has begun and the rooms are open (${game.seats.map(s => s.name).join(', ')})`);
  const nbI = api.where(game, I).neighbours.map(nm);
  let r = call(O, 'where');
  ok(r.ok && r.place === 'the Square' && r.open && r.rooms.length === 3 && r.neighbours.length === 2, `where at the start of the day: ${JSON.stringify(r)}`);
  r = call(O, 'go', {room: 'parlour'});
  ok(r.ok && r.place === PARLOUR, `${nm(O)} goes to the parlour (${PARLOUR}): ${JSON.stringify(r)}`);
  r = call(O, 'invite', {player: nm(T)});
  ok(r.ok && JSON.stringify(r.with) === JSON.stringify([nm(T)]), `${nm(O)} invites ${nm(T)} into the parlour: ${JSON.stringify(r)}`);
  r = call(O, 'speak', {text: LINE});
  ok(r.ok && r.heard === `in ${PARLOUR}, heard by ${nm(T)}`, `${nm(O)} speaks in the parlour: ${r.heard}`);
  r = call(O, 'whisper', {to: nm(T), text: 'x'});
  ok(!r.ok && /no whispers in a room/i.test(r.error), `a whisper from the room is refused: ${r.error}`);
  const tT = call(T, 'read_talk');
  ok(tT.entries.some(e => e.type === 'say' && e.text === LINE && e.in === PARLOUR), `${nm(T)} hears the line, marked in ${PARLOUR}`);
  const hI = header(I);
  ok(new RegExp(`Moves: .*went to ${PARLOUR}.*into ${PARLOUR}`).test(hI) && new RegExp(`Away: ${nm(O)} and ${nm(T)} in ${PARLOUR}`).test(hI), `${nm(I)}'s header names the moves and who is away: ${hI}`);
  ok(hI.length < HEADER_CAP, `${nm(I)}'s header is under ${HEADER_CAP} (${hI.length})`);
  const tI = call(I, 'read_talk', {since: 0});
  ok(tI.entries.filter(e => e.type === 'move').length === 2 && !JSON.stringify(tI).includes(LINE), `${nm(I)}'s read_talk shows the two moves and not the line`);
  ok(new RegExp(`You are in ${PARLOUR} with`).test(call(T, 'what_is_asked').place || ''), `${nm(T)}'s what_is_asked names the room`);
  // a whisper to a non-neighbour, named with the two neighbours
  const far = game.seats.map(s => s.index).find(j => j !== I && !api.where(game, I).neighbours.includes(j) && api.where(game, j).place == null);
  r = call(I, 'whisper', {to: nm(far), text: 'A word, please.'});
  ok(!r.ok && r.error.includes(andNames(nbI)) && /Square/.test(r.error), `${nm(I)} whispering to ${nm(far)} is refused with ${andNames(nbI)}: ${r.error}`);
  r = call(T, 'leave');
  ok(r.ok && r.place === 'the Square' && api.where(game, T).place == null, `${nm(T)} leaves for the Square`);
  // the rest pass; when nominations open the rooms close and Odette comes back
  for (const s of game.seats) if (!game.clock.nominationsOpen && api.view(game, s.index).clock.toSpeak?.includes(s.index)) call(s.index, 'pass');
  ok(game.clock.nominationsOpen && api.where(game, O).place == null, `nominations open: ${nm(O)} is back at the Square`);
  const hO = header(O);
  ok(!/Rooms,/.test(hO) && /You are at the Square/.test(hO) && /rooms close/.test(hO), `${nm(O)}'s header: no rooms, at the Square, the closing in the moves: ${hO}`);
  r = call(O, 'go', {room: 'nook'});
  ok(!r.ok && /closed/.test(r.error), `go after nominations open is refused: ${r.error}`);
  for (const i of game.seats.map(s => s.index)) {if (i === O || i === T) continue; call(i, 'read_talk', {since: 0}); header(i); call(i, 'where'); call(i, 'what_is_asked')}
  for (const s of game.seats) if (s.index !== O && s.index !== T) ok(!out[s.index].some(x => x.includes(LINE)), `${s.name} never carries the room line`);
  console.log(`    | ${nm(I)}'s header with two in the parlour:`);
  console.log(hI.split('\n').map(l => '    | ' + l).join('\n'));
}
function andNames(xs) {return xs.length < 2 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`}


section('game 3 fixes: claims checked before repeated (#67), a reason to use a room (#68), notes that know they are stale (#71)');
{
  // #67: Odette claimed one role; Bram says she changed it; Corwin repeats it. claims shows the truth.
  const g = fakeGame('day');
  const ev = e => g.events.push({id: g.events.length, ...e});
  ev(say(0, "I'm the Ravenkeeper, so I'm not the Scarlet Woman."));
  ev(say(1, 'Odette changed her claim from Washerwoman to Ravenkeeper.', 2));
  ev(say(1, "I'm the Washerwoman, and I saw that coming.", 2));
  ev(say(3, 'Odette has claimed two roles, Washerwoman then Ravenkeeper.', 2));
  let r = run(g, 'claims', {}, 4);
  clean(r, 'claims');
  const of = n => r.claims.find(p => p.player === n)?.roles || [];
  ok(r.ok && of('Odette').length === 1 && of('Odette')[0].role === 'Ravenkeeper' && of('Odette')[0].day === 1 && of('Odette')[0].said === "I'm the Ravenkeeper, so I'm not the Scarlet Woman.",
    `claims: Odette named one role, with her exact line: ${JSON.stringify(of('Odette'))}`);
  ok(of('Bram').map(c => `${c.role}/${c.day}`).join(',') === 'Chef/1,Washerwoman/2', `claims: Bram named two roles, Chef on day 1 then Washerwoman on day 2: ${JSON.stringify(of('Bram'))}`);
  ok(!of('Corwin').length && r.noClaim.includes('Corwin') && /Bram/.test(r.note) && !/Odette/.test(r.note), `a line about someone else's claim is not a claim; the note names only Bram: ${r.note}`);
  r = run(g, 'claims', {player: 'odet'}, 4);
  ok(r.ok && r.claims.length === 1 && r.claims[0].roles.length === 1, 'claims for one player, by a prefix of the name');
  ok(!run(g, 'claims', {player: 'Nobody'}, 4).ok, 'claims for a player who does not exist is refused');
  ok(!JSON.stringify(run(g, 'claims', {}, 4)).includes('Poisoner'), 'a whisper between two others claims nothing for this seat');
  r = run(g, 'claims', {}, 0);
  ok(r.claims.find(p => p.player === 'Fitch')?.roles[0]?.whispered === 'to Odette', 'a claim whispered to me is listed, marked as whispered');
  const h = playerHeader(g, 4, fakeApi);
  ok(/Claims \(one player per role\): Chef: Bram; Ravenkeeper: Odette; Washerwoman: Bram \(day 2\)\. Bram named Chef then Washerwoman\./.test(h), `the header's claims line: ${h}`);
  ok(!/Fitch Monk/.test(playerHeader(g, 0, fakeApi)), 'a whispered claim stays out of the header line');
  const quiet = fakeGame('night'); quiet.events = quiet.events.filter(e => e.type !== 'say');
  ok(!/Claims so far/.test(playerHeader(quiet, 0, fakeApi)), 'no claims, no claims line');
  const cases = [["I'm the Ravenkeeper, so I'm not the Scarlet Woman.", 'Odette', 'Ravenkeeper'], ['I am Bram, the Washerwoman.', 'Bram', 'Washerwoman'],
    ['Empath here. I got a 1.', 'Thea', 'Empath'], ['As the Investigator, I learned something.', 'Ines', 'Investigator'], ["I'm not sure, but I'm the Fortune-Teller.", 'Odette', 'Fortune Teller'],
    ["If I'm the Imp, why say so?", 'Fitch', ''], ["You think I'm the Imp? No.", 'Fitch', ''], ['My Washerwoman claim came from an earlier game.', 'Odette', ''],
    ['Odette has now claimed Ravenkeeper.', 'Bram', ''], ['I saw Odette or Ines as the Ravenkeeper.', 'Bram', '']];
  for (const [t, s, want] of cases) ok(claimsInLine(t, s).join() === want, `claimsInLine(${JSON.stringify(t)}) is ${JSON.stringify(want)}: ${JSON.stringify(claimsInLine(t, s))}`);
  const sys = systemFor('player', 'Corwin');
  ok(/look it up with claims/.test(sys) && /quote both of their lines/.test(sys), 'the prompt: check a claim with claims before repeating it, quote both lines before saying it changed');
  ok(/claims \(every role/.test(PLAYER_TOOL_LINES), 'the tool lines name claims');
  // #81: every character is in play at most once. Two players claim the Mayor: the header marks it; one alone is no mark.
  const g2 = fakeGame('day');
  const ev2 = e => g2.events.push({id: g2.events.length, ...e});
  ev2(say(3, "I'm the Mayor, so keep me alive.")); ev2(say(6, 'Empath here. I got a 0.'));
  let h2 = playerHeader(g2, 4, fakeApi);
  ok(/one player per role\): .*Mayor: Corwin[;.]/.test(h2) && !/twice/.test(h2), `one Mayor claim alone shows no clash mark: ${h2}`);
  ev2(say(0, "I'm the Mayor, and Corwin is lying.", 2));
  h2 = playerHeader(g2, 4, fakeApi);
  ok(/one player per role unless marked\): .*Mayor: Odette and Corwin \(twice: at most one is\)/.test(h2) && /Empath: Yusuf[;.]/.test(h2), `two Mayor claims are marked as a clash, the Empath is not: ${h2}`);
  ok(h2.length <= HEADER_CAP, `the header with a clash stays under ${HEADER_CAP} (${h2.length})`);
  const r2 = run(g2, 'claims', {}, 4);
  clean(r2, 'claims');
  ok(r2.sameRole?.length === 1 && /^Mayor: claimed by Odette, Corwin. Each character is in play at most once/.test(r2.sameRole[0]), `the claims tool names the clash: ${JSON.stringify(r2.sameRole)}`);
  ok(!run(g, 'claims', {}, 4).sameRole, 'no clash, no sameRole field');
  const sys2 = systemFor('player', 'Bram');
  ok(/Every character is in play at most once/.test(sys2) && /lying, or is the Drunk/.test(sys2) && /bluffs are characters not in play/.test(sys2), 'the prompt: each character at most once, a second claim is a contradiction, bluffs are not in play');
  ok(/Every character is in play at most once/.test(systemFor('storyteller')), 'the Storyteller prompt carries the rule too');
}
{
  // #68: the header names one player to take to a room when the seat has a reason, and nobody when it has none
  const takeOf = h => (h.match(/Take (\w+) to the (\w+) to talk in private \(([^)]*)\): invite \1, room \2\./) || []).slice(1);
  let g = fakeGame('day');
  ok(!/Take \w+ to/.test(playerHeader(g, 0, fakeApi)), 'no reason, no invite line');
  ok(/Rooms until nominations open/.test(playerHeader(g, 0, fakeApi)), 'with no reason the rooms line is still there');
  g.events.push({id: g.events.length, ...say(1, 'Odette, what did you learn last night?')});
  let t = takeOf(playerHeader(g, 0, fakeApi));
  ok(t[0] === 'Bram' && t[1] === 'parlour' && /asked you a question/.test(t[2]), `someone asked me a question: ${t}`);
  g.events.push({id: g.events.length, ...say(6, 'I think Odette is lying about her night.')});
  t = takeOf(playerHeader(g, 0, fakeApi));
  ok(t[0] === 'Yusuf' && /spoke against you/.test(t[2]), `the newest line against me wins: ${t}`);
  const hT = playerHeader(g, 0, fakeApi);
  ok(/Free; rooms close when nominations open./.test(hT) && !/Rooms until/.test(hT) && hT.length < HEADER_CAP, `the invite line replaces the rooms line and the header stays under the cap (${hT.length})`);
  g = fakeGame('day'); g.events.push({id: g.events.length, ...say(3, 'Odette, why so quiet?')});
  ok(!/Take Corwin/.test(playerHeader(g, 0, fakeApi)), 'a player already in a room is not offered');
  g = fakeGame('day'); run(g, 'note', {text: 'Thea was kind; Fitch seems evil to me.'});
  t = takeOf(playerHeader(g, 0, fakeApi));
  ok(t[0] === 'Fitch' && /your notes doubt Fitch/.test(t[2]), `my own notes doubt a player: ${t}`);
  g = fakeGame('day'); g.events.push({id: g.events.length, ...say(4, "I'm the Fortune Teller, for what it is worth.")});
  t = takeOf(playerHeader(g, 0, fakeApi));
  ok(t[0] === 'Thea' && /claims to be the Fortune Teller too/.test(t[2]), `a player claims my own role: ${t}`);
  // the evil team: the partner the Storyteller named, ahead of any accuser
  const evilApi = {...fakeApi, view: (x, s) => ({...fakeApi.view(x, s), role: {id: 'poisoner', name: 'Poisoner', team: 'minion', ability: 'x'},
    told: [{night: 1, what: 'role', text: 'You are the Poisoner (minion): x'}, {night: 1, what: 'minion-info', text: 'The demon is Fitch.'}]})};
  g = fakeGame('day'); g.events.push({id: g.events.length, ...say(6, 'I think Odette is lying.')});
  t = takeOf(playerHeader(g, 0, evilApi));
  ok(t[0] === 'Fitch' && /Fitch is on your team/.test(t[2]), `the evil seat is offered its demon first: ${t}`);
  ok(!/on your team/.test(playerHeader(g, 0, fakeApi)), 'a good seat is never told someone is on its team');
  for (const st of ['night', 'nominations', 'vote', 'ended']) ok(!/Take \w+ to/.test(playerHeader(fakeGame(st), 0, evilApi)), `${st}: no invite line`);
  g = fakeGame('day'); g.places[0] = 'parlour'; ok(!/Take \w+ to/.test(playerHeader(g, 0, evilApi)), 'in a room already: no invite line');
  const sys = systemFor('player', 'Ines');
  ok(/costs no turn/.test(sys) && /team-mate when you are evil/.test(sys) && /one player who claimed a role/.test(sys) && /press one player/.test(sys) && !/says something too/.test(sys),
    'the prompt says when a room is worth it and that it costs no turn, and no longer warns seats off');
}
{
  // #71: a note the game has overtaken is marked, in the header and in my_notes; the words stay the seat's own
  const g = fakeGame('day');
  run(g, 'note', {text: 'Bram claims Chef.'});
  run(g, 'note', {text: 'Thea is dead too.'});
  run(g, 'note', {text: 'Bluff plan: I am the Empath if pressed.'});
  run(g, 'note', {text: 'I am Odette, the Empath.'});
  const h = playerHeader(g, 0, fakeApi);
  ok(/Stale notes: note 2 "Thea is dead" \(Thea is alive\); note 4 "I am Odette, the Empath" \(you are the Fortune Teller now\)\. Write a fresh note\./.test(h), `the header marks the stale notes: ${h}`);
  ok(h.length < HEADER_CAP, `with the notes line the header stays under ${HEADER_CAP} (${h.length}): ${h}`);
  const r = run(g, 'my_notes');
  ok(r.notes[0] === 'Bram claims Chef.' && r.notes[1] === 'Thea is dead too. [out of date: Thea is alive]' && r.notes[2] === 'Bluff plan: I am the Empath if pressed.' && /note 2: Thea is alive; note 4/.test(r.outOfDate),
    `my_notes keeps the words and marks the stale ones: ${JSON.stringify(r)}`);
  g.seats[4].alive = false;
  ok(!/note 2/.test(playerHeader(g, 0, fakeApi)), 'once Thea is dead the note is true again');
  run(g, 'note', {text: 'Yusuf is still alive.'}); g.seats[6].alive = false;
  ok(/"Yusuf is still alive" \(Yusuf is dead\)/.test(playerHeader(g, 0, fakeApi)), 'a dead player noted as alive is marked');
  ok(!/Stale notes/.test(playerHeader(fakeGame('day'), 0, fakeApi)), 'no notes, no notes line');
  ok(/marks a note stale, write a fresh one/.test(systemFor('player', 'Fitch')) && /told apart from what you guess/.test(systemFor('player', 'Fitch')), 'the prompt: facts apart from guesses, rewrite a stale note');
}
{
  // #71 and #68 in a real game: seed 23 deals Bram the Scarlet Woman and Fitch the Imp, as game 3 did
  const game = newGame({seed: 23, rounds: 1}), sc = createScripted(23);
  const ctx = i => ({game, seat: {index: i, name: game.seats[i].name}, api: api.forSeat(i), log: () => {}});
  const call = (i, name, args = {}) => tool(name).handler(args, ctx(i));
  const step = () => {const p = game.pending; if (p.seat === api.ST) api.answer(game, api.ST, sc(game), 'scripted'); else api.answer(game, p.seat, sc(game))};
  for (let n = 0; n < 500 && !(game.phase === 'day' && api.roomsOpen(game)); n++) step();
  const SW = game.seats.findIndex(s => s.role === 'scarlet-woman'), IMP = game.seats.findIndex(s => s.role === 'imp'), nm = i => game.seats[i].name;
  ok(SW >= 0 && IMP >= 0, `seed 23 deals a Scarlet Woman (${nm(SW)}) and an Imp (${nm(IMP)})`);
  const SNUG = api.where(game, SW).rooms.find(x => x.id === 'nook').name.replace(/^the\s+/i, '');
  let h = playerHeader(game, SW);
  ok(new RegExp(`Take ${nm(IMP)} to the ${SNUG} to talk in private \\(${nm(IMP)} is on your team\\): invite ${nm(IMP)}, room ${SNUG}\\.`).test(h), `the minion is offered a room with its demon: ${h}`);
  ok(h.length < HEADER_CAP, `${nm(SW)}'s header with the invite is under ${HEADER_CAP} (${h.length})`);
  const good = game.seats.findIndex(s => s.role === 'ravenkeeper');
  ok(!/Take \w+ to/.test(playerHeader(game, good)), `${nm(good)}, good with no reason yet, is offered nobody`);
  let r = call(SW, 'invite', {player: nm(IMP), room: SNUG});
  ok(r.ok && r.with.includes(nm(IMP)), `the invite the header spells out works as written: ${JSON.stringify(r)}`);
  call(SW, 'leave'); call(IMP, 'leave');
  call(SW, 'note', {text: `I am ${nm(SW)}, Scarlet Woman (evil minion). The demon is ${nm(IMP)}.`});
  ok(!/Stale notes/.test(playerHeader(game, SW)) && !call(SW, 'my_role').changed, 'before the change the note is true and my_role says nothing changed');
  for (const s of game.seats) if (!game.clock.nominationsOpen) call(s.index, 'pass');
  call(good, 'nominate', {target: nm(IMP)});
  for (let n = 0; n < 50 && game.pending?.kind === 'vote'; n++) {const s = game.pending.seats.find(x => api.pendingFor(game, x)?.mine === null); if (s == null) break; call(s, 'vote', {yes: 'yes'})}
  for (let n = 0; n < 500 && game.phase !== 'night' && game.pending; n++) {
    if (game.pending.kind === 'nomination') {for (const s of game.seats) if (api.pendingFor(game, s.index)?.kind === 'nomination') call(s.index, 'pass'); continue}
    step();
  }
  ok(game.seats[SW].role === 'imp' && !game.seats[IMP].alive, `${nm(IMP)} is executed and ${nm(SW)} becomes the Imp`);
  const mr = call(SW, 'my_role');
  ok(mr.changed === 'You were the Scarlet Woman; you are the Imp now, since day 1.' && mr.role === 'Imp', `my_role says the change plainly: ${mr.changed}`);
  h = playerHeader(game, SW);
  ok(new RegExp(`^You are ${nm(SW)}, the Imp \\(demon, evil\\), alive\\. You were the Scarlet Woman until day 1\\.`).test(h), `the header's first line says the change: ${h.split('\n')[0]}`);
  ok(new RegExp(`Stale notes: note 1 "I am ${nm(SW)}, Scarlet Woman" \\(you are the Imp now\\)`).test(h), `the header marks the old note: ${h}`);
  for (const s of game.seats) if (s.index !== SW) {
    ok(!call(s.index, 'my_role').changed && !/You were the/.test(playerHeader(game, s.index)) && !/Scarlet Woman" \(/.test(playerHeader(game, s.index)),
      `${s.name} sees nothing of ${nm(SW)}'s change or notes`);
  }
}

section("game 4 fixes: no dodge on day 1 (#87), the Poisoner's targets (#88), the log read right (#89), claims in other words (#92)");
{
  // #92: a claim made by describing the ability is a claim, marked "said, not named"; a line about someone else is not
  const cases = [['Ines nominated me, and my Virgin ability fired.', 'Odette', 'Virgin'], ['Ines nominated me and my trap fired.', 'Odette', 'Virgin'],
    ['Bram nominated me yesterday and nobody died.', 'Odette', ''], ['If anyone nominates me, they die on the spot.', 'Odette', 'Virgin'],
    ['I hold a townsfolk role that guards one neighbour each night from the demon.', 'Ines', 'Monk'], ['I guard one player each night.', 'Ines', 'Monk'],
    ['Two of my neighbours are evil, sadly.', 'Thea', 'Empath'], ['My first-night read was that no two evil players sit side by side.', 'Thea', 'Chef'],
    ['Thea says no two evil players sit side by side.', 'Bram', ''], ["The demon can't kill me, so test me.", 'Corwin', 'Soldier'], ["Odette's trap fired on Ines.", 'Fitch', ''],
    ['My Empath number was 1.', 'Thea', 'Empath'], ['If I am executed, good loses.', 'Fitch', 'Saint'], ['I learned there are no outsiders.', 'Fitch', 'Librarian']];
  for (const [t, s, want] of cases) ok(claimsInLine(t, s).join() === want, `claimsInLine(${JSON.stringify(t)}) is ${JSON.stringify(want)}: ${JSON.stringify(claimsInLine(t, s))}`);
  const g = fakeGame('day');
  const ev = e => g.events.push({id: g.events.length, ...e});
  ev(say(2, 'I hold a townsfolk role that guards one neighbour each night from the demon.'));
  ev(say(3, "I'm the Mayor; keep me alive."));
  let h = playerHeader(g, 4, fakeApi);
  ok(/Claims \(one player per role\): Chef: Bram; Monk: Ines \(said not named\); Mayor: Corwin\. No night answer to give yet: Monk and Mayor \(silence there is no dodge\)\./.test(h),
    `the claims line: by role, each by one player, a claim said not named, and the roles with nothing to tell on day 1: ${h}`);
  const r = run(g, 'claims', {}, 4);
  clean(r, 'claims');
  const monk = r.claims.find(p => p.player === 'Ines')?.roles[0];
  ok(monk?.role === 'Monk' && /said, not named/.test(monk.how) && r.oneClaim.includes('Mayor: Corwin, the one claim'), `the claims tool: the Monk said not named, the Mayor the one claim: ${JSON.stringify(r)}`);
  ev(say(2, "Fine: I'm the Monk.", 1));
  ok(!run(g, 'claims', {}, 4).claims.find(p => p.player === 'Ines').roles[0].how && !/said not named/.test(playerHeader(g, 4, fakeApi)), 'once named, the claim is named');
  g.day = 2;
  h = playerHeader(g, 4, fakeApi);
  ok(!/No night answer/.test(h) && /Monk: Ines \(day 1\)/.test(h), `on day 2 the day-1 mark is gone and the claims of day 1 carry their day: ${h}`);
  const sys = systemFor('player', 'Thea');
  ok(/never "the only Mayor left"/.test(sys) && /has claimed that role; claims lists it as said, not named/.test(sys), 'the prompt: no "only Mayor left", an ability described is a claim');
}
{
  // #87: the Monk on day 1 is told she has nothing to tell yet; an evil seat and an information role keep the usual nudge
  const as = (role, team, ability = 'x') => ({...fakeApi, view: (x, s) => ({...fakeApi.view(x, s), role: {id: role, name: role[0].toUpperCase() + role.slice(1), team, ability}})});
  const g = fakeGame('day');
  const h = playerHeader(g, 2, as('monk', 'townsfolk'));
  ok(/First day: the Monk first acts on night 2, so you have nothing to tell yet; say so if asked, and ask a player a question by name\./.test(h), `the Monk's day 1 nudge: ${h}`);
  ok(/First day: the Mayor learns nothing at night/.test(playerHeader(g, 2, as('mayor', 'townsfolk'))), 'the Mayor learns nothing at night');
  ok(/First day: say something about yourself/.test(playerHeader(g, 2, as('chef', 'townsfolk'))), 'the Chef has something to tell: the usual nudge');
  ok(/First day: say something about yourself/.test(playerHeader(g, 2, as('baron', 'minion'))), 'an evil seat is not told its role has nothing to tell');
  const mr = tool('my_role').handler({}, {...ctxFor(g, 2), api: as('monk', 'townsfolk')});
  ok(/first acts on night 2: on day 1 you have nothing to tell/.test(mr.day1) && !mr.reads, `my_role for the Monk: ${JSON.stringify(mr)}`);
  const sys = systemFor('player', 'Ines');
  ok(/A question a role cannot answer yet is not evidence/.test(sys) && /Monk and the Undertaker first act on night 2/.test(sys) && /Never nominate on an unanswered question alone/.test(sys) && /one standard/.test(sys),
    'the prompt: an unanswered question is no evidence, the roles with nothing on day 1, one standard, never nominate on it alone');
}
{
  // #89: my_role says what a count can and cannot show; read_talk and the header word the Virgin's trap with both parts named
  const chef = {...fakeApi, view: (x, s) => ({...fakeApi.view(x, s), role: {id: 'chef', name: 'Chef', team: 'townsfolk', ability: 'x'}})};
  const g = fakeGame('day');
  const mr = tool('my_role').handler({}, {...ctxFor(g, 4), api: chef});
  ok(/It names nobody: 0 means no two evil sit together, not who is evil/.test(mr.reads) && !mr.day1, `my_role for the Chef: ${JSON.stringify(mr)}`);
  ok(/does not say which one/.test(tool('my_role').handler({}, {...ctxFor(g, 4), api: {...fakeApi, view: (x, s) => ({...fakeApi.view(x, s), role: {id: 'empath', name: 'Empath', team: 'townsfolk'}})}}).reads), 'my_role for the Empath');
  const ev = e => g.events.push({id: g.events.length, ...e});
  ev({type: 'nomination', by: 1, target: 0, day: 1, audience: 'all', text: 'Bram nominates Odette.'});
  ev({type: 'virgin', seat: 1, target: 0, day: 1, audience: 'all', text: 'Bram is executed at once for nominating Odette.'});
  ev({type: 'execution', seat: 1, day: 1, audience: 'all', text: 'Bram is executed.'});
  g.seats[1].alive = false;
  const t = run(g, 'read_talk', {since: 0}, 4).entries;
  ok(t.find(e => e.type === 'nomination')?.text === 'Bram (nominator) nominated Odette (nominee).', `read_talk names both parts of a nomination: ${JSON.stringify(t.find(e => e.type === 'nomination'))}`);
  ok(t.find(e => e.type === 'virgin')?.text === 'Bram (nominator) nominated Odette (nominee); Odette is the Virgin, so the trap fired: Bram, the nominator, is executed at once.', `read_talk words the trap: ${JSON.stringify(t.find(e => e.type === 'virgin'))}`);
  g.day = 2;
  const h = playerHeader(g, 4, fakeApi);
  ok(/Record: day 1, Bram nominated Odette, the Virgin's trap fired and Bram \(the nominator\) died\./.test(h) && !/Bram was executed/.test(h), `the header's record line: ${h}`);
  ok(!/Record:/.test(playerHeader(fakeGame('day'), 4, fakeApi)), 'no deaths by day, no record line');
  const sys = systemFor('player', 'Fitch');
  ok(/check every statement about the log against the log/.test(sys) && /the nominator dies, never the Virgin/.test(sys) && /A count names nobody/.test(sys), 'the prompt: check the log, the trap kills the nominator, a count names nobody');
}
{
  // #88: the Poisoner, at night with the poison to pick, sees whose claimed ability still works and whose is spent
  const poisoner = {...fakeApi, view: (x, s) => ({...fakeApi.view(x, s), role: {id: 'poisoner', name: 'Poisoner', team: 'minion', ability: 'x'},
    told: [{night: 1, what: 'role', text: 'You are the Poisoner (minion): x'}, {night: 1, what: 'minion-info', text: 'The demon is Corwin.'}]})};
  const g = fakeGame('night');
  const ev = e => g.events.splice(g.events.length - 1, 0, {...e}); // before the night's phase line
  ev({type: 'virgin', seat: 1, target: 0, day: 1, audience: 'all'}); ev({type: 'execution', seat: 1, day: 1, audience: 'all', text: 'Bram is executed.'});
  ev(say(0, 'Bram nominated me, and my trap fired.')); ev(say(5, "I'm the Librarian; there are no outsiders."));
  ev(say(4, 'Empath here, I got a 1.')); ev(say(2, 'I guard one player each night.')); ev(say(3, "I'm the Soldier."));
  g.events.forEach((e, k) => {e.id = k});
  g.seats[1].alive = false;
  g.pending[6] = {...g.pending[0], seat: 6, role: 'poisoner', question: 'Yusuf (Poisoner): pick a player to poison tonight.', options: [0, 1, 2, 3, 4, 5, 6], count: 1};
  const h = playerHeader(g, 6, poisoner);
  ok(/Poison: worth it on Ines \(Monk\) and Thea \(Empath\); wasted on Odette \(Virgin, fired day 1\) and Fitch \(Librarian, first night only\)\. Never on the player your demon kills tonight\./.test(h),
    `the Poisoner's line: live and spent abilities, not the demon: ${h}`);
  ok(!/Corwin/.test(h.split('\n').find(l => l.startsWith('Poison:')) || 'Corwin'), 'the demon is never offered as a target');
  ok(h.length <= HEADER_CAP, `the Poisoner's night header stays under ${HEADER_CAP} (${h.length})`);
  ok(!/^Poison:/m.test(playerHeader(g, 0, fakeApi)), 'a good seat never sees the poison line');
  g.night = 1; ok(!/^Poison:/m.test(playerHeader(g, 6, poisoner)), 'night 1: nobody has claimed yet, no poison line');
  const sys = systemFor('player', 'Yusuf');
  ok(/wasted on an ability already spent/.test(sys) && /on the player the demon kills that night/.test(sys) && /agree in a room with your team-mate/.test(sys), "the prompt: poison a live ability, never a spent one or the demon's kill, agree by day");
}
{
  // a full day-2 header as game 4 had it: rooms, place, an invite, a record, five claims with marks, the talk read on day 1
  const g = fakeGame('day');
  const ev = e => g.events.push({id: g.events.length, ...e});
  ev({type: 'virgin', seat: 1, target: 0, day: 1, audience: 'all'}); ev({type: 'execution', seat: 1, day: 1, audience: 'all'});
  ev({type: 'slayer-shot', seat: 5, target: 6, day: 1, audience: 'all'});
  g.seats[1].alive = false; g.day = 2;
  run(g, 'read_talk', {}, 0);
  ev(say(0, 'Bram nominated me, and my trap fired.', 2)); ev(say(5, "I'm the Librarian; there are no outsiders.", 2));
  ev(say(4, 'Empath here, I got a 1.', 2)); ev(say(6, "I'm the Mayor.", 2)); ev(say(3, "I'm the Mayor, not Yusuf.", 2)); ev(say(4, 'Thea is lying, Odette.', 2));
  const h = playerHeader(g, 0, fakeApi);
  ok(h.length <= HEADER_CAP, `a full day-2 header stays under ${HEADER_CAP} (${h.length})`);
  console.log(`    | a full day-2 header (${h.length}):`);
  console.log(h.split('\n').map(l => '    | ' + l).join('\n'));
}

{
  // game 4's deal (seed 31: Odette Virgin, Bram Imp, Ines Monk, Yusuf Poisoner) played by the scripted seats; each seat reads
  // the talk before its header, as a runner does. The Monk's day 1 says she has nothing to tell yet; the Poisoner's nights
  // carry the poison line and never offer the demon; every header stays under the cap.
  const first = newGame({seed: 31}), sc = createScripted(31);
  for (let n = 0; n < 500 && !(first.phase === 'day' && api.roomsOpen(first)); n++) {
    const p = first.pending; if (p.seat === api.ST) api.answer(first, api.ST, sc(first), 'scripted'); else api.answer(first, p.seat, sc(first));
  }
  const monk = first.seats.findIndex(s => s.role === 'monk');
  ok(monk >= 0 && /First day: the Monk first acts on night 2, so you have nothing to tell yet/.test(playerHeader(first, monk)), `the Monk's day 1 header: ${monk >= 0 ? playerHeader(first, monk) : 'no Monk'}`);
  const game = newGame({seed: 31});
  const role = id => game.seats.findIndex(s => s.role === id);
  const POIS = role('poisoner'), IMP = role('imp');
  const seen = {poison: [], max: 0, at: ''};
  playScripted(game, 31, {onDecision: () => {
    for (const s of game.seats) {
      tool('read_talk').handler({}, {game, seat: {index: s.index, name: s.name}, api: api.forSeat(s.index), log: () => {}});
      const h = playerHeader(game, s.index);
      if (h.length > seen.max) {seen.max = h.length; seen.at = h}
      const pl = h.split('\n').find(l => l.startsWith('Poison:'));
      if (s.index === POIS && pl) seen.poison.push(pl);
    }
  }});
  ok(POIS >= 0 && IMP >= 0, 'seed 31 deals a Poisoner and an Imp');
  ok(seen.poison.length >= 1 && seen.poison.every(l => !l.includes(game.seats[IMP].name)), `the Poisoner's nights carry the poison line, never the demon: ${JSON.stringify(seen.poison)}`);
  ok(seen.max <= HEADER_CAP, `seed 31 played out, each seat reading before its header: the longest header is ${seen.max} (cap ${HEADER_CAP})${seen.max > HEADER_CAP ? ': ' + seen.at : ''}`);
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
