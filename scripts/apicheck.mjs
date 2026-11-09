// npm run apicheck: the game api (src/game/api.js) and the relay backend (src/game/backend.js) on seeded games.
//  1. Every api function in its legal and illegal cases on a fixed deal: talk at night, an empty, long or repeated line, a
//     second line in one round, the rounds opening the nominations, a dead seat nominating, a vote from a seat not in the
//     ballot, a repeat vote, the ballot completing the engine's vote, closeVote, endDay, the day ending by itself, whispers
//     (a third seat sees only whisper-seen), told seen by its seat only, notes capped at 50, Storyteller answers needing a
//     reason, and no view, pending or event ever carrying a token, a reason or another seat's role.
//  2. forSeat: a player's api acts and reads only as itself and has no Storyteller function.
//  3. A plain (JSON) copy restores to the same game.
//  3b. Rooms and neighbour whispers (#28): presence public and words private, a late joiner, capacity, invite, leave, whispers
//     only between the nearest living neighbours at the Square (the dead skipped), none in a room, a room line as the seat's
//     turn, the rooms closing when nominations open or the day ends, a dead seat in a room, the watch view's places and room
//     lines, and the seeded sim using rooms. APICHECK_VERBOSE=1 prints every check.
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
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)} if (process.env.APICHECK_VERBOSE) console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`)};
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
    } else if (p.kind === 'thoughts') {for (const i of p.seats) api.think(g, i, '')}
    else break;
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
  ok(imp.includes('Keep your minion covered: never name their role or team.'), 'the demon is told to keep its minion covered (#108)');
  const mi = g.seats.findIndex(x => x.name === 'Corwin'), mtold = api.view(g, mi).told.map(t => t.text).join(' ');
  ok(/The demon is /.test(mtold) && mtold.includes('Agree with your demon, in a room by day, which good role each of you claims.'), `the minion is told to agree a cover with its demon (#108): "${mtold.slice(-160)}"`);
  ok(g.seats.every((x, i) => i === 2 || i === mi || !api.events(g, i).some(e => /covered|Agree with your demon/.test(e.text || ''))), 'the cover words reach the demon and its minion alone');
  const dawn1 = api.events(g, 0).find(e => e.type === 'dawn' && e.day === 1);
  ok(dawn1 && dawn1.text === 'Day 1 breaks. The first night passes without a death, as it always does.', `day 1's dawn tells the quiet first night as the rule (#110): "${dawn1 && dawn1.text}"`);
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
  api.whisper(g, 0, 6, 'Psst, Yusuf: the secret word is marmalade.');
  ok(api.events(g, 6).some(e => e.type === 'whisper' && /marmalade/.test(e.text)), 'the whisper reaches its listener');
  ok(api.events(g, 0).some(e => e.type === 'whisper' && /marmalade/.test(e.text)), 'and its speaker');
  const third = api.events(g, 1);
  ok(!JSON.stringify(third).includes('marmalade') && third.some(e => e.type === 'whisper-seen' && e.from === 0 && e.to === 6), 'a third seat sees only whisper-seen');
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
  ok(throws(() => api.endDay(g), /Say why/), 'endDay without a reason is refused');
  api.endDay(g, 'the table has said its piece');
  ok(api.rulings(g).at(-1).kind === 'end-day' && api.rulings(g).at(-1).reason === 'the table has said its piece', 'endDay logs its reason as a ruling');
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
  const pg = api.pendingFor(g, 1);
  ok(Array.isArray(pg.seats) && pg.seats.includes(0) && g.seats.every(x => pg.seats.includes(x.index) === (x.alive || x.ghostVote)), 'the vote pending lists every seat that may vote, the dead with a ghost vote among them');
  ok(Array.isArray(pg.voted) && typeof pg.ballots === 'object' && pg.mine === null, 'the vote pending keeps voted, ballots and mine');
  api.vote(g, 0, true);
  for (const i of [1, 2, 3, 4, 5, 6]) api.vote(g, i, false);
  ok(!g.seats[0].ghostVote && !api.view(g, 0).ghostVote, "Odette's yes spends her ghost vote");
  api.nominate(g, 5, 3);
  ok(!api.pendingFor(g, 1).seats.includes(0), 'a dead seat with a spent ghost vote is not in the pending seats');
  ok(throws(() => api.vote(g, 0, true), /ghost vote is spent/), 'a vote from a seat not in the ballot is refused');
  ok(api.pendingFor(g, 0) === null, 'and it gets no vote pending');
  api.vote(g, 1, true);
  ok(throws(() => api.closeVote(g), /Say why/), 'closeVote without a reason is refused');
  const closed = api.closeVote(g, 'four seats sat on their hands');
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
  ok(Array.isArray(no) && no.every(x => x.night === 3 && 'role' in x && 'seat' in x && typeof x.acted === 'boolean') && no.some(x => x.role === 'imp' && x.seat === 2) && no.some(x => x.status === 'now'),
    'nightOrder lists the night in waking order as {role, seat, acted}');
  const night1 = api.nightOrder(newGame({seed: 1, roles: ROLES}));
  ok(night1.some(x => x.role === 'minion-info' && x.seat === null) && night1.every(x => !x.acted), 'the first night lists its tellings with seat null, nothing acted yet');
  const gr = api.grimoire(g).seats.flatMap(x => x.tokens);
  ok(gr.length && gr.every(t => 'by' in t) && gr.some(t => t.token === 'master' && t.by === 4), 'the grimoire tokens carry who placed them');
}

