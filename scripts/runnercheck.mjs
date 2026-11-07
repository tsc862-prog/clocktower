// Runner check: the runner supervisor (scripts/runners.mjs) and the seat runner (scripts/seat-runner.mjs) with mock providers, no
// key and no network (`npm run runnercheck`).
//   1. The start rules: kinds, providers, model names, budget caps, one runner per seat, at most eight; the command line never
//      carries a key and carries a turn cap only when one is asked.
//   2. No turn cap anywhere by default: every kind's default maxTurns is null, the pacing's turnCap is Infinity without --max-turns,
//      and no script gives --max-turns a default.
//   3. End to end on the real relay script with --runners and a mock Ollama: the page starts a local runner for a seat, it claims
//      the seat, warms up and plays turns (state, turns, provider/model, log file), the events log gets its start line, a stop from
//      the page ends it and lets go of the seat, and the end goes to the events log.
//   4. A budget stop with a mock OpenAI (a paid mind): the runner stops itself when its spend reaches the dollar budget, the
//      supervisor marks it spent and logs it, and resume() does not bring it back.
//   5. The Storyteller runner is refused plainly until it exists.
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkStart, runnerArgs, RUNNER_KINDS, MAX_RUNNERS} from './runners.mjs';
import {turnCap} from './pacing.mjs';
import {startMockOllama} from './mock-ollama.mjs';
import {startMockOpenAI, KEY} from './mock-openai.mjs';
import {quietEnv, startRelayProcess, req} from './relaycheck.mjs';
import {ms} from './ci-clock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'http://localhost:5173';
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const sleep = t => new Promise(r => setTimeout(r, t));
const until = async (f, t = 30000, step = 150) => {const t0 = Date.now(); for (;;) {const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > t) return null; await sleep(step)}};
const lines = f => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

console.log('start requests');
{
  const ps = [{id: 1, name: 'Odette', alive: true}, {id: 2, name: 'Bram', alive: false}];
  const c = checkStart({player: 1}, ps);
  ok(c.req && c.req.key === 'player:1' && c.req.maxTurns === null && c.req.budget === 1, 'a player runner keeps $1.00 and no turn cap');
  const l = checkStart({player: '1', provider: 'ollama', model: 'qwen2.5:14b'}, ps);
  ok(l.req && l.req.budget === null && l.req.maxTurns === null, 'a local runner has no budget and no turn cap');
  ok(checkStart({player: 1, provider: 'openai', model: 'gpt-6-luna'}, ps).req.budget === 1, 'an OpenAI runner is paid: it keeps a budget');
  ok(checkStart({player: 9}, ps).code === 404 && checkStart({player: 2}, ps).code === 409 && checkStart({}, ps).code === 400, 'unknown, out-of-the-game and missing seats are refused');
  ok(checkStart({player: 1, provider: 'x;rm'}, ps).code === 400 && checkStart({player: 1, model: '--env=x'}, ps).code === 400 && checkStart({player: 1, model: 'a b'}, ps).code === 400, 'providers from the list only; model names plain');
  ok(checkStart({player: 1, budget: 5.01}, ps).code === 400 && checkStart({player: 1, budget: 0}, ps).code === 400 && checkStart({player: 1, maxTurns: 1.5}, ps).code === 400, 'budgets and an asked turn cap are checked');
  ok(checkStart({kind: 'shell'}, ps).code === 400, 'unknown runner kinds are refused');
  ok(checkStart({player: 1}, ps, {running: [{key: 'player:1'}]}).code === 409, 'one runner per seat');
  ok(MAX_RUNNERS === 8 && checkStart({player: 1}, ps, {running: Array.from({length: 8}, (_, i) => ({key: 'x' + i}))}).code === 429, 'at most eight runners: seven players and the Storyteller');
  const args = runnerArgs({...c.req, provider: 'openai', model: 'gpt-6-luna'}, 'http://127.0.0.1:8787');
  ok(args.join(' ') === 'scripts/seat-runner.mjs --url http://127.0.0.1:8787 --player 1 --budget 1 --provider openai --model gpt-6-luna', 'the command line: script, url, seat, budget, provider, model; no key: ' + args.join(' '));
  ok(runnerArgs({...l.req, maxTurns: 40}, 'u').join(' ').includes('--max-turns 40') && !args.includes('--max-turns'), 'a turn cap goes on the command line only when asked');
  ok(checkStart({kind: 'storyteller'}, ps).code === 501, 'the Storyteller runner is refused plainly until it is installed: ' + checkStart({kind: 'storyteller'}, ps).error);
}

