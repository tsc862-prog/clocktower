// Voice timing check (`npm run voicetimingcheck`): clips made on say, and the game waiting for the ear (issue #50, part 4), against a
// mock speech engine, no network.
//   1. The backend's pace (fake clock): a page that reported (voice on, fresh) and lags more than one spoken line holds a seat's soft
//      wake ({wake: null, holdMs}); heard catching up releases it; a decision is never held; no page, voice false and a stale report
//      never hold; one seat is held no more than 30 s.
//   2. Over the relay with the mock engine: a line said gets {type: 'clip', id, clip: {id, ms}} on the page's socket and the clip on
//      GET /play/watch (the audio plays back); the Storyteller's lines use the Storyteller's voice; POST /play/heard is the page's alone
//      and moves the mark; /tts/status carries {clipsOnSay, heard}; with the engine off no clip is made.
import http from 'node:http';
import WebSocket from 'ws';
import {gameBackend, HOLD_CAP_MS, HEARD_FRESH_MS} from '../src/game/backend.js';
import {ST} from '../src/game/api.js';
import {quietEnv, req} from './relaycheck.mjs';
import {startRelay} from './relay.mjs';

let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; return !!c};
const PAGE = 'http://localhost:5173';
const sleep = t => new Promise(r => setTimeout(r, t));
const until = async (f, t = 5000, step = 50) => {const t0 = Date.now(); for (;;) {const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > t) return null; await sleep(step)}};
const AUDIO = Buffer.from('ID3-mock-audio-bytes-0123456789');

async function holds() {
  console.log('pace holds soft wakes while the page lags');
  let clock = 1000000, n = 0;
  const b = gameBackend({seed: 5, scripted: false, now: () => clock});
  try {
    const say = async k => {for (let i = 0; i < k; i++) await b.storytellerCall('narrate', {text: 'A line number ' + (++n)})};
    await say(3); // spoken events 12, 13, 14 (nothing is spoken before)
    const soft = id => b.pace(id, {realMs: 5, wake: 'all'});
    ok(b.heardMark() === null, 'no mark before a page reports');
    let r = await soft(1);
    ok(r.wake === 'soft', 'no page has reported: the soft wake is not held');
    await say(1);
    b.heard({last: 11, voice: true});
    r = await soft(2);
    ok(r.ok && r.wake === null && r.holdMs > 0 && r.holdMs <= 2000, `a page 4 lines behind with its voice on: seat 2's soft wake is held (holdMs ${r.holdMs})`);
    r = await soft(2); ok(r.wake === null, 'and held again on the next poll');
    b.heard({last: 14, voice: true});
    r = await soft(2);
    ok(r.wake === 'soft', 'heard within one line of the newest: released');
    await say(2);
    r = await soft(3); ok(r.wake === null && r.holdMs > 0, 'two lines ahead again: held');
    const p = b.pace(3, {realMs: 5, wake: 'all'}); await sleep(30); b.heard({last: 100, voice: true}); r = await p;
    ok(r.wake === 'soft' || r.wake === 'heartbeat', 'a heard report ends a hold at once');
    b.heard({last: 11, voice: false});
    r = await soft(4); ok(r.wake === 'soft', 'voice false (page muted or off): not held');
    b.heard({last: 11, voice: true}); clock += HEARD_FRESH_MS + 1000;
    r = await soft(5); ok(r.wake === 'soft', 'a report older than 90 s (page closed): not held');
    clock += 1; b.heard({last: 11, voice: true});
    const d = await b.pace(ST, {realMs: 5, wake: 'all'});
    ok(d.wake === 'now', `a decision waits on the Storyteller: wake ${d.wake}, not held`);
    b.heard({last: 11, voice: true});
    const first = await soft(6); ok(first.wake === null, 'seat 6 is held to begin with');
    clock += HOLD_CAP_MS - 1000; b.heard({last: 11, voice: true});
    r = await soft(6); ok(r.wake === null && r.holdMs <= 1000, `near the cap the hold shrinks to what is left (holdMs ${r.holdMs})`);
    clock += 1500; b.heard({last: 11, voice: true});
    r = await soft(6); ok(r.wake === 'soft', `past ${HOLD_CAP_MS / 1000} s of holding the seat is woken anyway`);
  } finally {b.close()}
}

