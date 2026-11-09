// npm run edgecheck: every rule with an edge case, each on a fixed deal with the decisions that matter scripted and
// everything else answered quietly (true information, no registering trick, no nominations, every vote no).
// Exit 1 on any failure.
import {newGame, answer, replay, playOut, grimoire, validate} from '../src/game/index.js';
import {isPoisoned} from '../src/game/grimoire.js';
import * as api from '../src/game/api.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)}};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const section = name => console.log(`- ${name}`);

// The quiet answerer: what a test does not script.
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

// rules: [{kind, role?, night?, day?, why?, when?(p, s), value | answer(p, s), once?}]
function play(roles, rules = [], {until, seed = 1, state} = {}) {
  const used = new Set();
  const override = (p, s) => {
    for (const [k, r] of rules.entries()) {
      if (used.has(k)) continue;
      if (r.kind && r.kind !== p.kind) continue;
      if (r.role && r.role !== p.role) continue;
      if (r.seat != null && r.seat !== p.seat) continue;
      if (r.night != null && !(s.phase === 'night' && s.night === r.night)) continue;
      if (r.day != null && !(s.phase === 'day' && s.day === r.day)) continue;
      if (r.why && !String(p.why || '').includes(r.why)) continue;
      if (r.when && !r.when(p, s)) continue;
      if (r.once) used.add(k);
      return r.answer ? r.answer(p, s) : r.value;
    }
    return undefined;
  };
  return playOut(state || newGame({seed, roles}), quiet, {override, until, maxDays: 20});
}

const allYes = p => Object.fromEntries(p.seats.map(s => [s, true]));
const told = (s, what, pred = () => true) => s.log.filter(e => e.type === 'told' && e.what === what && pred(e));
const atDay = n => s => s.phase === 'day' && s.day >= n && s.pending?.kind === 'nomination';
const atNight = n => s => s.phase === 'night' && s.night >= n;
const capture = (bag, extra = {}) => ({...extra, answer: (p, s) => {bag.push(p); return extra.value !== undefined ? extra.value : quiet(s)}});
const execOn = (day, by, target) => [
  {kind: 'nomination', day, once: true, value: {by, target}},
  {kind: 'vote', day, when: p => p.nominee === target, answer: allYes, once: true},
];
const throws = (f, re) => {try {f(); return false} catch (e) {return !re || re.test(e.message)}};
// The Slayer's standing shot, answered on the day's table decision; and the moment after it resolved.
const shot = (day, by, target) => ({kind: 'nomination', day, once: true, value: {by, ability: 'slayer', target}});
const validateShot = (s, by, target) => validate(s.pending, {by, ability: 'slayer', target});
const afterShot = s => s.log.some(e => e.type === 'slayer-shot') && (s.pending?.kind === 'nomination' || s.phase !== 'day');

// ---------------------------------------------------------------------------------------------------------------
section('poisoned and drunk information');
{
  const roles = ['empath', 'imp', 'poisoner', 'chef', 'monk', 'soldier', 'mayor'];
  // poisoned Empath: told anything 0-2, truth kept
  const seen = [];
  let s = play(roles, [{kind: 'choose', role: 'poisoner', value: 0}, {kind: 'info', role: 'empath', ...capture(seen, {value: 2})}], {until: atDay(1)});
  ok(seen[0]?.malfunctioning === true && eq(seen[0].truth, [1]) && eq(seen[0].options, [1, 0, 2]), 'a poisoned Empath may be told any count; the truth (1) is shown to the Storyteller');
  ok(told(s, 'empath')[0]?.info === 2, 'a poisoned Empath is told the false count the Storyteller picked');
  // healthy Empath: only the truth is legal
  s = play(roles, [{kind: 'choose', role: 'poisoner', value: 3}], {until: s => s.pending?.kind === 'info' && s.pending.role === 'empath'});
  ok(eq(s.pending.options, [1]) && s.pending.malfunctioning === false, 'a healthy Empath is offered only the true count');
  ok(throws(() => answer(s, 2)), 'a false count for a healthy Empath is refused');
  // the Drunk as an information role
  const seen2 = [];
  s = play(['drunk', 'imp', 'baron', 'chef', 'soldier', 'monk', 'saint'], [{kind: 'believed-role', value: 'empath'}, {kind: 'info', role: 'empath', ...capture(seen2)}], {until: atDay(1)});
  ok(s.seats[0].believed === 'empath' && s.seats[0].role === 'drunk', 'the Drunk believes it is the Empath and the grimoire keeps both');
  ok(seen2[0]?.malfunctioning === true && seen2[0].options.length === 3, 'the Drunk Empath wakes in the Empath\'s place and may be told anything');
  ok(told(s, 'role', e => e.seat === 0)[0]?.role === 'empath', 'the Drunk is told it is the Empath');
}

