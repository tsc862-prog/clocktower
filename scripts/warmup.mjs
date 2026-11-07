// The start gate's warm-up: a seat is "ready" only once its runner has completed one model call with
// the same model (and, for Ollama, the same num_ctx) it plays with. Before its first turn a runner reports
// POST /play/ready {state:'warming'}, makes one tiny call, then {state:'ready', ms} or {state:'failed', error}.
// The game waits until every seat is ready (the start gate). A failed warm-up never stops the runner (its turns go on); the
// page shows the error and the owner restarts the runner or starts anyway.
// Plain Node, no dependency. Used by the seat runners (scripts/seat-runner.mjs).
const SCHEMA = {type: 'object', properties: {ready: {type: 'boolean'}}, required: ['ready'], additionalProperties: false};
const SYSTEM = 'You are warming up before a game session. Answer with the JSON object {"ready": true}.';

async function postReady(base, body) {
  try {const r = await fetch(String(base).replace(/\/+$/, '') + '/play/ready', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    return r.ok ? await r.json().catch(() => ({ok: true})) : {ok: false, status: r.status}} catch (e) {return {ok: false, error: String(e && e.message || e)}}
}

// One tiny call through an adapter: a local adapter's chat (it waits in the runner's Ollama queue like a turn
// would) or the one-shot call of a paid adapter (Claude, OpenAI). -> ms
export async function warmCall(adapter, model, {timeoutMs = 600000} = {}) {
  const t0 = Date.now();
  if (adapter.local && adapter.chat) {
    const r = await adapter.chat({model, messages: [{role: 'system', content: SYSTEM}, {role: 'user', content: 'Ready?'}], format: SCHEMA, maxTokens: 16, temperature: 0, signal: AbortSignal.timeout(timeoutMs)});
    if (!r || !r.message) throw new Error('no answer');
  } else await adapter.call({system: SYSTEM, user: 'Ready?', schema: SCHEMA, maxTokens: 64, model, effort: 'low', timeoutMs: Math.min(timeoutMs, 60000)});
  return Date.now() - t0;
}

// warmUp({base, seat: {player: id} | {role: 'storyteller'}, runner, model, adapter | call, log}) -> {ok, ms?, error?}
// call: an async => void that makes the warm-up call itself (tests, or a runner with its own client).
export async function warmUp({base, seat, runner, model = null, adapter = null, call = null, log = () => {}, label = ''}) {
  const id = {...seat, runner, ...(model ? {model} : {})};
  await postReady(base, {...id, state: 'warming'});
  log(`${label}warming up ${model || 'the model'}...`);
  const t0 = Date.now();
  try {
    const ms = call ? (await call(), Date.now() - t0) : await warmCall(adapter, model);
    await postReady(base, {...id, state: 'ready', ms});
    log(`${label}ready: ${model || 'the model'} answered in ${(ms / 1000).toFixed(1)} s`);
    return {ok: true, ms};
  } catch (e) {
    const error = String(e && e.message || e).split(/\r?\n/)[0].slice(0, 200);
    await postReady(base, {...id, state: 'failed', error});
    log(`${label}warm-up failed: ${error} (the runner plays on; the page shows the seat as not ready)`);
    return {ok: false, error};
  }
}

// A Claude seat's warm-up adapter (the relay's own one-shot call, scripts/providers/anthropic.mjs), built only when
// needed so a local-only runner never loads the SDK. The key stays in this process.
export async function claudeWarmAdapter(apiKey) {
  const [{default: Anthropic}, {anthropicAdapter}] = await Promise.all([import('@anthropic-ai/sdk'), import('./providers/anthropic.mjs')]);
  return anthropicAdapter({client: new Anthropic({apiKey})});
}
