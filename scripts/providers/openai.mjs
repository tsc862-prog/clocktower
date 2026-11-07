// OpenAI adapter (Mixed minds). Chat Completions at OPENAI_BASE_URL (default
// https://api.openai.com/v1) with strict JSON-schema structured output for the relay's decisions and
// writing, and a multi-turn chat with function tools for the agent loop (scripts/local-agent.mjs).
//
// Why Chat Completions and not the Responses API: both are supported by the current models, but the
// agent loop is the same tool-calling loop the Ollama runner already has (messages in, tool_calls
// out), Chat Completions is also what OpenAI-compatible servers speak (OPENAI_BASE_URL), and the loop
// keeps its own history, so Responses' server-side state buys nothing here. Per OpenAI's model page,
// Chat Completions function calling on the current reasoning models only works with
// reasoning_effort "none", so every request sends it; a model that rejects the field (400 naming
// it) is asked again without it and remembered, as the Ollama adapter does with `think`.
//
// The key is read by the process that makes the call (the relay, or an agent runner started from the
// same.env) and goes only into the Authorization header: never logged, never in an error message
// (anything key-shaped in an API error is scrubbed).
//
// There is no default model in code: OPENAI_MODEL sets one, otherwise the caller picks (the mind row's
// model list is filled from GET /models). Model ids and prices below were read from OpenAI's pages
// (see PRICES); a model that is not in the table reports tokens with cost 'unknown'.
// Interface: see anthropic.mjs.

export const OPENAI_URL = 'https://api.openai.com/v1';