console.log('no turn cap by default');
{
  ok(Object.values(RUNNER_KINDS).every(K => K.defaults.maxTurns === null), 'every runner kind defaults to no turn cap');
  ok(turnCap(undefined) === Infinity && turnCap(null) === Infinity && turnCap('') === Infinity && turnCap('5') === 5, 'pacing: turnCap is Infinity unless --max-turns is given');
  const bad = [];
  for (const f of ['runners.mjs', 'seat-runner.mjs', 'pacing.mjs', 'local-agent.mjs', 'relay.mjs']) {
    const t = readFileSync(join(ROOT, 'scripts', f), 'utf8');
    if (/opt\(\s*['"]max-turns['"]\s*,\s*(?!null\b)[^)\s]/.test(t) || /['"]--max-turns['"]\s*,\s*['"]?\d/.test(t) || /defaults:\s*\{[^}]*maxTurns:\s*\d/.test(t)) bad.push(f);
  }
  ok(!bad.length, `no script gives --max-turns a default${bad.length ? ': ' + bad.join(', ') : ''}`);
}

async function e2e() {
  const ol = await startMockOllama(), oa = await startMockOpenAI();
  const env = await quietEnv({OLLAMA_URL: ol.url, OPENAI_BASE_URL: oa.url, OPENAI_API_KEY: KEY, AGENT_POLL_MS: String(ms(1500, 200)), AGENT_MIN_GAP: '0', AGENT_PROVIDER: 'ollama'});
  const R = await startRelayProcess(['--play-only', '--runners'], env), {base} = R;
  const events = join(env.AGENT_LOGS, 'runners', 'events.jsonl');
  try {
    console.log('a local runner, start to stop');
    const s = await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 3, provider: 'ollama', model: 'mock-tools:1b'}});
    ok(s.status === 200 && s.runner && s.runner.key === 'player:3' && s.runner.budget === null, 'the page starts a local runner for Ines (#3): no budget');
    const view = () => req(base, '/play/runner', {origin: PAGE}).then(r => (r.runners || []).find(x => x.key === 'player:3'));
    const played = await until(async () => {const v = await view(); return v && v.turns >= 2 ? v : null}, ms(40000, 15000));
    ok(!!played, `it plays turns (${played ? played.turns : 0} so far, state ${played ? played.state : '?'})`);
    if (played) {
      ok(['live', 'waiting'].includes(played.state) && played.provider === 'ollama' && played.model === 'mock-tools:1b', `state ${played.state}, mind ${played.provider} ${played.model}`);
      ok(played.cost === 0 && played.turnCap === 'until stopped', 'costs nothing and plays until stopped');
      ok(existsSync(join(ROOT, played.log)) || existsSync(join(env.AGENT_LOGS, 'runners', 'player-3.log')), 'its output goes to its log file');
    }
    const h = await req(base, '/play/health');
    const seat = (h.players || []).find(p => p.id === 3);
    ok(seat && seat.claimed && seat.ready === 'ready', `the seat is claimed and warmed up (ready: ${seat && seat.ready})`);
    ok(ol.seen.warm >= 1 && ol.seen.length >= 3, `the mock Ollama saw the warm-up and the turns (${ol.seen.length} chats)`);
    ok(lines(events).some(e => e.event === 'start' && e.key === 'player:3' && e.by === 'page'), 'the events log has the start, by the page');
    const local = await req(base, '/play/runner');
    ok(((local.runners || []).find(x => x.key === 'player:3') || {lines: ['x']}).lines.length === 0, 'a local request sees the runner without its output lines');
    const st = await req(base, '/play/runner/stop', {method: 'POST', origin: PAGE, body: {player: 3}});
    ok(st.status === 200, 'the page stops it');
    const gone = await until(async () => {const v = await view(); return v && v.state === 'stopped' ? v : null}, ms(15000, 8000));
    ok(!!gone && gone.endWhy && /stopped/.test(gone.endWhy), `it ends cleanly (${gone ? gone.state + ', ' + gone.endWhy : 'still running'})`);
    const h2 = await until(async () => {const x = await req(base, '/play/health'); const p = x.players.find(p => p.id === 3); return p && !p.claimed ? x : null}, ms(8000, 3000));
    ok(!!h2, 'and lets go of the seat');
    ok(lines(events).some(e => e.event === 'end' && e.key === 'player:3' && e.by === 'owner'), 'the events log has the end, by the owner');

    console.log('a budget stop (paid mind)');
    const b = await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 4, provider: 'openai', model: 'gpt-6-astra', budget: 0.01}});
    ok(b.status === 200 && b.runner.budget === 0.01, 'the page starts an OpenAI runner for Corwin (#4) with a $0.01 budget');
    const spent = await until(async () => {const r = await req(base, '/play/runner', {origin: PAGE}); const v = (r.runners || []).find(x => x.key === 'player:4'); return v && v.state === 'stopped' ? v : null}, ms(40000, 15000));
    ok(!!spent && spent.budgetSpent && spent.endWhy === 'budget reached', `it stops itself at the budget (${spent ? spent.turns + ' turn(s), $' + spent.cost + ', ' + spent.endWhy : 'still running'})`);
    ok(!!spent && spent.cost >= 0.01, 'its spend reached the budget');
    ok(lines(events).some(e => e.event === 'budget' && e.key === 'player:4' && e.why === 'budget reached'), 'the events log has the budget stop');
    ok(oa.problems.length === 0, `the mock OpenAI saw well-formed chats${oa.problems.length ? ': ' + oa.problems.join('; ') : ''}`);
    const active = JSON.parse(readFileSync(join(env.AGENT_LOGS, 'runners', 'active.json'), 'utf8'));
    ok(!(active.runners || []).some(x => x.player === 4) && (active.spent || []).some(x => x.key === 'player:4'), 'it left the active list and is kept as spent, so a restart does not start it again');
    ok(!R.out.concat(readFileSync(join(env.AGENT_LOGS, 'runners', 'player-4.log'), 'utf8').split('\n')).some(l => l.includes(KEY)), 'no key in the relay output or the runner log');

    console.log('the Storyteller');
    const sr = await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {kind: 'storyteller'}});
    ok(sr.status === 501 && /not installed/.test(sr.error || ''), 'a Storyteller runner start says it is not installed yet');
  } finally {
    await Promise.race([R.stop(), sleep(8000)]); try {R.child.kill()} catch {}
    ol.close(); oa.close();
  }
}
await e2e().catch(e => {console.error(e); fails++});
console.log(fails ? `${fails} runner check(s) failed` : 'runner check: all ok');
process.exit(fails ? 1 : 0);
