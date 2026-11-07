// npm run apicheck: the game api (src/game/api.js) and the relay backend (src/game/backend.js) on seeded games.
//  1. Every api function in its legal and illegal cases on a fixed deal: talk at night, an empty, long or repeated line, a
//     second line in one round, the rounds opening the nominations, a dead seat nominating, a vote from a seat not in the
//     ballot, a repeat vote, the ballot completing the engine's vote, closeVote, endDay, the day ending by itself, whispers
//     (a third seat sees only whisper-seen), told seen by its seat only, notes capped at 50, Storyteller answers needing a
//     reason, and no view, pending or event ever carrying a token, a reason or another seat's role.
//  2. forSeat: a player's api acts and reads only as itself and has no Storyteller function.
//  3. A plain (JSON) copy restores to the same game.
//  4. Scripted games played to their end through the api alone (players: say, pass, nominate, vote, answer; the
//     Storyteller: answer with reasons) make the same engine decisions and the same winner as `npm run sim`, and the same
//     seed gives the same transcript twice.
//  5. The backend: tool handlers get a seat-bound api, an ApiError comes back as {ok: false, error}, pace wakes 'now' for a
//     decision and 'soft' for unseen events, and the scripted Storyteller answers after its grace period.
// Exit 1 on any failure.
import {newGame, createScripted} from '../src/game/index.js';
import * as api from '../src/game/api.js';
import {gameBackend} from '../src/game/backend.js';
import {simulate} from './headless.mjs';

let fails = 0, passes = 0;
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)}};
const section = name => console.log(`- ${name}`);
const ST = 'storyteller';
const throws = (f, re) => {try {f(); return false} catch (e) {return e instanceof api.ApiError && (!re || re.test(e.message))}};
const msgOf = f => {try {f(); return ''} catch (e) {return e.message}};
const keysDeep = (v, out = new Set()) => {if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {if (!Array.isArray(v)) out.add(k); keysDeep(x, out)} return out};
const FORBIDDEN_KEYS = ['tokens', 'token', 'reason', 'believed', 'truth', 'audience', 'grimoire', 'cause', 'role'];

// What a seat may see, gathered: its view, its pending and all its events.
const seen = (g, i) => ({view: api.view(g, i), pending: api.pendingFor(g, i), events: api.events(g, i)});
// No key that only the Storyteller has; `role` appears only as the seat's own role in its view.
function clean(g, i) {
  const s = seen(g, i), {role, ...rest} = s.view;
  const keys = keysDeep({...s, view: rest});
  return FORBIDDEN_KEYS.filter(k => keys.has(k) && !(k === 'role' && s.pending && s.pending.role === s.view.role.id));
}

// The quiet Storyteller and quiet night choices, through the api.
function settle(g, choices = {}, until = gm => gm.phase === 'day' && gm.pending?.kind === 'nomination') {
  for (let n = 0; n < 500 && g.pending && !until(g); n++) {
    const p = g.pending;
    if (p.seat === ST) {
      const v = p.kind === 'demon-bluffs' ? p.options.slice(0, p.count) : p.kind === 'info' ? (p.truth.length ? p.truth : p.options)[0] : p.kind === 'register' ? p.options[0] : p.options[0];
      api.answer(g, ST, v, `quiet default for ${p.kind}`);
    } else if (p.kind === 'choose') {
      const pick = choices[p.role]?.(g, p);
      api.answer(g, p.seat, pick !== undefined ? pick : p.count ? p.options.filter(x => x !== p.seat).slice(0, p.count) : p.options.includes(null) ? null : p.options.find(x => x !== p.seat));
    } else break;
  }
}
const talkRound = (g, tag) => {for (const s of g.seats) if (s.alive && !g.clock.nominationsOpen) api.say(g, s.index, `${s.name} speaks, ${tag}, day ${g.day} round ${g.clock.round}.`)};

// Odette washerwoman, Bram soldier, Ines imp, Corwin poisoner, Thea butler, Fitch empath, Yusuf chef
const ROLES = ['washerwoman', 'soldier', 'imp', 'poisoner', 'butler', 'empath', 'chef'];

