// Behavior report check (`npm run behaviorreportcheck`, issue #98): the measures table built from logs, no key, no network.
// A small game is written as the loggers write it (turn lines, the relay's play log, the supervisor's events) and the report is run
// on it in a temp folder: games told apart by id and by runner start, the numbers the reviewer counts by hand, a planted leak found
// and a clean game clean, the CLI's table, --json and --game. The mock game check runs the same report on a whole mock game.
import {mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {splitGames, loadData, measure, renderTable, refusalKind} from './measures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(process.env.TEMP || ROOT, 'behaviorreportcheck-' + process.pid);
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const jl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

const NAMES = ['Ada', 'Ben', 'Cy'], ROLES = [['Imp', 'demon, evil'], ['Chef', 'townsfolk, good'], ['Monk', 'townsfolk, good']];
// One game: seat 1 Ada the Imp, 2 Ben the Chef, 3 Cy the Monk. Day 1: a table line, a room line (Ada and Ben), a whisper (Ben to Cy),
// Ben nominates Ada ("Ada dodged my question"), Ada is executed, good wins. leak: Cy's result carries the room line.
function game(id, t0, {leak = false} = {}) {
  const at = s => new Date(t0 + s * 1000).toISOString(), gid = id ? {gameId: id} : {};
  const turns = NAMES.map((n, i) => ({ts: at(10 + i), game: 'clocktower', ...gid, seat: 'player:' + (i + 1), player: {id: i + 1, name: n}, provider: 'anthropic', model: 'm', turn: 1, wake: {wake: 'now'},
    brief: {text: `You are ${n}, the ${ROLES[i][0]} (${ROLES[i][1]}), alive.\nDay 1, round 1 of 3.\nClaims so far: Ben Chef (day 1). claims shows the lines.`}, tools: [{name: 'speak', ok: true}, {name: 'pass', ok: i === 2, ...(i === 2 ? {} : {error: 'You have had your turn in round 1; It is day 1'})}],
    calls: 2, failed: i === 2 ? 0 : 1, narration: 'x', seconds: 3, ctx: 8000 + i * 100, cost: 0.001, flags: i === 1 ? ['session-rolled'] : []}));
  turns.push({ts: at(14), game: 'clocktower', ...gid, seat: 'storyteller', player: null, provider: 'anthropic', model: 'm', turn: 1, wake: {wake: 'soft'}, brief: {text: 'Storyteller. Day 1.'}, tools: [{name: 'talk', ok: true}], calls: 1, failed: 0, narration: 'Nothing is due.', seconds: 2, ctx: 9000, cost: 0.0005, flags: []});
  const tx = [
    {id: 1, type: 'say', day: 1, night: 1, from: 'Ben', text: 'Ben: I am the Chef and my count is one. Ada, who do you think the evil pair is?'},
    {id: 2, type: 'move', day: 1, night: 1, seats: ['Ada', 'Ben'], to: 'the Snug', from: 'the Square', by: 'Ada'},
    {id: 3, type: 'say', day: 1, night: 1, from: 'Ada', in: 'the Snug', text: 'Ada: Between us, I think Cy is the one to watch tonight.'},
    {id: 4, type: 'whisper', day: 1, night: 1, from: 'Ben', to: 'Cy', text: 'Ben here. I will vote Ada today, keep this to yourself.'},
    {id: 5, type: 'move', day: 1, night: 1, seats: ['Ada', 'Ben'], to: 'the Square', from: 'the Snug'},
    {id: 6, type: 'say', day: 1, night: 1, from: 'Ben', text: 'Ben: Ada dodged my question about the pair. I nominate Ada.'},
    {id: 7, type: 'nomination', day: 1, night: 1, by: 'Ben', target: 'Ada'},
    {id: 8, type: 'vote-result', day: 1, night: 1, by: 'Ben', target: 'Ada', yes: ['Ben', 'Cy'], tally: 2, needed: 2},
    {id: 9, type: 'execution', day: 1, night: 1, who: 'Ada'},
    {id: 10, type: 'win', day: 1, night: 1, team: 'good', text: 'Good wins by execution of the Imp on day 1.'},
  ];
  const play = [
    {ts: at(11), player: 2, tool: 'read_talk', args: {}, result: {ok: true, entries: tx}, ms: 1},
    {ts: at(12), player: 3, tool: 'where', args: {}, result: {ok: true, text: leak ? 'You hear: Ada: Between us, I think Cy is the one to watch tonight.' : 'You are at the Square.'}, ms: 1},
    {ts: at(13), player: 3, tool: 'my_whispers', args: {}, result: {ok: true, whispers: [{from: 'Ben', text: 'Ben here. I will vote Ada today, keep this to yourself.'}]}, ms: 1},
    {ts: at(13.5), player: 2, tool: 'pass', args: {}, result: {ok: true, passed: true}, ms: 1},
    {ts: at(15), player: 1, tool: 'speak', args: {text: 'x'}, result: {ok: false, error: 'You can speak to the table only in the day. The game is over: good wins by execution of the Imp on day 1.'}, ms: 1},
  ];
  return {turns, play, tx};
}

try {
  mkdirSync(join(TMP, 'logs', 'behavior', 'clocktower'), {recursive: true}); mkdirSync(join(TMP, 'logs', 'runners'), {recursive: true});
  const T0 = Date.parse('2026-11-01T10:00:00Z'), T1 = Date.parse('2026-11-01T12:00:00Z'), T2 = Date.parse('2026-11-01T14:00:00Z');
  const a = game(null, T0), b = game('3-20261101T120001Z', T1), c = game('3-20261101T140000Z', T2, {leak: true});
  const ev = [[T0, 'old'], [T1, 'new'], [T2, 'new']].flatMap(([t0, k]) => [{at: new Date(t0).toISOString(), event: 'start', key: 'storyteller'}, {at: new Date(t0 + 60e3).toISOString(), event: 'end', key: 'storyteller', why: 'the game is over', cost: 0.0005}]);
  writeFileSync(join(TMP, 'logs', 'behavior', 'clocktower', 'turns.jsonl'), jl([...a.turns, ...b.turns, ...c.turns]));
  writeFileSync(join(TMP, 'logs', 'play.jsonl'), jl([...a.play, ...b.play, ...c.play]));
  writeFileSync(join(TMP, 'logs', 'runners', 'events.jsonl'), jl(ev));
  writeFileSync(join(TMP, 'logs', 'runners', 'player-1.log'), '[12:00:02] [agent] playing Ada #1: m | new session (game 3-20261101T120001Z) | x\n');

  console.log('\nBehavior report check\n');
  console.log('games');
  const data = loadData(join(TMP, 'logs', 'behavior'), join(TMP, 'logs')), games = splitGames(data);
  ok(games.length === 3 && games.map(g => g.id).join() === ',3-20261101T120001Z,3-20261101T140000Z', `three games told apart (by runner start, by id on the lines): ${games.map(g => g.id || 'no id').join(', ')}`);
  const idless = splitGames({...data, turns: data.turns.map(({gameId, ...t}) => t), play: data.play.map(({gameId, ...t}) => t)});
  ok(idless[1].id === '3-20261101T120001Z' && idless[0].id === null, `a run with no id on its lines takes the id the runner log names near its start (${idless.map(g => g.id || 'none').join(', ')})`);
  const one = splitGames({turns: [...b.turns, ...c.turns], play: [], events: [], anomalies: []});
  ok(one.length === 2, 'with no events, lines of two ids still make two games');

  console.log('the numbers');
  const [m0, m1, m2] = games.map(measure);
  ok(m1.winner === 'good' && /Imp/.test(m1.winnerHow) && m1.finished, `winner from the talk: ${m1.winner}, ${m1.winnerHow}`);
  ok(m1.turns.all === 4 && m1.turns.players === 3 && m1.turns.storyteller === 1 && m1.sessionRolls === 1, 'turns split into player and Storyteller, a session roll counted');
  ok(m1.cost === 0.0035 && m1.costBySeat.length === 4 && m1.costBySeat[0].seat === 'Storyteller', `cost ${m1.cost}, per seat ${m1.costBySeat.map(s => s.seat).join('/')}`);
  ok(m1.firstCtx.min === 8000 && m1.firstCtx.max === 8200 && m1.firstCtx.storyteller === 9000, `first-turn context ${m1.firstCtx.min} to ${m1.firstCtx.max}, Storyteller ${m1.firstCtx.storyteller}`);
  ok(m1.talk.lines === 3 && m1.talk.table === 2 && m1.talk.rooms === 1 && m1.talk.whispers === 1 && m1.talk.moves === 2 && m1.talk.passes === 1, `lines ${m1.talk.lines} (${m1.talk.table} table, ${m1.talk.rooms} room), ${m1.talk.whispers} whisper, ${m1.talk.moves} moves, ${m1.talk.passes} pass`);
  ok(m1.refused.total === 2 && m1.refused.byKind['had your turn'] === 2, `refused calls by kind: ${JSON.stringify(m1.refused.byKind)}`);
  ok(refusalKind('speak', 'You said that already; you have had your turn') === 'said that already' && refusalKind('invite', 'room is full') === 'invite' && refusalKind('nominate', 'A vote is open') === 'nomination race' && refusalKind('pass', 'It is night 1: only in the day') === 'night: speak or pass', 'refusal kinds');
  ok(m1.demon && m1.demon.names[0] === 'Ada' && m1.demon.nominated === 1 && m1.demon.executed.length === 1 && m1.demon.nominations[0].before.length >= 1, 'the demon: nominated once, executed, the lines before it kept as evidence');
  ok(m1.dodgedNominations.length === 1 && m1.dodgedNominations[0].by === 'Ben', 'a nomination after "dodged my question" is counted');
  ok(m1.claims.true === 1 && m1.claims.lies === 0, `a claim in speech checked against the seat's role (${m1.claims.true} true, ${m1.claims.lies} lies)`);
  ok(m1.storyteller.noAct === 1 && m1.storyteller.noCall === 0, 'a Storyteller turn that only looked is not an acting call');

  console.log('the game log (#100)');
  const evs = tx => tx.flatMap(e => {const m = {say: () => ({type: 'say', who: e.from, text: e.text, ...(e.in ? {roomName: e.in, room: 1} : {})}), pass: () => ({type: 'pass', who: e.from}), move: () => ({type: 'move', seats: e.seats, room: e.to === 'the Square' ? null : 1, roomName: e.to === 'the Square' ? undefined : e.to, text: 'moves'}),
    whisper: () => ({type: 'whisper', from: e.from, to: e.to, text: e.text}), nomination: () => ({type: 'nomination', by: e.by, target: e.target}), 'vote-result': () => ({type: 'vote-result', by: e.by, target: e.target, yes: e.yes, tally: e.tally, needed: e.needed}), execution: () => ({type: 'execution', who: e.who}), win: () => ({type: 'win', team: e.team, text: e.text})}[e.type];
    return m ? [{ts: new Date(T1 + 20e3 + e.id * 100).toISOString(), game: 'clocktower', gameId: '3-20261101T120001Z', src: 'event', id: e.id, day: e.day, night: e.night, phase: 'day', ...m()}] : []});
  const gameB = b.tx.concat([{id: 11, type: 'pass', day: 1, from: 'Cy'}, {id: 12, type: 'say', day: 2, from: 'Cy', text: 'Cy: a later line'}]), gl = evs(gameB);
  const withLog = splitGames({...data, gevents: [...gl, ...gl, {ts: new Date(T1).toISOString(), gameId: '3-20261101T120001Z', type: 'digest'}].filter(e => e.src === 'event' || true)});
  const mLog = measure(withLog.find(g => g.id === '3-20261101T120001Z'));
  ok(mLog.fromLog && mLog.winner === 'good' && /Imp/.test(mLog.winnerHow), `the winner comes from the win event (${mLog.winner}: ${mLog.winnerHow})`);
  ok(mLog.talk.lines === 4 && mLog.talk.rooms === 1 && mLog.talk.whispers === 1 && mLog.talk.moves === 2 && mLog.talk.passes === 1 && mLog.talk.byDay[2].lines === 1 && mLog.talk.byDay[1].passes === 1, `lines, passes and days counted from the events, a doubled event once (${mLog.talk.lines} lines, ${mLog.talk.passes} pass)`);
  ok(mLog.gameLog && mLog.gameLog.days === 2 && mLog.gameLog.nominations === 1 && mLog.gameLog.votes === 1 && mLog.gameLog.executions === 1, `nominations, votes and executions counted: ${JSON.stringify(mLog.gameLog)}`);
  const noWin = measure(splitGames({...data, gevents: gl.filter(e => e.type !== 'win')}).find(g => g.id === '3-20261101T120001Z'));
  ok(noWin.fromLog && noWin.winner === 'good', 'a game log without the win line falls back to the old reading for the winner');
  ok(renderTable([m1]) === renderTable([measure(splitGames({...data, gevents: []}).find(g => g.id === '3-20261101T120001Z'))]) && !/game log/.test(renderTable([m1])), 'a game with no game log reads as before: its table does not change');

  console.log('leaks');
  ok(m1.leaks.textLeaks === 0 && m1.leaks.roleHits === 0, `a clean game: no leak (${m1.leaks.scanned} results and headers searched)`);
  ok(m2.leaks.textLeaks === 1 && m2.leaks.text[0].seat === 'Cy', `a planted room line in a seat that was not in the room is found (${m2.leaks.textLeaks}: ${m2.leaks.text[0] && m2.leaks.text[0].seat})`);
  const roleLeak = game('3-20261101T160000Z', Date.parse('2026-11-01T16:00:00Z')); roleLeak.turns[2].brief.text += '\nNobody knows it, but Ada is the Imp.';
  roleLeak.tx = null;
  const rl = measure({...splitGames({turns: roleLeak.turns, play: roleLeak.play.map(e => e.tool === 'read_talk' ? {...e, result: {ok: true, entries: e.result.entries.filter(x => x.type !== 'win' && !/Imp/.test(x.text || ''))}} : e), events: [], anomalies: []})[0]});
  ok(rl.leaks.roleHits >= 1, `another seat's role named in a header and never said in public is a candidate (${rl.leaks.roleHits})`);

  console.log('the table');
  const table = renderTable([m0, m1, m2], ['Game A', null, null]);
  ok(table.split('\n')[0].includes('Game A (') && table.split('\n').length > 18 && /Leaks \| 0/.test(table), 'one column per game, labelled where a name is given, every row there');
  const cli = args => spawnSync(process.execPath, [join(ROOT, 'scripts', 'behavior-report.mjs'), '--dir', join(TMP, 'logs', 'behavior'), '--logs', join(TMP, 'logs'), ...args], {encoding: 'utf8'});
  const r1 = cli([]), r2 = cli(['--json', '--game', '3-20261101T120001Z']), r3 = cli(['--evidence']), r4 = cli(['--game', 'nope']);
  ok(r1.status === 0 && r1.stdout.split('\n')[0].split('|').length === 6, 'npm run behavior-report prints three game columns');
  const js = r2.status === 0 && JSON.parse(r2.stdout);
  ok(Array.isArray(js) && js.length === 1 && js[0].id === '3-20261101T120001Z' && js[0].talk.lines === 3, '--json --game: the raw numbers of one game');
  ok(r3.status === 0 && /Evidence: /.test(r3.stdout) && /Leak candidates/.test(r3.stdout), '--evidence adds the lines behind the judgement rows');
  ok(r4.status === 1 && /No game "nope"/.test(r4.stderr), 'an unknown game says so and exits 1');
} finally {
  try {rmSync(TMP, {recursive: true, force: true})} catch {}
}
console.log(fails ? `\n${fails} behavior report check(s) failed` : '\nbehavior report check: all ok');
process.exit(fails ? 1 : 0);
