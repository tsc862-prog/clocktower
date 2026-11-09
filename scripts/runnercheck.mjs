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
//   5. The game budget: a runner with no budget asked gets its share of GAME_BUDGET ($5: the Storyteller's 30% set apart, the
//      players' 70% split seven ways); a Claude player seat runs scripts/agent-seat.mjs, any other mind scripts/seat-runner.mjs; the
//      Storyteller runner is installed, and its scripted fallback has no budget.
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkStart, runnerArgs, RUNNER_KINDS, MAX_RUNNERS, gameShares, defaultBudgets} from './runners.mjs';
import {turnCap, makePacer, storytellerDueNow} from './pacing.mjs';
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
  ok(c.req && c.req.key === 'player:1' && c.req.maxTurns === null && c.req.budget === 0.5, `a player runner keeps its share of the $5 game ($${c.req && c.req.budget}) and no turn cap`);
  const l = checkStart({player: '1', provider: 'ollama', model: 'qwen2.5:14b'}, ps);
  ok(l.req && l.req.budget === null && l.req.maxTurns === null, 'a local runner has no budget and no turn cap');
  ok(checkStart({player: 1, provider: 'openai', model: 'gpt-6-luna'}, ps).req.budget === 0.5, 'an OpenAI runner is paid: it keeps a budget');
  ok(checkStart({player: 9}, ps).code === 404 && checkStart({player: 2}, ps).code === 409 && checkStart({}, ps).code === 400, 'unknown, out-of-the-game and missing seats are refused');
  ok(checkStart({player: 1, provider: 'x;rm'}, ps).code === 400 && checkStart({player: 1, model: '--env=x'}, ps).code === 400 && checkStart({player: 1, model: 'a b'}, ps).code === 400, 'providers from the list only; model names plain');
  ok(checkStart({player: 1, budget: 5.01}, ps).code === 400 && checkStart({player: 1, budget: 0}, ps).code === 400 && checkStart({player: 1, maxTurns: 1.5}, ps).code === 400, 'budgets and an asked turn cap are checked');
  ok(checkStart({kind: 'shell'}, ps).code === 400, 'unknown runner kinds are refused');
  ok(checkStart({player: 1}, ps, {running: [{key: 'player:1'}]}).code === 409, 'one runner per seat');
  ok(MAX_RUNNERS === 8 && checkStart({player: 1}, ps, {running: Array.from({length: 8}, (_, i) => ({key: 'x' + i}))}).code === 429, 'at most eight runners: seven players and the Storyteller');
  const args = runnerArgs({...c.req, provider: 'openai', model: 'gpt-6-luna'}, 'http://127.0.0.1:8787');
  ok(args.join(' ') === 'scripts/seat-runner.mjs --url http://127.0.0.1:8787 --player 1 --budget 0.5 --provider openai --model gpt-6-luna', 'the command line: script, url, seat, budget, provider, model; no key: ' + args.join(' '));
  ok(runnerArgs({...l.req, maxTurns: 40}, 'u').join(' ').includes('--max-turns 40') && !args.includes('--max-turns'), 'a turn cap goes on the command line only when asked');
  const g = gameShares(), sr = checkStart({kind: 'storyteller'}, ps).req;
  ok(g.storyteller === 1.5 && g.player === 0.5 && sr && sr.budget === 1.5, `the game budget: $${g.total} with the Storyteller's $${g.storyteller} set apart, $${g.player} for each player`);
  const b2 = defaultBudgets({GAME_BUDGET: '10'}), b3 = defaultBudgets({RUNNER_BUDGET: '0.2'});
  ok(b2.storyteller === 3 && b2.player === 1 && b3.player === 0.2 && b3.storyteller === 0.2, 'GAME_BUDGET moves both shares; RUNNER_BUDGET sets every runner');
  ok(runnerArgs({...c.req, claude: true}, 'u')[0] === 'scripts/agent-seat.mjs' && runnerArgs({...l.req}, 'u')[0] === 'scripts/seat-runner.mjs', 'a Claude seat runs the Agent SDK runner, a local one the local loop');
  const pc = checkStart({player: 1, minGap: 60, heartbeat: '360'}, ps);
  ok(pc.req && pc.req.minGap === 60 && pc.req.heartbeat === 360 && runnerArgs(pc.req, 'u').join(' ').endsWith('--min-gap 60 --heartbeat 360') && !args.includes('--min-gap'), 'the pace knob reaches the command line as --min-gap and --heartbeat, and only when asked');
  ok([{minGap: 4}, {minGap: 601}, {minGap: 'x'}, {heartbeat: 9}, {heartbeat: 1441}].every(x => checkStart({player: 1, ...x}, ps).code === 400) && checkStart({player: 1, minGap: 5, heartbeat: 1440}, ps).req, 'minGap 5 to 600 and heartbeat 10 to 1440 only');
  const sc = checkStart({kind: 'storyteller', scripted: true}, ps).req;
  ok(sc && sc.budget === null && runnerArgs(sc, 'u').join(' ') === 'scripts/storyteller-runner.mjs --url u --scripted', 'the scripted Storyteller has no budget: ' + (sc ? runnerArgs(sc, 'u').join(' ') : ''));
}

