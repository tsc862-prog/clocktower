// Ollama adapter (Mixed minds): local open models, no key, no cost.
// Uses the native POST /api/chat with `format` set to the JSON schema (Ollama's structured outputs: the
// reply is constrained to the schema by the sampler, which the OpenAI-compatible /v1 endpoint does not
// guarantee for every version) and stream:false. Token counts come from prompt_eval_count / eval_count.
// The model is kept loaded for keepAlive between calls so a decision does not pay the load time.
// think:false: thinking models (qwen3.x, deepseek-r1...) would otherwise spend the whole token budget
// thinking before the JSON (measured live: every reply cut off). A model that says it does not support
// thinking is asked again without the field, and remembered.
// Interface: see anthropic.mjs.

// Agent runner chats (chat):, the owner's local table got "fetch failed" after exactly
// 5 minutes (undici's default headers timeout) while Ollama swapped two models under five 16k-context
// requests. So chat posts with node:http and its own timeout (OLLAMA_CHAT_TIMEOUT seconds, default 600),
// runs at most `parallel` requests at once per adapter (OLLAMA_PARALLEL, default 1: a runner's members
// share one queue), and says plainly when Ollama is busy or loading. loaded lists the models Ollama
// holds in memory (GET /api/ps) so a runner can warn when the relay's minds use another local model.
import http from 'node:http';
import https from 'node:https';

export const OLLAMA_URL = 'http://localhost:11434';
export const OLLAMA_MODEL = 'qwen2.5:14b';
const envNum = (k, d) => {const v = typeof process !== 'undefined' && process.env ? Number(process.env[k]) : NaN; return Number.isFinite(v) && v > 0 ? v : d};
export const CHAT_TIMEOUT_S = envNum('OLLAMA_CHAT_TIMEOUT', 600), OLLAMA_PARALLEL = envNum('OLLAMA_PARALLEL', 1);
// One context size for every local call. Ollama reloads the whole model whenever a request asks a
// different num_ctx than the one it was loaded with, and a request without num_ctx gets the server's default
// (32768 on the owner's PC) while the agent loop asked 16384: a table runner, a Storyteller runner and the relay's
// minds on one GPU thrashed the model and hit the 600 s timeout. So the adapter sends num_ctx on EVERY request
// (call and chat), read from one place: OLLAMA_NUM_CTX, default 16384. Callers never pick their own.
export const NUM_CTX_DEFAULT = 16384;
export const numCtxFrom = (env = typeof process !== 'undefined' ? process.env : {}) => {const v = Math.round(Number(env && env.OLLAMA_NUM_CTX)); return Number.isFinite(v) && v >= 512 ? v : NUM_CTX_DEFAULT};

export const REPEAT_LIMIT_RE = /repeat limit|prediction aborted/i;
const fail = (msg, raw) => Object.assign(new Error(msg), raw != null ? {raw} : {});

// POST JSON with one overall timeout and no headers timeout of its own (a local model may think for minutes).
function postJson(url, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'https:' ? https : http, data = Buffer.from(JSON.stringify(body));
    const req = lib.request(u, {method: 'POST', headers: {'content-type': 'application/json', 'content-length': data.length}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {const text = Buffer.concat(chunks).toString('utf8'); resolve({ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text)})});
      res.on('error', reject);
    });
    const t = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})), timeoutMs);
    req.on('close', () => clearTimeout(t)); req.on('error', reject);
    if (signal) {if (signal.aborted) req.destroy(new Error('aborted')); else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), {once: true})}
    req.end(data);
  });
}

