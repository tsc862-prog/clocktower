// Local text-to-speech for the narrator voice. The relay never calls a hosted service: the engine is
// any local server that speaks the OpenAI "audio/speech" shape on the owner's PC (Kokoro-FastAPI with Kokoro-82M is the
// first choice). The engine URL must be loopback, so no text of the game ever leaves the machine. Audio is cached by
// hash of (model, voice, text) under logs/tts/, so a line is generated once.
//   ttsEngine({url, model, format, dir, fetchImpl, timeoutMs, enabled}) -> {status(), speak(text, voice), route(req,res,send)}
//   status() -> {enabled, ok, engine, url, voices[], format, error?, hint?}   (never throws)
//   speak(text, voice) -> {id, cached, ms}   (throws a plain Error when the engine is missing or fails)
// Routes (the page's origin only, handled by the relay): GET /tts/status, POST /tts/say {text, voice} -> {id, ms, cached},
// GET /tts?id=<hex> -> the audio bytes. Env: RELAY_TTS=0 turns it off, TTS_URL (default http://127.0.0.1:8880), TTS_MODEL
// (default kokoro), TTS_FORMAT (mp3|wav|ogg, default mp3), TTS_VOICE (default voice).
import {createHash} from 'node:crypto';
import {mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TTS_URL = 'http://127.0.0.1:8880';
export const TTS_MAX_CHARS = 500;
const MIME = {mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg'};
const KEEP = 500; // cached clips kept (newest)
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i;
export const isLoopbackUrl = u => {try {const x = new URL(u); return /^https?:$/.test(x.protocol) && LOOPBACK.test(x.hostname)} catch {return false}};
export const ttsOff = env => /^(0|false|no|off)$/i.test((env && env.RELAY_TTS) || '');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HINT = 'Narrator voice: no local speech engine at {url}. Start one (Kokoro-FastAPI, see CLAUDE.md "Narrator voice") or set TTS_URL; the game stays silent until then.';
export const clampSpeed = s => {const n = Number(s); return Number.isFinite(n) && n > 0 ? Math.round(Math.min(1.5, Math.max(0.7, n)) * 100) / 100 : 1}; // the speaking rate a page may ask for
const clip = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);

export function ttsEngine({url = TTS_URL, model = 'kokoro', format = 'mp3', defaultVoice = null, dir = join(ROOT, 'logs', 'tts'), fetchImpl = globalThis.fetch, timeoutMs = 15000, enabled = true} = {}) {
  format = MIME[format] ? format : 'mp3'; url = String(url).replace(/\/+$/, '');
  const local = isLoopbackUrl(url);
  let voices = [], lastOk = null, lastErr = null, writes = 0, busy = Promise.resolve();
  const aborting = ms => {const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return {signal: c.signal, done: () => clearTimeout(t)}};
  async function status() {
    if (!enabled) return {enabled: false, ok: false, engine: null, voices: [], format, error: 'off (RELAY_TTS=0)'};
    if (!local) return {enabled: true, ok: false, engine: null, url, voices: [], format, error: 'TTS_URL must be on this machine (127.0.0.1 or localhost): the game text is never sent elsewhere', hint: HINT.replace('{url}', url)};
    const a = aborting(2500);
    try {
      let list = null;
      try {const r = await fetchImpl(url + '/v1/audio/voices', {signal: a.signal}); if (r.ok) {const j = await r.json(); list = Array.isArray(j) ? j : j && j.voices}} catch (e) {if (e && e.name === 'AbortError') throw e}
      if (!list) {const r = await fetchImpl(url + '/health', {signal: a.signal}).catch(() => null); if (!r || !r.ok) throw new Error('not answering' + (r ? ' (HTTP ' + r.status + ')' : ''))}
      voices = (list || []).map(v => typeof v === 'string' ? v : v && (v.id || v.name)).filter(Boolean).slice(0, 200);
      lastOk = Date.now(); lastErr = null;
      return {enabled: true, ok: true, engine: model, url, voices, format};
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 100);
      return {enabled: true, ok: false, engine: null, url, voices: [], format, error: lastErr, hint: HINT.replace('{url}', url)};
    } finally {a.done()}
  }
  const idOf = (voice, text, speed = 1) => createHash('sha256').update([model, format, voice, text, ...(speed !== 1 ? [speed] : [])].join('\u0000')).digest('hex').slice(0, 24);
  const fileOf = id => join(dir, id + '.' + format);
  const validId = id => /^[0-9a-f]{24}$/.test(String(id || ''));
  function prune() {
    try {const fs = readdirSync(dir).map(n => ({n, t: statSync(join(dir, n)).mtimeMs})).sort((a, b) => b.t - a.t);
      for (const f of fs.slice(KEEP)) try {unlinkSync(join(dir, f.n))} catch {}} catch {}
  }
  // One clip at a time (a local engine is one GPU or CPU): calls queue behind each other.
  function speak(text, voice, rate) {
    const speed = clampSpeed(rate); // 1 sends and caches exactly as before
    const run = async () => {
      if (!enabled) throw new Error('narrator voice is off');
      if (!local) throw new Error('TTS_URL is not on this machine');
      const t = clip(text); if (!t) throw new Error('nothing to say');
      if (lastOk === null && lastErr === null) await status(); // learn the engine's voices once
      let v = String(voice || defaultVoice || '').slice(0, 40);
      if (voices.length && !voices.includes(v)) v = defaultVoice && voices.includes(defaultVoice) ? defaultVoice : voices[0];
      const id = idOf(v, t, speed), f = fileOf(id), t0 = Date.now();
      if (existsSync(f)) return {id, cached: true, ms: 0};
      const a = aborting(timeoutMs);
      try {
        const r = await fetchImpl(url + '/v1/audio/speech', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model, input: t, voice: v || undefined, response_format: format, ...(speed !== 1 ? {speed} : {})}), signal: a.signal});
        if (!r.ok) throw new Error('engine answered HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 16) throw new Error('engine sent no audio');
        mkdirSync(dir, {recursive: true}); writeFileSync(f, buf); lastOk = Date.now(); lastErr = null;
        if (++writes % 50 === 0) prune();
        return {id, cached: false, ms: Date.now() - t0};
      } catch (e) {
        lastErr = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 100); throw new Error(lastErr);
      } finally {a.done()}
    };
    const p = busy.then(run, run); busy = p.catch(() => {}); return p;
  }
  // The relay's route hook: returns true when the request was ours. headers: CORS headers for the page's origin.
  function route(req, res, send, headers = {}) {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (req.method === 'GET' && p === '/tts/status') {status().then(s => send(200, s)); return true}
    if (req.method === 'GET' && p === '/tts') {
      const id = u.searchParams.get('id'); if (!validId(id) || !existsSync(fileOf(id))) {send(404, {error: 'no such clip'}); return true}
      try {const b = readFileSync(fileOf(id)); res.writeHead(200, {...headers, 'content-type': MIME[format], 'content-length': b.length, 'cache-control': 'max-age=3600'}); res.end(b)} catch {send(404, {error: 'no such clip'})}
      return true;
    }
    if (req.method === 'POST' && p === '/tts/say') {
      let size = 0; const ch = [];
      req.on('data', c => {size += c.length; if (size > 4000) {send(413, {error: 'too large'}); req.destroy()} else ch.push(c)});
      req.on('end', () => {
        if (size > 4000) return;
        let b; try {b = JSON.parse(Buffer.concat(ch).toString('utf8'))} catch {return send(400, {error: 'bad json'})}
        if (!b || typeof b.text !== 'string' || !b.text.trim()) return send(400, {error: 'text required'});
        speak(b.text, typeof b.voice === 'string' ? b.voice : null, b.speed).then(o => send(200, o), e => send(503, {error: e.message, hint: HINT.replace('{url}', url)}));
      });
      return true;
    }
    return false;
  }
  return {status, speak, route, file: fileOf, idOf, dir, get url() {return url}, get lastError() {return lastErr}, get lastOk() {return lastOk}, enabled};
}

export function ttsFromEnv(env = process.env, opts = {}) {
  return ttsEngine({url: env.TTS_URL || TTS_URL, model: env.TTS_MODEL || 'kokoro', format: env.TTS_FORMAT || 'mp3', defaultVoice: env.TTS_VOICE || null, enabled: !ttsOff(env), ...opts});
}
