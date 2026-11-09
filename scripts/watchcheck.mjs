// Watch check (`npm run watchcheck`): the watcher's routes the page reads, with no key and no network.
//   1. Origins: GET /play/watch and POST /play/game/new answer the page's origin only (no Origin and any other Origin: 403; the page's
//      preflight: 204 with CORS); /play/health answers local tools and the page (with CORS), and refuses any other Origin; a seat's
//      routes still refuse the page.
//   2. The watch body against a seeded game (seed 5) played by eight fake runners to day 1 with a whisper said: every field the page
//      reads (the recorded frame's keys, src/ui/fixtures/game.json) with the same types, canNewGame, the whisper with its text, the
//      seats' told lines, ids in order and `last` the newest; `since` returns only what came after, nothing past `last`, and a
//      `since` past the end of the game (a new game began) reads from the start.
//   3. A new game over the wire: POST /play/game/new {seed, rounds} replaces the game (seed, rounds and events from id 0 in the watch),
//      every seat claim stays with its runner, a claimed runner plays on and a stranger is still refused.
//   2b. The live push: the page's WebSocket gets {type: 'watch', seed, last, events, clock, pending, ballot, phase, day, night, winner}
//      within a second of a seat's line said through the relay, with that line among its events, in the watch body's shapes.
//   4. A runner's last turn: the supervisor (--runners) starts a Claude seat on the fake Agent SDK; its runner view carries
//      lastTurn {wake, at, cost, header, tools: [{tool, args, ok}]} for the page's origin and none for a local request.
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {relayGame, table} from './channelcheck.mjs';
import {quietEnv, startRelayProcess, req} from './relaycheck.mjs';
import {ms} from './ci-clock.mjs';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'http://localhost:5173', EVIL = 'http://evil.example';
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; return !!c};
const sleep = t => new Promise(r => setTimeout(r, t));
const until = async (f, t, step = 200) => {const t0 = Date.now(); for (;;) {const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > t) return null; await sleep(step)}};
const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