section('a plain copy restores');
{
  const back = api.restore(JSON.parse(JSON.stringify(g)));
  ok(JSON.stringify(back.log) === JSON.stringify(g.log) && JSON.stringify(back.clock) === JSON.stringify(g.clock) && JSON.stringify(back.notes) === JSON.stringify(g.notes) && JSON.stringify(back.pending) === JSON.stringify(g.pending), 'restore(JSON copy) rebuilds the same log, clock, notes and pending');
  ok(throws(() => api.say(JSON.parse(JSON.stringify(g)), 1, 'hi'), /plain copy/), 'acting on a plain copy is refused with the way out');
}

section('game 1 (#30): a pass from a night header never burns a day turn');
// Seed 7 as game 1 dealt it: Odette the Washerwoman, Bram the Imp, Ines the Ravenkeeper, Thea the Slayer. The pacer woke
// seats in night 1 and at dawn; their headers said "Night 1"; Bram's pass was refused at night, but Odette's and Ines's
// landed while the dawn still held (the Slayer's shot was asked there) and counted as their round-1 turn.
{
  const g7 = newGame({seed: 7});
  settle(g7, {}, gm => gm.phase === 'night' && gm.pending?.seat === ST);
  ok(g7.phase === 'night' && g7.night === 1, 'seed 7 stands in night 1');
  const acts = g7.actions.length, clock = JSON.stringify(g7.clock);
  ok(throws(() => api.pass(g7, 1), /only in the day/), 'Bram passes from a night header: refused');
  ok(throws(() => api.pass(g7, 0), /only in the day/) && throws(() => api.pass(g7, 2), /only in the day/), 'so are Odette\'s and Ines\'s passes at night');
  ok(throws(() => api.say(g7, 0, 'Morning?'), /only in the day/), 'and a line at night');
  ok(g7.actions.length === acts && JSON.stringify(g7.clock) === clock && !g7.log.some(e => e.type === 'pass'), 'a refused pass records nothing, moves no clock and marks no turn');
  ok(!api.canAct(g7, 0) && /until day 1/.test(api.nextTurnText(g7, 0)), `at night a seat with no night choice cannot act: "${api.nextTurnText(g7, 0)}"`);
  settle(g7);
  ok(g7.phase === 'day' && g7.day === 1 && g7.pending.kind === 'nomination', 'dawn of day 1 goes straight to the talk');
  ok(!api.mustAct(g7, 4) && api.dayActionFor(g7, 4)?.ability === 'slayer' && api.pendingFor(g7, 4) === null, 'nothing blocks the dawn: the Slayer\'s shot stands open to Thea, nobody waits on it');
  // The moment of dawn before the day's clock has started (the engine still resolving the dawn, as it was in game 1
  // while the Slayer's dawn choice waited): the same passes are refused and count for nothing.
  const step = g7.step; g7.step = 'dawn';
  ok(!api.canAct(g7, 0) && /breaking/.test(api.legalNow(g7, 0)), `at the moment of dawn no seat can act: "${api.legalNow(g7, 0)}"`);
  ok(throws(() => api.pass(g7, 0), /not begun/) && throws(() => api.pass(g7, 2), /not begun/) && throws(() => api.say(g7, 2, 'It is day 1.'), /not begun/), 'Odette\'s and Ines\'s passes at the moment of dawn are refused');
  ok(g7.clock.spoke.length === 0 && g7.clock.round === 1 && !g7.log.some(e => e.type === 'pass'), 'and the refused passes mark no turn');
  g7.step = step;
  const v = api.view(g7, 0);
  ok(v.clock.round === 1 && v.clock.toSpeak.length === 7, 'day 1, round 1: every seat still has its turn');
  api.say(g7, 0, 'I have a first-night read; I will share it when it matters.');
  api.say(g7, 2, 'Nobody died in the night. Thea, Odette, what did you notice?');
  ok(g7.log.filter(e => e.type === 'say' && e.day === 1 && [0, 2].includes(e.seat)).length === 2, 'Odette and Ines each have a real choice in round 1, and speak');
  ok(throws(() => api.pass(g7, 0), /had your turn/) && g7.clock.round === 1 && g7.clock.spoke.length === 2, 'a refused pass after a line moves nothing either');
  ok(!api.canAct(g7, 0) && api.nextTurnText(g7, 0) === 'until round 2' && api.canAct(g7, 1), 'a seat that has had its turn cannot act until round 2; one that has not, can');
}