section('setup and the first night');
const g = newGame({seed: 1, roles: ROLES});
{
  settle(g, {poisoner: () => 6, butler: () => 0}, gm => gm.pending?.seat === ST);
  ok(g.log.every(e => e.audience && Number.isInteger(e.id)) && g.log.every((e, k) => e.id === k), 'every log entry has an increasing id and an audience');
  const p = api.pendingFor(g, ST);
  ok(p && p.seat === ST && Array.isArray(p.options), `the Storyteller sees its pending whole (${p && p.kind})`);
  ok(throws(() => api.answer(g, ST, p.kind === 'demon-bluffs' ? p.options.slice(0, p.count) : p.options[0]), /reason/), 'a Storyteller answer without a reason is refused');
  ok(throws(() => api.answer(g, ST, '__nope__', 'because'), /not an option|pick exactly/), 'a Storyteller answer outside the options is refused');
  ok(throws(() => api.answer(g, 1, 3), /Nothing is asked of you/), 'a player answering with nothing pending is refused, and told what is legal');
  ok(throws(() => api.say(g, 0, 'hello'), /only in the day/), 'no talk before the day');
  ok(throws(() => api.whisper(g, 0, 1, 'hello'), /only in the day/), 'no whisper before the day');
  ok(throws(() => api.view(g, ST)) && throws(() => api.view(g, 9), /no seat/), 'view needs a player seat');
  settle(g, {poisoner: () => 6, butler: () => 0});
  ok(g.phase === 'day' && g.day === 1 && g.pending.kind === 'nomination', 'the game reaches day 1 through the api');
  const ww = api.events(g, 0).filter(e => e.type === 'told');
  ok(ww.length === 2 && ww[1].what === 'washerwoman' && /^One of .* is the /.test(ww[1].text), `told reaches its seat as a sentence: "${ww[1] && ww[1].text}"`);
  ok(api.view(g, 0).told.length === 2, "the Washerwoman's view carries her own role and her information");
  for (let i = 1; i < 7; i++) ok(!api.events(g, i).some(e => e.type === 'told' && e.what === 'washerwoman'), `${g.seats[i].name} never sees the Washerwoman's information`);
  const imp = api.view(g, 2).told.map(t => t.text).join(' ');
  ok(/Your minion is Corwin/.test(imp) && /bluff/.test(imp), `the demon is told its minion and its bluffs: "${imp.slice(0, 160)}"`);
  const bram = JSON.stringify(seen(g, 1));
  const others = g.seats.filter(s => s.index !== 1).map(s => g.script.roles.find(r => r.id === s.role));
  ok(others.every(r => !bram.includes(r.name) && !bram.includes(`"${r.id}"`)), "the Soldier's view, pending and events name no other seat's role");
  for (let i = 0; i < 7; i++) {const bad = clean(g, i); ok(!bad.length, `${g.seats[i].name} sees no token, reason or other role (${bad.join(', ') || 'clean'})`)}
  ok(api.rulings(g).every(r => r.reason && r.reason.startsWith('quiet default')), `every ruling keeps its reason (${api.rulings(g).length})`);
}