section('the Poisoner and the Soldier; the Poisoner and the Monk; the Drunk Monk and Soldier');
{
  const roles = ['soldier', 'imp', 'poisoner', 'empath', 'chef', 'monk', 'mayor'];
  const base = [{kind: 'choose', role: 'monk', value: 4}, {kind: 'choose', role: 'imp', value: 0}];
  let s = play(roles, [...base, {kind: 'choose', role: 'poisoner', value: 3}], {until: atDay(2)});
  ok(s.seats[0].alive, 'the Imp cannot kill a healthy Soldier');
  s = play(roles, [...base, {kind: 'choose', role: 'poisoner', night: 2, value: 0}, {kind: 'choose', role: 'poisoner', value: 3}], {until: atDay(2)});
  ok(!s.seats[0].alive, 'a poisoned Soldier dies to the Imp');

  const r2 = ['monk', 'imp', 'poisoner', 'empath', 'chef', 'saint', 'mayor'];
  const b2 = [{kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 3}];
  s = play(r2, [...b2, {kind: 'choose', role: 'poisoner', value: 4}], {until: atDay(2)});
  ok(s.seats[3].alive, 'the Monk\'s protection stops the Imp');
  s = play(r2, [...b2, {kind: 'choose', role: 'poisoner', night: 2, value: 0}, {kind: 'choose', role: 'poisoner', value: 4}], {until: atDay(2)});
  ok(!s.seats[3].alive, 'a poisoned Monk protects nobody');

  const r3 = ['drunk', 'imp', 'baron', 'empath', 'chef', 'soldier', 'saint'];
  s = play(r3, [{kind: 'believed-role', value: 'monk'}, {kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 3}], {until: atDay(2)});
  ok(!s.seats[3].alive, 'the Drunk Monk protects nobody');
  s = play(['drunk', 'imp', 'baron', 'empath', 'chef', 'monk', 'saint'], [{kind: 'believed-role', value: 'soldier'}, {kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 0}], {until: atDay(2)});
  ok(!s.seats[0].alive, 'the Drunk Soldier dies to the Imp');

  // the poison ends at once when the Poisoner dies
  s = play(['empath', 'imp', 'poisoner', 'chef', 'monk', 'soldier', 'mayor'], [{kind: 'choose', role: 'poisoner', value: 0}, ...execOn(1, 3, 2)], {until: atNight(2)});
  ok(!s.seats[2].alive && !isPoisoned(s, 0), 'the poison ends when the Poisoner is executed');
}

section('the Fortune Teller and the red herring');
{
  const roles = ['fortune-teller', 'imp', 'baron', 'empath', 'chef', 'saint', 'mayor'];
  const ft = (picks) => {const seen = []; play(roles, [{kind: 'red-herring', value: 3}, {kind: 'choose', role: 'fortune-teller', value: picks}, {kind: 'info', role: 'fortune-teller', ...capture(seen)}], {until: atDay(1)}); return seen[0]};
  ok(eq(ft([3, 4]).truth, [true]), 'the red herring reads as the demon');
  ok(eq(ft([4, 5]).truth, [false]), 'two good players who are not the red herring read no');
  ok(eq(ft([1, 5]).truth, [true]), 'the demon reads yes');
  ok(eq(ft([2, 4]).truth, [false]), 'a minion reads no');
  const s = newGame({seed: 1, roles});
  ok(s.pending.kind === 'red-herring' && !s.pending.options.includes(1) && !s.pending.options.includes(2), 'the red herring is chosen among good players only');
}