// $ per 1M tokens, standard tier, short context (<272K input) where the page splits by context.
// Source: https://developers.openai.com/api/docs/pricing (platform.openai.com/docs/pricing redirects
// there), read 2026-11-01. `cached` ($ per 1M cached input tokens) is given only where the page was read
// on 2026-11-03 (gpt-6.1-terra, gpt-6-luna); a model without one prices cached tokens at `in`, so its cost stays an upper bound.
// The page notes GPT-5.6 Sol's price is promotional through at least 2026-11-21.
export const PRICES_SOURCE = 'https://developers.openai.com/api/docs/pricing (read 2026-11-01)';
export const PRICES = {
  'gpt-6-astra': {in: 10, out: 50}, 'gpt-6.1-sol': {in: 2, out: 10}, 'gpt-6.1-terra': {in: 1, out: 5, cached: 0.05}, 'gpt-6-luna': {in: 0.10, out: 0.50, cached: 0.01}, 'gpt-6-sol': {in: 2, out: 10},
  'gpt-5.6-sol': {in: 4, out: 20}, 'gpt-5.6-terra': {in: 2, out: 12}, 'gpt-5.6-luna': {in: 0.20, out: 1.20},
  'gpt-5.5': {in: 5, out: 30}, 'gpt-5.5-pro': {in: 30, out: 180}, 'gpt-5.4': {in: 2.5, out: 15}, 'gpt-5.4-pro': {in: 30, out: 180}, 'gpt-5.4-mini': {in: 0.75, out: 4.5}, 'gpt-5.4-nano': {in: 0.20, out: 1.25},
  'gpt-5.2': {in: 1.75, out: 14}, 'gpt-5.2-pro': {in: 21, out: 168}, 'gpt-5.1': {in: 1.25, out: 10}, 'gpt-5': {in: 1.25, out: 10}, 'gpt-5-mini': {in: 0.25, out: 2}, 'gpt-5-nano': {in: 0.05, out: 0.40}, 'gpt-5-pro': {in: 15, out: 120},
  'gpt-4.1': {in: 2, out: 8}, 'gpt-4.1-mini': {in: 0.40, out: 1.60}, 'gpt-4.1-nano': {in: 0.10, out: 0.40},
  'gpt-4o': {in: 2.5, out: 10}, 'gpt-4o-mini': {in: 0.15, out: 0.60},
  'o1': {in: 15, out: 60}, 'o3': {in: 2, out: 8}, 'o3-pro': {in: 20, out: 80}, 'o3-mini': {in: 1.10, out: 4.40}, 'o4-mini': {in: 1.10, out: 4.40},
  'gpt-4-turbo': {in: 10, out: 30}, 'gpt-3.5-turbo': {in: 0.50, out: 1.50},
};
// A dated snapshot (gpt-4o-2024-08-06) is priced as its family when the table has no row for the snapshot itself.
export const priceFor = model => {const m = String(model || ''); return PRICES[m] || PRICES[m.replace(/-\d{4}-\d{2}-\d{2}$/, '')] || null};
// -> number, or null when the model is not in the table (the caller reports 'unknown').
// The picker list: with an allow list (OPENAI_MODELS) exactly those the key can use, in the order given, the rest
// reported as dropped; without one the key's chat models cheapest first (input + output price), unpriced last.
// prices: {id: {in, out}} per 1M tokens for the listed models that have a row, for the picker's labels (OpenAI only).
// labelOf: the price shown beside each model (default priceOf for the OpenAI table, none for another priceOf unless given; Gemini).
export function shapeList(models, allow = null, priceOf = priceFor, labelOf = priceOf === priceFor ? priceFor : null) {
  const have = new Set(models), dropped = allow && allow.length ? allow.filter(m => !have.has(m)) : [];
  let list = allow && allow.length ? allow.filter(m => have.has(m)) : models.slice();
  if (!(allow && allow.length)) { const cost = m => { const p = priceOf(m); return p ? p.in + p.out : Infinity }; list = list.map((m, i) => [m, i]).sort((a, b) => cost(a[0]) - cost(b[0]) || a[1] - b[1]).map(x => x[0]) }
  const prices = {}; if (labelOf) for (const m of list) { const p = labelOf(m); if (p) prices[m] = {in: p.in, out: p.out} }
  return {models: list, dropped, prices: labelOf ? prices : null};
}
// inTok is the whole prompt; cachedTok of it is billed at the cached rate when the table has one (else at `in`).
export const costOf = (model, inTok, outTok, cachedTok = 0) => {const p = priceFor(model); if (!p) return null; const c = Math.min(Math.max(+cachedTok || 0, 0), inTok); return ((inTok - c) * p.in + c * (p.cached ?? p.in) + outTok * p.out) / 1e6};

// Chat-capable models out of GET /models (which also lists embeddings, speech, images, moderation...).
export const isChatModel = id => /^(gpt-|o\d|chatgpt-|chat-latest)/.test(id)
  && !/(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|codex|instruct|davinci|babbage|computer-use|sora|deep-research|diarize)/.test(id);

export const scrub = s => String(s == null ? '' : s).replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-…').replace(/hf_[A-Za-z0-9]{6,}/g, 'hf_…').replace(/AIza[A-Za-z0-9_-]{6,}/g, 'AIza…').replace(/([?&]key=)[^&\s]+/gi, '$1…').replace(/Bearer\s+\S+/gi, 'Bearer …');
const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => {clearTimeout(t); rej(Object.assign(new Error('aborted'), {name: 'AbortError'}))}, {once: true});
});

