// The relay: the only place a model key lives besides the runners. It listens on 127.0.0.1:8787 and serves
//   GET  /health   {ok, model, providers: {anthropic: {ok, models}, ollama: {ok, url, models, numCtx}, openai, huggingface, google},
//                   seats: {players: [{id, name}], storyteller: true}, queues}: which minds can be reached, and the table's seats
//   /mcp, /play/*  the seats (scripts/relay-mcp.mjs): MCP and plain JSON tools, claims, pacing, readiness, behavior turns, and the
//                  watcher page's WebSocket
//   /play/runner*  the runner supervisor (scripts/runners.mjs): the page starts and stops runners (--runners or RELAY_RUNNERS=1)
//   /tts*          the local voice engine (scripts/providers/tts.mjs): probed at start, RELAY_TTS=0 off, =1 on
//
// Providers: scripts/providers/ (anthropic.mjs: Claude; ollama.mjs: local models at OLLAMA_URL, default http://localhost:11434,
// cost 0; openai.mjs: OpenAI Chat Completions and the Hugging Face router; google.mjs: Gemini through Google's OpenAI-compatible
// endpoint). The limiter (providers/limiter.mjs) keeps each provider within its concurrent-request cap.
//
// Setup: keys in .env at the repo root (git-ignored; see .env.example), then `npm run relay`. Every key is optional: without one
// that provider answers its status with "no key" and a runner on it refuses to start with the same plain message.
// --play-only: the seats and the page work and no key is asked for (no warning). Env: RELAY_MODEL, RELAY_PORT, RELAY_ORIGIN,
// OLLAMA_URL, OLLAMA_MODEL. Keys are read here and by the runners only, never printed, never sent to the browser.
// Launcher (npm run up, scripts/up.mjs): --launcher (CLOCKTOWER_LAUNCHER=1) makes "stop" on stdin a clean quit, since Windows has
// no signal to send; --resume-runners restarts the last run's runners (logs/runners/active.json).
// Behavior logs: logs/behavior/<game>/ for the watcher (npm run behavior-report); --no-behavior or RELAY_BEHAVIOR=0 turns them off.
// Verbose: --verbose (or RELAY_VERBOSE=1) appends every tool call to logs/play.jsonl.
// Game: --game serves a seeded game (src/game/backend.js) instead of the stub: --seed N (default 1), --rounds N (speaking rounds
// before nominations, default 3), --scripted (a Storyteller decision nobody answers in time gets the scripted default).
import http from 'node:http';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {attachPlay, PLAY_LOG} from './relay-mcp.mjs';
import {attachRunners} from './runners.mjs';
import {ttsFromEnv, HINT} from './providers/tts.mjs';
import {behaviorLog} from './behavior-log.mjs';
import {makeProviders, PROVIDERS, isLocal, DEFAULT_MODEL, PRICES, costOf} from './providers/index.mjs';
import {makeLimiter, rateLimitOf} from './providers/limiter.mjs';
import {gameBackend} from '../src/game/backend.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export {DEFAULT_MODEL, PRICES, costOf};
export const DEV_ORIGIN = 'http://localhost:5173', PORT = 8787;
// Concurrent requests per provider the relay allows at once (env RELAY_<NAME>_CONCURRENCY). A 429 pauses the queue (retry-after,
// else 1-2-4 s, at most RATE_PAUSE_MAX); limitedCall retries only when asked, with jitter, up to RATE_RETRIES times.
export const ANTHROPIC_CONCURRENCY = 2, OPENAI_CONCURRENCY = 4, HF_CONCURRENCY = 4, GOOGLE_CONCURRENCY = 4, RATE_RETRIES = 3, RATE_PAUSE_MAX = 10000;
export const makeLimits = (env = {}) => ({anthropic: makeLimiter({max: Number(env.RELAY_ANTHROPIC_CONCURRENCY) || ANTHROPIC_CONCURRENCY}), openai: makeLimiter({max: Number(env.RELAY_OPENAI_CONCURRENCY) || OPENAI_CONCURRENCY}), huggingface: makeLimiter({max: Number(env.RELAY_HF_CONCURRENCY) || HF_CONCURRENCY}), google: makeLimiter({max: Number(env.RELAY_GOOGLE_CONCURRENCY) || GOOGLE_CONCURRENCY, rpm: Number(env.RELAY_GOOGLE_RPM) || 0})});
const sleepFor = (ms, signal) => new Promise((res, rej) => {if (signal && signal.aborted) return rej(Object.assign(new Error('aborted'), {name: 'AbortError'}));
  const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => {clearTimeout(t); rej(Object.assign(new Error('aborted'), {name: 'AbortError'}))}, {once: true})});