section('the Recluse registering');
{
  const roles = ['fortune-teller', 'imp', 'baron', 'recluse', 'empath', 'chef', 'investigator'];
  const regs = {Investigator: 'poisoner', Chef: 'poisoner', Empath: 'scarlet-woman', 'Fortune Teller': 'imp'};
  const seen = [], asked = [];
  play(roles, [
    {kind: 'red-herring', value: 6},
    {kind: 'choose', role: 'fortune-teller', value: [3, 5]},
    {kind: 'register', answer: p => {asked.push(p); return regs[p.why.replace('to the ', '')] ?? p.options[0]}},
    {kind: 'info', ...capture(seen)},
  ], {until: atDay(1)});
  const info = r => seen.find(p => p.role === r);
  ok(asked.every(p => p.subject === 3) && asked.length === 4, `the Storyteller is asked about the Recluse for each ability that could see it (${asked.map(p => p.why).join(', ')})`);
  ok(asked[0]?.options[0] === 'recluse' && asked[0].options.includes('imp') && asked[0].options.includes('baron'), 'the Recluse may register as itself, a minion or the demon');
  ok(info('investigator')?.truth.some(o => o.role === 'poisoner' && o.players.includes(3)), 'the Recluse registered as the Poisoner shows to the Investigator');
  ok(eq(info('chef')?.truth, [2]), 'the Chef counts the Recluse registered as evil beside the Baron (two pairs)');
  ok(eq(info('empath')?.truth, [1]), 'the Empath counts the Recluse registered as evil');
  ok(eq(info('fortune-teller')?.truth, [true]), 'the Fortune Teller sees the Recluse registered as the demon');
  // and when it registers as itself
  const seen2 = [];
  play(roles, [{kind: 'red-herring', value: 6}, {kind: 'choose', role: 'fortune-teller', value: [3, 5]}, {kind: 'info', ...capture(seen2)}], {until: atDay(1)});
  ok(eq(seen2.find(p => p.role === 'chef').truth, [1]) && eq(seen2.find(p => p.role === 'fortune-teller').truth, [false]), 'the Recluse registering as itself counts as good');

  // the Undertaker, the Ravenkeeper
  const r2 = ['undertaker', 'imp', 'baron', 'recluse', 'ravenkeeper', 'chef', 'soldier'];
  const s = play(r2, [...execOn(1, 0, 3), {kind: 'choose', role: 'imp', value: 4}, {kind: 'choose', role: 'ravenkeeper', value: 3},
    {kind: 'register', why: 'Undertaker', value: 'imp'}, {kind: 'register', why: 'Ravenkeeper', value: 'baron'}], {until: atDay(2)});
  ok(told(s, 'undertaker')[0]?.info === 'imp', 'the Undertaker may learn the executed Recluse as the Imp');
  ok(told(s, 'ravenkeeper')[0]?.info === 'baron', 'the Ravenkeeper may learn the Recluse as the Baron');
  // the Slayer
  const r3 = ['slayer', 'imp', 'baron', 'recluse', 'chef', 'empath', 'soldier'];
  let t = play(r3, [shot(1, 0, 3), {kind: 'register', why: 'Slayer', value: 'imp'}], {until: afterShot});
  ok(!t.seats[3].alive && !t.winner && t.log.some(e => e.type === 'death' && e.cause === 'slayer' && e.seat === 3), 'the Slayer\'s shot kills a Recluse registering as the demon, and the game goes on');
  t = play(r3, [shot(1, 0, 3)], {until: afterShot});
  ok(t.seats[3].alive, 'the Slayer\'s shot misses a Recluse registering as itself');
}

section('the Spy registering');
{
  const roles = ['washerwoman', 'imp', 'spy', 'empath', 'librarian', 'chef', 'saint'];
  const regs = {Washerwoman: 'monk', Librarian: 'butler', Chef: 'mayor', Empath: 'virgin'};
  const seen = [], asked = [];
  const s = play(roles, [{kind: 'register', answer: p => {asked.push(p); return regs[p.why.replace('to the ', '')] ?? p.options[0]}}, {kind: 'info', ...capture(seen)}], {until: atDay(1)});
  const info = r => seen.find(p => p.role === r);
  ok(asked.length === 4 && asked.every(p => p.subject === 2), `the Storyteller is asked about the Spy for each ability that could see it (${asked.map(p => p.why).join(', ')})`);
  ok(!asked[0].options.includes('imp') && asked[0].options.includes('monk') && asked[0].options.includes('saint'), 'the Spy may register as itself, a townsfolk or an outsider');
  ok(info('washerwoman').truth.some(o => o.role === 'monk' && o.players.includes(2)), 'the Washerwoman may be shown the Spy as a townsfolk');
  ok(info('librarian').truth.some(o => o.role === 'butler' && o.players.includes(2)) && info('librarian').truth.some(o => o.role === 'saint'), 'the Librarian may be shown the Spy as an outsider');
  ok(eq(info('chef').truth, [0]), 'the Chef does not count the Spy registered as good (no pair)');
  ok(eq(info('empath').truth, [0]), 'the Empath does not count the Spy registered as good');
  ok(told(s, 'grimoire', e => e.seat === 2).length === 1, 'the Spy sees the grimoire on the first night');
  const s0 = play(roles, [], {until: atDay(1)});
  ok(told(s0, 'chef')[0].info === 1 && told(s0, 'empath')[0].info === 1, 'the Spy registering as itself is evil to the Chef and the Empath');

  const r2 = ['undertaker', 'imp', 'spy', 'ravenkeeper', 'chef', 'mayor', 'soldier'];
  let t = play(r2, [...execOn(1, 0, 2), {kind: 'choose', role: 'imp', value: 4}, {kind: 'register', why: 'Undertaker', value: 'empath'}], {until: atDay(2)});
  ok(told(t, 'undertaker')[0]?.info === 'empath', 'the Undertaker may learn the executed Spy as a townsfolk');
  t = play(r2, [{kind: 'choose', role: 'imp', value: 3}, {kind: 'choose', role: 'ravenkeeper', value: 2}, {kind: 'register', why: 'Ravenkeeper', value: 'chef'}], {until: atDay(2)});
  ok(told(t, 'ravenkeeper')[0]?.info === 'chef', 'the Ravenkeeper may learn the Spy as a townsfolk');
  // the Spy nominating the Virgin, registering as a townsfolk
  t = play(['virgin', 'imp', 'spy', 'chef', 'empath', 'soldier', 'mayor'], [{kind: 'nomination', day: 1, once: true, value: {by: 2, target: 0}}, {kind: 'register', why: 'Virgin', value: 'chef'}], {until: atNight(2)});
  ok(!t.seats[2].alive && t.executed[0]?.how === 'virgin', 'a Spy registering as a townsfolk is executed by the Virgin');
}

