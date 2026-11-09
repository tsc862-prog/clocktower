// Mock game check (`npm run mockgamecheck`, slice 4 of issue #1): runners play a whole game without a dollar spent. No key, no
// network beyond 127.0.0.1. The real relay script (--runners --game --seed 5) and its supervisor start eight runners from the page:
// the Storyteller and six players on Claude through a fake Agent SDK (scripts/fake-agent-sdk.mjs: the real runner,
// scripts/claude-runner.mjs, with the SDK's stream played by the mock mind) and one player on the mock Ollama (mock-play:1b, the
// same mock mind through the local loop). It proves:
//   - every runner claims its seat, warms up and plays paced turns, each with a non-empty header as its prompt and a cost line
//     ("| ctx 3k | turn $x | run $y" for Claude, the local line for Ollama);
//   - a budget stop: one seat starts on a dear model with $0.01, stops itself when the fake price crosses it, stays stopped, and
//     the owner starts it again;
//   - the game budget: the supervisor counts every Claude seat's spend into the players' and the Storyteller's pools;
//   - a session roll before the price line (SESSION_ROLL_TOKENS small here);
//   - a gone Storyteller pauses the game; the owner's resume starts the scripted Storyteller, which answers from then on;
//   - the behavior log has one line per turn, every line with its header;
//   - the game reaches a winner; every runner then stops by itself ("the game is over") and no turn begins after it (#69).
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {readFileSync, existsSync, readdirSync, cpSync, rmSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startMockOllama} from './mock-ollama.mjs';
import {quietEnv, startRelayProcess, req} from './relaycheck.mjs';
import {ms} from './ci-clock.mjs';
import {loadData, splitGames, measure, renderTable} from './measures.mjs';

// On a failure the runner logs, the events log and the behavior log are kept in logs/mockgamecheck/ (CI uploads it as an artifact).
export const KEEP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'mockgamecheck');
function keepLogs(env) {
  try {rmSync(KEEP_DIR, {recursive: true, force: true}); mkdirSync(KEEP_DIR, {recursive: true});
    for (const [from, to] of [[join(env.AGENT_LOGS, 'runners'), 'runners'], [env.BEHAVIOR_DIR, 'behavior'], [join(env.AGENT_LOGS, 'play.jsonl'), 'play.jsonl']]) if (existsSync(from)) cpSync(from, join(KEEP_DIR, to), {recursive: true});
    console.log(`  the runner and behavior logs are kept in ${KEEP_DIR}`)} catch (e) {console.log('  could not keep the logs: ' + e.message)}
}
const PAGE = 'http://localhost:5173', SEED = 5, OLLAMA_SEAT = 7, DEAR_SEAT = 4;
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; return !!c};
const sleep = t => new Promise(r => setTimeout(r, t));
const until = async (f, t, step = 250) => {const t0 = Date.now(); for (;;) {const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > t) return null; await sleep(step)}};
const jsonl = f => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

