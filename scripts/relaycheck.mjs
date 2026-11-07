// Relay check: the real relay script with no key and no network (`npm run relaycheck`). It starts `scripts/relay.mjs --play-only`
// on a free port and proves:
//   1. GET /health lists every provider (none reached, no key) and the eight seats: seven players and the Storyteller.
//   2. A runner claims a player seat and `look` answers (plain JSON and MCP); a second runner is refused with 409, for the claim
//      and for the seat's tools.
//   3. Seats stay apart: a runner holding a player has no Storyteller tools and cannot take the Storyteller seat; the Storyteller's
//      runner has no player tools; a request with a browser Origin drives no seat.
//   4. GET /play/runner answers the page's origin (with CORS) and refuses any other origin; a local request gets no output lines.
//      The page's WebSocket opens for the page's origin only.
//   5. "stop" on stdin (the launcher's quit) stops it cleanly.
//   6. --game --seed 3 --scripted serves a game: Odette's and the Storyteller's look answer, Odette's pace brief is her own
//      header, and nothing Odette is given names another seat's role.
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {spawn} from 'node:child_process';
import net from 'node:net';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {mkTmp, tmpEnv} from './tmp.mjs';
import {ms} from './ci-clock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'http://localhost:5173';
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const sleep = t => new Promise(r => setTimeout(r, t));
export const freePort = () => new Promise((res, rej) => {const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => {const p = s.address().port; s.close(() => res(p))})});
// The environment a check gives the relay: no key of any provider, Ollama at a closed port, logs and temp under a fresh folder.
export async function quietEnv(extra = {}) {
  const env = {...process.env, ...tmpEnv()};
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'RELAY_RUNNERS', 'RELAY_TTS', 'AGENT_PROVIDER']) delete env[k];
  const logs = mkTmp('relaycheck-');
  return {...env, OLLAMA_URL: 'http://127.0.0.1:' + await freePort(), AGENT_LOGS: logs, BEHAVIOR_DIR: join(logs, 'behavior'), ...extra};
}
// Start the relay script; resolves once it listens. -> {child, base, out: [lines], stop()}
export async function startRelayProcess(args = [], env = {}) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`, out = [];
  const child = spawn(process.execPath, ['scripts/relay.mjs', '--launcher', ...args], {cwd: ROOT, env: {...env, RELAY_PORT: String(port)}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const take = d => {for (const l of String(d).split(/\r?\n/)) if (l.trim()) out.push(l)};
  child.stdout.on('data', take); child.stderr.on('data', take);
  const exited = new Promise(r => child.on('exit', (code, sig) => r({code, sig})));
  const t0 = Date.now();
  while (!out.some(l => /\[relay\] listening on/.test(l))) {if (child.exitCode != null || Date.now() - t0 > 20000) throw new Error('the relay did not start:\n' + out.join('\n')); await sleep(50)}
  return {child, base, out, exited, stop: () => {try {child.stdin.write('stop\n')} catch {}; return exited}};
}
export const req = (base, path, {method = 'GET', body, origin, headers = {}} = {}) => fetch(base + path, {method, headers: {...(body ? {'content-type': 'application/json'} : {}), ...(origin ? {origin} : {}), ...headers}, ...(body ? {body: JSON.stringify(body)} : {})})
  .then(async r => ({status: r.status, headers: r.headers, ...(await r.json().catch(() => ({})))}));
const mcp = (base, method, params, headers) => fetch(base + '/mcp', {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})}).then(async r => ({status: r.status, ...(await r.json().catch(() => ({})))}));

async function main() {
  const env = await quietEnv();
  const R = await startRelayProcess(['--play-only'], env), {base} = R;
  try {
    console.log('health');
    const h = await req(base, '/health');
    const names = Object.keys(h.providers || {});
    ok(h.ok && ['anthropic', 'ollama', 'openai', 'huggingface', 'google'].every(n => names.includes(n)), `GET /health lists the providers (${names.join(', ')})`);
    ok(names.every(n => h.providers[n].ok === false), 'with no key and no Ollama no provider is reached, and each says why: ' + names.map(n => `${n}: ${String(h.providers[n].error || '').slice(0, 40)}`).join('; '));
    ok(h.providers.anthropic && /no ANTHROPIC_API_KEY/.test(h.providers.anthropic.error || ''), 'Claude says plainly that there is no key');
    const seats = (h.seats && h.seats.players || []).length + (h.seats && h.seats.storyteller ? 1 : 0);
    ok(seats === 8 && h.seats.players.map(p => p.name).join(',') === 'Odette,Bram,Ines,Corwin,Thea,Fitch,Yusuf', `eight seats: ${(h.seats.players || []).map(p => p.name).join(', ')} and the Storyteller`);
    ok(!R.out.some(l => /sk-|api[_-]?key=/i.test(l)), 'the relay printed no key');

    console.log('claims');
    const c1 = await req(base, '/play/claim', {method: 'POST', body: {player: 1, runner: 'A', provider: 'ollama', model: 'mock-tools:1b'}});
    ok(c1.status === 200 && c1.player && c1.player.name === 'Odette', 'runner A claims seat #1 (Odette)');
    const look = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'A', tool: 'look', args: {}}});
    ok(look.status === 200 && look.phase === 'no game yet' && Array.isArray(look.seats), "the seat's look answers: " + JSON.stringify({phase: look.phase, seats: look.seats}));
    const list = await mcp(base, 'tools/list', {}, {'x-clocktower-player': '1', 'x-clocktower-runner': 'A'});
    ok(list.status === 200 && list.result && list.result.tools.some(t => t.name === 'look'), 'over MCP the seat lists its tools (look)');
    const mlook = await mcp(base, 'tools/call', {name: 'look', arguments: {}}, {'x-clocktower-player': '1', 'x-clocktower-runner': 'A'});
    ok(mlook.status === 200 && /no game yet/.test(JSON.stringify(mlook.result || {})), 'over MCP look answers the stub');
    const c2 = await req(base, '/play/claim', {method: 'POST', body: {player: 1, runner: 'B'}});
    ok(c2.status === 409, 'a second runner claiming seat #1 is refused with 409');
    const b1 = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'B', tool: 'look', args: {}}});
    ok(b1.status === 409 && b1.refused, "a second runner calling seat #1's tools is refused with 409");
    const bm = await mcp(base, 'tools/call', {name: 'look', arguments: {}}, {'x-clocktower-player': '1', 'x-clocktower-runner': 'B'});
    ok(/played by another runner/.test(JSON.stringify(bm.result || {})), "over MCP too, seat #1 answers only its own runner");
    const hp = await req(base, '/play/health');
    ok(hp.players.find(p => p.id === 1).claimed && hp.players.find(p => p.id === 1).runner.provider === 'ollama', '/play/health shows the seat held and its mind');

    console.log('seats stay apart');
    const st1 = await req(base, '/play/storyteller', {method: 'POST', body: {runner: 'A', tool: 'look', args: {}}});
    ok(st1.status === 403, 'a runner holding a player cannot call the Storyteller route (403)');
    const stm = await mcp(base, 'tools/list', {}, {'x-clocktower-role': 'storyteller', 'x-clocktower-runner': 'A'});
    ok(stm.status === 403, 'nor reach the Storyteller tools over MCP (403)');
    const stc = await req(base, '/play/claim', {method: 'POST', body: {role: 'storyteller', runner: 'A'}});
    ok(stc.status === 409, 'nor take the Storyteller seat (one runner, one seat)');
    const sc = await req(base, '/play/claim', {method: 'POST', body: {role: 'storyteller', runner: 'S', provider: 'ollama'}});
    ok(sc.status === 200, 'runner S takes the Storyteller seat');
    const sl = await req(base, '/play/storyteller', {method: 'POST', body: {runner: 'S', tool: 'look', args: {}}});
    ok(sl.status === 200 && sl.phase === 'no game yet', "the Storyteller's look answers the stub");
    const sp = await req(base, '/play/call', {method: 'POST', body: {player: 2, runner: 'S', tool: 'look', args: {}}});
    ok(sp.status === 403, 'the Storyteller runner has no player tools (403)');
    const sc2 = await req(base, '/play/claim', {method: 'POST', body: {role: 'storyteller', runner: 'T'}});
    ok(sc2.status === 409, 'a second Storyteller runner is refused with 409');
    const sp2 = await req(base, '/play/claim', {method: 'POST', body: {player: 2, runner: 'S'}});
    ok(sp2.status === 409, 'the Storyteller runner cannot also claim a player seat');
    const bo = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'A', tool: 'look', args: {}}, origin: PAGE});
    ok(bo.status === 403, 'a request with a browser Origin drives no seat, the page included (403)');
    const rel = await req(base, '/play/release', {method: 'POST', body: {player: 1, runner: 'A'}});
    const c3 = await req(base, '/play/claim', {method: 'POST', body: {player: 1, runner: 'B'}});
    ok(rel.status === 200 && c3.status === 200, 'once A lets go, B may take the seat');

    console.log('the page');
    const rp = await req(base, '/play/runner', {origin: PAGE});
    ok(rp.status === 200 && rp.headers.get('access-control-allow-origin') === PAGE && rp.enabled === false && /--runners/.test(rp.how || ''), 'GET /play/runner answers the page (CORS), runners off, and says how to turn them on');
    const ro = await req(base, '/play/runner', {origin: 'http://evil.example'});
    ok(ro.status === 403, 'GET /play/runner refuses any other origin (403)');
    const rl = await req(base, '/play/runner');
    ok(rl.status === 200 && !rl.headers.get('access-control-allow-origin') && (rl.runners || []).every(r => !r.lines || !r.lines.length), 'a local request gets the states without CORS and without output lines');
    const ho = await req(base, '/health', {origin: 'http://evil.example'});
    ok(ho.status === 403, 'GET /health refuses another origin');
    const wsOpen = origin => new Promise(res => {const ws = new WebSocket(base.replace('http', 'ws') + '/play', {headers: {origin}}); const t = setTimeout(() => {ws.terminate(); res({open: false})}, ms(4000, 800));
      ws.on('open', () => ws.once('message', m => {clearTimeout(t); ws.close(); res({open: true, msg: JSON.parse(String(m))})})); ws.on('error', () => {clearTimeout(t); res({open: false})}); ws.on('unexpected-response', () => {clearTimeout(t); res({open: false})})});
    const wp = await wsOpen(PAGE);
    ok(wp.open && wp.msg && wp.msg.type === 'links' && wp.msg.links['1'] && wp.msg.storyteller, "the page's WebSocket opens and gets the seats' links");
    const we = await wsOpen('http://evil.example');
    ok(!we.open, 'the WebSocket refuses another origin');

    console.log('stop');
    const t0 = Date.now(), ex = await Promise.race([R.stop(), sleep(ms(15000, 4000)).then(() => null)]);
    ok(ex && ex.code === 0, `"stop" on stdin quits cleanly (exit ${ex ? ex.code : 'none'} in ${Date.now() - t0} ms)`);
  } finally {try {R.child.kill()} catch {}}
  await gameCase();
  console.log(fails ? `${fails} relay check(s) failed` : 'relay check: all ok');
  process.exit(fails ? 1 : 0);
}
// 6. a seeded game behind the relay (src/game/backend.js)
async function gameCase() {
  console.log('a game behind the relay');
  const {newGame} = await import('../src/game/index.js');
  const api = await import('../src/game/api.js');
  const deal = newGame({seed: 3});
  // What a seat may hear of roles: its own, and any named in what it was told (seed 3 deals Odette the Spy, who sees the
  // grimoire, so Bram is checked too).
  const foreign = (i, said) => deal.seats.filter(s => s.index !== i).map(s => deal.script.roles.find(r => r.id === s.role))
    .filter(r => r.id !== deal.seats[i].role && !api.view(deal, i).told.some(t => t.text.includes(r.name)))
    .filter(r => said.includes(r.name) || said.includes('"' + r.id + '"'));
  const env = await quietEnv();
  const R = await startRelayProcess(['--play-only', '--game', '--seed', '3', '--scripted'], env), {base} = R;
  try {
    ok(R.out.some(l => /serving a game: seed 3, scripted/.test(l)), 'the relay says it serves game seed 3 with the scripted Storyteller');
    const h = await req(base, '/play/health');
    ok(h.players && h.players.map(p => p.name).join(',') === deal.seats.map(s => s.name).join(','), "its seats are the game's seats");
    const c = await req(base, '/play/claim', {method: 'POST', body: {player: 1, runner: 'G1'}});
    const sc = await req(base, '/play/claim', {method: 'POST', body: {role: 'storyteller', runner: 'GS'}});
    ok(c.status === 200 && sc.status === 200, 'a runner claims Odette and another the Storyteller');
    const look = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'G1', tool: 'look', args: {}}});
    const slook = await req(base, '/play/storyteller', {method: 'POST', body: {runner: 'GS', tool: 'look', args: {}}});
    ok(look.status === 200 && look.ok !== false && slook.status === 200 && slook.ok !== false, 'look answers for Odette and for the Storyteller');
    const brief = await req(base, '/play/pace', {method: 'POST', body: {player: 1, runner: 'G1', brief: true}});
    ok(brief.status === 200 && brief.ok && /Odette/.test(JSON.stringify(brief.brief)), "pace {brief: true} answers with Odette's header");
    const leaked = foreign(0, JSON.stringify([look, brief]));
    ok(!leaked.length, "nothing Odette is given names another seat's role beyond what she was told" + (leaked.length ? ": " + leaked.map(r => r.name).join(", ") : ""));
    const cb = await req(base, '/play/claim', {method: 'POST', body: {player: 2, runner: 'G2'}});
    const blook = await req(base, '/play/call', {method: 'POST', body: {player: 2, runner: 'G2', tool: 'look', args: {}}});
    const bbrief = await req(base, '/play/pace', {method: 'POST', body: {player: 2, runner: 'G2', brief: true}});
    const bl = foreign(1, JSON.stringify([blook, bbrief]));
    ok(cb.status === 200 && blook.status === 200 && bbrief.ok && !bl.length, "nor does anything Bram is given" + (bl.length ? ": " + bl.map(r => r.name).join(", ") : ""));
  } finally {await Promise.race([R.stop(), sleep(ms(15000, 4000))]); try {R.child.kill()} catch {}}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => {console.error(e); process.exit(1)});
