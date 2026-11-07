// Google (Gemini) adapter (Mixed minds, ; built in ). Gemini's OpenAI-compatible Chat Completions
// surface (https://generativelanguage.googleapis.com/v1beta/openai/, bearer = the AI Studio key) is the OpenAI
// adapter with other options, as the Hugging Face router is: decisions and writing as strict json_schema,
// the agent loop's tool calls, usage from the reply. Where the compat layer falls short the adapter asks the native
// generateContent API instead (the stub's TODO): a strict schema the compat layer rejects (400 naming the schema or
// response_format) goes to POST /v1beta/models/<model>:generateContent with systemInstruction, responseMimeType
// application/json and responseJsonSchema, usage from usageMetadata (thinking tokens counted as output), a
// MAX_TOKENS finish -> 'reply cut off', a safety finish or a blocked prompt -> 'model refused'; remembered per model.
// GOOGLE_NATIVE=1 sends every structured call natively. Tool calls stay on the compat path: the Gemini 3 models
// return a thought signature on each tool call (extra_content.google.thought_signature) that must come back within
// the turn, which the loop does; a 400 naming a missing signature is asked once more with the tool calls written
// out as plain text, so a turn never dies on it.
//
// Read from Google's pages on 2026-11-03 (never from memory):
//   - OpenAI compatibility (https://ai.google.dev/gemini-api/docs/openai, now aistudio.google.com/docs/openai): base
//     URL, Bearer key, tools, response_format, reasoning_effort minimal|low|medium|high, "none" turns thinking off on
//     the 2.5 models only ("Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models"), GET /models.
//   - Thinking (aistudio.google.com/docs/thinking): every current model supports "low"; a small output limit cuts the
//     answer while thinking tokens are still billed, so the adapter adds HEADROOM tokens on top of the caller's limit.
//   - Pricing (PRICES_SOURCE below). Rate limits (aistudio.google.com/docs/rate-limits) do not print the free tier's
//     numbers; they are shown per key in AI Studio. A 429 RESOURCE_EXHAUSTED is the limit; daily quotas reset at
//     midnight Pacific.
//
// The owner's account is the free tier (no bill), so free: true by default: cost 0 for every call (the tokens are
// still counted) and an exhausted daily quota is a 'quota' error, never retried: "Gemini free quota used up for
// today; the player plays scripted / the runner waits". GOOGLE_TIER=paid prices calls from the table instead.
// The key is read by the process that calls (the relay, a runner), goes only into the Authorization header (compat)
// or the x-goog-api-key header (native), is never logged and is scrubbed from every error.
// Interface: see anthropic.mjs.
import {openaiAdapter, scrub} from './openai.mjs';

export const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

// $ per 1M tokens, Standard tier, prompts <= 200k tokens, text input; output includes thinking tokens.
// Source: https://ai.google.dev/gemini-api/docs/pricing (redirects to aistudio.google.com/docs/pricing), read
// 2026-11-03. Promotional prices noted there: gemini-3.8-flash and gemini-3.6-flash double on 2027-01-01,
// gemini-4-argon on 2026-12-01; gemini-2.5-pro and gemini-2.5-flash are deprecated and route to gemini-3.8-flash
// and gemini-3.5-flash-lite on 2026-12-01. Models with a free tier on the page: every one below except
// gemini-4-argon and gemini-3.1-pro-preview (paid only).
export const PRICES_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing (read 2026-11-03)';
export const PRICES = {
  'gemini-4-argon': {in: 2, out: 10}, 'gemini-3.8-flash': {in: 0.75, out: 3.75}, 'gemini-3.6-flash': {in: 0.75, out: 3.75},
  'gemini-3.5-flash-lite': {in: 0.30, out: 2.50}, 'gemini-3.1-flash-lite': {in: 0.25, out: 1.50}, 'gemini-3.1-pro-preview': {in: 2, out: 12},
  'gemini-3-flash-preview': {in: 0.50, out: 3}, 'gemini-2.5-pro': {in: 1.25, out: 10}, 'gemini-2.5-flash': {in: 0.30, out: 2.50}, 'gemini-2.5-flash-lite': {in: 0.10, out: 0.40},
};
export const FREE_MODELS = Object.keys(PRICES).filter(m => m !== 'gemini-4-argon' && m !== 'gemini-3.1-pro-preview');
export const priceFor = m => {const s = String(m || '').replace(/^models\//, ''); return PRICES[s] || PRICES[s.replace(/-(\d{2,3}|latest)$/, '')] || null};
export const costOf = (m, i, o) => {const p = priceFor(m); return p ? (i * p.in + o * p.out) / 1e6 : null};

// Chat models out of GET /models (which also lists embeddings, image, live, speech and video models).
export const isGeminiChat = id => /^gemini-/.test(id) && !/(embedding|image|live|tts|audio|robotics|veo|imagen|aqa|omni|computer-use|vision)/.test(id);
// Thinking: off where it can be (the 2.5 Flash models), else "low" (every current model accepts it).
export const effortFor = m => /^gemini-2\.5-flash/.test(String(m)) ? 'none' : 'low';
export const HEADROOM = 1024;
export const headroomFor = m => effortFor(m) === 'none' ? 0 : HEADROOM;
export const googleTier = env => /^paid$/i.test(String(env && env.GOOGLE_TIER || '')) ? 'paid' : 'free';

const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});
const SAFETY = /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|LANGUAGE)$/;