async function watcher() {
  const R = await relayGame(['--game', '--seed', '5']), {base, backend} = R;
  try {
    console.log('origins');
    const get = (path, origin) => req(base, path, {origin});
    const w0 = await get('/play/watch'), w1 = await get('/play/watch', EVIL), w2 = await get('/play/watch', PAGE);
    ok(w0.status === 403 && w1.status === 403 && w2.status === 200, `/play/watch: no Origin ${w0.status}, another origin ${w1.status}, the page ${w2.status}`);
    ok(w2.headers.get('access-control-allow-origin') === PAGE, '/play/watch answers the page with CORS');
    const pre = await fetch(base + '/play/game/new', {method: 'OPTIONS', headers: {origin: PAGE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'}});
    ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === PAGE && /POST/.test(pre.headers.get('access-control-allow-methods') || ''), `the page's preflight for /play/game/new: ${pre.status}`);
    const n0 = await req(base, '/play/game/new', {method: 'POST', body: {seed: 5}}), n1 = await req(base, '/play/game/new', {method: 'POST', body: {seed: 5}, origin: EVIL});
    ok(n0.status === 403 && n1.status === 403, `/play/game/new: no Origin ${n0.status}, another origin ${n1.status}`);
    const h0 = await get('/play/health'), h1 = await get('/play/health', PAGE), h2 = await get('/play/health', EVIL);
    ok(h0.status === 200 && h1.status === 200 && h1.headers.get('access-control-allow-origin') === PAGE && h2.status === 403, `/play/health: local ${h0.status}, the page ${h1.status} with CORS, another origin ${h2.status}`);
    const c = await req(base, '/play/call', {method: 'POST', body: {player: 1, tool: 'look'}, origin: PAGE});
    ok(c.status === 403, `a seat's route still refuses the page (${c.status})`);

    console.log('the watch body');
    const T = await table({base, backend});
    await T.drive(g => g.phase === 'day' && g.clock.spoke.length >= 2);
    const g = backend.game, a = g.seats[0].name, b = g.seats[1].name;
    const wh = await T.call(0, 'whisper', {to: b, text: 'Watchmark: only we two hear this.'});
    ok(wh.ok, `${a} whispers to ${b}`);
    const w = await get('/play/watch', PAGE), frame = Object.values(JSON.parse(readFileSync(join(ROOT, 'src/ui/fixtures/game.json'), 'utf8')).frames)[0];
    const missing = Object.keys(frame).filter(k => !(k in w) || (frame[k] !== null && w[k] !== null && typeOf(frame[k]) !== typeOf(w[k])));
    ok(!missing.length, `every field of the recorded frame, same types (${Object.keys(frame).join(', ')})${missing.length ? ': missing or other type: ' + missing.join(', ') : ''}`);
    ok(w.canNewGame === true && w.seed === 5 && typeof w.rounds === 'number', `canNewGame, seed ${w.seed}, rounds ${w.rounds}`);
    const ws = w.events.find(e => e.type === 'whisper' && /Watchmark/.test(e.text || ''));
    ok(!!ws && ws.from === 0 && ws.to === 1, 'the whisper with its text and its two parties');
    const told = w.events.filter(e => e.type === 'told');
    ok(told.length >= g.seats.length && told.every(e => typeof e.text === 'string' && e.text && Number.isInteger(e.seat)), `every seat's told lines with their text (${told.length})`);
    const ids = w.events.map(e => e.id);
    ok(ids.every((x, i) => i === 0 || x > ids[i - 1]) && w.last === ids.at(-1) && w.last === g.log.at(-1).id, `events in id order, last ${w.last} the newest`);
    ok(w.grimoire && Array.isArray(w.grimoire.seats) && w.grimoire.seats.length === 7 && Array.isArray(w.nightOrder) && Array.isArray(w.rulings) && w.rulings.length > 0, 'the grimoire, the night order and the rulings');
    const mid = ids[Math.floor(ids.length / 2)], ws2 = await get(`/play/watch?since=${mid}`, PAGE);
    ok(ws2.events.length && ws2.events.every(e => e.id > mid) && ws2.events.length === ids.filter(x => x > mid).length, `since ${mid}: only the ${ws2.events.length} events after it`);
    const wl = await get(`/play/watch?since=${w.last}`, PAGE);
    ok(wl.events.length === 0 && wl.last === w.last, 'since the last id: nothing new');
    const wf = await get(`/play/watch?since=${w.last + 1000}`, PAGE);
    ok(wf.events.length === w.events.length && wf.events[0].id === 0, 'a since past the end of the game reads from the start');

    console.log('the live push');
    const sock = new WebSocket(base.replace(/^http/, 'ws') + '/play', {origin: PAGE}), got = [];
    await new Promise((res, rej) => {sock.once('open', res); sock.once('error', rej)});
    sock.on('message', d => {try {const m = JSON.parse(String(d)); if (m.type === 'watch') got.push({m, at: Date.now()})} catch {}});
    const gg = backend.game, who = gg.seats.find(x => x.alive && !gg.clock.spoke.includes(x.index)).index, line = 'Pushmark: the square hears this at once.';
    const t0 = Date.now(), said = await T.call(who, 'speak', {text: line});
    ok(said.ok, `${gg.seats[who].name} says a line through the relay`);
    const hit = await until(async () => got.find(x => x.m.events.some(e => e.type === 'say' && e.text === line)), 1500, 20);
    ok(!!hit && hit.at - t0 <= 1000, `the page's socket gets the line within a second (${hit ? hit.at - t0 + ' ms' : 'not at all'})`);
    if (hit) {
      const m = hit.m, wb = await get(`/play/watch?since=${m.events[0].id - 1}`, PAGE), keys = ['seed', 'last', 'events', 'clock', 'pending', 'ballot', 'phase', 'day', 'night', 'winner'];
      ok(keys.every(k => k in m) && keys.every(k => typeOf(m[k]) === typeOf(wb[k])), `the push carries ${keys.join(', ')}, in the watch body's types`);
      ok(JSON.stringify(m.events) === JSON.stringify(wb.events.filter(e => e.id <= m.last)) && m.last === Math.max(...m.events.map(e => e.id)), "its events are the watch body's events, the same shapes");
    }
    sock.close();

    console.log('a new game over the wire');
    const before = await get('/play/health');
    const ng = await req(base, '/play/game/new', {method: 'POST', body: {seed: 7, rounds: 2}, origin: PAGE});
    ok(ng.status === 200 && ng.ok && ng.seed === 7 && ng.rounds === 2, `POST /play/game/new {seed: 7, rounds: 2}: ${ng.status}`);
    const nw = await get('/play/watch', PAGE), h7 = await get('/play/health');
    ok(typeof before.gameId === 'string' && /^5-\d{8}T\d{6}Z/.test(before.gameId) && w.gameId === before.gameId, `the game id in /play/health and the watch body: ${before.gameId}`);
    ok(typeof ng.gameId === 'string' && /^7-\d{8}T\d{6}Z/.test(ng.gameId) && ng.gameId !== before.gameId && nw.gameId === ng.gameId && h7.gameId === ng.gameId, `a new game deals a new id (${ng.gameId}), in the answer, the watch body and /play/health`);
    const ng2 = await req(base, '/play/game/new', {method: 'POST', body: {seed: 7, rounds: 2}, origin: PAGE});
    ok(ng2.gameId && ng2.gameId !== ng.gameId, `the same seed dealt again in the same second is still a new id (${ng2.gameId})`);
    ok(nw.seed === 7 && nw.rounds === 2 && nw.events[0].id === 0 && nw.day === 0 && !nw.events.some(e => e.type === 'whisper'), 'the watch serves the new game from its first event');
    const after = await get('/play/health');
    ok(after.players.every(p => p.claimed) && after.storyteller.claimed && JSON.stringify(before.players.map(p => p.id)) === JSON.stringify(after.players.map(p => p.id)), 'every seat claim stays');
    const look = await T.call(0, 'look'), stranger = await req(base, '/play/call', {method: 'POST', body: {player: 1, runner: 'stranger', tool: 'look'}});
    ok(look.ok && look.day === 0 && stranger.status === 409, 'the seat\'s own runner plays on in the new game; a stranger is still refused');
    const bad = await req(base, '/play/game/new', {method: 'POST', body: {seed: 'x'}, origin: PAGE});
    ok(bad.status === 400, 'a bad seed is refused');
    T.stop();
  } finally {await R.close()}
}

async function lastTurn() {
  console.log("a runner's last turn");
  const env = await quietEnv({CLOCKTOWER_FAKE_SDK: 'scripts/fake-agent-sdk.mjs', AGENT_PROVIDER: 'anthropic', AGENT_MIN_GAP: '1'});
  const R = await startRelayProcess(['--play-only', '--runners', '--game', '--seed', '5'], env), {base} = R;
  try {
    const s = await req(base, '/play/runner/start', {method: 'POST', origin: PAGE, body: {player: 2}});
    ok(s.status === 200, 'the page starts a Claude seat on the fake Agent SDK');
    const v = await until(async () => {const r = await req(base, '/play/runner', {origin: PAGE}); const x = (r.runners || []).find(y => y.key === 'player:2'); return x && x.lastTurn ? x : null}, ms(30000, 15000));
    const lt = v && v.lastTurn;
    ok(!!lt && typeof lt.at === 'string' && Number.isFinite(lt.cost) && typeof lt.header === 'string' && lt.header.length > 0 && typeof lt.wake === 'string', `lastTurn: wake ${lt && lt.wake}, cost ${lt && lt.cost}, header ${lt && lt.header ? lt.header.length + ' chars' : 'none'}`);
    ok(!!lt && Array.isArray(lt.tools) && lt.tools.length > 0 && lt.tools.every(t => typeof t.tool === 'string' && t.args && typeof t.args === 'object' && typeof t.ok === 'boolean'), `its tool calls with their arguments: ${lt ? lt.tools.map(t => t.tool + JSON.stringify(t.args)).join(', ') : ''}`);
    const local = await req(base, '/play/runner'), lx = (local.runners || []).find(y => y.key === 'player:2');
    ok(lx && lx.lastTurn === null, 'a local request gets the runner without its last turn (the page only)');
  } finally {await Promise.race([R.stop(), sleep(10000)]); try {R.child.kill()} catch {}}
}

// #69: when nominations open the seats that may nominate are woken one at a time in seat order (the stagger), a seat that passes
// moves the next one up, a vote wakes every voter at once, and once the game is over every pace answers {ok: false, gone: true}.
async function nominationPace() {
  console.log('nominations in seat order, nothing after the end');
  const {gameBackend} = await import('../src/game/backend.js');
  const tools = [
    {name: 'speak', act: true, desc: 'speak', args: {}, handler: (a, ctx) => ({ok: true, ...ctx.api.say(ctx.game, ctx.seat.index, a.text)})},
    {name: 'pass', act: true, desc: 'pass', args: {}, handler: (a, ctx) => ({ok: true, ...ctx.api.pass(ctx.game, ctx.seat.index)})},
    {name: 'nominate', act: true, desc: 'nominate', args: {}, handler: (a, ctx) => ({ok: true, ...ctx.api.nominate(ctx.game, ctx.seat.index, a.target)})},
  ];
  let t = 1e12; const STAG = 5000;
  const be = gameBackend({seed: 3, players: tools, storyteller: [], scripted: true, grace: 5, now: () => t, stagger: STAG});
  try {
    let day = null; const t0 = Date.now();
    while (be.game.phase !== 'day' && Date.now() - t0 < 8000) day = await be.call(1, 'pace', {realMs: 200, wake: 'all'});
    ok(be.game.phase === 'day', `the scripted Storyteller carries the game to day 1 (${day && day.clock}, pending ${JSON.stringify(be.game.pending && be.game.pending.kind)})`);
    for (const r of [1, 2, 3]) for (let i = 1; i <= 7; i++) await be.call(i, 'speak', {text: `Round ${r} from seat ${i}.`});
    ok(be.game.clock.nominationsOpen && be.game.pending && be.game.pending.kind === 'nomination', 'after three rounds nominations open');
    const paceAll = async () => {const out = []; for (let i = 1; i <= 7; i++) out.push((await be.call(i, 'pace', {realMs: 20, wake: 'now'})).wake); return out};
    const w0 = await paceAll();
    ok(w0[0] === 'now' && w0.slice(1).every(w => w === null), `at the opening only the first seat wakes (${w0.join(', ')})`);
    const hb = await be.call(3, 'pace', {realMs: 20, wake: 'all'});
    ok(hb.ok && hb.wake === null, `a later seat gets no heartbeat or soft wake while it waits its moment (${hb.wake}: ${hb.why})`);
    t += STAG;
    const w1 = await paceAll();
    ok(w1[0] === 'now' && w1[1] === 'now' && w1.slice(2).every(w => w === null), `${STAG / 1000} s on the next seat wakes too (${w1.join(', ')})`);
    ok((await be.call(1, 'pass', {})).ok, 'the first seat passes on nominating');
    const w2 = await paceAll();
    ok(w2[0] === null && w2[1] === 'now' && w2[2] === 'now' && w2.slice(3).every(w => w === null), `a pass moves the next seat up (${w2.join(', ')})`);
    const target = be.game.seats[4].name, nom = await be.call(2, 'nominate', {target: 4});
    ok(nom.ok && be.game.pending && be.game.pending.kind === 'vote', `the second seat nominates ${target}: a vote opens${nom.ok ? '' : ' (' + nom.error + ')'}`);
    const w3 = await paceAll();
    ok(w3.every(w => w === 'now'), `a vote wakes every voter at once (${w3.join(', ')})`);
    be.game.winner = {team: 'good', text: 'good wins (the check ends the game)'};
    const ends = [], stEnd = await be.pace('storyteller', {realMs: 20, wake: 'all'});
    for (let i = 1; i <= 7; i++) ends.push(await be.call(i, 'pace', {realMs: 20, wake: 'all'}));
    ok(ends.every(r => r.ok === false && r.gone === true) && stEnd.ok === false && stEnd.gone === true, "once the game is over every pace, the Storyteller's too, answers {ok: false, gone: true} at once, with unseen events");
    const off = gameBackend({seed: 3, players: tools, storyteller: [], scripted: true, grace: 5});
    ok(off.gameId && off.gameId !== be.gameId && /^3-19700101T000000Z/.test(off.gameId), `a backend with no clock still deals an id (${off.gameId})`);
    off.close();
  } finally {be.close()}
}

// #74 with #69: an act due from the Storyteller (here the unnarrated dawn) wakes it now, never held for the voice, even while the
// page lags behind the spoken lines (a player's soft wake is held in the same moment).
async function storytellerDueWake() {
  console.log('a due Storyteller act wakes it now');
  const {gameBackend} = await import('../src/game/backend.js');
  const tools = [{name: 'speak', act: true, desc: 'speak', args: {}, handler: (a, ctx) => ({ok: true, ...ctx.api.say(ctx.game, ctx.seat.index, a.text)})}];
  const be = gameBackend({seed: 3, players: tools, storyteller: [], scripted: true, grace: 5, now: () => 1e12});
  try {
    be.setVoice({clip: async () => ({id: 'c', ms: 1})});
    const t0 = Date.now(); while (be.game.phase !== 'day' && Date.now() - t0 < 8000) await be.call(1, 'pace', {realMs: 200, wake: 'all'});
    await be.call(2, 'speak', {text: 'Bram, at first light.'}); await be.call(3, 'speak', {text: 'Ines, at first light.'});
    be.heard({last: -1, voice: true}); // the page has played nothing yet: several spoken lines behind
    const t1 = Date.now(), st = await be.pace('storyteller', {realMs: 20, wake: 'all'}), stMs = Date.now() - t1;
    ok(be.game.phase === 'day' && st.wake === 'now' && /narrate/.test(st.why) && stMs < 1000, `an unnarrated dawn wakes the Storyteller now while the page lags (${st.wake}: ${st.why}, ${stMs} ms)`);
    const p = await be.call(4, 'pace', {realMs: 20, wake: 'all'});
    ok(p.wake === null && p.holdMs > 0, `in the same moment a player's soft wake is held for the voice (${p.why})`);
  } finally {be.close()}
}

async function main() {
  console.log('\nClocktower watch check: the routes the page reads\n');
  await nominationPace();
  await storytellerDueWake();
  await watcher();
  await lastTurn();
  console.log(fails ? `\n${fails} watch check(s) failed` : '\nwatch check: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
