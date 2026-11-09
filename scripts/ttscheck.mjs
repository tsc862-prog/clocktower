// Voice check: the relay's narrator voice against a mock speech engine, no network (`npm run ttscheck`). Proves:
//   1. RELAY_TTS unset and an engine answering: on by the start-up probe, "voice engine found (N voices)" in the relay's output,
//      /tts/status lists the voices (and the seat voice map when src/data/voices.js exists).
//   2. RELAY_TTS unset and nothing answering: off with the hint; /tts/say is refused (503).
//   3. RELAY_TTS=0 forces off even with an engine answering; RELAY_TTS=1 forces on (an engine that starts later is used).
//   4. POST /tts/say then GET /tts?id=<id> round-trips the audio bytes; the second say is cached (the engine is asked once).
//   5. The page's origin only: another origin is refused (403), the page's origin gets CORS.
import http from 'node:http';
import {quietEnv, startRelayProcess, req, freePort} from './relaycheck.mjs';

let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const PAGE = 'http://localhost:5173';
const VOICES = ['af_heart', 'bf_emma', 'am_adam'];
const AUDIO = Buffer.from('ID3-mock-audio-bytes-0123456789');

async function mockEngine(port = 0) {
  const speech = [];
  const server = http.createServer((q, r) => {
    if (q.method === 'GET' && q.url === '/v1/audio/voices') {r.writeHead(200, {'content-type': 'application/json'}); return r.end(JSON.stringify({voices: VOICES}))}
    if (q.method === 'POST' && q.url === '/v1/audio/speech') {let b = ''; q.on('data', c => b += c); q.on('end', () => {speech.push(JSON.parse(b)); r.writeHead(200, {'content-type': 'audio/mpeg'}); r.end(AUDIO)}); return}
    r.writeHead(404); r.end();
  });
  await new Promise(res => server.listen(port, '127.0.0.1', res));
  return {url: 'http://127.0.0.1:' + server.address().port, speech, close: () => new Promise(res => server.close(res))};
}
const sleep = t => new Promise(r => setTimeout(r, t));
const until = async (f, t = 15000) => {const t0 = Date.now(); while (Date.now() - t0 < t) {const v = await f(); if (v) return v; await sleep(100)} return null};

async function main() {
  const mock = await mockEngine();
  try {
    console.log('on by probe');
    let R = await startRelayProcess(['--play-only'], await quietEnv({TTS_URL: mock.url}));
    try {
      ok(await until(() => R.out.some(l => /voice engine found \(3 voices\)/.test(l))), 'the relay says: voice engine found (3 voices)');
      const s = await req(R.base, '/tts/status', {origin: PAGE});
      ok(s.status === 200 && s.ok === true && s.voices.join() === VOICES.join(), "GET /tts/status: ok with the engine's voices");
      ok(s.seatVoices === undefined || (s.seatVoices && typeof s.seatVoices === 'object'), 'seatVoices is absent or the map from src/data/voices.js');
      const text = 'The bell tolls for ' + Date.now() + '.';
      const say = await req(R.base, '/tts/say', {method: 'POST', body: {text, voice: 'bf_emma'}, origin: PAGE});
      ok(say.status === 200 && /^[0-9a-f]{24}$/.test(say.id) && say.cached === false, 'POST /tts/say makes a clip');
      const clip = await fetch(R.base + '/tts?id=' + say.id, {headers: {origin: PAGE}});
      const bytes = Buffer.from(await clip.arrayBuffer());
      ok(clip.status === 200 && /audio\/mpeg/.test(clip.headers.get('content-type')) && bytes.equals(AUDIO), 'GET /tts?id returns the audio bytes');
      ok(mock.speech.length === 1 && mock.speech[0].voice === 'bf_emma' && mock.speech[0].input === text, 'the engine was asked once, with the voice and the text');
      const again = await req(R.base, '/tts/say', {method: 'POST', body: {text, voice: 'bf_emma'}, origin: PAGE});
      ok(again.status === 200 && again.id === say.id && again.cached === true && mock.speech.length === 1, 'the same line is cached: same id, the engine is not asked again');
      const bad = await fetch(R.base + '/tts?id=' + '0'.repeat(24), {headers: {origin: PAGE}});
      ok(bad.status === 404, 'an unknown clip id is 404');
      const other = await req(R.base, '/tts/status', {origin: 'http://evil.example'});
      ok(other.status === 403, 'another origin is refused (403)');
      ok(clip.headers.get('access-control-allow-origin') === PAGE, "the page's origin gets CORS on the audio");
    } finally {await R.stop()}

    console.log('off when nothing answers');
    R = await startRelayProcess(['--play-only'], await quietEnv({TTS_URL: 'http://127.0.0.1:' + await freePort()})); // a port bound and released: nothing listens
    try {
      // the relay's own status, polled until the start-up probe has decided (not a log line)
      let s = null; await until(async () => (s = await req(R.base, '/tts/status', {origin: PAGE})).enabled === false);
      ok(s && s.status === 200 && s.enabled === false && s.ok === false && /Kokoro/.test(s.hint || ''), '/tts/status: off, with the hint');
      ok(R.out.some(l => /voice engine not found/.test(l)), 'the relay also says so');
      const say = await req(R.base, '/tts/say', {method: 'POST', body: {text: 'Hello.'}, origin: PAGE});
      ok(say.status === 503, '/tts/say is refused (503)');
    } finally {await R.stop()}

    console.log('forced off');
    R = await startRelayProcess(['--play-only'], await quietEnv({TTS_URL: mock.url, RELAY_TTS: '0'}));
    try {
      ok(await until(() => R.out.some(l => /voice engine off \(RELAY_TTS=0\)/.test(l))), 'RELAY_TTS=0: off, though an engine answers');
      const s = await req(R.base, '/tts/status', {origin: PAGE});
      ok(s.status === 200 && s.enabled === false && s.ok === false, '/tts/status says off');
      const before = mock.speech.length;
      const say = await req(R.base, '/tts/say', {method: 'POST', body: {text: 'Nope.'}, origin: PAGE});
      ok(say.status === 503 && mock.speech.length === before, '/tts/say is refused and the engine is not asked');
    } finally {await R.stop()}

    console.log('forced on, the engine comes later');
    const port = await freePort();
    R = await startRelayProcess(['--play-only'], await quietEnv({TTS_URL: 'http://127.0.0.1:' + port, RELAY_TTS: '1'}));
    let late = null;
    try {
      ok(await until(() => R.out.some(l => /forced on .*not answering/.test(l))), 'RELAY_TTS=1 with no engine: on anyway, says it is not answering');
      late = await mockEngine(port);
      const s = await req(R.base, '/tts/status', {origin: PAGE});
      ok(s.ok === true && s.voices.length === 3, 'the engine started later is picked up');
    } finally {await R.stop(); if (late) await late.close()}
  } finally {await mock.close()}
  console.log(fails ? `\nttscheck: ${fails} failed` : '\nttscheck: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