section('day 1: the talk and the clock');
{
  const v = api.view(g, 0);
  ok(v.clock.round === 1 && v.clock.roundsBeforeNominations === 3 && !v.clock.nominationsOpen && v.clock.toSpeak.length === 7, 'day 1 starts at round 1 of 3, nominations closed, seven to speak');
  ok(throws(() => api.say(g, 0, '   '), /Say something/), 'an empty line is refused');
  ok(throws(() => api.say(g, 0, 'x'.repeat(601)), /under 600/), 'a line over 600 characters is refused');
  api.say(g, 0, 'Good morning, all.');
  ok(throws(() => api.say(g, 0, 'And another thing.'), /had your turn/), 'a second line in one round is refused');
  ok(throws(() => api.pass(g, 0), /had your turn/), 'so is a pass after a line in the same round');
  ok(throws(() => api.nominate(g, 1, 2), /not open yet/), 'nominating before the rounds are done is refused');
  for (const i of [1, 2, 3, 4, 5]) api.say(g, i, `Seat ${i} says hello.`);
  api.pass(g, 6);
  ok(g.clock.round === 2 && api.events(g, 3).some(e => e.type === 'phase' && e.what === 'round' && e.round === 2), 'the round ends when every living seat has spoken or passed, and the table hears it');
  ok(throws(() => api.say(g, 0, 'good morning, all'), new RegExp(api.REPEAT_MESSAGE.replace(/[.;]/g, '.'))), `a repeat of one of the last three lines is refused: "${msgOf(() => api.say(g, 0, 'Good morning, all.')).slice(0, 60)}"`);
  ok(throws(() => api.say(g, 0, 'Это моя реплика здесь'), /English/), 'a line not in English is refused');
  api.whisper(g, 0, 5, 'Psst, Fitch: the secret word is marmalade.');
  ok(api.events(g, 5).some(e => e.type === 'whisper' && /marmalade/.test(e.text)), 'the whisper reaches its listener');
  ok(api.events(g, 0).some(e => e.type === 'whisper' && /marmalade/.test(e.text)), 'and its speaker');
  const third = api.events(g, 1);
  ok(!JSON.stringify(third).includes('marmalade') && third.some(e => e.type === 'whisper-seen' && e.from === 0 && e.to === 5), 'a third seat sees only whisper-seen');
  ok(!JSON.stringify(api.events(g, ST)).includes('marmalade'), 'the Storyteller does not hear the whisper either');
  ok(throws(() => api.whisper(g, 0, 0, 'me'), /yourself/) && throws(() => api.whisper(g, 0, 12, 'hi'), /seat number/), 'a whisper to oneself or to no seat is refused');
  talkRound(g, 'second'); talkRound(g, 'third');
  ok(g.clock.nominationsOpen && api.events(g, 2).some(e => e.type === 'phase' && e.what === 'nominations'), 'after three rounds nominations open, and the table hears it');
  const pn = api.pendingFor(g, 0);
  ok(pn && pn.kind === 'nomination' && pn.targets.length === 7, 'a living seat that has not nominated gets the nomination round');
}

section('day 1: nominations, the ballot, endDay');
{
  ok(throws(() => api.nominate(g, 0, 99), /seat number/), 'a nomination of no seat is refused');
  api.nominate(g, 0, 1);
  ok(g.pending.kind === 'vote' && g.pending.nominee === 1, 'Odette nominates Bram: the vote opens');
  ok(throws(() => api.nominate(g, 0, 3), /nominated today already/), 'a second nomination by the same seat is refused');
  ok(throws(() => api.nominate(g, 2, 1), /Bram has been nominated/), 'a second nomination of the same seat is refused');
  ok(throws(() => api.endDay(g), /close it first/), 'endDay is refused while a vote is open');
  ok(throws(() => api.vote(g, 0, 'maybe'), /yes \(true\) or no/), 'a vote is yes or no');
  api.vote(g, 0, true);
  ok(throws(() => api.vote(g, 0, false), /voted already/), 'a repeat vote is refused');
  const pv = api.pendingFor(g, 3);
  ok(pv.kind === 'vote' && pv.voted.join() === '0' && pv.ballots[0] === true && pv.mine === null && api.pendingFor(g, 0).mine === true, 'the vote pending shows who has voted and the seat\'s own hand');
  ok(api.mustAct(g, 3) && !api.mustAct(g, 0), 'a seat that voted is not asked again');
  const before = g.today.votes.length;
  for (const i of [1, 2, 3, 4, 5]) api.answer(g, i, false);
  ok(g.today.votes.length === before && g.pending.kind === 'vote', 'the ballot waits for the last voter');
  api.vote(g, 6, true);
  ok(g.today.votes.length === before + 1 && g.pending.kind === 'nomination', 'the last voter completes the ballot and the engine counts it');
  const vr = api.events(g, 4).filter(e => e.type === 'vote-result').at(-1);
  ok(vr && vr.tally === 2 && vr.needed === 4 && !('voided' in vr), `the table sees the result: "${vr && vr.text}"`);
  ok(api.view(g, 4).today.nominations[0].result === 'not enough', "the day's book in the view shows it");
  api.endDay(g);
  ok(g.phase === 'night' && g.night === 2, 'endDay ends the day: night 2');
  ok(throws(() => api.endDay(g), /not day/), 'endDay at night is refused');
}