section('the Scarlet Woman and the star pass');
{
  const roles = ['scarlet-woman', 'imp', 'chef', 'empath', 'soldier', 'monk', 'washerwoman'];
  let s = play(roles, execOn(1, 2, 1), {until: atNight(2)});
  ok(s.seats[0].role === 'imp' && s.seats[0].team === 'demon' && !s.winner, 'the Scarlet Woman becomes the Imp when the Imp is executed with seven alive');
  ok(told(s, 'became-demon', e => e.seat === 0).length === 1, 'the new Imp is told');
  s = play(roles, [{kind: 'choose', role: 'imp', value: 1}], {until: atDay(2)});
  ok(s.seats[0].role === 'imp' && !s.seats[1].alive && !s.winner, 'the Scarlet Woman becomes the Imp when the Imp kills itself');
  // five alive at the execution: she takes over; four: good wins
  const down = [{kind: 'choose', role: 'imp', night: 2, value: 2}, {kind: 'choose', role: 'monk', value: 0}];
  s = play(roles, [...down, ...execOn(2, 5, 3), {kind: 'choose', role: 'imp', night: 3, value: 4}, ...execOn(3, 6, 1)], {until: s => s.winner || atNight(4)(s)});
  ok(s.seats[0].role === 'imp' && !s.winner, 'with five alive the Imp\'s execution hands the demon to the Scarlet Woman');
  s = play(roles, [...down, ...execOn(2, 5, 3), {kind: 'choose', role: 'imp', night: 3, value: 6}, ...execOn(3, 5, 1)], {until: s => s.winner});
  ok(s.winner?.team === 'good' && s.winner.reason === 'demon-dead' && s.seats[0].role === 'scarlet-woman', 'with four alive the Imp\'s execution wins for good; the Scarlet Woman stays a minion');
  // star pass with four alive: a minion still takes over
  s = play(roles, [...down, ...execOn(2, 5, 3), {kind: 'choose', role: 'imp', night: 3, value: 6}, {kind: 'choose', role: 'imp', night: 4, value: 1}], {until: s => s.winner || atDay(4)(s)});
  ok(s.seats[0].role === 'imp' && !s.winner && s.log.some(e => e.type === 'new-demon' && e.how === 'star-pass'), 'the Imp killing itself with four alive still passes to a minion (the star pass)');
  // star pass with two minions: the Storyteller picks
  const r2 = ['poisoner', 'imp', 'spy', 'chef', 'empath', 'soldier', 'monk'];
  const asked = [];
  s = play(r2, [{kind: 'choose', role: 'poisoner', value: 3}, {kind: 'choose', role: 'imp', value: 1}, {kind: 'star-pass', answer: p => {asked.push(p); return 2}}], {until: atDay(2)});
  ok(eq(asked[0]?.options, [0, 2]) && s.seats[2].role === 'imp' && s.seats[0].role === 'poisoner', 'with two minions the Storyteller picks which becomes the Imp');
  // a poisoned Scarlet Woman does not take over
  s = play(['scarlet-woman', 'imp', 'poisoner', 'empath', 'soldier', 'monk', 'chef'], [{kind: 'choose', role: 'poisoner', value: 0}, ...execOn(1, 3, 1)], {until: s => s.winner || atNight(2)(s)});
  ok(s.winner?.team === 'good' && s.seats[0].role === 'scarlet-woman', 'a poisoned Scarlet Woman does not take over');
  // the Imp killing itself with no minion alive
  s = play(['imp', 'baron', 'chef', 'empath', 'soldier', 'monk', 'mayor'], [...execOn(1, 2, 1), {kind: 'choose', role: 'imp', night: 2, value: 0}], {until: s => s.winner});
  ok(s.winner?.team === 'good' && s.winner.reason === 'demon-dead' && s.winner.phase === 'night', 'the Imp killing itself with no minion left wins for good at once');
}