// Hugging Face Inference Providers router: OpenAI-compatible, the same adapter with other options.
// Provider id `huggingface`, base URL the router, HF_TOKEN from the environment (read by the process that calls,
// only into the Authorization header, scrubbed from errors). The owner's credit is the free allowance and
// recharge is off, so an exhausted allowance (402, or a 429 naming credits) is a 'quota' error, never retried.
// No price table: the reply's usage.estimated_cost is the cost ('unknown' when a reply has none). No
// reasoning_effort. Not every Hub model has an enabled provider (400 model_not_supported), so the model list is
// a curated default (HF_MODELS in.env overrides) checked once with one tiny call per model, cached for the
// adapter's life, and the unsupported ones are dropped. Defaults confirmed to have live providers on the Hub
// (Inference Providers panel, 2026-11-03); Meta-Llama-3.1-8B answered live per the issue.
export const HF_URL = 'https://router.huggingface.co/v1';
export const HF_MODELS = ['meta-llama/Llama-3.1-8B-Instruct', 'meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'];
export const hfModelList = env => {const l = String(env && env.HF_MODELS || '').split(/[,\s]+/).filter(m => /^[A-Za-z0-9][\w.:\/+-]{0,99}$/.test(m)); return l.length ? l : HF_MODELS.slice()};
export const HF_OPTS = {name: 'huggingface', label: 'Hugging Face', keyName: 'HF_TOKEN', baseUrl: HF_URL, free: true, sendEffort: false, tokensField: 'max_tokens', costField: 'estimated_cost', models: HF_MODELS,
  note: 'shares the free allowance with the art pipeline', pricesSource: 'usage.estimated_cost of each reply (Hugging Face router)'};
export const hfAdapter = (o = {}) => openaiAdapter({...HF_OPTS, ...o});

