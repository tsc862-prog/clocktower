// The watcher page's recorded game (npm run uifixture [-- --seed N]): plays one seeded game through the game api with scripted
// answers, a few lines of talk per round, whispers between rounds and a Storyteller who narrates each dawn, and writes what the
// page would read at three moments to src/ui/fixtures/game.json:
//   talk     day 1, mid-round: talk and a whisper, no vote yet
//   vote     the first vote of the game with some hands cast and some still to come
//   rooms    day 2, the evil pair gone to the Snug and one seat alone in the Vestry, a line said in a room (#80)
//   end      the game over, every event
// Each frame is watchView(game): the body the page asks of the backend as GET /play/watch (not served yet; see the slice 6 PR).
// The page builds every panel from these frames until the route exists, and npm run uismoke checks the panels against them.
// No model, no network; the same seed writes the same file. --dry prints a summary and writes nothing.
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as api from '../src/game/api.js';
import SCRIPT, {EVIL} from '../src/data/script.js';
import {newGame} from '../src/game/state.js';
import {createScripted} from '../src/game/scripted.js';
import {createRng} from '../src/game/rng.js';
import {SCRIPTED_REASON} from '../src/game/backend.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = join(ROOT, 'src', 'ui', 'fixtures', 'game.json');
export const FIXTURE_SEED = 1;
const ST = api.ST, copy = v => v == null ? v : JSON.parse(JSON.stringify(v));

// What the watcher may read: everything. The proposed body of GET /play/watch?since=N (the page's origin only): the grimoire with
// its pending decision, every log entry after `since` (whispers with their text, what each seat was told, the rulings) with the
// table's sentence for it as `text`, the day clock, the open ballot and the coming night's waking order.
export function watchView(game, since = -1) {
  const g = api.grimoire(game), c = game.clock;
  const st = api.events(game, ST, since), whispers = game.log.filter(e => (e.type === 'whisper' || e.type === 'say' && e.room != null) && e.id > since).map(({n, ...e}) => copy(e));
  const events = [...st, ...whispers].sort((a, b) => a.id - b.id);
  return {ok: true, seed: game.config.seed, rounds: game.config.rounds, phase: g.phase, night: game.night, day: game.day,
    clock: {day: c.day, round: c.round, roundsBeforeNominations: c.roundsBeforeNominations, nominationsOpen: c.nominationsOpen, spoke: [...c.spoke], passedNominating: [...c.passedNominating]},
    pending: copy(game.pending), ballot: copy(game.ballot), grimoire: g, nightOrder: api.nightOrder(game), rulings: api.rulings(game),
    winner: copy(game.winner), last: game.log.length ? game.log.at(-1).id : -1, events, places: (({square, rooms, open}) => ({square, rooms, open}))(api.where(game, ST))};
}

const LINES = [
  'I slept badly. The tower kept me up, ticking wrong.', 'Before anyone asks: I have nothing worth hiding, and I would like the same from you.',
  'Someone was on Lamp Row after the bell. I heard boots.', 'Let us hear what everyone learned last night, one at a time.',
  'I am not accusing anyone yet. I am counting.', 'That is a very tidy story. Tidy stories bother me.',
  'If you have information, now is when it helps.', 'I would rather hang the wrong neighbour than none, and I hate saying it.',
  'Ask me again tomorrow. I will know more by then.', 'You were quick to answer that. Too quick.',
  'The baker never came back to the Square. Has anyone seen him?', 'Fine. I will say what I am, and you can do what you like with it.',
  'Two of you keep agreeing with each other. I noticed.', 'Nothing useful from me this round, I am afraid.', 'Whoever is feeding the hour, you are good at it.',
  'I counted the votes yesterday. Someone did not vote the way they talked.', 'Look at who has said the least.',
];
const WHISPERS = ['I trust you more than the rest. Do not make me regret it.', 'Watch who votes last today.', 'I have a name. Not yet.',
  'If they nominate me, back me.', 'My information points left of me.', 'Say nothing about what I told you.'];
const REASONS = {
  'believed-role': 'A role the Drunk could believably hold, one nobody else at the table is likely to claim.',
  'red-herring': 'A quiet good player, so a yes from the Fortune Teller costs the town a day, not the game.',
  'demon-bluffs': 'Three roles the town will not expect, so the demon has room to move.',
  register: 'Registers as it truly is this time; a lie here would tip the game too early.',
  info: 'True information: the table is already leaning wrong and needs a fair chance.',
  'mayor-bounce': 'The Mayor stays the target; a bounce now would decide the game.',
  'star-pass': 'The minion most likely to keep the demon hidden.',
};