section('the Butler');
{
  const roles = ['butler', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'];
  const votes = (p, yes) => Object.fromEntries(p.seats.map(x => [x, yes.includes(x)]));
  let s = play(roles, [
    {kind: 'choose', role: 'butler', value: 3},
    {kind: 'nomination', day: 1, once: true, value: {by: 4, target: 2}}, {kind: 'vote', once: true, answer: p => votes(p, [0, 3])},
    {kind: 'nomination', day: 1, once: true, value: {by: 5, target: 6}}, {kind: 'vote', once: true, answer: p => votes(p, [0, 4])},
  ], {until: atNight(2)});
  const [v1, v2] = s.today.votes;
  ok(v1.yes.includes(0) && v1.tally === 2, 'the Butler\'s vote counts when the master votes');
  ok(!v2.yes.includes(0) && v2.voided.includes(0) && v2.tally === 1, 'the Butler\'s vote does not count when the master does not vote');
  // a dead master with no ghost vote: the Butler cannot vote
  s = play(roles, [{kind: 'choose', role: 'butler', value: 3}], {until: atDay(1)});
  s.seats[3].alive = false; s.seats[3].ghostVote = false;
  s = play(roles, [{kind: 'nomination', day: 1, once: true, value: {by: 4, target: 2}}, {kind: 'vote', once: true, answer: p => votes(p, [0, 4])}], {state: s, until: atNight(2)});
  ok(s.today.votes[0].voided.includes(0) && s.today.votes[0].tally === 1, 'a master dead with no ghost vote leaves the Butler unable to vote');
  // a poisoned Butler votes freely
  s = play(['butler', 'imp', 'poisoner', 'chef', 'empath', 'soldier', 'monk'], [
    {kind: 'choose', role: 'butler', value: 3}, {kind: 'choose', role: 'poisoner', value: 0},
    {kind: 'nomination', day: 1, once: true, value: {by: 4, target: 2}}, {kind: 'vote', once: true, answer: p => votes(p, [0])},
  ], {until: atNight(2)});
  ok(s.today.votes[0].yes.includes(0), 'a poisoned Butler votes freely');
}

section('the Virgin');
{
  const roles = ['virgin', 'imp', 'baron', 'chef', 'drunk', 'soldier', 'saint'];
  let s = play(roles, [{kind: 'nomination', day: 1, once: true, value: {by: 3, target: 0}}], {until: atNight(2)});
  ok(!s.seats[3].alive && s.executed[0]?.seat === 3 && s.executed[0].how === 'virgin', 'a townsfolk nominating the Virgin is executed at once');
  ok(s.today.votes.length === 0 && s.today.nominators.length === 1, 'the Virgin\'s execution ends the day: no vote, no more nominations');
  s = play(roles, [{kind: 'nomination', day: 1, once: true, value: {by: 6, target: 0}}], {until: atNight(2)});
  ok(s.seats[6].alive && s.today.votes.length === 1, 'an outsider nominating the Virgin does not die, and the vote goes ahead');
  s = play(roles, [{kind: 'nomination', day: 1, once: true, value: {by: 4, target: 0}}], {until: atNight(2)});
  ok(s.seats[4].alive, 'the Drunk (an outsider who believes otherwise) nominating the Virgin does not die');
  s = play(roles, [{kind: 'choose', role: 'imp', value: 5}, {kind: 'nomination', day: 1, once: true, value: {by: 6, target: 0}}, {kind: 'nomination', day: 2, once: true, value: {by: 3, target: 0}}], {until: atNight(3)});
  ok(s.seats[0].alive && s.seats[3].alive, 'the Virgin\'s ability works once only');
  s = play(['virgin', 'imp', 'poisoner', 'chef', 'empath', 'soldier', 'mayor'], [{kind: 'choose', role: 'poisoner', night: 1, value: 0}, {kind: 'choose', role: 'poisoner', value: 4}, {kind: 'choose', role: 'imp', value: 5},
    {kind: 'nomination', day: 1, once: true, value: {by: 3, target: 0}}, {kind: 'nomination', day: 2, once: true, value: {by: 5, target: 0}}], {until: atNight(3)});
  ok(s.seats[0].alive && s.seats[3].alive && s.seats[5].alive, 'a poisoned Virgin does nothing, and the ability is spent');
}

section('the Slayer');
{
  // The shot is a standing day action (#37): never offered at dawn, never blocking, callable at any moment of the day.
  const roles = ['slayer', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'];
  let s = play(roles, [], {until: atDay(1)});
  ok(s.pending.kind === 'nomination' && !s.log.some(e => e.type === 'wake' && e.phase === 'day'), 'no choice is asked of the Slayer at dawn: the day goes straight to its talk');
  ok(s.pending.dayActions.length === 1 && s.pending.dayActions[0].by === 0 && s.pending.dayActions[0].ability === 'slayer' && eq(s.pending.dayActions[0].options, [0, 1, 2, 3, 4, 5, 6]), 'the day\'s table decision offers the Slayer\'s shot');
  ok(!api.mustAct(s, 0) && api.pendingFor(s, 0)?.standing === true && api.pendingFor(s, 0).options[0] === null && api.canAct(s, 0), 'the shot never makes the Slayer\'s seat wait: a standing choice it may answer or not');
  s = play(roles, [shot(1, 0, 1)], {until: s => s.winner});
  ok(s.winner?.team === 'good' && s.winner.reason === 'demon-dead' && s.winner.day === 1, 'the Slayer kills the Imp and good wins');
  s = play(roles, [shot(1, 0, 2), {kind: 'choose', role: 'imp', answer: p => [3, 4, 6].find(x => p.options.includes(x))}], {until: atDay(2)});
  ok(s.seats[2].alive && s.seats[1].alive && s.log.filter(e => e.type === 'slayer-shot').length === 1, 'the Slayer\'s shot at a minion does nothing');
  ok(s.day === 2 && s.seats[0].alive && !s.pending.dayActions.length && api.pendingFor(s, 0) === null, 'and the Slayer shoots once only: no shot on day 2');
  ok(throws(() => validateShot(s, 0, 1), /no slayer day action/), 'the engine refuses a spent Slayer\'s shot');
  s = play(['drunk', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'], [{kind: 'believed-role', value: 'slayer'}, shot(1, 0, 1)], {until: atNight(2)});
  ok(s.seats[1].alive && !s.winner && s.log.some(e => e.type === 'slayer-shot' && e.seat === 0) && s.log.some(e => e.type === 'no-effect' && e.seat === 0), 'the Drunk Slayer may shoot, in public, and the shot does nothing');
  s = play(['slayer', 'imp', 'scarlet-woman', 'chef', 'empath', 'soldier', 'monk'], [shot(1, 0, 1)], {until: s => s.winner || atNight(2)(s)});
  ok(!s.winner && s.seats[2].role === 'imp', 'the Slayer killing the Imp with five or more alive hands the demon to the Scarlet Woman');

  // through the api: mid-day after talk
  let g = play(roles, [], {until: atDay(1)});
  for (const x of g.seats) api.say(g, x.index, `${x.name} speaks first.`);
  ok(g.clock.round === 2 && api.canAct(g, 0), 'after a round of talk the Slayer still holds the shot');
  ok(eq(api.answer(g, 0, null), {kept: true}) && api.dayActionFor(g, 0), 'answering "nobody" keeps the shot for later');
  ok(throws(() => api.dayAction(g, 0, 9), /Pick one of/), 'a shot at no seat is refused');
  ok(throws(() => api.dayAction(g, 3, 1), /no ability to use by day/), 'a seat with no day ability cannot shoot');
  const r = api.answer(g, 0, 1);
  ok(r.used === 'slayer' && g.winner?.team === 'good' && api.events(g, 4).some(e => e.type === 'slayer-shot' && e.seat === 0 && e.target === 1), 'the Slayer shoots mid-day, through the same answer as a night choice, and the whole table sees it at once');

  // during nominations: the shot resolves and the nominations go on
  g = play(roles, [], {until: atDay(1)});
  api.openNominations(g);
  api.nominate(g, 3, 4);
  ok(throws(() => api.dayAction(g, 0, 2), /vote is open/), 'no shot while a vote is open: it waits for the vote to end');
  for (const i of g.pending.seats) api.vote(g, i, false);
  ok(api.pendingFor(g, 0)?.kind === 'nomination', 'nominations go on: the Slayer may still nominate');
  ok(api.dayAction(g, 0, 2).used === 'slayer' && g.seats[2].alive && g.phase === 'day', 'the Slayer shoots during the nominations: a miss, and the day goes on');
  ok(g.pending.kind === 'nomination' && eq(g.today.nominators, [3]) && !g.pending.dayActions.length && api.pendingFor(g, 0)?.kind === 'nomination', 'the nominations keep their book, and the spent shot is gone');
  ok(throws(() => api.dayAction(g, 0, 1), /spent/), 'a spent Slayer\'s second shot is refused');

  // a dead Slayer has no shot
  g = play(roles, [{kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 0}], {until: atDay(2)});
  ok(!g.seats[0].alive && !g.pending.dayActions.length && api.dayActionFor(g, 0) === null && !api.pendingFor(g, 0), 'a dead Slayer is offered no shot');
  ok(throws(() => api.dayAction(g, 0, 1), /dead/), 'and a dead Slayer\'s shot is refused');
  const back = replay(JSON.parse(JSON.stringify((() => {const h = play(roles, [], {until: atDay(1)}); api.dayAction(h, 0, 2); return h})())));
  ok(back.log.some(e => e.type === 'slayer-shot' && e.target === 2) && !back.pending.dayActions.length, 'a game with a shot replays from its plain copy');
}

section('the Ravenkeeper and the Undertaker');
{
  const roles = ['ravenkeeper', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'];
  let s = play(roles, [{kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 0}, {kind: 'choose', role: 'ravenkeeper', value: 1}], {until: atDay(2)});
  ok(told(s, 'ravenkeeper')[0]?.info === 'imp', 'the Ravenkeeper killed at night wakes and learns a role');
  s = play(roles, [{kind: 'choose', role: 'monk', value: 0}, {kind: 'choose', role: 'imp', value: 3}], {until: atDay(2)});
  ok(!s.log.some(e => e.type === 'wake' && e.role === 'ravenkeeper'), 'the Ravenkeeper does not wake when it did not die');
  s = play(roles, [...execOn(1, 3, 0), {kind: 'choose', role: 'imp', value: 3}], {until: atDay(2)});
  ok(!s.log.some(e => e.type === 'wake' && e.role === 'ravenkeeper'), 'the Ravenkeeper executed by day does not wake');

  const r2 = ['undertaker', 'imp', 'baron', 'drunk', 'chef', 'soldier', 'monk'];
  s = play(r2, [...execOn(1, 4, 3), {kind: 'choose', role: 'imp', night: 2, value: 4}], {until: atDay(3)});
  ok(told(s, 'undertaker')[0]?.info === 'drunk' && told(s, 'undertaker').length === 1, 'the Undertaker learns the executed Drunk as the Drunk, and does not wake after a day without an execution');
}

section('the Mayor');
{
  const roles = ['mayor', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'];
  let s = play(roles, [{kind: 'choose', role: 'imp', night: 2, value: 3}, ...execOn(2, 0, 4), {kind: 'choose', role: 'imp', night: 3, value: 6},
    ...execOn(3, 0, 2), {kind: 'choose', role: 'imp', night: 4, value: 5}], {until: s => s.winner});
  ok(s.winner?.team === 'good' && s.winner.reason === 'mayor' && s.winner.day === 4, 'three alive, no execution and the Mayor alive: good wins');
  s = play(roles, [{kind: 'choose', role: 'monk', value: 4}, {kind: 'choose', role: 'imp', value: 0}, {kind: 'mayor-bounce', value: 3}], {until: atDay(2)});
  ok(s.seats[0].alive && !s.seats[3].alive, 'the Mayor\'s bounce: the Storyteller may kill another player instead');
  s = play(roles, [{kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 0}, {kind: 'mayor-bounce', value: 3}], {until: atDay(2)});
  ok(s.seats[0].alive && s.seats[3].alive, 'a bounce onto a protected player kills nobody');
  s = play(roles, [{kind: 'choose', role: 'monk', value: 4}, {kind: 'choose', role: 'imp', value: 0}], {until: atDay(2)});
  ok(!s.seats[0].alive, 'without a bounce the Mayor dies');
}

section('the Saint');
{
  let s = play(['saint', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'], execOn(1, 3, 0), {until: s => s.winner || atNight(2)(s)});
  ok(s.winner?.team === 'evil' && s.winner.reason === 'saint', 'the Saint\'s execution loses the game for good');
  s = play(['saint', 'imp', 'poisoner', 'chef', 'empath', 'soldier', 'monk'], [{kind: 'choose', role: 'poisoner', value: 0}, ...execOn(1, 3, 0)], {until: s => s.winner || atNight(2)(s)});
  ok(!s.winner, 'a poisoned Saint\'s execution does not');
}

section('winning, votes and the dead');
{
  let s = play(['imp', 'baron', 'chef'], [{kind: 'choose', role: 'imp', value: 2}], {until: s => s.winner});
  ok(s.winner?.team === 'evil' && s.winner.reason === 'two-alive', 'two players alive with the demon: evil wins');
  s = play(['chef', 'imp', 'baron', 'empath', 'soldier', 'monk', 'mayor'], execOn(1, 0, 1), {until: s => s.winner});
  ok(s.winner?.team === 'good' && /execution of the Imp on day 1/.test(s.winner.text), 'the demon executed: good wins');

  const roles = ['chef', 'imp', 'baron', 'empath', 'soldier', 'monk', 'mayor'], later = [];
  s = play(roles, [...execOn(1, 0, 3), {kind: 'choose', role: 'imp', value: 4},
    {kind: 'nomination', day: 2, once: true, value: {by: 0, target: 2}}, {kind: 'vote', day: 2, once: true, answer: p => Object.fromEntries(p.seats.map(x => [x, x === 3]))},
    {kind: 'nomination', day: 2, once: true, value: {by: 5, target: 6}}, {kind: 'vote', day: 2, ...capture(later)}], {until: atNight(3)});
  const [a, b] = s.today.votes;
  ok(a.yes.includes(3) && !s.seats[3].ghostVote, 'a dead player\'s yes counts and spends the ghost vote');
  ok(later.length === 1 && !later[0].seats.includes(3) && later[0].seats.includes(0), 'the dead player who spent the ghost vote is not asked again');
  ok(b && b.need === 3, 'the bar is half the living, rounded up');

  // a tie on the block executes nobody
  s = play(roles, [{kind: 'nomination', day: 1, once: true, value: {by: 0, target: 2}}, {kind: 'vote', once: true, answer: p => Object.fromEntries(p.seats.map(x => [x, x < 4]))},
    {kind: 'nomination', day: 1, once: true, value: {by: 3, target: 5}}, {kind: 'vote', once: true, answer: p => Object.fromEntries(p.seats.map(x => [x, x < 4]))}], {until: atNight(2)});
  ok(s.today.executed == null && s.seats.every(x => x.alive), 'a tie executes nobody');
  // nominations: once each way a day
  s = play(roles, [{kind: 'nomination', day: 1, once: true, value: {by: 0, target: 2}}], {until: s => s.today?.nominators.length === 1 && s.pending?.kind === 'nomination'});
  ok(!s.pending.options.some(o => o && (o.by === 0 || o.target === 2)), 'a player nominates once a day and is nominated once a day');
}

section('the Empath with dead neighbours');
{
  const roles = ['empath', 'chef', 'imp', 'soldier', 'monk', 'baron', 'mayor'];
  const s = play(roles, [{kind: 'choose', role: 'monk', value: 3}, {kind: 'choose', role: 'imp', value: 1}], {until: atDay(2)});
  const e = told(s, 'empath');
  ok(e[0].info === 0 && eq(e[1].neighbours, [6, 2]) && e[1].info === 1, 'the Empath reads the nearest living neighbours, past the dead');
}

section('decisions, determinism and replay');
{
  let s = newGame({seed: 3, roles: ['empath', 'imp', 'poisoner', 'chef', 'monk', 'soldier', 'mayor']});
  ok(s.pending.kind === 'choose' && s.pending.role === 'poisoner' && s.pending.seat === 2, 'the first decision is the Poisoner\'s');
  ok(throws(() => answer(s, 99)), 'an answer that is not an option is refused');
  s = play(['fortune-teller', 'imp', 'baron', 'chef', 'empath', 'soldier', 'monk'], [], {until: s => s.pending?.kind === 'choose' && s.pending.role === 'fortune-teller'});
  ok(throws(() => answer(s, [3])) && throws(() => answer(s, [3, 3])), 'a two-player pick needs two different players');
  s = play(['chef', 'imp', 'baron', 'empath', 'soldier', 'monk', 'mayor'], [{kind: 'nomination', once: true, value: {by: 0, target: 2}}], {until: s => s.pending?.kind === 'vote'});
  ok(throws(() => answer(s, {0: true})), 'a vote needs a yes or no from every voter');
  // replay from a plain copy
  const g = newGame({seed: 11});
  const live = play(null, [], {state: g, until: s => s.answers.length >= 25});
  const copy = JSON.parse(JSON.stringify(live));
  const back = replay(copy);
  ok(eq(back.log, live.log) && eq(back.pending, live.pending) && eq(grimoire(back), grimoire(live)), 'a plain copy replays to the same game');
}

console.log(fails ? `${fails} edge check(s) failed, ${passes} passed` : `all ${passes} edge checks pass`);
process.exit(fails ? 1 : 0);