section('night 2 and day 2: the dead, ghost votes, closeVote, the day ending itself');
{
  settle(g, {poisoner: () => 6, imp: () => 0, butler: () => 3});
  ok(g.phase === 'day' && !g.seats[0].alive, 'the Imp killed Odette in the night');
  const dawn = api.events(g, 3).filter(e => e.type === 'dawn').at(-1);
  ok(dawn && /Odette died in the night/.test(dawn.text) && !('grimoire' in dawn), `dawn tells the table who died, and nothing more: "${dawn && dawn.text}"`);
  api.openNominations(g);
  ok(g.clock.nominationsOpen, 'the Storyteller opens the nominations early');
  ok(throws(() => api.nominate(g, 0, 2), /dead may not nominate/), 'a dead seat may not nominate');
  api.say(g, 0, 'From beyond: I was the Washerwoman.');
  ok(api.events(g, 1).some(e => e.type === 'say' && e.seat === 0), 'the dead still speak');
  api.nominate(g, 4, 6);
  api.vote(g, 0, true);
  for (const i of [1, 2, 3, 4, 5, 6]) api.vote(g, i, false);
  ok(!g.seats[0].ghostVote && !api.view(g, 0).ghostVote, "Odette's yes spends her ghost vote");
  api.nominate(g, 5, 3);
  ok(throws(() => api.vote(g, 0, true), /ghost vote is spent/), 'a vote from a seat not in the ballot is refused');
  ok(api.pendingFor(g, 0) === null, 'and it gets no vote pending');
  api.vote(g, 1, true);
  const closed = api.closeVote(g);
  ok(closed.missing.length === 5, 'the Storyteller closes the vote');
  const vc = api.events(g, 2).filter(e => e.type === 'vote-closed').at(-1);
  ok(vc && vc.missing.length === 5 && g.pending.kind === 'nomination', `closeVote counts the missing as no and the table hears it: "${vc && vc.text}"`);
  ok(throws(() => api.closeVote(g), /No vote is open/), 'closeVote with no vote open is refused');
  api.pass(g, 1); api.pass(g, 2); api.answer(g, 3, null);
  ok(g.phase === 'day', 'the day goes on while a living seat has neither nominated nor passed');
  api.pass(g, 6);
  ok(g.phase === 'night' && api.events(g, 1).some(e => e.type === 'phase' && e.what === 'day-ends'), 'every living seat nominated or passed: the day ends by itself');
  for (let i = 0; i < 7; i++) {const bad = clean(g, i); ok(!bad.length, `after two days ${g.seats[i].name} still sees no token, reason or other role (${bad.join(', ') || 'clean'})`)}
}

section('notes');
{
  for (let k = 1; k <= 51; k++) api.note(g, 1, `note ${k}`);
  const n = api.notes(g, 1);
  ok(n.length === 50 && n[0].text === 'note 2' && n.at(-1).text === 'note 51', 'notes keep the newest 50; the 51st drops the oldest');
  ok(throws(() => api.note(g, 1, ' ')) && throws(() => api.note(g, 1, 'x'.repeat(601))), 'an empty or overlong note is refused');
  ok(api.notes(g, 2).length === 0 && !JSON.stringify(seen(g, 2)).includes('note 51'), 'nobody else reads them');
}