export function record(seed = FIXTURE_SEED, rounds = 2) {
  const game = newGame({seed, rounds}), ans = createScripted(seed), rng = createRng(seed * 7919 + 13), frames = {};
  let said = 0, whispered = 0, dawns = 0, guard = 0, stCalls = 0;
  const alive = () => game.seats.filter(s => s.alive).map(s => s.index);
  while (!game.winner && guard++ < 5000) {
    const p = game.pending;
    if (!p) break;
    if (game.phase === 'day' && game.day > dawns) {
      dawns = game.day;
      const dead = game.log.filter(e => e.type === 'dawn' && e.day === game.day).flatMap(e => e.deaths).map(i => game.seats[i].name);
      api.narrate(game, dead.length ? `The bell rang once at first light. ${dead.join(' and ')} did not come down to the Square, and will not.` : 'The bell rang once at first light. Every door on Lamp Row opened. Nobody looked relieved.');
    }
    if (p.seat === ST) {
      stCalls++;
      api.answer(game, ST, ans(game), stCalls % 4 === 0 ? SCRIPTED_REASON : REASONS[p.kind] || 'The rules leave this to the Storyteller; this keeps the game fair.');
      continue;
    }
    if (p.kind === 'choose') {api.answer(game, p.seat, ans(game)); continue}
    if (game.phase === 'day' && !game.clock.nominationsOpen) {
      const c = game.clock, next = alive().find(i => !c.spoke.includes(i));
      if (c.spoke.length === 0 && rng.chance(0.7)) {
        const live = alive().filter(i => game.places[i] == null), a = rng.pick(live), to = api.where(game, a).canWhisper; // whispers are between neighbours at the Square (#28)
        if (to.length) api.whisper(game, a, rng.pick(to), WHISPERS[whispered++ % WHISPERS.length]);
      }
      // day 2: the evil pair takes the Snug and one seat sits alone in the Vestry (no rng: the same seed plays the same game)
      if (game.day === 2 && c.round === 1 && c.spoke.length === 0 && !game.log.some(e => e.type === 'move')) {
        const evil = alive().filter(i => EVIL.includes(SCRIPT.roles.find(r => r.id === game.seats[i].role)?.team));
        if (evil.length >= 2) api.invite(game, evil[0], evil[1], 'nook');
        const alone = alive().find(i => game.places[i] == null && !evil.includes(i));
        if (alone != null) api.go(game, alone, 'parlour');
      }
      let spoke = false;
      if (rng.chance(0.85)) try {api.say(game, next, LINES[said++ % LINES.length]); spoke = true} catch {} // a line the seat said lately: it passes
      if (!spoke) api.pass(game, next);
      if (!frames.talk && game.day === 1 && game.log.some(e => e.type === 'whisper') && game.clock.spoke.length === 3) frames.talk = watchView(game);
      if (!frames.rooms && game.day === 2 && game.log.some(e => e.type === 'say' && e.room != null) && game.clock.spoke.length >= 4) frames.rooms = watchView(game);
      continue;
    }
    if (p.kind === 'nomination') {
      const v = ans(game);
      if (v) api.nominate(game, v.by, v.target);
      else for (const i of alive()) if (game.pending && game.pending.kind === 'nomination' && !game.today.nominators.includes(i) && !game.clock.passedNominating.includes(i)) api.pass(game, i);
      continue;
    }
    if (p.kind === 'vote') {
      const v = ans(game), n = game.seats.length, order = [...p.seats].sort((a, b) => ((a - p.nominee - 1 + n) % n) - ((b - p.nominee - 1 + n) % n));
      order.forEach((i, k) => {
        if (!frames.vote && k === 3) frames.vote = watchView(game);
        api.vote(game, i, !!v[i]);
      });
      continue;
    }
    if (p.kind === 'thoughts') {for (const i of p.seats) api.think(game, i, ''); continue} // the night's thoughts (#111): none in the fixture
    throw new Error(`the recorder has no move for ${p.kind} (${p.seat})`);
  }
  frames.end = watchView(game);
  return {seed, rounds, recorded: 'npm run uifixture', frames};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--seed'), seed = i >= 0 ? Number(process.argv[i + 1]) : FIXTURE_SEED;
  const f = record(seed), ev = f.frames.end.events, n = t => ev.filter(e => e.type === t).length;
  if (process.argv.includes('--dry')) {
    console.log(`seed ${seed}: ${ev.length} events, ${n('say')} lines, ${n('whisper')} whispers, ${n('nomination')} nominations, ${n('execution')} executions, ${f.frames.end.rulings.length} rulings, frames ${Object.keys(f.frames).join(', ')}, winner ${f.frames.end.winner && f.frames.end.winner.team}; ${f.frames.end.grimoire.seats.map(s => s.role + (s.believed !== s.role ? '(' + s.believed + ')' : '')).join(' ')}`);
    process.exit(0);
  }
  mkdirSync(dirname(FIXTURE), {recursive: true});
  writeFileSync(FIXTURE, JSON.stringify(f) + '\n');
  console.log(`wrote ${FIXTURE.slice(ROOT.length + 1)}: seed ${seed}, ${ev.length} events, frames ${Object.keys(f.frames).join(', ')}`);
}