// One provider call through its limiter: queued (urgent first), paused on 429, retried when asked.
export async function limitedCall(lim, once, {urgent, retry, signal, deadline = null, minLeft = 0, log = () => {}, label = ''}) {
  for (let attempt = 0; ; attempt++) {
    try {return await lim.run(once, {urgent, signal, deadline, minLeft})}
    catch (e) {
      const rl = rateLimitOf(e); if (!rl) throw e;
      const back = rl.retryAfterMs != null ? rl.retryAfterMs : 1000 * 2 ** attempt;
      lim.rateLimited(Math.min(RATE_PAUSE_MAX, back));
      if (!retry || attempt >= RATE_RETRIES || (signal && signal.aborted)) {e.rateLimited = true; throw e}
      const wait = back * (1 + Math.random() * .5);
      log(`[relay] ${label} rate limited (429): retry ${attempt + 1}/${RATE_RETRIES} in ${(wait / 1000).toFixed(1)} s`);
      await sleepFor(wait, signal);
    }
  }
}

// Minimal .env reader (no dependency). Real environment variables win; .env.local beats .env.
export function loadEnv(root = ROOT, env = process.env) {
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f); if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m || line.trim().startsWith('#')) continue;
      if (env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

// createRelay({providers, model, origin, log, limits, tts, seats}) -> {server}: /health and /tts; attach the seats and the runners after.
// providers: {name: adapter} (scripts/providers/); seats: () => the backend's info() (players and the Storyteller seat).
export function createRelay({providers, model = DEFAULT_MODEL, origin = DEV_ORIGIN, limits = makeLimits(), tts = null, seats = () => ({players: [], storyteller: false})} = {}) {
  // Which providers can answer: configured or not, reachable or not, and their models. Never a key.
  async function providerStatus() {
    const out = {};
    for (const name of PROVIDERS) {const P = providers[name]; if (!P) continue;
      try {out[name] = {...await P.status(), local: isLocal(name)}} catch (e) {out[name] = {ok: false, models: [], local: isLocal(name), error: String(e.message || e).slice(0, 80)}}}
    if (tts) {try {const t = await tts.status(); out.tts = {engine: t.engine, voices: t.voices, ready: t.ok, error: t.error}} catch {}}
    return out;
  }
  const seatView = () => {const i = seats() || {}; return {players: (i.players || []).map(p => ({id: p.id, name: p.name})), storyteller: !!i.storyteller}};
  const server = http.createServer((req, res) => {
    const o = req.headers.origin;
    const send = (code, obj) => {
      const h = {'content-type': 'application/json'};
      if (o === origin) {h['access-control-allow-origin'] = origin; h.vary = 'origin'}
      res.writeHead(code, h); res.end(JSON.stringify(obj));
    };
    if (o && o !== origin) return send(403, {error: 'origin not allowed'});
    if (req.method === 'OPTIONS') {
      res.writeHead(204, o === origin ? {'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin'} : {}); return res.end();
    }
    const queues = () => Object.fromEntries(Object.entries(limits || {}).map(([k, l]) => [k, l.stats()]));
    if (req.method === 'GET' && req.url === '/health') return void providerStatus().then(p => send(200, {ok: true, model, providers: p, seats: seatView(), queues: queues()}), () => send(200, {ok: true, model, seats: seatView(), queues: queues()}));
    if (tts && /^\/tts(\/|\?|$)/.test(req.url) && tts.route(req, res, send, o === origin ? {'access-control-allow-origin': origin, vary: 'origin'} : {})) return;
    send(404, {error: 'not found'});
  });
  return {server};
}

// The narrator voice. RELAY_TTS unset: probe TTS_URL (default Kokoro-FastAPI on 127.0.0.1:8880) at start, on when it answers, off
// with the hint when not; RELAY_TTS=0 forces off, =1 forces on (the engine may start later). /tts/status also carries the seat voice
// map from src/data/voices.js when that file exists (read behind a try, so the relay starts without it).
// -> {tts: {status, route} | null, probed: Promise}; the promise settles once the start-up probe has logged its line.
export function makeVoice(env, log = () => {}) {
  const mode = String(env.RELAY_TTS ?? '').trim();
  const forcedOff = /^(0|false|no|off)$/i.test(mode), forced = /^(1|true|yes|on)$/i.test(mode);
  const engine = ttsFromEnv(env, forcedOff ? {enabled: false} : {});
  const st = {off: forcedOff, reason: forcedOff ? 'off (RELAY_TTS=0)' : 'off (no engine answered at start; start Kokoro and restart the relay)', seatVoices: null};
  const loaded = import('../src/data/voices.js').then(m => {const v = m.SEAT_VOICES || m.VOICES || m.default; st.seatVoices = v && typeof v === 'object' ? v : null}).catch(() => {});
  const tts = {
    async status() {
      if (st.off) return {enabled: false, ok: false, engine: null, voices: [], error: st.reason, hint: HINT.replace('{url}', engine.url), ...(st.seatVoices ? {seatVoices: st.seatVoices} : {})};
      const s = await engine.status(); return st.seatVoices ? {...s, seatVoices: st.seatVoices} : s;
    },
    route(req, res, send, headers) {
      const p = new URL(req.url, 'http://x').pathname;
      if (st.off) {
        if (req.method === 'GET' && p === '/tts/status') {tts.status().then(s => send(200, s)); return true}
        send(503, {error: 'narrator voice is off', hint: HINT.replace('{url}', engine.url)}); return true;
      }
      if (req.method === 'GET' && p === '/tts/status') {tts.status().then(s => send(200, s)); return true}
      return engine.route(req, res, send, headers);
    },
  };
  if (forcedOff) {log('[relay] voice engine off (RELAY_TTS=0)'); return {tts, probed: Promise.resolve()}}
  const probed = loaded.then(() => engine.status()).then(s => {
    if (s.ok) log(`[relay] voice engine found (${s.voices.length} voices) at ${s.url}${st.seatVoices ? ', seat voices mapped' : ''}`);
    else if (forced) log(`[relay] voice engine forced on (RELAY_TTS=1) but not answering at ${engine.url}: ${s.error}`);
    else {st.off = true; log('[relay] voice engine not found. ' + HINT.replace('{url}', engine.url))}
  }).catch(() => {});
  return {tts, probed};
}

// startRelay({env, argv, port, log}) -> {server, play, sup, quit, ready: Promise<port>}: what `npm run relay` runs; the checks start it too.
export function startRelay({env = loadEnv(), argv = process.argv, port = Number(env.RELAY_PORT || PORT), log = console.log} = {}) {
  const playOnly = argv.includes('--play-only');
  if (!playOnly && !env.ANTHROPIC_API_KEY) log('[relay] No ANTHROPIC_API_KEY: Claude seats cannot start (put a key in .env, see .env.example). Local models (Ollama) still work; --play-only hides this line.');
  const model = env.RELAY_MODEL || DEFAULT_MODEL, origin = env.RELAY_ORIGIN || DEV_ORIGIN;
  const verbose = argv.includes('--verbose') || /^(1|true|yes)$/i.test(env.RELAY_VERBOSE || '') ? PLAY_LOG : null;
  // The relay itself makes no model call yet (the seats' runners do); its Claude adapter answers status only, so the SDK is
  // loaded with the key by the runners, never here. A key present shows as configured.
  const anthropicClient = env.ANTHROPIC_API_KEY ? {messages: {create: () => Promise.reject(new Error('the relay makes no Claude call'))}} : null;
  const providers = makeProviders({anthropicClient, model, env});
  const limits = makeLimits(env);
  const behavior = argv.includes('--no-behavior') || /^(0|false|no|off)$/i.test(env.RELAY_BEHAVIOR || '') ? null : behaviorLog({game: env.CLOCKTOWER_GAME || 'clocktower', log});
  const {tts, probed} = makeVoice(env, log);
  let play = null;
  const {server} = createRelay({providers, model, origin, limits, tts, seats: () => play ? play.backend.info() : {}});
  const flag = k => {const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null};
  const backend = argv.includes('--game') ? gameBackend({seed: Number(flag('--seed') ?? 1), ...(flag('--rounds') != null ? {rounds: Number(flag('--rounds'))} : {}),
    scripted: argv.includes('--scripted'), log, note: rec => {if (behavior) behavior.ingest('game', rec)}}) : null;
  if (backend) log(`[relay] serving a game: seed ${Number(flag('--seed') ?? 1)}${argv.includes('--scripted') ? ', scripted Storyteller fallback' : ''}`);
  play = attachPlay(server, {backend, origin, verbose, behavior, log});
  const runnersOn = argv.includes('--runners') || /^(1|true|yes)$/i.test(env.RELAY_RUNNERS || '');
  const sup = attachRunners(server, {play, enabled: runnersOn, origin, base: () => `http://127.0.0.1:${server.address() ? server.address().port : port}`, log, env});
  // Quit: every runner gets "stop" on its stdin and a moment to let go of its seat; exit kills the rest.
  let quitting = false;
  const quit = () => {if (quitting) return; quitting = true; sup.shutdown().then(() => server.close(() => {})).then(() => setTimeout(() => process.exit(0), 200)); setTimeout(() => process.exit(0), 10000).unref()};
  const ready = new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      log(`[relay] listening on http://127.0.0.1:${p}  model ${model}  origin ${origin}  seats: ${play.backend.info().players.length} players and the Storyteller${verbose ? '  verbose -> ' + verbose : ''}${behavior ? '  behavior logs -> ' + behavior.dir() : ''}`);
      log(runnersOn ? '[relay] runners ON: the page can start and stop runners (logs in logs/runners/)' : '[relay] runners off (start with --runners to launch runners from the page)');
      if (runnersOn && (argv.includes('--resume-runners') || /^(1|true|yes)$/i.test(env.RELAY_RESUME_RUNNERS || ''))) sup.resume().catch(e => log('[runners] resume failed: ' + e.message));
      providers.ollama.status().then(o => log(`[relay] ollama at ${o.url}: ${o.ok ? (o.models.length ? o.models.join(', ') : 'reachable, no models pulled') : o.error}`)).catch(() => {});
      res(p);
    });
  });
  return {server, play, sup, quit, ready, providers};
}

// ---- run as a script ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = loadEnv();
  const {quit, ready} = startRelay({env});
  ready.catch(e => {console.error(`[relay] could not listen: ${e.message}`); process.exit(1)});
  process.on('SIGINT', quit); process.on('SIGTERM', quit); process.on('SIGHUP', quit);
  // The one-window launcher (npm run up) cannot send a signal Windows delivers to a node process, so it writes "stop" on stdin.
  if (/^(1|true|yes)$/i.test(env.CLOCKTOWER_LAUNCHER || '') || process.argv.includes('--launcher')) {
    process.stdin.setEncoding('utf8'); process.stdin.on('data', d => {if (/\bstop\b/.test(d)) quit()}); process.stdin.on('end', quit); process.stdin.on('error', quit); process.stdin.resume();
  }
}