export function openaiAdapter({apiKey = null, baseUrl = OPENAI_URL, defaultModel = null, fetchImpl = globalThis.fetch, statusTtl = 60000,
  name = 'openai', label = 'OpenAI', keyName = 'OPENAI_API_KEY', free = false, sendEffort = true, tokensField = 'max_completion_tokens', modelFilter = isChatModel, pricesSource = PRICES_SOURCE,
  costField = null, models: curated = null, note: statusNote = null,
  // Hooks for other OpenAI-compatible endpoints (Gemini); each defaults to the OpenAI behaviour.
  effortValue = () => 'none', // the reasoning_effort sent (when sendEffort)
  headroom = () => 0, // tokens added to max tokens (a thinking model spends output tokens before it answers)
  costFn = null, // (model, in, out) -> $ or null; default the OpenAI price table (or costField)
  mapError = null, // (status, body, message, retryAfter) -> Error or null, before the default mapping
  onBadRequest = null, // (err, body) -> a body to send instead, or null (asked once per request)
  native = null, // {structured(body, {signal, error})}: a native endpoint for strict schemas the compat layer rejects
  modelId = id => id, // a listed model id as the picker shows it
  allow = null, // an allow list (OPENAI_MODELS, GOOGLE_MODELS; )
  priceOf = priceFor, // a model's {in, out} per 1M for sorting the picker list
  labelOf = undefined, // the price shown beside it (default: priceOf for OpenAI, none otherwise); Gemini's free tier shows $0
} = {}) {
  const base = String(baseUrl || OPENAI_URL).replace(/\/+$/, '');
  const noEffort = new Set(); // models that rejected reasoning_effort
  let cached = null, cachedAt = 0, verified = null; // verified: a curated list after its one tiny call per model (kept for the adapter's life)
  const noSchema = new Set(); // models whose provider rejected strict json_schema (asked with json_object + the schema in the prompt from then on)

  // The API's own error, mapped to a short message the relay and the UI can show. Never contains the key.
  function apiError(status, j, headers) {
    if (Array.isArray(j)) j = j[0]; // some compatible servers answer an error as a one-element array
    const e = j && typeof j.error === 'object' && j.error || {}, msg = scrub(e.message || (j && typeof j.error === 'string' ? j.error : '')).slice(0, 160), code = e.code || e.type || '';
    const ra = Number(headers && headers.get && headers.get('retry-after'));
    const retryAfter = Number.isFinite(ra) && ra >= 0 ? ra : null;
    if (mapError) {const m = mapError(status, j, msg, retryAfter); if (m) return m}
    if (status === 401) return fail(name + ': bad or missing ' + (name === 'openai' ? 'key' : keyName), {status, kind: 'auth'});
    if (curated && (code === 'model_not_supported' || /model_not_supported/.test(msg))) return fail(name + ': model not supported by an enabled provider; the picker list: ' + (verified || curated).join(', '), {status, kind: 'model', code: 'model_not_supported'});
    if (free && (status === 402 || (status === 429 && /credit|quota|allowance|exceeded your monthly/i.test(msg || String(e).slice(0, 200))))) return fail(label + ' allowance used up (recharge is off); the player plays scripted / the runner waits', {status, kind: 'quota'});
    if (status === 429 && /insufficient_quota/.test(code)) return fail(name + ': out of credit (insufficient quota; check billing)', {status, kind: 'quota'});
    if (status === 429) return fail(name + ': rate limit' + (retryAfter != null ? ` (retry after ${retryAfter} s)` : ''), {status, kind: 'rate', retryAfter, ...(retryAfter != null ? {headers: {'retry-after': String(retryAfter)}} : {})}); // headers: what the relay's limiter (providers/limiter.mjs rateLimitOf) reads
    if (status === 404) return fail(name + ': model not found or not available to this key' + (msg ? ' (' + msg + ')' : ''), {status, kind: 'model'});
    return fail(name + ': ' + (msg || 'HTTP ' + status), {status, kind: 'http', apiMessage: msg});
  }

  // One POST with the reasoning_effort fallback and a bounded wait on 429. waitMs: the most we sleep for
  // a rate limit in total (0 = never; decisions have seconds, an agent turn can afford more).
  async function post(path, body, {signal, waitMs = 0, retries = 1} = {}) {
    if (!apiKey) throw fail(name + ' is not configured (no ' + keyName + '): bad or missing key', {status: 401, kind: 'auth'});
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(base + path, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + apiKey}, body: JSON.stringify(body), signal});
      let j = null; try {j = await r.json()} catch {}
      if (r.ok) return j;
      if (r.status === 400 && 'reasoning_effort' in body && /reasoning_effort/i.test(String(j && j.error && j.error.message))) {noEffort.add(body.model); delete body.reasoning_effort; continue}
      const err = apiError(r.status, j, r.headers);
      if (r.status === 400 && onBadRequest && !body._again) {const nb = onBadRequest(err, body); if (nb) {body = Object.defineProperty(nb, '_again', {value: true}); continue}}
      if (r.status === 400 && body.tools && /tool|function/i.test(err.apiMessage || '') && /support|enabled|allowed|unavailable/i.test(err.apiMessage || '')) err.noTools = true; // the loop switches to JSON actions
      if (err.kind === 'rate' && attempt < retries) {
        const wait = Math.max(500, (err.retryAfter != null ? err.retryAfter : 1) * 1000);
        if (waited + wait <= waitMs) {waited += wait; await sleep(wait, signal); continue}
      }
      throw err;
    }
  }

  // A curated list (huggingface): one tiny call per model, once; model_not_supported drops the model, any other
  // failure keeps it (the allowance may be spent or the provider busy); a bad token is the status. Cached once settled.
  let verifying = null;
  function curatedStatus() {
    if (verified) return Promise.resolve({ok: true, models: verified, default: defaultModel || null, verified: true, ...(statusNote ? {note: statusNote} : {})});
    return verifying || (verifying = (async () => {
      const keep = [], dropped = []; let authErr = null;
      await Promise.all(curated.map(async m => {
        try {await post('/chat/completions', {model: m, [tokensField]: 1, messages: [{role: 'user', content: 'ok'}]}, {retries: 0}); keep.push(m)}
        catch (e) {if (e.kind === 'auth') authErr = e; else if (e.kind === 'model') dropped.push(m); else keep.push(m)}
      }));
      verifying = null;
      if (authErr) return {ok: false, models: [], default: defaultModel || null, error: authErr.message.replace(name + ': ', '')}; // not cached: a fixed token is picked up
      verified = curated.filter(m => keep.includes(m));
      return {ok: true, models: verified, default: defaultModel || null, verified: true, ...(dropped.length ? {dropped: curated.filter(m => dropped.includes(m))} : {}), ...(statusNote ? {note: statusNote} : {})};
    })());
  }

  // A strict json_schema request; a provider that rejects it (400 naming the schema or response_format) is asked
  // again with json_object and the schema spelled out in the system prompt, and remembered (huggingface routes to
  // many providers). The relay validates every answer against the schema either way.
  const asJsonObject = body => {
    const rf = body.response_format, sch = rf && rf.json_schema && rf.json_schema.schema, msgs = body.messages.slice();
    if (sch && msgs[0] && msgs[0].role === 'system') msgs[0] = {...msgs[0], content: msgs[0].content + ' Reply with one JSON object only, matching this JSON schema: ' + JSON.stringify(sch)};
    else if (sch) msgs.unshift({role: 'system', content: 'Reply with one JSON object only, matching this JSON schema: ' + JSON.stringify(sch)});
    return {...body, response_format: {type: 'json_object'}, messages: msgs};
  };
  const nativeSchema = new Set(); // models whose compat layer rejected the strict schema: asked natively from then on
  async function withSchema(body, _schema, opts) {
    if (native && body.response_format && body.response_format.type === 'json_schema') {
      if (nativeSchema.has(body.model) || native.always) return native.structured(body, {...opts, error: apiError});
      try {return await post('/chat/completions', body, opts)}
      catch (e) {
        if (e.status === 400 && e.kind === 'http' && /response_format|json_schema|schema|structured/i.test(e.apiMessage || '')) {nativeSchema.add(body.model); return native.structured(body, {...opts, error: apiError})}
        throw e;
      }
    }
    if (!curated || !body.response_format || body.response_format.type !== 'json_schema') return post('/chat/completions', body, opts);
    if (noSchema.has(body.model)) return post('/chat/completions', asJsonObject(body), opts);
    try {return await post('/chat/completions', body, opts)}
    catch (e) {
      if (e.status === 400 && e.kind === 'http' && /response_format|json_schema|schema|structured/i.test(e.apiMessage || '')) {noSchema.add(body.model); return post('/chat/completions', asJsonObject(body), opts)}
      throw e;
    }
  }

  const effortField = mdl => !sendEffort || noEffort.has(mdl) ? {} : {reasoning_effort: effortValue(mdl)};
  const tokens = (mdl, n) => n + (Number(headroom(mdl)) || 0);

  return {
    name, label, local: false, free, defaultModel: defaultModel || null, pricesSource, nativeModels: () => [...nativeSchema],
    configured: () => !!apiKey,
    // Reachable and the key accepted, and the chat models this key can use (GET /models). Cached.
    async status() {
      if (!apiKey) return {ok: false, models: [], default: defaultModel || null, error: 'no ' + keyName};
      if (curated) return curatedStatus();
      if (cached && Date.now() - cachedAt < statusTtl) return cached;
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 4000);
      try {
        const r = await fetchImpl(base + '/models', {headers: {authorization: 'Bearer ' + apiKey}, signal: ac.signal});
        let j = null; try {j = await r.json()} catch {}
        if (!r.ok) throw apiError(r.status, j, r.headers);
        const models = (Array.isArray(j && j.data) ? j.data : []).map(m => m && typeof m.id === 'string' ? modelId(m.id) : null).filter(id => typeof id === 'string' && modelFilter(id)).sort();
        const listed = shapeList(models, allow, priceOf, labelOf === undefined ? (priceOf === priceFor ? priceFor : null) : labelOf), pick = defaultModel ? null : 'pick a model (' + keyName.replace(/_(API_KEY|TOKEN)$/, '') + '_MODEL sets a default)';
        cached = {ok: true, models: listed.models, ...(listed.prices ? {prices: listed.prices} : {}), ...(listed.dropped.length ? {dropped: listed.dropped} : {}), default: defaultModel || null, ...(free ? {free: true} : {}), ...(pick || statusNote ? {note: [statusNote, pick].filter(Boolean).join('; ')} : {})};
      } catch (e) {
        cached = {ok: false, models: [], default: defaultModel || null, error: e.name === 'AbortError' ? 'not reachable (timeout)' : e.kind ? e.message.replace(name + ': ', '') : 'not reachable (' + scrub(e.cause && e.cause.code || e.message).slice(0, 60) + ')'};
      } finally {clearTimeout(t)}
      cachedAt = Date.now();
      return cached;
    },
    // One structured decision or writing request.
    async call({system, user, schema, maxTokens, model, signal}) {
      const mdl = model || defaultModel;
      if (!mdl) throw fail(name + ': no model chosen (pick one in the mind row, or set the default model in .env)');
      const t0 = Date.now();
      const body = {model: mdl, ...effortField(mdl), [tokensField]: tokens(mdl, maxTokens),
        response_format: {type: 'json_schema', json_schema: {name: 'reply', strict: true, schema}},
        messages: [{role: 'system', content: system}, {role: 'user', content: user}]};
      const j = await withSchema(body, schema, {signal, retries: 0}); // a 429 goes to the relay's limiter (queue pause, writing kinds retried)
      return finish(j, mdl, t0, true);
    },
    // A multi-turn chat for the agent loop. messages are the loop's own (Ollama-shaped) messages:
    // assistant tool_calls with object arguments, tool results with tool_name. They are translated to
    // OpenAI's shape here (call ids made up in order). tools: function tools; format: a JSON schema, asked
    // for as JSON mode (OpenAI models all have tools, so this is only a fallback), or with strict: true as strict
    // json_schema (the forced Table turn). Returns the loop's
    // shape {message:{role,content,tool_calls?}, usage:{in,out,cost,costKnown}, model, ms, done}.
    async chat({model, messages, tools, format, strict = false, maxTokens = 600, signal}) {
      const mdl = model || defaultModel;
      if (!mdl) throw fail(name + ': no model chosen (use --model, or set the default model in .env)');
      const fit = fitTools(tools, toOpenAI(messages));
      const t0 = Date.now(), body = {model: mdl, ...effortField(mdl), [tokensField]: tokens(mdl, maxTokens), messages: fit.messages,
        ...(tools ? {tools: fit.tools} : {}), ...(format ? {response_format: strict ? {type: 'json_schema', json_schema: {name: 'reply', strict: true, schema: format}} : {type: 'json_object'}} : {})};
      const j = await withSchema(body, format, {signal, waitMs: 30000, retries: 4});
      const out = finish(j, mdl, t0, false);
      const m = out.raw, calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(c => c && c.function).map(c => {
        let args = c.function.arguments; try {args = JSON.parse(args || '{}')} catch {} // a string that is not JSON stays a string; cleanArgs rejects it
        return {function: {name: c.function.name, arguments: args}, ...(c.extra_content ? {extra_content: c.extra_content} : {})}}) : []; // extra_content: Gemini's thought signature, sent back within the turn
      return {message: {role: 'assistant', content: m.content || '', ...(calls.length ? {tool_calls: calls} : {})}, usage: out.usage, model: out.model, ms: out.ms, done: out.finish};
    },
  };

  function finish(j, mdl, t0, structured) {
    const ch = j && Array.isArray(j.choices) ? j.choices[0] : null, m = ch && ch.message || {};
    const billed = j && j.model || mdl, u = j && j.usage || {};
    // out: completion tokens, or total minus prompt when that is larger (thinking tokens billed as output but not counted as completion)
    const inTok = +u.prompt_tokens || 0, outTok = Math.max(+u.completion_tokens || 0, (+u.total_tokens || 0) - inTok), ec = costField ? Number(u[costField]) : NaN;
    const cachedTok = Math.min(+(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, inTok); // : the cached part of prompt_tokens
    const c = costFn ? costFn(billed, inTok, outTok) ?? costFn(mdl, inTok, outTok) : costField ? (Number.isFinite(ec) && ec >= 0 ? ec : null) : costOf(billed, inTok, outTok, cachedTok) ?? costOf(mdl, inTok, outTok, cachedTok);
    const usage = {in: inTok, out: outTok, ...(cachedTok ? {cached: cachedTok} : {}), cost: c ?? 0, costKnown: c != null, ...(c == null ? {costNote: 'unknown'} : {})};
    const text = typeof m.content === 'string' ? m.content : null;
    const out = {text, usage, model: billed, ms: Date.now() - t0, raw: m, finish: ch && ch.finish_reason || null};
    if (structured) {
      if (m.refusal) throw Object.assign(fail('model refused', {raw: m.refusal}), {result: out});
      if (out.finish === 'length') throw Object.assign(fail('reply cut off', {raw: text}), {result: out});
      if (out.finish === 'content_filter') throw Object.assign(fail('model refused (content filter)'), {result: out});
      if (!text) throw Object.assign(fail('no text in reply'), {result: out});
    } else if (m.refusal) throw Object.assign(fail('model refused', {raw: m.refusal}), {result: out});
    return out;
  }
}