console.log('a live pace change reaches the pacer');
{
  const sent = [], logs = [];
  let answer = {ok: true, wake: null};
  const fetchImpl = async (u, o) => {sent.push(JSON.parse(o.body)); return {status: 200, json: async () => answer}};
  const pc = makePacer({base: 'http://x', player: 1, runner: 'r', minGap: 20, heartbeat: 120, pollMs: 10, fetchImpl, log: l => logs.push(l), stopped: () => sent.length >= 3});
  await pc.next();
  ok(sent[0].minGap === 20 && sent[0].heartbeat === 120, 'the pacer sends its minGap and heartbeat with each pace poll');
  answer = {ok: true, wake: null, pace: {minGap: 45, heartbeat: 300}};
  const p2 = makePacer({base: 'http://x', player: 1, runner: 'r', minGap: 20, heartbeat: 120, pollMs: 10, fetchImpl, log: l => logs.push(l), stopped: () => sent.length >= 6});
  await p2.next(); sent.length = 5; await p2.next();
  ok(sent[sent.length - 1].minGap === 45 && sent[sent.length - 1].heartbeat === 300 && logs.some(l => /min gap now 45/.test(l)), 'a pace answer with overrides is adopted and sent back on the next poll');
}

console.log('the Storyteller is played only when something is due (#91)');
{
  const asked = [], post = answer => async (path, body) => {asked.push({path, body}); if (answer instanceof Error) throw answer; return answer};
  ok(await storytellerDueNow(post({ok: true, due: 'nothing', dueTool: null})) === null, 'nothing due: null, so a soft wake ends with no model call');
  ok(asked[0].path === '/play/storyteller' && asked[0].body.tool === 'look', 'it asks the Storyteller\'s own look tool (a free read)');
  const d = await storytellerDueNow(post({ok: true, due: 'the end of the game is not yet narrated', dueTool: 'narrate'}));
  ok(d && d.tool === 'narrate' && /end of the game/.test(d.why), 'a narration owed: {tool, why}');
  ok(await storytellerDueNow(post({ok: true, phase: 'no game yet'})) === undefined && await storytellerDueNow(post(new Error('down'))) === undefined, 'an older relay or an error: undefined, so the turn is played as before');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'claude-runner.mjs'), 'utf8');
  ok(/st && w\.wake !== 'now'[\s\S]{0,200}storytellerDueNow[\s\S]{0,120}due === null/.test(src) && /lastTurn = true/.test(src), 'the Claude runner skips a soft wake with nothing due and plays one last turn for the end');
}

