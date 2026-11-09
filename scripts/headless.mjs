// npm run sim [-- --seed N] [--verbose] [--quiet]
// One seeded Trouble Brewing game with scripted seats, from the deal to a winner, played through the game api
// (src/game/talk.js): the scripted answers for every decision and scripted talk for every speaking round, rooms included.
// Prints the deal, each night's actions, what each waking role was told and the grimoire at dawn, each day's moves to and
// from the rooms and a summary of its talk, its nominations, votes and execution, the winner and how, and a one-line
// summary. The same seed prints the same transcript; the talk has its own RNG, so it never changes a decision.
import {pathToFileURL} from 'node:url';
import {SCRIPT} from '../src/data/script.js';
import {newGame, roleName} from '../src/game/index.js';
import {playScripted} from '../src/game/talk.js';
import {ROOMS} from '../src/data/rooms.js';

const argv = process.argv.slice(2);
const opt = (k, d) => {const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d};
const seed = Number(opt('--seed', '1'));
const verbose = argv.includes('--verbose'), quiet = argv.includes('--quiet');

export function simulate(seed, {verbose = false} = {}) {
  const decisions = [];
  const state = playScripted(newGame({seed, script: SCRIPT}), seed, {onDecision: (p, v, s) => decisions.push({at: s.log.length, p, v})});
  return {state, lines: transcript(state, verbose ? decisions : []), summary: summary(seed, state)};
}

export const summary = (seed, state) => `seed ${seed}: ${state.winner.text}, ${state.winner.alive} alive`;