async function main() {
  console.log('\nClocktower mock game: eight runners from the supervisor, a mock Claude and a mock Ollama\n');
  const ol = await startMockOllama();
  const env = await quietEnv({OLLAMA_URL: ol.url, CLOCKTOWER_FAKE_SDK: 'scripts/fake-agent-sdk.mjs', AGENT_PROVIDER: 'anthropic', AGENT_MIN_GAP: '2',
    AGENT_MAX_FAILS: '50', RUNNER_CLAUDE_MAX: '8', SESSION_ROLL_TOKENS: '6000', GAME_BUDGET: '5', RELAY_VERBOSE: '1'});
  let completed = false;
  const R = await startRelayProcess(['--play-only', '--runners', '--game', '--seed', String(SEED)], env), {base} = R;
  const start = body => req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body});
  const view = () => req(base, '/play/runner', {origin: PAGE});
  const runner = async key => ((await view()).runners || []).find(x => x.key === key);
  try {
    console.log('start');
    const st = await start({kind: 'storyteller'});
    ok(st.status === 200 && st.runner.budget === 1.5, `the Storyteller runner starts with its share of the $5 game set apart ($${st.runner && st.runner.budget})`);
    const startSeat = async id => {
      const body = id === OLLAMA_SEAT ? {player: id, provider: 'ollama', model: 'mock-play:1b'} : id === DEAR_SEAT ? {player: id, model: 'claude-opus-5-5', budget: 0.01} : {player: id};
      const s = await start(body);
      ok(s.status === 200, `seat #${id} starts: ${id === OLLAMA_SEAT ? 'mock Ollama' : 'Claude (fake SDK)'}${id === DEAR_SEAT ? ', Opus with $0.01' : ''}, budget ${s.runner ? s.runner.budget : s.error}`);
    };
    for (let id = 1; id <= 7; id++) if (id !== DEAR_SEAT) await startSeat(id);
    const others = h => h.players.filter(p => p.id !== DEAR_SEAT);
    const all = await until(async () => {const h = await req(base, '/play/health'); return others(h).every(p => p.claimed) && h.storyteller.claimed ? h : null}, ms(30000, 15000));
    ok(!!all, 'every seat started is claimed by its own runner, and the Storyteller seat by its own');
    const ready = await until(async () => {const h = await req(base, '/play/health'); return others(h).every(p => p.ready === 'ready') && h.storyteller.ready && h.storyteller.ready.state === 'ready' ? h : null}, ms(30000, 15000));
    ok(!!ready, 'every runner warmed up (the start gate)');

    console.log('a budget stop');
    await startSeat(DEAR_SEAT);
    const spent = await until(async () => {const v = await runner('player:' + DEAR_SEAT); return v && v.state === 'stopped' ? v : null}, ms(60000, 30000));
    ok(!!spent && spent.budgetSpent && spent.endWhy === 'budget reached' && spent.cost >= 0.01, `seat #${DEAR_SEAT} stops itself when its spend crosses $0.01 (${spent ? spent.turns + ' turn(s), $' + spent.cost + ', ' + spent.endWhy : 'still running'})`);
    await sleep(ms(3000, 600));
    ok(((await runner('player:' + DEAR_SEAT)) || {}).state === 'stopped', 'and stays stopped: nothing but a person starts it again');
    const again = await start({player: DEAR_SEAT, model: 'claude-haiku-5-5'});
    ok(again.status === 200, `the owner starts it again on Haiku with a player's share ($${again.runner && again.runner.budget})`);

    console.log('a gone Storyteller pauses the game');
    await req(base, '/play/runner/stop', {method: 'POST', origin: PAGE, body: {kind: 'storyteller'}});
    const paused = await until(async () => {const v = await view(); return v.paused ? v : null}, ms(15000, 8000));
    ok(!!paused, `the supervisor marks the game paused (${paused ? paused.paused.why : 'not paused'})`);
    const res = await req(base, '/play/runner/resume', {method: 'POST', origin: PAGE, body: {}});
    ok(res.status === 200 && res.runner && res.runner.budget === null, 'the owner resumes: the scripted Storyteller starts, at no cost');
    ok(!(await view()).paused, 'the game is no longer paused');

    console.log('the game');
    const over = await until(async () => {const h = await req(base, '/play/health'); return /over/.test(h.phase || '') ? h : null}, ms(240000, 150000), 500);
    ok(!!over, `the game reaches its end (${over ? over.phase : (await req(base, '/play/health')).phase})`);
    // #69: after the win every runner is told the game is over at its next pace and stops by itself; no turn starts after it
    const tWin = Date.now(), live = ((await view()).runners || []).filter(r => !['stopped', 'crashed'].includes(r.state)).map(r => r.key);
    // the supervisor learns of a stop a moment after the runner says it: poll until every one shows stopped with its reason (up to 10 s once all have stopped)
    const stopped = rs => live.every(k => {const r = rs.find(x => x.key === k); return r && ['stopped', 'crashed'].includes(r.state)});
    let selfStop = await until(async () => {const rs = (await view()).runners || []; return stopped(rs) ? rs : null}, ms(30000, 15000));
    if (selfStop) selfStop = await until(async () => {const rs = (await view()).runners || []; return live.every(k => (rs.find(x => x.key === k) || {}).endWhy === 'the game is over') ? rs : null}, ms(10000, 10000)) || (await view()).runners;
    const notOver = live.filter(k => {const r = (selfStop || []).find(x => x.key === k); return !r || r.endWhy !== 'the game is over'});
    const overEnds = (selfStop || []).filter(r => r.endWhy === 'the game is over').map(r => r.key);
    ok(!!selfStop && !notOver.length && overEnds.length >= 5, `every runner playing at the win stops by itself, "the game is over" (${overEnds.join(', ')}${notOver.length ? '; not: ' + notOver.join(', ') : ''})`);
    const v = await view();
    await req(base, '/play/runner/stop-all', {method: 'POST', origin: PAGE, body: {why: 'the check is done'}});
    const look = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'mockgamecheck', tool: 'look', args: {}}});
    ok(!!look.winner, `a winner: ${look.winner || 'none'}`);
    // #90: the end is narrated before the Storyteller's runner stops (here the scripted one: the plain facts and every role)
    const watched = ((await req(base, '/play/watch?since=0', {origin: PAGE})).events) || [];
    const winAt = watched.findIndex(e => e.type === 'win'), endLine = winAt >= 0 ? watched.slice(winAt + 1).find(e => e.type === 'narration') : null;
    ok(!!endLine && /^The game is over: (good|evil) wins/.test(endLine.text) && /Who was who: /.test(endLine.text), `the end is narrated after the win, roles revealed: ${endLine ? endLine.text.slice(0, 160) : 'no narration after the win'}`);
    const thoughts = watched.filter(e => e.type === 'thought');
    ok(thoughts.length > 0 && thoughts.every(e => e.audience === 'watcher' && /keep my own counsel/.test(e.text)), `the seats thought through think as each night ended, so the relay waited on them (#111): ${thoughts.length} thoughts`);
    console.log(`  game budget: players $${v.game.players.spent} of $${v.game.players.budget}, Storyteller $${v.game.storyteller.spent} of $${v.game.storyteller.budget}`);
    ok(v.game.players.spent > 0 && v.game.storyteller.spent > 0, 'the game budget counts the players\' and the Storyteller\'s spend apart');

    console.log('the logs');
    const logs = join(env.AGENT_LOGS, 'runners'), files = readdirSync(logs).filter(f => f.endsWith('.log'));
    const text = Object.fromEntries(files.map(f => [f, readFileSync(join(logs, f), 'utf8')]));
    const turnLines = Object.fromEntries(files.map(f => [f, text[f].split('\n').filter(l => /\[turn \d+\]/.test(l))]));
    // A turn line is completed (its cost line: "| ctx 3k | turn $x | run $y", the local loop's "(local)" line) or says why it is
    // not ("| cut: stopped, reported spend" when a stop ends a turn in flight, "| failed: <error>", the local loop's "failed").
    // Completed turns must carry the cost; interrupted ones must say why; any other shape fails and is printed.
    const COST = /\| ctx \d+k \| turn \$\d+\.\d+ \| run \$\d+\.\d+/, WHY = /\| (?:cut|failed): \S/;
    const show = l => l.replace(/^\[[\d:]+\] /, '').slice(0, 220);
    for (let id = 1; id <= 7; id++) {const f = `player-${id}.log`, t = turnLines[f] || [];
      const local = id === OLLAMA_SEAT, done = t.filter(l => local ? /\(local\)/.test(l) : !WHY.test(l)), cut = t.filter(l => !done.includes(l));
      const bad = local ? cut.filter(l => !/\] failed \| run \$/.test(l)) : [...done.filter(l => !COST.test(l)), ...cut.filter(l => !COST.test(l))];
      ok(done.length > 0 && !bad.length, `seat #${id}: ${done.length} completed turns, each with its cost line${local ? ' (local)' : ' and the session size'}${cut.length ? `; ${cut.length} cut short, each saying why (${cut.map(l => (l.match(/\| (?:cut|failed): [^|]*/) || ['failed'])[0].replace(/^\| /, '')).join('; ')})` : ''}${bad.length ? '\n         offending: ' + bad.map(show).join('\n         offending: ') : done[0] ? ': ' + show(done[0]).slice(0, 140) : ''}`)}
    const stTurns = turnLines['storyteller.log'] || [];
    ok(stTurns.some(l => /scripted/.test(l)) && stTurns.some(l => /\| ctx \d+k/.test(l)), `the Storyteller played turns with its mind and then scripted (${stTurns.length} turns)`);
    ok(Object.values(text).some(t => /\[session rolled/.test(t)), 'a session rolled before its price line');
    const turns = jsonl(join(env.BEHAVIOR_DIR, 'clocktower', 'turns.jsonl')), counted = v.runners.reduce((n, r) => n + r.turns, 0);
    const allTurnLines = Object.values(turnLines).reduce((n, t) => n + t.filter(l => !/\] failed \| run \$/.test(l)).length, 0); // the local loop writes no behavior line for a turn that failed outright
    ok(turns.length > 0 && turns.length === allTurnLines, `the behavior log has one line per turn (${turns.length} lines, ${allTurnLines} turn lines in the runner logs, ${counted} counted by the supervisor)`);
    // a turn that began after the win (3 s for the win's own poll); the Storyteller's one turn that narrates the end is owed (#90)
    const endTurn = t => t.seat === 'storyteller' && t.wake && /^narrate: the end/.test(t.wake.why || '');
    const late = turns.filter(t => Date.parse(t.ts) - (t.seconds || 0) * 1000 > tWin + 3000 && !endTurn(t));
    ok(!late.length, `no turn begins after the game is over${late.length ? ': ' + late.map(t => t.seat + (t.player ? ' #' + t.player : '') + ' ' + t.ts).join(', ') : ''}`);
    const empty = turns.filter(t => !(t.brief && typeof t.brief.text === 'string' && t.brief.text.trim()));
    ok(!empty.length, `every turn played from a non-empty header${empty.length ? ': ' + empty.length + ' without' : ''}`);
    const ev = jsonl(join(logs, 'events.jsonl'));
    ok(ev.some(e => e.event === 'budget' && e.key === 'player:' + DEAR_SEAT) && ev.some(e => e.event === 'pause'), 'the events log has the budget stop and the pause');
    // the report (#98): one finished game, told apart by the id every log line carries, numbers that agree with the logs
    const rep = splitGames(loadData(env.BEHAVIOR_DIR, env.AGENT_LOGS)).map(measure);
    ok(rep.length === 1 && !!rep[0].id && turns.every(t => t.gameId === rep[0].id), `the behavior report finds one game and every turn line carries its id (${rep.map(r => r.id).join(', ')})`);
    // #100: the relay logs the game's own public events to game.jsonl, once each, and the report's winner and counts come from them
    const gl = jsonl(join(env.BEHAVIOR_DIR, 'clocktower', 'game.jsonl')).filter(e => e.src === 'event'), winLine = gl.find(e => e.type === 'win');
    ok(!!winLine && winLine.team === look.winner && winLine.gameId === (rep[0] || {}).id && !!winLine.ts && Number.isFinite(winLine.id), `game.jsonl has the win line (${winLine ? winLine.team + ', event ' + winLine.id : 'none'}) with the game id and a timestamp`);
    const evIds = gl.map(e => e.id);
    ok(new Set(evIds).size === evIds.length && ['night', 'dawn', 'say', 'nomination', 'vote-result'].every(k => gl.some(e => e.type === k)), `every event is logged once (${gl.length} events: ${[...new Set(gl.map(e => e.type))].join(', ')})`);
    ok(!!rep[0] && rep[0].fromLog === true && rep[0].winner === winLine.team && /game log/.test(renderTable(rep)), 'the report reads the winner and the counts from the game log');
    const M = rep[0] || {};
    ok(M.winner === look.winner && M.turns && M.turns.all === turns.length && M.leaks && M.leaks.textLeaks + M.leaks.roleHits === 0 && M.talk && M.talk.lines > 0,
      `and its numbers agree: winner ${M.winner}, ${M.turns && M.turns.all} turns, ${M.talk && M.talk.lines} lines, ${M.leaks ? M.leaks.textLeaks + M.leaks.roleHits : '?'} leaks, ${M.refused && M.refused.total} refused calls`);
    if (rep.length) console.log(renderTable(rep).split('\n').map(l => '    ' + l.slice(0, 200)).join('\n'));
    const sum = `mock game seed ${SEED}: ${look.winner || 'no winner'}; ${turns.length} turns, ${turns.filter(t => t.provider === 'anthropic').length} by Claude (fake), ${turns.filter(t => t.provider === 'ollama').length} by Ollama (mock), ${turns.filter(t => t.provider === 'scripted').length} scripted; $${(v.game.players.spent + v.game.storyteller.spent).toFixed(4)} counted, $0 spent`;
    console.log('\n' + sum);
    completed = true;
  } finally {
    await Promise.race([R.stop(), sleep(10000)]); try {R.child.kill()} catch {}
    ol.close();
    if (fails || !completed) keepLogs(env);
  }
  console.log(fails ? `${fails} mock game check(s) failed` : 'mock game check: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
