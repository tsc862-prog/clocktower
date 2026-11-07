// npm run gamecheck: the script and the engine hold together. The deal by table size (and the Baron's change), a
// seeded and complete deal, every role's wake entry against the night order, every role's rule present, every
// pending kind with a scripted answer, every role on a tiny table, and seeds 1-20 of the sim ending with a winner
// within 15 days. Exit 1 on any failure.
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCRIPT} from '../src/data/script.js';
import {deal, createRng, newGame, createScripted, playOut, PENDING_KINDS, HOOKS, TELLINGS, PASSIVE} from '../src/game/index.js';
import {SCRIPTED_KINDS} from '../src/game/scripted.js';
import {simulate} from './headless.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0, passes = 0;
const ok = (cond, msg) => {if (cond) passes++; else {fails++; console.log(`  FAIL ${msg}`)}};
const section = name => console.log(`- ${name}`);
const byId = Object.fromEntries(SCRIPT.roles.map(r => [r.id, r]));
const count = (roles, team) => roles.filter(id => byId[id].team === team).length;

section('the script');
{
  ok(SCRIPT.roles.length === 22 && new Set(SCRIPT.roles.map(r => r.id)).size === 22, 'twenty-two roles, ids unique');
  const teams = t => SCRIPT.roles.filter(r => r.team === t).length;
  ok(teams('townsfolk') === 13 && teams('outsider') === 4 && teams('minion') === 4 && teams('demon') === 1, 'thirteen townsfolk, four outsiders, four minions, one demon');
  for (const r of SCRIPT.roles) {
    ok(/^[a-z]+(-[a-z]+)*$/.test(r.id) && r.name && r.ability && Array.isArray(r.reminders), `${r.id}: id in kebab-case, a name, an ability and reminders`);
    ok(['first', 'each', 'other', 'when-killed', 'never'].includes(r.wakes), `${r.id}: wakes is one of first, each, other, when-killed, never`);
    const inFirst = SCRIPT.firstNight.includes(r.id), inOther = SCRIPT.otherNights.includes(r.id);
    const want = {first: [true, false], each: [true, true], other: [false, true], 'when-killed': [false, true], never: [false, false]}[r.wakes];
    ok(inFirst === want[0] && inOther === want[1], `${r.id}: wakes '${r.wakes}' matches the night order (first night ${inFirst}, other nights ${inOther})`);
    const h = HOOKS[r.id] || {};
    ok(!!HOOKS[r.id] || PASSIVE(r), `${r.id}: has its rule (a hook in the engine, or a data rule: disguise, misregisters, heir, setup)`);
    if (inFirst) ok(typeof h.firstNight === 'function', `${r.id}: has a first-night action`);
    if (inOther) ok(typeof h.otherNight === 'function', `${r.id}: has an other-night action`);
  }
  for (const id of [...SCRIPT.firstNight, ...SCRIPT.otherNights]) ok(!!byId[id] || !!TELLINGS[id], `night order entry ${id} is a role or a telling`);
}

section('the deal');
{
  for (let n = 5; n <= 15; n++) {
    let good = true, sawBaron = false;
    for (let seed = 1; seed <= 60; seed++) {
      const roles = deal(SCRIPT, n, createRng(seed)), c = SCRIPT.setup[n];
      const baron = roles.some(id => byId[id].setup?.outsiders);
      sawBaron ||= baron;
      const shift = baron ? Math.min(2, c.townsfolk) : 0;
      if (roles.length !== n || new Set(roles).size !== n || count(roles, 'townsfolk') !== c.townsfolk - shift || count(roles, 'outsider') !== c.outsiders + shift
        || count(roles, 'minion') !== c.minions || count(roles, 'demon') !== c.demon) {good = false; console.log(`       ${n} seats, seed ${seed}: ${roles.join(', ')}`)}
    }
    ok(good, `${n} seats: every deal has the right count of each team${sawBaron ? ' (the Baron adds two outsiders)' : ''}`);
  }
  const seven = deal(SCRIPT, 7, createRng(7));
  ok(JSON.stringify(seven) === JSON.stringify(deal(SCRIPT, 7, createRng(7))), 'the deal is seeded: the same seed deals the same roles');
  const distinct = new Set(Array.from({length: 20}, (_, i) => deal(SCRIPT, 7, createRng(i + 1)).join())).size;
  ok(distinct >= 18, `different seeds deal differently (${distinct} of 20 distinct)`);
  const g = newGame({seed: 4});
  ok(g.seats.length === 7 && g.seats.map(s => s.name).join() === 'Odette,Bram,Ines,Corwin,Thea,Fitch,Yusuf', 'a new game seats the seven by name');
}

section('decisions and randomness');
{
  ok(PENDING_KINDS.every(k => SCRIPTED_KINDS.includes(k)), `every pending kind has a scripted answer (${PENDING_KINDS.join(', ')})`);
  const walk = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const bad = [...walk(join(ROOT, 'src/game')), join(ROOT, 'src/data/script.js')].filter(f => /Math\.random|Date\.now|new Date|performance\.now|fetch\(|process\./.test(readFileSync(f, 'utf8')));
  ok(bad.length === 0, `the engine takes no randomness or time but the seeded RNG, and no network${bad.length ? ': ' + bad.join(', ') : ''}`);
  const phase = readFileSync(join(ROOT, 'src/game/engine.js'), 'utf8');
  const named = SCRIPT.roles.filter(r => new RegExp(`['"]${r.id}['"]`).test(phase)).map(r => r.id);
  ok(named.length === 0, `the phase code names no role${named.length ? ': ' + named.join(', ') : ''}`);
}

section('every role on a tiny table');
{
  const fill = ['chef', 'empath', 'soldier', 'monk', 'mayor', 'washerwoman', 'librarian'];
  for (const r of SCRIPT.roles) {
    let finished = 0, woke = r.wakes === 'never' || r.wakes === 'when-killed' || r.wakes === 'other' || r.team === 'demon';
    for (let seed = 1; seed <= 4; seed++) {
      const roles = [r.id];
      if (r.team !== 'demon') roles.push('imp');
      if (r.team !== 'minion') roles.push('poisoner');
      for (const f of fill) if (roles.length < 5 && !roles.includes(f)) roles.push(f);
      try {
        let s = newGame({seed, roles: createRng(seed).shuffle(roles)});
        s = playOut(s, createScripted(seed), {maxDays: 15});
        if (s.winner) finished++;
        if (s.log.some(e => e.type === 'wake' && e.role === r.id && e.night === 1)) woke = true;
      } catch (e) {console.log(`       ${r.id} seed ${seed}: ${e.message}`)}
    }
    ok(finished === 4 && woke, `${r.id}: four five-seat games finish${r.wakes === 'first' || r.wakes === 'each' ? ', and it wakes on the first night' : ''}`);
  }
}

section('the sim: seeds 1-20');
{
  const days = [];
  for (let seed = 1; seed <= 20; seed++) {
    try {
      const {state, summary} = simulate(seed);
      days.push(state.day);
      ok(!!state.winner && state.day <= 15, `${summary}`);
    } catch (e) {ok(false, `seed ${seed} threw: ${e.message}`)}
  }
  console.log(`       days per game: ${days.join(' ')}`);
  const a = simulate(1, {verbose: true}).lines.join('\n'), b = simulate(1, {verbose: true}).lines.join('\n');
  ok(a === b, 'the same seed prints the same transcript');
}

console.log(fails ? `${fails} game check(s) failed, ${passes} passed` : `all ${passes} game checks pass`);
process.exit(fails ? 1 : 0);