section('forSeat: a seat acts and reads only as itself');
{
  const a = api.forSeat(1), s = api.forSeat(ST);
  ok(throws(() => a.view(g, 2), /only as yourself/) && throws(() => a.events(g, 2)) && throws(() => a.notes(g, 2)) && throws(() => a.say(g, 2, 'hi')), "a player's api refuses another seat");
  ok(throws(() => a.grimoire(g), /Only the Storyteller/) && throws(() => a.rulings(g)) && throws(() => a.endDay(g)), "a player's api has no Storyteller function");
  ok(a.view(g, 1).name === 'Bram' && a.notes(g, 1).length === 50, "it reads its own seat");
  ok(s.view(g, 2).name === 'Ines' && Array.isArray(s.grimoire(g).seats) && throws(() => s.notes(g, 2)) && throws(() => s.events(g, 2)) && throws(() => s.say(g, 2, 'x')), 'the Storyteller reads any view and the grimoire, never a seat\'s notes or whispers, and never acts for a player');
  const no = api.nightOrder(g);
  ok(no.night === 3 && no.steps.some(x => x.step === 'imp') && (g.phase === 'night' ? no.steps.some(x => x.status === 'now') : no.steps.every(x => x.status === 'to come')), 'nightOrder gives the waking order of the night and where the night stands');
}

section('a plain copy restores');
{
  const back = api.restore(JSON.parse(JSON.stringify(g)));
  ok(JSON.stringify(back.log) === JSON.stringify(g.log) && JSON.stringify(back.clock) === JSON.stringify(g.clock) && JSON.stringify(back.notes) === JSON.stringify(g.notes) && JSON.stringify(back.pending) === JSON.stringify(g.pending), 'restore(JSON copy) rebuilds the same log, clock, notes and pending');
  ok(throws(() => api.say(JSON.parse(JSON.stringify(g)), 1, 'hi'), /plain copy/), 'acting on a plain copy is refused with the way out');
}

section('scripted games through the api alone match the sim');
// Players answer only through say, pass, nominate, vote and answer; the Storyteller only through answer with a reason.
function apiGame(seed) {
  const gm = newGame({seed}), sc = createScripted(seed);
  for (let n = 0; n < 20000 && !gm.winner; n++) {
    const p = gm.pending;
    if (p.seat === ST) {api.answer(gm, ST, sc(gm), `scripted ${p.kind}`); continue}
    if (p.kind === 'choose') {api.answer(gm, p.seat, sc(gm)); continue}
    if (p.kind === 'vote') {const v = sc(gm); for (const i of p.seats) (i % 2 ? api.vote : api.answer)(gm, i, v[i]); continue}
    if (p.kind === 'nomination' && !gm.clock.nominationsOpen) {
      for (const s of gm.seats) if (s.alive && !gm.clock.nominationsOpen && !gm.clock.spoke.includes(s.index)) (s.index === 3 ? api.pass(gm, s.index) : api.say(gm, s.index, `${s.name} on day ${gm.day}, round ${gm.clock.round}.`));
      continue;
    }
    if (p.kind === 'nomination') {
      const v = sc(gm);
      if (v === null) {for (const s of gm.seats) if (gm.phase === 'day' && s.alive) api.pass(gm, s.index); continue}
      api.nominate(gm, v.by, v.target); continue;
    }
    throw new Error(`unexpected ${p.kind}`);
  }
  return gm;
}
for (const seed of [1, 2, 3, 4, 5, 7]) {
  const a = apiGame(seed), b = apiGame(seed), sim = simulate(seed).state;
  ok(a.winner && a.winner.text === sim.winner.text, `seed ${seed}: the api game ends as the sim does (${a.winner && a.winner.text})`);
  ok(JSON.stringify(a.answers) === JSON.stringify(sim.answers), `seed ${seed}: the same ${sim.answers.length} engine decisions as the sim`);
  ok(JSON.stringify(a.log) === JSON.stringify(b.log), `seed ${seed}: the same transcript twice (${a.log.length} entries)`);
  const rl = a.log.filter(e => e.type === 'ruling');
  ok(rl.length > 0 && rl.length + countPlayerAnswers(a) === a.answers.length && rl.every(e => e.reason && e.audience === ST), `seed ${seed}: every Storyteller decision is a ruling with its reason, seen by the Storyteller alone (${rl.length})`);
  const leaks = a.seats.flatMap(s => clean(a, s.index));
  ok(!leaks.length, `seed ${seed}: no seat ever sees a token, reason or other role${leaks.length ? ': ' + leaks.join(', ') : ''}`);
}
function countPlayerAnswers(gm) {
  // engine decisions not taken by the Storyteller: choices, nominations (and the null ending them), votes
  let n = 0; const st = new Set(gm.log.filter(e => e.type === 'ruling').map(e => e.decision));
  for (let k = 0; k < gm.answers.length; k++) if (!st.has(k)) n++;
  return n;
}