async function mockEngine() {
  const speech = [];
  const server = http.createServer((q, r) => {
    if (q.method === 'GET' && q.url === '/v1/audio/voices') {r.writeHead(200, {'content-type': 'application/json'}); return r.end(JSON.stringify({voices: ['af_heart', 'bm_daniel', 'bf_emma']}))}
    if (q.method === 'POST' && q.url === '/v1/audio/speech') {let b = ''; q.on('data', c => b += c); q.on('end', () => {speech.push(JSON.parse(b)); r.writeHead(200, {'content-type': 'audio/mpeg'}); r.end(AUDIO)}); return}
    r.writeHead(404); r.end();
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  return {url: 'http://127.0.0.1:' + server.address().port, speech, close: () => new Promise(res => server.close(res))};
}

async function relay(env, fn) {
  const lines = [], R = startRelay({env, argv: ['node', 'relay.mjs', '--play-only', '--no-behavior', '--game', '--seed', '5'], port: 0, log: l => lines.push(String(l))});
  const port = await R.ready, base = `http://127.0.0.1:${port}`;
  try {await fn(base, R, lines)} finally {R.sup.killAll(); await new Promise(res => {R.server.close(() => res()); setTimeout(res, 500).unref()})}
}
const narrate = (base, text) => req(base, '/play/storyteller', {method: 'POST', body: {runner: 'vt-st', tool: 'narrate', args: {text}}});
const claim = base => req(base, '/play/claim', {method: 'POST', body: {role: 'storyteller', runner: 'vt-st'}});
const json = r => r; // req() already parses the body
const page = async base => {
  const sock = new WebSocket(base.replace(/^http/, 'ws') + '/play', {origin: PAGE}), got = [];
  await new Promise((res, rej) => {sock.once('open', res); sock.once('error', rej)});
  sock.on('message', d => {try {got.push(JSON.parse(String(d)))} catch {}});
  return {sock, got};
};

async function wire() {
  const mock = await mockEngine();
  try {
    console.log('clips made on say, over the relay');
    await relay(await quietEnv({TTS_URL: mock.url}), async base => {
      await until(async () => (await json(await req(base, '/tts/status', {origin: PAGE}))).ok);
      ok((await claim(base)).status === 200, 'the Storyteller claims its seat');
      const {sock, got} = await page(base);
      const text = 'The bell tolls, clip ' + Date.now() + '.';
      ok((await narrate(base, text)).status === 200, 'the Storyteller narrates a line');
      const push = await until(async () => got.find(m => m.type === 'watch' && m.events.some(e => e.text === text)));
      ok(!!push, 'the push carries the line at once (never held for the clip)');
      const id = push && push.events.find(e => e.text === text).id;
      const c = await until(async () => got.find(m => m.type === 'clip' && m.id === id));
      ok(!!c && /^[0-9a-f]{24}$/.test(c.clip.id) && Number.isFinite(c.clip.ms), `then a clip message {type: 'clip', id, clip: {id, ms}} (${c ? JSON.stringify(c.clip) : 'none'})`);
      ok(mock.speech.some(s => s.input === text && s.voice === 'bm_daniel' && s.speed === 0.95), "the engine was asked in the Storyteller's voice and speed");
      const w = await json(await req(base, '/play/watch', {origin: PAGE})), ev = w.events.find(e => e.id === id);
      ok(ev && ev.clip && c && ev.clip.id === c.clip.id, 'GET /play/watch carries the clip on the event');
      const audio = await fetch(base + '/tts?id=' + c.clip.id, {headers: {origin: PAGE}});
      ok(audio.status === 200 && Buffer.from(await audio.arrayBuffer()).equals(AUDIO), 'the clip id plays back from GET /tts?id=');
      const k = mock.speech.length; await sleep(200);
      ok(mock.speech.length === k, 'no second request for the same line');
      ok(!w.events.some(e => e.type === 'whisper' && e.clip), 'no clip on a whisper');

      console.log('the heard mark and the status');
      const s0 = await json(await req(base, '/tts/status', {origin: PAGE}));
      ok(s0.clipsOnSay === true && s0.heard === null, '/tts/status: clipsOnSay true, heard null before a report');
      const h0 = await req(base, '/play/heard', {method: 'POST', body: {last: id, voice: true}}), h1 = await req(base, '/play/heard', {method: 'POST', body: {last: id, voice: true}, origin: 'http://evil.example'});
      ok(h0.status === 403 && h1.status === 403, 'POST /play/heard: no Origin and another origin are refused (403)');
      const bad = await req(base, '/play/heard', {method: 'POST', body: {voice: true}, origin: PAGE});
      ok(bad.status === 400, 'POST /play/heard without last is 400');
      const h = await req(base, '/play/heard', {method: 'POST', body: {last: id, voice: true}, origin: PAGE}), hb = h;
      ok(h.status === 200 && hb.ok && hb.heard.last === id && hb.heard.voice === true && typeof hb.heard.at === 'number', 'the page reports: the backend keeps {last, at, voice}');
      ok(h.headers.get('access-control-allow-origin') === PAGE, "and the page's origin gets CORS");
      const s1 = await json(await req(base, '/tts/status', {origin: PAGE}));
      ok(s1.clipsOnSay === true && s1.heard && s1.heard.last === id && s1.heard.voice === true, '/tts/status carries heard {last, at, voice}');
      sock.close();
    });

    console.log('engine off: no clips');
    await relay(await quietEnv({TTS_URL: mock.url, RELAY_TTS: '0'}), async base => {
      await claim(base);
      const {sock, got} = await page(base);
      const n = mock.speech.length, text = 'A quiet line ' + Date.now() + '.';
      await narrate(base, text);
      ok(await until(async () => got.find(m => m.type === 'watch' && m.events.some(e => e.text === text))), 'the push still carries the line');
      await sleep(400);
      ok(!got.some(m => m.type === 'clip') && mock.speech.length === n, 'no clip message and the engine is not asked');
      const s = await json(await req(base, '/tts/status', {origin: PAGE}));
      ok(s.clipsOnSay === false, '/tts/status: clipsOnSay false');
      sock.close();
    });
  } finally {await mock.close()}
}

async function main() {
  console.log('\nvoice timing check\n');
  await holds(); await wire();
  console.log(fails ? `\nvoicetimingcheck: ${fails} failed` : '\nvoicetimingcheck: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