section('rooms and neighbour whispers (#28)');
{
  // Odette washerwoman 0, Bram soldier 1, Ines imp 2, Corwin poisoner 3, Thea butler 4, Fitch empath 5, Yusuf chef 6
  const g = newGame({seed: 1, roles: ROLES});
  settle(g, {poisoner: () => 6, butler: () => 0}, gm => gm.phase === 'night' && gm.pending?.seat === ST);
  ok(throws(() => api.go(g, 0, 'nook'), /only in the day/) && throws(() => api.leave(g, 0), /only in the day/) && throws(() => api.invite(g, 0, 1, 'nook'), /only in the day/), 'no rooms at night');
  settle(g, {poisoner: () => 6, butler: () => 0});
  const w0 = api.where(g, 0);
  ok(w0.place === null && w0.square.length === 7 && w0.open && JSON.stringify(w0.rooms.map(r => [r.id, r.size, r.free])) === JSON.stringify([['nook', 2, 2], ['parlour', 3, 3], ['backroom', 4, 4]]),
    'where: everyone at the Square, three open rooms for 2, 3 and 4');
  ok(JSON.stringify(w0.neighbours) === JSON.stringify([6, 1]) && JSON.stringify(w0.canWhisper) === JSON.stringify([6, 1]), "where: Odette's neighbours are Yusuf and Bram");
  ok(throws(() => api.go(g, 0, 'cellar'), /no room "cellar".*nook/), 'an unknown room is refused, naming the rooms');
  ok(throws(() => api.leave(g, 0), /at the Square already/), 'leave from the Square is refused');
  const before = g.log.length;
  const r1 = api.go(g, 0, 'the Parlour');
  const mv = g.log.slice(before).filter(e => e.type === 'move');
  ok(r1.place === 'parlour' && mv.length === 1 && mv[0].audience === 'all', 'go: Odette goes to the Vestry (a room named loosely), a public move');
  ok(g.seats.every(s => api.events(g, s.index).some(e => e.type === 'move' && e.room === 'parlour' && e.text === 'Odette went to the Vestry.')) && api.events(g, ST).some(e => e.type === 'move'),
    'presence is public: every seat and the Storyteller see "Odette went to the Vestry."');
  ok(api.view(g, 4).seats[0].room === 'parlour' && api.view(g, 0).place.room === 'parlour' && api.view(g, 0).place.name === 'the Vestry', 'view: who is where, and my own place');
  ok(!g.clock.spoke.includes(0), 'a move is not a turn');
  api.invite(g, 0, 1);
  ok(g.places[1] === 'parlour' && g.log.at(-1).text === 'Odette called Bram into the Vestry.' && JSON.stringify(api.view(g, 0).place.with) === JSON.stringify([1]), 'invite (room omitted: my own room): Bram joins Odette, in public');
  api.say(g, 0, 'Just the two of us: the word is quince.');
  const line = g.log.at(-1);
  ok(line.room === 'parlour' && JSON.stringify(line.audience) === JSON.stringify([0, 1]), 'a line in a room has the room and its occupants as the audience');
  ok(api.events(g, 1).some(e => e.type === 'say' && e.room === 'parlour' && /quince/.test(e.text)), 'Bram, in the room, hears it, with its room');
  ok([2, 3, 4, 5, 6].every(i => !JSON.stringify(api.events(g, i)).includes('quince')) && !JSON.stringify(api.events(g, ST)).includes('quince'), 'words are private: no seat outside the room hears them, nor the Storyteller');
  ok(g.clock.spoke.includes(0), 'a line in a room is the seat\'s turn of the round');
  ok(throws(() => api.say(g, 0, 'And another thing.'), /had your turn/), 'so a second line in the same round is refused, in the room as at the Square');
  ok(throws(() => api.whisper(g, 0, 1, 'psst'), /no whispers in a room/), 'no whispers in a room');
  api.go(g, 2, 'parlour');
  ok(!JSON.stringify(api.events(g, 2)).includes('quince'), 'a late joiner hears nothing said before it came in');
  api.say(g, 1, 'Ines, welcome. I am listening.');
  ok(api.events(g, 2).some(e => e.room === 'parlour' && /welcome/.test(e.text)) && JSON.stringify(g.log.at(-1).audience) === JSON.stringify([0, 1, 2]), 'and hears what is said once it is in');
  ok(throws(() => api.go(g, 3, 'parlour'), /holds 3 and has 3.*full/), 'capacity: the Vestry holds three');
  api.invite(g, 3, 4, 'nook');
  ok(g.places[3] === 'nook' && g.places[4] === 'nook' && g.log.at(-1).text === 'Corwin and Thea went to the Snug.', 'invite from the Square: both go, one public line');
  ok(throws(() => api.go(g, 5, 'nook'), /full/) && throws(() => api.invite(g, 5, 6, 'nook'), /no room for the two of you/), 'capacity: the Snug holds two');
  ok(throws(() => api.invite(g, 5, 0, 'backroom'), /only someone at the Square/), 'a seat in another room cannot be invited away');
  ok(throws(() => api.invite(g, 5, 5, 'backroom'), /yourself/) && throws(() => api.invite(g, 5, 6), /Name a room/), 'invite needs another seat and, from the Square, a room');
  // whispers at the Square: the nearest living neighbour on each side, both at the Square
  ok(throws(() => api.whisper(g, 5, 4, 'hi'), /Thea is in the Snug/), 'a neighbour in a room cannot be whispered to');
  ok(throws(() => api.whisper(g, 5, 1, 'hi'), /only to your nearest living neighbours: Thea and Yusuf/), 'a whisper to a non-neighbour is refused, naming the two who are');
  api.whisper(g, 5, 6, 'Yusuf, a word.');
  ok(api.events(g, 6).some(e => e.type === 'whisper') && api.events(g, 3).some(e => e.type === 'whisper-seen' && e.from === 5 && e.to === 6), 'a neighbour whisper reaches its listener; the table (even in a room) sees it happen');
  api.leave(g, 2);
  ok(g.places[2] === null && g.log.at(-1).text === 'Ines came back to the Square from the Vestry.' && g.log.at(-1).audience === 'all', 'leave: back to the Square, in public');
  api.go(g, 2, 'backroom'); api.go(g, 2, 'parlour');
  ok(g.log.at(-1).text === 'Ines left the Taproom for the Vestry.', 'go from one room to another names both');
  const plain = JSON.parse(JSON.stringify(g)), back = api.restore(plain);
  ok(JSON.stringify(back.places) === JSON.stringify(g.places) && JSON.stringify(back.log) === JSON.stringify(g.log), 'a plain copy restores the same places and the same log');
  // the round ends when every living seat has had a line or a pass anywhere
  for (const s of g.seats) if (!g.clock.spoke.includes(s.index)) api.say(g, s.index, `${s.name} speaks where they are.`);
  ok(g.clock.round === 2, 'round 1 ends with lines in rooms and at the Square alike');
  const pAway = g.seats.filter(s => g.places[s.index] != null).map(s => s.index);
  talkRound(g, 'rooms 2'); talkRound(g, 'rooms 3');
  const close = g.log.filter(e => e.type === 'move' && e.closed).at(-1);
  ok(g.clock.nominationsOpen && close && JSON.stringify(close.seats) === JSON.stringify(pAway) && close.audience === 'all' && g.places.every(x => x === null),
    `the rooms close when nominations open and everyone is called back, in public: "${close && close.text}"`);
  ok(!api.where(g, 0).open && throws(() => api.go(g, 0, 'nook'), /rooms are closed/) && throws(() => api.invite(g, 0, 1, 'nook'), /rooms are closed/), 'no rooms once nominations are open');
  for (let i = 0; i < 7; i++) {const bad = clean(g, i); ok(!bad.length, `${g.seats[i].name} sees no token, reason or other role with rooms (${bad.join(', ') || 'clean'})`)}
  // the player api and the Storyteller's
  const pa = api.forSeat(0), sa = api.forSeat(ST);
  ok(pa.where(g, 0).place === null && throws(() => pa.go(g, 1, 'nook'), /only as yourself/) && sa.where(g, ST).square.length === 7 && throws(() => sa.go(g, 0, 'nook'), /does not go/),
    "forSeat: a player moves only itself; the Storyteller reads where but moves nobody");
}
{
  // a day with a dead seat: whispers skip the dead, the dead use rooms, endDay closes the rooms, a new day starts at the Square
  const g = newGame({seed: 1, roles: ROLES});
  const ch = {poisoner: () => 6, butler: () => 0, imp: () => 5};
  settle(g, ch);
  api.endDay(g, 'checking the rooms on day 2');
  settle(g, ch);
  ok(g.day === 2 && !g.seats[5].alive, `day 2 with Fitch dead (${g.seats.filter(s => !s.alive).map(s => s.name).join(', ')})`);
  ok(JSON.stringify(api.where(g, 4).neighbours) === JSON.stringify([3, 6]) && JSON.stringify(api.where(g, 6).neighbours) === JSON.stringify([4, 0]), "the dead are skipped: Thea's neighbours are Corwin and Yusuf");
  ok(throws(() => api.whisper(g, 4, 5, 'hi'), /neighbours: Corwin and Yusuf/), 'no whisper to a dead seat');
  api.whisper(g, 4, 6, 'Across the empty chair.');
  ok(api.events(g, 6).some(e => e.type === 'whisper' && /empty chair/.test(e.text)), 'a whisper across a dead seat reaches the next living neighbour');
  api.whisper(g, 5, 4, 'From the dead.');
  ok(api.events(g, 4).some(e => e.type === 'whisper' && /From the dead/.test(e.text)), 'a dead seat whispers to its nearest living neighbours');
  api.invite(g, 5, 6, 'nook');
  api.say(g, 5, 'Even dead, I have a view.');
  ok(g.places[5] === 'nook' && api.events(g, 6).some(e => e.room === 'nook' && /Even dead/.test(e.text)) && !JSON.stringify(api.events(g, 0)).includes('Even dead'), 'a dead seat goes to a room, invites, and talks there');
  ok(g.places.filter(x => x === 'nook').length === 2 && api.view(g, 0).seats[5].room === 'nook', 'the table sees the dead seat in the Snug');
  api.endDay(g, 'ending day 2 with the Snug full');
  ok(g.log.some(e => e.type === 'move' && e.closed && e.day === 2) && g.places.every(x => x === null), 'the Storyteller ending the day closes the rooms too');
}
{
  // the watcher's view carries places and room lines with their room
  const be = gameBackend({seed: 1});
  const g = be.game;
  settle(g, {});
  const pair = g.seats.slice(0, 2).map(s => s.index);
  api.invite(g, pair[0], pair[1], 'nook');
  api.say(g, pair[0], 'A line for the Snug and the watcher only.');
  const w = be.watch(-1);
  ok(w.places && w.places.open && JSON.stringify(w.places.rooms.find(r => r.id === 'nook').seats) === JSON.stringify(pair) && w.places.square.length === 5, 'the watch view carries who is where');
  ok(w.events.some(e => e.type === 'say' && e.room === 'nook' && /watcher only/.test(e.text)) && w.events.some(e => e.type === 'move' && e.room === 'nook'), 'and the room line with its room, and the move');
  be.close();
}
{
  const sim = simulate(1).state;
  ok(sim.log.some(e => e.type === 'move' && e.room) && sim.log.some(e => e.type === 'say' && e.room) && sim.log.some(e => e.type === 'move' && e.closed), 'the seeded sim goes to rooms, talks there and sees them close');
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
    if (p.kind === 'thoughts') {const v = sc(gm); for (const i of p.seats) (i % 2 ? api.think : api.answer)(gm, i, v[i] ?? ''); continue}
    if (p.kind === 'nomination' && !gm.clock.nominationsOpen) {
      for (const s of gm.seats) if (s.alive && !gm.clock.nominationsOpen && !gm.clock.spoke.includes(s.index)) (s.index === 3 ? api.pass(gm, s.index) : api.say(gm, s.index, `${s.name} on day ${gm.day}, round ${gm.clock.round}.`));
      continue;
    }
    if (p.kind === 'nomination') {
      const v = sc(gm);
      if (v === null) {for (const s of gm.seats) if (gm.phase === 'day' && s.alive) api.pass(gm, s.index); continue}
      if (v.ability) {(api.pendingFor(gm, v.by)?.standing ? api.answer : api.dayAction)(gm, v.by, v.target); continue}
      api.nominate(gm, v.by, v.target); continue;
    }
    throw new Error(`unexpected ${p.kind}`);
  }
  return gm;
}
for (const seed of [1, 2, 3, 4, 5, 7, 10]) {
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

section('the night thoughts (#111): the api');
{
  // Odette washerwoman, Bram soldier, Ines imp, Corwin poisoner, Thea butler, Fitch empath, Yusuf chef
  const tg = newGame({seed: 1, roles: ROLES}), SECRET = 'Thoughtmark zq111x: I am sure Fitch lies.';
  settle(tg, {poisoner: () => 6, butler: () => 0}, gm => gm.pending?.kind === 'thoughts');
  const p = tg.pending;
  ok(p && p.kind === 'thoughts' && p.seat === 'table' && JSON.stringify(p.seats) === '[0,1,2,3,4,5,6]' && tg.phase === 'night' && tg.night === 1, 'night 1 ends with the thoughts scene, every living seat asked');
  const po = api.pendingFor(tg, 0);
  ok(po && JSON.stringify(Object.keys(po)) === '["kind","question","mine","tonight"]' && po.kind === 'thoughts' && po.mine === null && /what are you thinking/.test(po.question), `a seat's pending: {kind, question, mine, tonight} (${JSON.stringify(po)})`);
  ok(/^You woke as the Washerwoman\. One of .* is the /.test(po.tonight), `tonight: what Odette did and learned ("${po.tonight}")`);
  ok(api.pendingFor(tg, 1).tonight === 'You slept.', `a seat that did not wake slept ("${api.pendingFor(tg, 1).tonight}")`);
  ok(/^You woke as the Poisoner\. You chose Yusuf\./.test(api.pendingFor(tg, 3).tonight), `the Poisoner's own choice ("${api.pendingFor(tg, 3).tonight}")`);
  ok(/Your minion is Corwin/.test(api.pendingFor(tg, 2).tonight) && !/Washerwoman/.test(api.pendingFor(tg, 2).tonight), `the demon's night, nothing of others' ("${api.pendingFor(tg, 2).tonight.slice(0, 120)}")`);
  ok(api.pendingFor(tg, ST) === null && throws(() => api.answer(tg, ST, {0: 'x'}, 'a reason'), /Nothing waits on the Storyteller/), 'the Storyteller is not asked and cannot answer the scene');
  ok([0, 1, 2, 3, 4, 5, 6].every(i => api.mustAct(tg, i) && api.canAct(tg, i)), 'every living seat must act (a runner is woken now)');
  ok(/what are you thinking\? Answer with a sentence or two/.test(api.legalNow(tg, 0)), `legalNow says it: "${api.legalNow(tg, 0)}"`);
  ok(api.nightOrder(tg).every(x => x.status === 'done'), 'during the scene the night order reads done');
  ok(throws(() => api.think(tg, 0, 42), /sentence or two of text/), 'a thought that is not text is refused');
  const r0 = api.think(tg, 0, SECRET);
  ok(r0.thought === SECRET && r0.waitingOn === 6 && api.pendingFor(tg, 0).mine === SECRET && !api.mustAct(tg, 0), 'a seat thinks once; its pending keeps its own text as mine, and it need not act again');
  ok(throws(() => api.think(tg, 0, 'again'), /already/), 'a second thought the same night is refused');
  const r1 = api.answer(tg, 1, '  ' + 'y'.repeat(1000));
  ok(r1.cut === 400 && r1.thought.length === 400, 'answer() takes a thought too; a long one is cut to 400');
  ok(!tg.log.some(e => e.type === 'thought'), 'nothing is logged until every seat has answered');
  for (const i of [2, 3, 4, 5]) api.answer(tg, i, i === 4 ? 'Thea wonders.' : '');
  ok(tg.pending.kind === 'thoughts' && api.pendingFor(tg, 6).mine === null, 'the scene waits for the last seat');
  api.think(tg, 6, null);
  const th = tg.log.filter(e => e.type === 'thought');
  ok(tg.phase === 'day' && th.length === 3 && JSON.stringify(th.map(e => e.seat)) === '[0,1,4]' && th.every(e => e.audience === 'watcher' && e.night === 1 && e.day === 0), `the scene ends, three thoughts logged for the watcher, the empty ones not (${th.map(e => e.seat)})`);
  const dawn = tg.log.find(e => e.type === 'dawn' && e.day === 1);
  ok(th.every(e => e.id < dawn.id) && th.every(e => e.id > Math.max(...tg.log.filter(x => x.type === 'told' && x.night === 1).map(x => x.id))), 'the thoughts come after the night and before the dawn');
  for (let i = 0; i < 7; i++) {
    const all = JSON.stringify([api.events(tg, i, -1), api.view(tg, i), api.pendingFor(tg, i), api.notes(tg, i)]);
    ok(!all.includes('zq111x') && !all.includes('yyyy') && !all.includes('Thea wonders') && !/"thought"/.test(all), `${tg.seats[i].name}: no thought in its events, view, pending or notes, its own included`);
  }
  const stAll = JSON.stringify([api.events(tg, ST, -1), api.grimoire(tg), api.rulings(tg), api.nightOrder(tg)]);
  ok(!stAll.includes('zq111x') && !stAll.includes('Thea wonders'), "the Storyteller's events, grimoire, rulings and night order carry no thought");
  const back = api.restore(JSON.parse(JSON.stringify(tg)));
  ok(JSON.stringify(back.log) === JSON.stringify(tg.log), 'a plain copy restores to the same thoughts');
  // night 2: the dead are not asked and cannot think
  api.endDay(tg, 'the check ends day 1');
  settle(tg, {poisoner: () => 6, imp: () => 5}, gm => gm.pending?.kind === 'thoughts');
  ok(tg.night === 2 && !tg.seats[5].alive && !tg.pending.seats.includes(5) && api.pendingFor(tg, 5) === null, 'night 2: the dead Empath is not asked');
  ok(throws(() => api.think(tg, 5, 'from beyond'), /Only the living/), 'a dead seat cannot think');
}

section('the night thoughts (#111): the backend');
{
  const sc = createScripted(1), SECRET = 'Backmark zq111y';
  const quiet = (g, p) => p.count ? p.options.filter(x => x !== p.seat).slice(0, p.count) : p.options.includes(null) ? null : p.options.find(x => x !== p.seat);
  const tools = [
    {name: 'look', act: false, desc: 'look', args: {}, handler: (args, ctx) => ({ok: true, events: ctx.api.events(ctx.game, ctx.seat.index, -1), view: ctx.api.view(ctx.game, ctx.seat.index)})},
    {name: 'pick', act: true, desc: 'pick', args: {}, handler: (args, ctx) => ({ok: true, ...ctx.api.answer(ctx.game, ctx.seat.index, quiet(ctx.game, ctx.game.pending))})},
    {name: 'think', act: true, desc: 'think', args: {text: {type: 'string'}}, handler: (args, ctx) => ({ok: true, ...ctx.api.answer(ctx.game, ctx.seat.index, args.text)})},
  ];
  const sttools = [
    {name: 'auto', act: true, desc: 'auto', args: {}, handler: (args, ctx) => ({ok: true, ...ctx.api.answer(ctx.game, ST, sc(ctx.game), 'the check answers')})},
    {name: 'look', act: false, desc: 'look', args: {}, handler: (args, ctx) => ({ok: true, events: ctx.api.events(ctx.game, ST, -1), pending: ctx.api.pendingFor(ctx.game, ST)})},
  ];
  const logged = [], clipped = [];
  const toThoughts = async be => {
    for (let n = 0; n < 100 && be.game.pending && be.game.pending.kind !== 'thoughts' && be.game.phase !== 'day'; n++) {
      const p = be.game.pending;
      if (p.seat === ST) await be.storytellerCall('auto', {}); else await be.call(p.seat + 1, 'pick', {});
    }
  };
  const be = gameBackend({seed: 1, players: tools, storyteller: sttools, onEvent: r => logged.push(r)});
  be.setVoice({clip: (name, text) => {clipped.push({name, text}); return {id: 'c' + clipped.length, ms: 10}}});
  be.attach({readyState: 1, send() {}, on() {}});
  await toThoughts(be);
  ok(be.game.pending?.kind === 'thoughts', 'with a think tool at the table, the backend waits on the seats for their thoughts');
  const w = await be.call(1, 'pace', {realMs: 0, wake: 'now'});
  ok(w.wake === 'now' && /what are you thinking/.test(w.why), `a seat is woken now for its thought (${w.why})`);
  ok((await be.call(1, 'think', {text: SECRET})).ok, 'Odette thinks through her tool');
  for (let i = 2; i <= 7; i++) await be.call(i, 'think', {text: i === 2 ? 'Bram ponders the dark.' : ''});
  ok(be.game.phase === 'day', 'when every seat has thought, the dawn comes');
  const ev = be.watch(-1).events.filter(e => e.type === 'thought');
  ok(ev.length === 2 && ev[0].seat === 0 && ev[0].text === SECRET && ev[0].audience === 'watcher' && ev[0].night === 1 && ev[0].day === 0, `the watch body carries the thoughts (${JSON.stringify(ev[0])})`);
  ok(logged.some(r => r.type === 'thought' && r.who === 'Odette' && r.text === SECRET && r.night === 1), 'the behavior log gets the thought, with the seat by name');
  for (let i = 1; i <= 7; i++) ok(!JSON.stringify(await be.call(i, 'look', {})).includes('zq111y') && !(await be.call(i, 'pace', {brief: true})).brief.includes('zq111y'), `seat ${i}: no thought in its tools or header`);
  const stl = JSON.stringify([await be.storytellerCall('look', {}), await be.storytellerCall('pace', {brief: true})]);
  ok(!stl.includes('zq111y') && !stl.includes('Bram ponders'), "the Storyteller's tools and header carry no thought");
  await new Promise(r => setTimeout(r, 400));
  ok(clipped.some(c => c.name === 'Odette' && c.text === SECRET) && clipped.some(c => c.name === 'Bram' && /ponders/.test(c.text)), `a thought is spoken in its seat's voice (${clipped.filter(c => c.name !== 'Storyteller').map(c => c.name)})`);
  be.close();
  // a table without a think tool has no thought to give: the backend answers the scene empty and the night runs on
  const be2 = gameBackend({seed: 1, players: tools.filter(t => t.name !== 'think'), storyteller: sttools});
  await toThoughts(be2);
  ok(be2.game.phase === 'day' && !be2.game.log.some(e => e.type === 'thought') && be2.game.actions.filter(a => a[0] === 'think').length === 7, 'without a think tool the scene is answered empty at once and logs nothing');
  be2.close();
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
  // #29: a seat that has had its turn this round is not woken soft for the others' lines; the next round wakes it.
  ok((await be.call(1, 'speak', {text: 'Odette, round one.'})).ok, 'Odette takes her round-1 turn');
  await be.call(1, 'pace', {realMs: 0, wake: 'all'});
  await be.call(3, 'speak', {text: 'Ines, round one.'});
  const spent = await be.call(1, 'pace', {realMs: 30, wake: 'all'});
  ok(spent.wake === 'heartbeat' && /until round 2/.test(spent.why), `Odette, having spoken, is not woken soft for Ines's line (${spent.wake}: ${spent.why})`);
  ok(!api.canAct(be.game, 0) && api.canAct(be.game, 3), 'canAct: Odette cannot act this round, Corwin can');
  const corwin = await be.call(4, 'pace', {realMs: 30, wake: 'all'});
  ok(corwin.wake === 'soft', 'Corwin, still holding his turn, is woken soft for the same line');
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