console.log('no turn cap by default');
{
  ok(Object.values(RUNNER_KINDS).every(K => K.defaults.maxTurns === null), 'every runner kind defaults to no turn cap');
  ok(turnCap(undefined) === Infinity && turnCap(null) === Infinity && turnCap('') === Infinity && turnCap('5') === 5, 'pacing: turnCap is Infinity unless --max-turns is given');
  const bad = [];
  for (const f of ['runners.mjs', 'seat-runner.mjs', 'pacing.mjs', 'local-agent.mjs', 'relay.mjs', 'claude-runner.mjs', 'agent-seat.mjs', 'storyteller-runner.mjs']) {
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

    console.log('the pace knob');
    ok((await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 5, provider: 'ollama', model: 'mock-tools:1b', minGap: 3}})).status === 400
      && (await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 5, provider: 'ollama', model: 'mock-tools:1b', heartbeat: 5000}})).status === 400, 'a start with minGap 3 or heartbeat 5000 is refused');
    const ps = await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 5, provider: 'ollama', model: 'mock-tools:1b', minGap: 5, heartbeat: 30}});
    ok(ps.status === 200 && ps.runner.paceNow.minGap === 5 && ps.runner.paceNow.heartbeat === 30, 'a start with the knob shows pace {minGap, heartbeat} in the runner view');
    const log5 = join(env.AGENT_LOGS, 'runners', 'player-5.log');
    const argv = await until(async () => {const t = readFileSync(log5, 'utf8'); return /--min-gap 5 --heartbeat 30/.test(t) ? t : null}, ms(10000, 5000));
    ok(!!argv, 'the runner process got --min-gap 5 --heartbeat 30 on its command line');
    const lv = await req(base, '/play/runner/limits', {method: 'POST', origin: PAGE, body: {key: 'player:5', minGap: 9, heartbeat: 45}});
    ok(lv.status === 200 && lv.runner.paceNow.minGap === 9 && lv.runner.paceNow.heartbeat === 45, 'a live change shows in the view at once');
    ok((await req(base, '/play/runner/limits', {method: 'POST', origin: PAGE, body: {key: 'player:5', minGap: 1}})).status === 400, 'a live change out of range is refused');
    const adopted = await until(async () => {const t = readFileSync(log5, 'utf8'); return /min gap now 9 s/.test(t) && /heartbeat now 45 game min/.test(t)}, ms(20000, 10000));
    ok(!!adopted, 'the runner adopts the new pace at its next poll (its log says so)');
    await req(base, '/play/runner/stop', {method: 'POST', origin: PAGE, body: {player: 5}});

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
    const sr = await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {kind: 'storyteller', provider: 'anthropic'}});
    const ended = sr.status === 200 && await until(async () => {const r = await req(base, '/play/runner', {origin: PAGE}); const v = (r.runners || []).find(x => x.key === 'storyteller'); return v && v.state !== 'starting' && (v.state === 'crashed' || v.state === 'stopped') ? v : null}, ms(20000, 10000));
    ok(!!ended && /No ANTHROPIC_API_KEY/.test(ended.error || ''), `with no key the Claude Storyteller runner starts and says plainly why it cannot play (${ended ? ended.error : sr.error})`);
  } finally {
    await Promise.race([R.stop(), sleep(8000)]); try {R.child.kill()} catch {}
    ol.close(); oa.close();
  }
}
// #66: a seat's model session belongs to one dealt game. On one relay (--game, fake Agent SDK whose sessions outlive the process):
// the same game restarted resumes its session (the context carries on); a new game (POST /play/game/new) starts every runner on a
// fresh session id at a small context, its log says "new game <id>: fresh session", and the active list carries the game id; a
// runner left running across a new deal rolls to a fresh session at its next wake.
async function sessions() {
  console.log('one session per dealt game');
  const env = await quietEnv({CLOCKTOWER_FAKE_SDK: 'scripts/fake-agent-sdk.mjs', AGENT_PROVIDER: 'anthropic', AGENT_MIN_GAP: '1', AGENT_POLL_MS: String(ms(1000, 300))});
  const R = await startRelayProcess(['--play-only', '--runners', '--game', '--scripted', '--grace', '150', '--seed', '5'], env), {base} = R;
  const log1 = join(env.AGENT_LOGS, 'runners', 'player-1.log'), sessFile = join(env.AGENT_LOGS, 'agents', '1.json');
  const text = () => existsSync(log1) ? readFileSync(log1, 'utf8') : '';
  const turnCtx = t => [...t.matchAll(/\[turn \d+\][^\n]*\| ctx (\d+)k/g)].map(m => Number(m[1]));
  const sess = () => JSON.parse(readFileSync(sessFile, 'utf8'));
  const view = () => req(base, '/play/runner', {origin: PAGE}).then(r => (r.runners || []).find(x => x.key === 'player:1'));
  // #125: a seat sleeps through the night, so a seat is started once the scripted Storyteller has carried the game to day (polled, not timed)
  const toDay = () => until(async () => (await req(base, '/play/watch?since=0', {origin: PAGE})).phase === 'day', ms(60000, 30000), 100);
  const start = async () => {ok(!!(await toDay()), 'the game is at day 1 before the seat starts'); return req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 1}})};
  const stopIt = async () => {await req(base, '/play/runner/stop', {method: 'POST', origin: PAGE, body: {player: 1}}); return until(async () => {const v = await view(); return v && v.state === 'stopped' ? v : null}, ms(15000, 8000))};
  // the log after text offset `from`, once it has n turn lines
  const turnsAfter = (from, n) => until(async () => {const t = text().slice(from); return turnCtx(t).length >= n ? t : null}, ms(40000, 20000));
  try {
    const g1 = (await req(base, '/play/health')).gameId;
    ok(typeof g1 === 'string' && /^5-\d{8}T\d{6}Z$/.test(g1), `the relay deals game ${g1}`);
    ok((await start()).status === 200, 'Odette starts on Claude (fake SDK)');
    const run1 = await turnsAfter(0, 3);
    const s1 = run1 && sess();
    ok(!!run1 && /new session \(game /.test(run1) && s1.sessionId && s1.gameId === g1, `she plays on a new session ${s1 && s1.sessionId} for game ${s1 && s1.gameId}`);
    const c1 = turnCtx(run1 || '');
    ok(c1.length >= 3 && c1.at(-1) > c1[0], `her context grows as she plays (${c1.join('k, ')}k)`);
    ok(!!(await stopIt()), 'stopped');

    const at2 = text().length;
    ok((await start()).status === 200, 'started again on the same game');
    const run2 = await turnsAfter(at2, 1), c2 = turnCtx(run2 || '');
    ok(!!run2 && run2.includes('resuming session ' + s1.sessionId) && sess().sessionId === s1.sessionId, 'the same game id resumes her session');
    ok(c2.length && c2[0] > c1[0], `and the context carries on (${c2[0]}k against ${c1[0]}k at her first turn)`);
    ok(!!(await stopIt()), 'stopped');

    const ng = await req(base, '/play/game/new', {method: 'POST', origin: PAGE, body: {seed: 5}}), g2 = (await req(base, '/play/health')).gameId;
    ok(ng.status === 200 && g2 === ng.gameId && g2 !== g1 && /^5-/.test(g2), `a new game: ${g2}`);
    const at3 = text().length;
    ok((await start()).status === 200, 'Odette starts on the new game');
    const run3 = await turnsAfter(at3, 1), c3 = turnCtx(run3 || ''), s3 = sess();
    ok(!!run3 && run3.includes(`new game ${g2}: fresh session`) && /new session \(game /.test(run3) && !run3.includes('resuming session'), `her log says "new game ${g2}: fresh session" and starts a new session`);
    ok(s3.sessionId && s3.sessionId !== s1.sessionId && s3.gameId === g2, `a fresh session id (${s3.sessionId}, not ${s1.sessionId}) kept under game ${s3.gameId}`);
    ok(c3.length && c3[0] <= c1[0], `at a small context again (${c3[0]}k, as her first turn of the first game: ${c1[0]}k)`);
    const active = JSON.parse(readFileSync(join(env.AGENT_LOGS, 'runners', 'active.json'), 'utf8'));
    ok(active.gameId === g2 && (active.runners || []).some(x => x.player === 1 && x.gameId === g2), `the active list carries the game id (${active.gameId})`);

    const at4 = text().length, ng3 = await req(base, '/play/game/new', {method: 'POST', origin: PAGE, body: {seed: 5}});
    const run4 = await until(async () => {const t = text().slice(at4); return t.includes(`new game ${ng3.gameId}: fresh session`) && turnCtx(t).length >= 1 ? t : null}, ms(40000, 20000));
    ok(!!run4 && sess().gameId === ng3.gameId && sess().sessionId !== s3.sessionId, `a runner left running across a new deal rolls to a fresh session at its next wake (game ${ng3.gameId})`);
    await stopIt();
  } finally {await Promise.race([R.stop(), sleep(8000)]); try {R.child.kill()} catch {}}
}

await e2e().catch(e => {console.error(e); fails++});
await sessions().catch(e => {console.error(e); fails++});
console.log(fails ? `${fails} runner check(s) failed` : 'runner check: all ok');
process.exit(fails ? 1 : 0);
