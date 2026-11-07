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
//   - the game reaches a winner.
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {startMockOllama} from './mock-ollama.mjs';
import {quietEnv, startRelayProcess, req} from './relaycheck.mjs';
import {ms} from './ci-clock.mjs';

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
    AGENT_MAX_FAILS: '50', RUNNER_CLAUDE_MAX: '8', SESSION_ROLL_TOKENS: '6000', GAME_BUDGET: '5'});
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
    const v = await view();
    await req(base, '/play/runner/stop-all', {method: 'POST', origin: PAGE, body: {why: 'the check is done'}});
    const look = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'mockgamecheck', tool: 'look', args: {}}});
    ok(!!look.winner, `a winner: ${look.winner || 'none'}`);
    console.log(`  game budget: players $${v.game.players.spent} of $${v.game.players.budget}, Storyteller $${v.game.storyteller.spent} of $${v.game.storyteller.budget}`);
    ok(v.game.players.spent > 0 && v.game.storyteller.spent > 0, 'the game budget counts the players\' and the Storyteller\'s spend apart');

    console.log('the logs');
    const logs = join(env.AGENT_LOGS, 'runners'), files = readdirSync(logs).filter(f => f.endsWith('.log'));
    const text = Object.fromEntries(files.map(f => [f, readFileSync(join(logs, f), 'utf8')]));
    const turnLines = Object.fromEntries(files.map(f => [f, text[f].split('\n').filter(l => /\[turn \d+\]/.test(l))]));
    for (let id = 1; id <= 7; id++) {const f = `player-${id}.log`, t = turnLines[f] || [];
      ok(t.length > 0 && (id === OLLAMA_SEAT || t.every(l => /\| ctx \d+k \| turn \$\d+\.\d+ \| run \$\d+\.\d+/.test(l))), `seat #${id}: ${t.length} turns, each with its cost line${id === OLLAMA_SEAT ? ' (local)' : ' and the session size'}${t[0] ? ': ' + t[0].replace(/^\[[\d:]+\] /, '').slice(0, 140) : ''}`)}
    const stTurns = turnLines['storyteller.log'] || [];
    ok(stTurns.some(l => /scripted/.test(l)) && stTurns.some(l => /\| ctx \d+k/.test(l)), `the Storyteller played turns with its mind and then scripted (${stTurns.length} turns)`);
    ok(Object.values(text).some(t => /\[session rolled/.test(t)), 'a session rolled before its price line');
    const turns = jsonl(join(env.BEHAVIOR_DIR, 'clocktower', 'turns.jsonl')), counted = v.runners.reduce((n, r) => n + r.turns, 0);
    const allTurnLines = Object.values(turnLines).reduce((n, t) => n + t.length, 0);
    ok(turns.length > 0 && turns.length === allTurnLines, `the behavior log has one line per turn (${turns.length} lines, ${allTurnLines} turn lines in the runner logs, ${counted} counted by the supervisor)`);
    const empty = turns.filter(t => !(t.brief && typeof t.brief.text === 'string' && t.brief.text.trim()));
    ok(!empty.length, `every turn played from a non-empty header${empty.length ? ': ' + empty.length + ' without' : ''}`);
    const ev = jsonl(join(logs, 'events.jsonl'));
    ok(ev.some(e => e.event === 'budget' && e.key === 'player:' + DEAR_SEAT) && ev.some(e => e.event === 'pause'), 'the events log has the budget stop and the pause');
    const sum = `mock game seed ${SEED}: ${look.winner || 'no winner'}; ${turns.length} turns, ${turns.filter(t => t.provider === 'anthropic').length} by Claude (fake), ${turns.filter(t => t.provider === 'ollama').length} by Ollama (mock), ${turns.filter(t => t.provider === 'scripted').length} scripted; $${(v.game.players.spent + v.game.storyteller.spent).toFixed(4)} counted, $0 spent`;
    console.log('\n' + sum);
  } finally {
    await Promise.race([R.stop(), sleep(10000)]); try {R.child.kill()} catch {}
    ol.close();
  }
  console.log(fails ? `${fails} mock game check(s) failed` : 'mock game check: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