// The agent loop's messages as OpenAI chat messages: tool_calls get ids and JSON-string arguments, and
// each following tool message answers the next unanswered id (a tool message with no call to answer
// becomes plain user text, so a trimmed history never sends an orphan).
// Chat Completions answers 400 to a function description past 1024 characters (developers' reports; the docs do not print it), and the
// game's longest tools run past that (the Storyteller's stage_scene is over 3000). Cut at a sentence and send the rest in the system
// message, so nothing is lost and the prompt is the same size. -> {tools, messages}
export const TOOL_DESC_MAX = 1024;
export function fitTools(tools, messages, max = TOOL_DESC_MAX) {
  if (!Array.isArray(tools)) return {tools, messages};
  const MORE = ' (more in your orders)', room = max - MORE.length, rest = [];
  const out = tools.map(t => {const f = t && t.function, d = f && f.description;
    if (typeof d !== 'string' || d.length <= max) return t;
    const dot = d.lastIndexOf('. ', room - 1), at = dot > room / 2 ? dot + 1 : room;
    rest.push(`${f.name}: ${d.slice(at).trim()}`);
    return {...t, function: {...f, description: d.slice(0, at).trim() + MORE}}});
  if (!rest.length) return {tools, messages};
  const note = 'More on your tools:\n' + rest.join('\n'), L = messages.slice(), i = L.findIndex(m => m.role === 'system');
  if (i >= 0) L[i] = {...L[i], content: L[i].content + '\n\n' + note}; else L.unshift({role: 'system', content: note});
  return {tools: out, messages: L};
}

export function toOpenAI(messages) {
  const out = [], pending = []; let n = 0;
  const flush = () => {while (pending.length) out.push({role: 'tool', tool_call_id: pending.shift(), content: '(not run)'})}; // calls cut short (the player died mid-reply)
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(c => {const id = 'call_' + (++n); pending.push(id);
        const a = c.function && c.function.arguments;
        return {id, type: 'function', function: {name: String(c.function && c.function.name || ''), arguments: typeof a === 'string' ? a : JSON.stringify(a || {})}, ...(c.extra_content ? {extra_content: c.extra_content} : {})}});
      out.push({role: 'assistant', content: m.content || null, tool_calls: calls});
    } else if (m.role === 'tool') {
      const id = pending.shift();
      out.push(id ? {role: 'tool', tool_call_id: id, content: String(m.content || '')} : {role: 'user', content: 'Result of ' + (m.tool_name || 'a tool') + ': ' + String(m.content || '')});
    } else out.push({role: m.role, content: m.content || ''});
  }
  return out;
}