export function ollamaAdapter({url = OLLAMA_URL, defaultModel = OLLAMA_MODEL, keepAlive = '30m', fetchImpl = globalThis.fetch, statusTtl = 10000, chatTimeoutMs = CHAT_TIMEOUT_S * 1000, parallel = OLLAMA_PARALLEL, chatPost = null, numCtx = numCtxFrom()} = {}) {
  const ctx = Number(numCtx) >= 512 ? Math.round(Number(numCtx)) : NUM_CTX_DEFAULT;
  const base = String(url).replace(/\/+$/, '');
  let cached = null, cachedAt = 0;
  const noThink = new Set(); // models that rejected the think field
  // the chat queue: at most `parallel` requests in flight, the rest wait in order. An urgent request (a Table scene
  // answer) goes ahead of every ordinary one still waiting (after earlier urgent ones); a request whose signal
  // aborts while it waits leaves the queue (a member's free turn given up for its scene answer).
  let live = 0; const queue = [];
  const take = (urgent = false, signal = null) => {
    if (live < parallel && !queue.length) {live++; return Promise.resolve()}
    return new Promise((res, rej) => {
      const e = {urgent: !!urgent, go: () => {if (signal) signal.removeEventListener('abort', gone); live++; res()}};
      const gone = () => {const i = queue.indexOf(e); if (i >= 0) queue.splice(i, 1); rej(Object.assign(new Error('ollama: the request was withdrawn while it waited in the queue'), {name: 'AbortError', withdrawn: true}))};
      if (signal) {if (signal.aborted) return gone(); signal.addEventListener('abort', gone, {once: true})}
      if (urgent) {let i = 0; while (i < queue.length && queue[i].urgent) i++; queue.splice(i, 0, e)} else queue.push(e);
    });
  };
  const give = () => {live--; const n = queue.shift(); if (n) n.go()};
  async function held() {
    try {const r = await fetchImpl(base + '/api/ps', {signal: AbortSignal.timeout(2000)}); if (!r.ok) return null; const j = await r.json();
      return (Array.isArray(j && j.models) ? j.models : []).filter(m => m && typeof (m.name || m.model) === 'string')
        .map(m => ({name: m.name || m.model, ctx: Number(m.context_length) > 0 ? Number(m.context_length) : null}))} catch {return null}
  }
  const posting = chatPost || ((u, b, signal) => postJson(u, b, chatTimeoutMs, signal));
  return {
    name: 'ollama', local: true, url: base, defaultModel, numCtx: ctx,
    configured: () => true,
    queued: () => queue.length,
    busy: () => live + queue.length, // requests in flight or waiting (a runner reports a member queued for its scene)
    // The models Ollama holds in memory now (GET /api/ps) with the context each was loaded at:
    // [{name, ctx}] (ctx null when this Ollama does not report context_length), or null when it does not answer.
    held,
    // The names only (older callers).
    async loaded() {const h = await held(); return h ? h.map(m => m.name) : null},
    // Reachable or not, and which models are pulled (GET /api/tags). Cached for statusTtl ms.
    async status() {
      if (cached && Date.now() - cachedAt < statusTtl) return cached;
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 1500);
      try {
        const r = await fetchImpl(base + '/api/tags', {signal: ac.signal});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const models = (Array.isArray(j && j.models) ? j.models : []).map(m => m && (m.name || m.model)).filter(n => typeof n === 'string').sort();
        cached = {ok: true, url: base, models, default: defaultModel, numCtx: ctx};
      } catch (e) {
        cached = {ok: false, url: base, models: [], default: defaultModel, numCtx: ctx, error: e.name === 'AbortError' ? 'not reachable (timeout)' : 'not reachable (' + String(e.cause && e.cause.code || e.message).slice(0, 60) + ')'};
      } finally {clearTimeout(t)}
      cachedAt = Date.now();
      return cached;
    },
    async call({system, user, schema, maxTokens, model, signal}) {
      const mdl = model || defaultModel, t0 = Date.now();
      const body = {
        model: mdl, stream: false, keep_alive: keepAlive, ...(noThink.has(mdl) ? {} : {think: false}),
        format: schema,
        // Local tokenizers differ from Claude's and cost nothing: give the reply some headroom over the
        // per-kind cap so a slightly wordier model is not cut off.
        options: {num_predict: Math.round(maxTokens * 2), num_ctx: ctx},
        messages: [{role: 'system', content: system}, {role: 'user', content: user}],
      };
      const post = () => fetchImpl(base + '/api/chat', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal});
      let r = await post(), j = null; try {j = await r.json()} catch {}
      if (!r.ok && 'think' in body && /think/i.test(String(j && j.error))) {noThink.add(mdl); delete body.think; r = await post(); j = null; try {j = await r.json()} catch {}}
      if (!r.ok) throw fail('ollama: ' + String(j && j.error || 'HTTP ' + r.status).slice(0, 160));
      const text = j && j.message && typeof j.message.content === 'string' ? j.message.content : null;
      const usage = {in: +(j && j.prompt_eval_count) || 0, out: +(j && j.eval_count) || 0, cost: 0};
      const out = {text, usage, model: (j && j.model) || mdl, ms: Date.now() - t0};
      if (j && j.done_reason === 'length') throw Object.assign(fail('reply cut off', text), {result: out});
      if (!text) throw Object.assign(fail('no text in reply'), {result: out});
      return out;
    },
    // Embeddings for semantic memory search: POST /api/embed with a small embedding model
    // (OLLAMA_EMBED_MODEL, default nomic-embed-text, see scripts/embed.mjs). input: an array of texts -> {vectors: [[number]], model, ms}.
    // No num_ctx here on purpose: an embedding model is its own small load and never evicts or reloads the chat model
    // the way a different context would. Throws a plain Error on any failure; callers fall back.
    async embed({model, input, signal, timeoutMs = 20000}) {
      const t0 = Date.now(), list = (Array.isArray(input) ? input : [input]).map(x => String(x == null ? '' : x));
      if (!model) throw fail('ollama: no embedding model named');
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
      if (signal) {if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), {once: true})}
      try {
        const r = await fetchImpl(base + '/api/embed', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model, input: list, truncate: true, keep_alive: keepAlive}), signal: ac.signal});
        let j = null; try {j = await r.json()} catch {}
        if (!r.ok) throw fail('ollama: ' + String(j && j.error || 'HTTP ' + r.status).slice(0, 160));
        const v = j && j.embeddings;
        if (!Array.isArray(v) || v.length !== list.length || !v.every(x => Array.isArray(x) && x.length)) throw fail('ollama: the embedding reply did not match the request');
        return {vectors: v, model: (j && j.model) || model, ms: Date.now() - t0};
      } catch (e) {
        if (e && e.name === 'AbortError') throw fail('ollama: no embedding in ' + Math.round(timeoutMs / 1000) + ' s');
        throw e;
      } finally {clearTimeout(t)}
    },
    // A multi-turn chat for the local agent runner (scripts/local-agent.mjs).
    // messages: Ollama chat messages (system/user/assistant with tool_calls/tool); tools: Ollama
    // function tools, or format: a JSON schema for the JSON-action fallback. Returns {message,
    // usage:{in,out,cost:0}, model, ms, done}. A model without tool support fails with e.noTools.
    // num_ctx is always the adapter's own; a per-call numCtx is ignored on purpose.
    async chat({model, messages, tools, format, maxTokens = 600, temperature = null, repeatPenalty = null, signal, urgent = false}) {
      const mdl = model || defaultModel, t0 = Date.now();
      const body = {model: mdl, stream: false, keep_alive: keepAlive, ...(noThink.has(mdl) ? {} : {think: false}), messages,
        ...(tools ? {tools} : {}), ...(format ? {format} : {}),
        options: {num_predict: maxTokens, num_ctx: ctx, ...(temperature != null ? {temperature} : {}), ...(repeatPenalty != null ? {repeat_penalty: repeatPenalty} : {})}};
      const post = async () => {
        try {return await posting(base + '/api/chat', body, signal)}
        catch (e) {const code = e && (e.code || e.cause && e.cause.code);
          if (code === 'ETIMEDOUT') throw fail(`ollama: no answer from ${mdl} in ${Math.round(chatTimeoutMs / 1000)} s (Ollama is busy or loading the model; another local model, such as the relay's minds, may be evicting it: use one model for both, or raise OLLAMA_CHAT_TIMEOUT)`);
          if (code === 'ECONNREFUSED') throw fail(`ollama: not reachable at ${base} (is Ollama running?)`);
          throw fail('ollama: ' + String(e && e.message || e).slice(0, 160))}};
      let r, j = null;
      await take(urgent, signal);
      try {
        r = await post(); try {j = await r.json()} catch {}
        if (!r.ok && 'think' in body && /think/i.test(String(j && j.error))) {noThink.add(mdl); delete body.think; r = await post(); j = null; try {j = await r.json()} catch {}}
      } finally {give()}
      if (!r.ok) {const msg = String(j && j.error || 'HTTP ' + r.status);
        // repeatLimit: Ollama aborted a generation that looped on repeated tokens ("prediction aborted, token repeat limit reached", live 2026-11-01)
        throw Object.assign(fail('ollama: ' + msg.slice(0, 160)), {noTools: !!tools && /does not support tools|tools? (are|is) not supported/i.test(msg), repeatLimit: REPEAT_LIMIT_RE.test(msg), status: r.status})}
      const message = j && j.message && typeof j.message === 'object' ? j.message : {role: 'assistant', content: ''};
      return {message, usage: {in: +(j && j.prompt_eval_count) || 0, out: +(j && j.eval_count) || 0, cost: 0}, model: (j && j.model) || mdl, ms: Date.now() - t0, done: j && j.done_reason || null};
    },
  };
}