// Google's errors, mapped before the OpenAI defaults: a bad key is a 400 "API key not valid" (or 401/403); a 429 is a
// per-minute limit (rate: the limiter pauses for the retry delay Google names) unless it names a daily quota or
// billing (quota: never retried).
export function googleError(free) {
  return (status, j, msg) => {
    const e = j && typeof j.error === 'object' && j.error || {}, all = scrub(e.message || msg).slice(0, 600) + ' ' + scrub(JSON.stringify(e.details || '')).slice(0, 400);
    if (status === 401 || status === 403 || (status === 400 && /API[ _]key|API_KEY_INVALID/i.test(all))) return fail('google: bad or missing GOOGLE_API_KEY', {status, kind: 'auth'});
    if (status === 429 || e.status === 'RESOURCE_EXHAUSTED') {
      if (/billing|prepay|credit|spend/i.test(all) && !free) return fail('google: out of credit (check billing in AI Studio)', {status, kind: 'quota'});
      if (/per ?day|PerDay|daily/i.test(all)) return fail(free ? 'Gemini free quota used up for today; the player plays scripted / the runner waits' : 'google: daily quota used up; the player plays scripted / the runner waits', {status, kind: 'quota'});
      const m = /retry in ([\d.]+)\s*s/i.exec(all) || /"retryDelay":"([\d.]+)s"/.exec(all), ra = m ? Math.ceil(Number(m[1])) : null;
      return fail('google: rate limit' + (free ? ' (free tier per-minute quota)' : '') + (ra != null ? ` (retry after ${ra} s)` : ''), {status: 429, kind: 'rate', retryAfter: ra, ...(ra != null ? {headers: {'retry-after': String(ra)}} : {})});
    }
    if (status === 404) return fail('google: model not found or not available to this key' + (msg ? ' (' + msg + ')' : ''), {status, kind: 'model'});
    return null;
  };
}

// The OpenAI-shaped messages with every tool call written out as text (a 400 for a missing thought signature).
export function flattenCalls(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.push({role: 'assistant', content: [m.content || '', ...m.tool_calls.map(c => 'I called ' + (c.function && c.function.name) + '(' + (c.function && c.function.arguments || '{}') + ').')].filter(Boolean).join(' ')});
    } else if (m.role === 'tool') out.push({role: 'user', content: 'Tool result: ' + String(m.content || '')});
    else out.push(m);
  }
  return out;
}