function transcript(state, decisions) {
  const out = [], name = i => state.seats[i]?.name ?? '-', rn = id => roleName(state, id);
  const who = i => `${name(i)} (${rn(state.seats[i].believed)})`;
  const fmt = (what, info) => {
    if (info === undefined) return '';
    if (info === null) return 'nothing';
    if (typeof info === 'boolean') return info ? 'yes' : 'no';
    if (typeof info === 'number') return String(info);
    if (typeof info === 'string') return rn(info);
    if (info.none) return 'no outsiders in play';
    if (info.players) return `${info.players.map(name).join(' or ')} is the ${rn(info.role)}`;
    return JSON.stringify(info);
  };
  const grim = g => g.map(s => {
    const toks = s.tokens.map(t => `${t.token}${t.value ? '=' + t.value : ''}${t.active === false ? '(off)' : ''}`).join(', ');
    return `    ${s.alive ? ' ' : '+'} ${s.name.padEnd(8)} ${rn(s.role).padEnd(14)}${s.believed !== s.role ? ' believes ' + rn(s.believed) : ''}${toks ? '  [' + toks + ']' : ''}${!s.alive && s.ghostVote ? '  ghost vote' : ''}`;
  });
  let d = 0;
  // the day's talk until nominations open: lines at the Square, passes, and each room's lines and speakers
  let talk = null, talkDone = false;
  const roomName = id => ROOMS.find(r => r.id === id)?.name ?? id;
  const flushTalk = () => {
    if (!talk || !(talk.square + talk.passes + Object.keys(talk.rooms).length)) {talk = null; return}
    const rooms = Object.entries(talk.rooms).map(([id, r]) => `${r.lines} in ${roomName(id)} (${[...r.who].map(name).join(', ')})`);
    out.push(`  Talk: ${talk.square} line${talk.square === 1 ? '' : 's'} at the Square${rooms.length ? ', ' + rooms.join(', ') : ''}, ${talk.passes} pass${talk.passes === 1 ? '' : 'es'}`);
    talk = null;
  };
  const flushDecisions = n => {
    while (d < decisions.length && decisions[d].at <= n) {
      const {p, v} = decisions[d++];
      out.push(`      ? ${p.question} -> ${JSON.stringify(v)}`);
    }
  };
  out.push(`${state.script.name}, seed ${state.config.seed}, ${state.seats.length} seats`);
  for (const e of state.log) {
    flushDecisions(e.n);
    switch (e.type) {
      case 'deal': out.push('The deal:'); state.seats.forEach((s, i) => out.push(`    ${s.name.padEnd(8)} ${rn(e.roles[i])}`)); break;
      case 'told':
        if (e.what === 'role') {if (state.seats[e.seat].role !== e.role || verbose) out.push(`  ${name(e.seat)} is told they are the ${rn(e.role)}`); break}
        if (e.what === 'grimoire') {out.push(`  ${who(e.seat)} sees the grimoire`); break}
        if (e.what === 'minion-info') {out.push(`  ${who(e.seat)} learns the demon: ${e.demon.map(name).join(', ')}`); break}
        if (e.what === 'demon-info') {out.push(`  ${who(e.seat)} learns the minions: ${e.minions.map(name).join(', ')}; bluffs: ${e.bluffs.map(rn).join(', ')}`); break}
        if (e.what === 'became-demon') {out.push(`  ${name(e.seat)} is told they are now the ${rn(e.role)}`); break}
        out.push(`  ${who(e.seat)} is told: ${e.picks ? e.picks.map(name).join(' and ') + ': ' : ''}${e.target != null ? name(e.target) + ' is the ' : ''}${fmt(e.what, e.info)}`);
        break;
      case 'night': flushTalk(); out.push('', `== Night ${e.night} ==`); break;
      case 'say': case 'pass': {
        if (e.phase !== 'day' || talkDone) break; // a pass on nominating, or talk after the nominations open
        talk = talk || {square: 0, passes: 0, rooms: {}};
        if (e.type === 'pass') {talk.passes++; break}
        if (e.room == null) talk.square++;
        else {const r = talk.rooms[e.room] = talk.rooms[e.room] || {lines: 0, who: new Set()}; r.lines++; r.who.add(e.seat)}
        break;
      }
      case 'move': out.push(`  ${e.text}`); break;
      case 'phase': if (e.what === 'nominations') {flushTalk(); talkDone = true} break;
      case 'acted': out.push(`  ${who(e.seat)} picks ${name(e.target)}`); break;
      case 'registered': out.push(`  (Storyteller) ${name(e.seat)} registers as the ${rn(e.as)} ${e.why}`); break;
      case 'death': out.push(`  ${name(e.seat)} the ${rn(e.role)} dies (${e.cause})`); break;
      case 'no-death': out.push(`  ${name(e.seat)} does not die (${e.why})`); break;
      case 'no-effect': out.push(`  ${who(e.seat)}: no effect (drunk or poisoned)`); break;
      case 'bounce': out.push(`  (Storyteller) the kill on the Mayor ${name(e.from)} lands on ${name(e.to)}`); break;
      case 'new-demon': out.push(`  ${name(e.seat)} the ${rn(e.was)} becomes the ${rn(e.role)} (${e.how})`); break;
      case 'dawn': talkDone = false;
        out.push('  Grimoire at dawn:', ...grim(e.grimoire), '', `== Day ${e.day} ==`);
        out.push(`  Dawn: ${e.deaths.length ? e.deaths.map(name).join(', ') + ' died in the night' : 'nobody died in the night'}`);
        break;
      case 'slayer-shot': out.push(`  ${name(e.seat)} claims the Slayer and shoots ${name(e.target)}`); break;
      case 'nomination': out.push(`  ${name(e.by)} nominates ${name(e.target)}`); break;
      case 'virgin': out.push(`  ${name(e.nominator)} nominated the Virgin ${name(e.seat)} and is executed at once`); break;
      case 'vote': out.push(`    votes ${e.tally}/${e.need} (${e.yes.map(name).join(', ') || 'none'})${e.voided.length ? '; not counted: ' + e.voided.map(name).join(', ') : ''}${e.block ? '; on the block: ' + (e.block.seat == null ? 'tie' : name(e.block.seat)) : ''}`); break;
      case 'execution': out.push(`  ${name(e.seat)} the ${rn(e.role)} is executed${e.how === 'vote' ? '' : ' (' + e.how + ')'}`); break;
      case 'no-execution': out.push('  No execution today'); break;
      case 'win': flushTalk(); out.push('', `Winner: ${e.team} (${e.reason}): ${e.text}`); break;
    }
  }
  flushDecisions(Infinity);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {lines, summary: s} = simulate(seed, {verbose});
  if (!quiet) console.log(lines.join('\n'));
  console.log((quiet ? '' : '\n') + s);
}