section('the backend');
{
  const tools = [
    {name: 'look', act: false, desc: 'look', args: {}, handler: (args, ctx) => ({ok: true, me: ctx.api.view(ctx.game, ctx.seat.index).name, seat: ctx.seat})},
    {name: 'peek', act: false, desc: 'peek', args: {}, handler: (args, ctx) => ({ok: true, other: ctx.api.view(ctx.game, (ctx.seat.index + 1) % 7)})},
    {name: 'grim', act: false, desc: 'grim', args: {}, handler: (args, ctx) => ({ok: true, g: ctx.api.grimoire(ctx.game)})},
    {name: 'speak', act: true, desc: 'speak', args: {text: {type: 'string'}}, handler: (args, ctx) => ({ok: true, ...ctx.api.say(ctx.game, ctx.seat.index, args.text)})},
  ];
  const sttools = [{name: 'look', act: false, desc: 'look', args: {}, handler: (args, ctx) => ({ok: true, pending: ctx.api.pendingFor(ctx.game, 'storyteller')})}];
  const be = gameBackend({seed: 3, players: tools, storyteller: sttools, scripted: true, grace: 5});
  const info = be.info();
  ok(info.players.length === 7 && info.players[0].id === 1 && info.players[0].name === 'Odette' && info.storyteller, 'info lists the seven seats as ids 1-7 and the Storyteller');
  const look = await be.call(1, 'look', {});
  ok(look.ok && look.me === 'Odette' && look.seat.index === 0, "a player's handler gets its own seat");
  const peek = await be.call(1, 'peek', {}), grim = await be.call(1, 'grim', {});
  ok(peek.ok === false && /only as yourself/.test(peek.error) && grim.ok === false && /Only the Storyteller/.test(grim.error), 'a handler asking for another seat or the grimoire gets {ok: false, error}');
  ok((await be.call(1, 'nope', {})).ok === false && (await be.call(9, 'look', {})).ok === false, 'an unknown tool or seat is refused');
  const brief = await be.call(1, 'pace', {brief: true});
  ok(brief.ok && /Odette/.test(brief.brief), `pace {brief: true} answers with the header: "${brief.brief}"`);
  const day = await be.call(1, 'pace', {realMs: 3000, wake: 'all'});
  ok(day.ok && day.wake === 'soft' && be.game.phase === 'day', `the scripted Storyteller carries the game to day 1 and the seat wakes soft (${day.wake}, ${day.clock})`);
  const hb = await be.call(1, 'pace', {realMs: 30, wake: 'all'});
  ok(hb.ok && hb.wake === 'heartbeat', 'with nothing new a paced wait ends in a heartbeat');
  const nw = await be.call(1, 'pace', {realMs: 30, wake: 'now'});
  ok(nw.ok && nw.wake === null, "a 'now' wait with nothing to do ends with wake null");
  const said = await be.call(2, 'speak', {text: 'Hello from Bram.'});
  ok(said.ok, 'a player speaks through its tool');
  const soft = await be.call(1, 'pace', {realMs: 30, wake: 'all'});
  ok(soft.wake === 'soft', "another seat's line wakes Odette soft");
  for (let i = 1; i <= 7; i++) await be.call(i, 'speak', {text: `Round one from seat ${i}.`});
  for (const r of [2, 3]) for (let i = 1; i <= 7; i++) await be.call(i, 'speak', {text: `Round ${r} from seat ${i}.`});
  const now = await be.call(1, 'pace', {realMs: 30, wake: 'now'});
  ok(be.game.clock.nominationsOpen && now.wake === 'now', `with nominations open a seat that may nominate wakes now (${now.why})`);
  const st = await be.storytellerCall('look', {});
  ok(st.ok && st.pending === null, "the Storyteller's handler reads through its own api");
  be.close();
}

console.log(fails ? `${fails} api check(s) failed, ${passes} passed` : `all ${passes} api checks pass`);
process.exit(fails ? 1 : 0);