// The native generateContent call for a strict schema (body: the compat request the adapter built). Returns a reply
// in the Chat Completions shape so the adapter's own finish applies (finish 'length' -> reply cut off,
// 'content_filter' -> model refused). Request fields: systemInstruction, contents, generationConfig {maxOutputTokens,
// responseMimeType, responseJsonSchema}; nothing else.
export function nativeCaller({apiKey, base, fetchImpl}) {
  return {
    always: false,
    async structured(body, {signal, error}) {
      const msgs = flattenCalls(body.messages || []), sys = msgs.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n'), contents = [];
      for (const m of msgs) {
        if (m.role === 'system') continue;
        const role = m.role === 'assistant' ? 'model' : 'user', text = String(m.content || '');
        if (!text) continue;
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n\n' + text; else contents.push({role, parts: [{text}]});
      }
      const rf = body.response_format, schema = rf && rf.json_schema && rf.json_schema.schema;
      const req = {...(sys ? {systemInstruction: {parts: [{text: sys}]}} : {}), contents,
        generationConfig: {maxOutputTokens: body.max_tokens, responseMimeType: 'application/json', ...(schema ? {responseJsonSchema: schema} : {})}};
      const r = await fetchImpl(base + '/models/' + encodeURIComponent(body.model) + ':generateContent', {method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': apiKey}, body: JSON.stringify(req), signal});
      let j = null; try {j = await r.json()} catch {}
      if (!r.ok) throw error(r.status, j, r.headers);
      const c = j && Array.isArray(j.candidates) ? j.candidates[0] : null, u = j && j.usageMetadata || {}, fr = c && c.finishReason || '';
      const text = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('') : '';
      const blocked = !c && j && j.promptFeedback && j.promptFeedback.blockReason;
      const finish = blocked || SAFETY.test(fr) ? 'content_filter' : fr === 'MAX_TOKENS' ? 'length' : 'stop';
      const inTok = +u.promptTokenCount || 0, outTok = (+u.candidatesTokenCount || 0) + (+u.thoughtsTokenCount || 0);
      return {model: j && j.modelVersion || body.model, native: true, usage: {prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok},
        choices: [{index: 0, finish_reason: finish, message: {role: 'assistant', content: text || null}}]};
    },
  };
}

export const GOOGLE_OPTS = {name: 'google', label: 'Gemini', keyName: 'GOOGLE_API_KEY', baseUrl: GOOGLE_URL, sendEffort: true, tokensField: 'max_tokens',
  modelFilter: isGeminiChat, modelId: id => id.replace(/^models\//, ''), effortValue: effortFor, headroom: headroomFor, pricesSource: PRICES_SOURCE};

// tier: 'free' (default; cost 0, a used-up daily quota stops) or 'paid' (cost from PRICES). nativeAlways: GOOGLE_NATIVE=1.
export function googleAdapter({apiKey = null, baseUrl = GOOGLE_URL, defaultModel = null, fetchImpl = globalThis.fetch, tier = 'free', nativeAlways = false, ...o} = {}) {
  const free = tier !== 'paid', base = String(baseUrl || GOOGLE_URL).replace(/\/+$/, ''), nativeBase = base.replace(/\/openai$/, '');
  const nat = nativeCaller({apiKey, base: nativeBase, fetchImpl}); nat.always = !!nativeAlways;
  const ad = openaiAdapter({...GOOGLE_OPTS, ...o, apiKey, baseUrl: base, defaultModel, fetchImpl, free,
    costFn: free ? () => 0 : costOf, mapError: googleError(free), native: nat,
    // picker: sorted by the paid price, labelled with what a call costs here ($0 / $0 on the free tier; a paid-only model keeps its price)
    priceOf: priceFor, labelOf: free ? m => {const p = priceFor(m); return p && FREE_MODELS.some(f => f === m || String(m).startsWith(f + '-')) ? {in: 0, out: 0} : p} : priceFor,
    note: free ? 'free tier: no bill; per-minute and daily quotas (see AI Studio)' : 'paid tier: billed by Google',
    onBadRequest: (err, body) => Array.isArray(body.messages) && body.messages.some(m => m.tool_calls) && /thought[_ ]?signature/i.test(err.apiMessage || '') ? {...body, messages: flattenCalls(body.messages)} : null});
  ad.tier = free ? 'free' : 'paid';
  return ad;
}
// From the environment (the relay, the runners): GOOGLE_API_KEY, GOOGLE_MODEL, GOOGLE_BASE_URL, GOOGLE_TIER, GOOGLE_NATIVE; the relay adds
// GOOGLE_MODELS (an allow list through modelListFrom).
export const googleFromEnv = (env, o = {}) => googleAdapter({apiKey: env.GOOGLE_API_KEY || null, baseUrl: env.GOOGLE_BASE_URL || undefined, defaultModel: env.GOOGLE_MODEL || null,
  tier: googleTier(env), nativeAlways: /^(1|true|yes)$/i.test(String(env.GOOGLE_NATIVE || '')), ...o});
