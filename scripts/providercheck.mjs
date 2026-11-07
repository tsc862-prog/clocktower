// Provider check: every model provider against its mock, with no key and no network (`npm run providercheck`).
//   Claude      the adapter's request shape per model (Haiku 5.5: thinking off; Sonnet 5.5: between_tools and the server-side
//               refusal fallback; Opus 5.5: no thinking field, which it cannot turn off), structured output, the price table with
//               Haiku's long-prompt rates, refusals and cut replies as errors, and the no-key message. A fake client: no network.
//   Ollama      the mock Ollama: status lists the pulled models, a structured call, the tool loop in tools mode, JSON-action mode for a
//               model without tools, calls written as text, an answer in another language kept out, a looping generation retried
//               cooler, a model that is down.
//   OpenAI      the mock OpenAI: status lists chat models only, a structured call priced from the table, an unpriced model says so,
//               the tool loop with well-formed chats, a refusal, a 401 says the key is bad, and the no-key message.
//   HF, Gemini  the same adapter shape: the no-key message from the relay's status and from a runner start.
// Every check here runs offline.
import {anthropicAdapter, PRICES, costOf, DEFAULT_MODEL} from './providers/anthropic.mjs';
import {ollamaAdapter} from './providers/ollama.mjs';
import {openaiAdapter, hfAdapter} from './providers/openai.mjs';
import {googleFromEnv} from './providers/google.mjs';
import {makeProviders, PROVIDERS} from './providers/index.mjs';
import {openaiRunner} from './agent-chat.mjs';
import {localTurn} from './local-agent.mjs';
import {startMockOllama} from './mock-ollama.mjs';
import {startMockOpenAI, KEY} from './mock-openai.mjs';
import {MODELS} from '../src/data/prompts.js';
import {PROVIDERS as LIST} from '../src/data/providers.js';

let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const SCHEMA = {type: 'object', properties: {ready: {type: 'boolean'}}, required: ['ready'], additionalProperties: false};
const rejects = async (p, re) => {try {await p; return false} catch (e) {return re.test(String(e.message || e))}};
const sess = () => ({system: 'You are Odette, a player at the table.'});
const game = () => {const calls = []; return {calls, call: async (tool, args) => {calls.push(tool); return tool === 'look' ? {ok: true, phase: 'no game yet', seats: []} : {ok: false, error: 'unknown tool ' + tool}}}};

console.log('the provider list');
ok(JSON.stringify(PROVIDERS) === JSON.stringify(LIST), 'the relay and the shared list name the same providers: ' + LIST.join(', '));

console.log('Claude (a fake client)');
{
  const seen = [], reply = {stop_reason: 'end_turn', content: [{type: 'text', text: '{"ready":true}'}], usage: {input_tokens: 1000, output_tokens: 10}};
  const fake = (r = reply) => ({messages: {create: async b => {seen.push({ns: 'messages', ...b}); return {model: b.model, ...r}}}, beta: {messages: {create: async b => {seen.push({ns: 'beta', ...b}); return {model: b.model, ...r}}}}});
  const ad = anthropicAdapter({client: fake()});
  ok(DEFAULT_MODEL === 'claude-haiku-5-5' && Object.keys(PRICES).join(',') === Object.keys(MODELS).join(','), 'the default is Haiku 5.5 and the prices come from the one model table');
  const h = await ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64, model: 'claude-haiku-5-5'});
  const hb = seen.pop();
  ok(h.text === '{"ready":true}' && hb.ns === 'messages' && hb.thinking && hb.thinking.type === 'disabled' && hb.output_config.format.type === 'json_schema' && hb.output_config.effort === 'low', 'Haiku 5.5: structured output, thinking off, effort low');
  ok(Math.abs(h.usage.cost - (1000 * 0.10 + 10 * 0.50) / 1e6) < 1e-12, `Haiku 5.5 is priced at $0.10 / $0.50 per million ($${h.usage.cost})`);
  ok(Math.abs(costOf('claude-haiku-5-5', 120000, 100) - (120000 * 0.50 + 100 * 2.50) / 1e6) < 1e-12, "past 100k prompt tokens Haiku 5.5 charges its long-prompt rates (the cost cliff)");
  await ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64, model: 'claude-sonnet-5-5'}); const sb = seen.pop();
  ok(sb.ns === 'beta' && sb.thinking.type === 'between_tools' && sb.fallbacks === 'default' && sb.betas.includes('server-side-fallback-2026-07-01'), 'Sonnet 5.5: between_tools and the default refusal fallback');
  await ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64, model: 'claude-opus-5-5'}); const ob = seen.pop();
  ok(!('thinking' in ob) && ob.output_config.effort === 'low', 'Opus 5.5: no thinking field (it cannot be turned off), effort low');
  ok(await rejects(anthropicAdapter({client: fake({...reply, stop_reason: 'refusal'})}).call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64}), /refused/), 'a refusal is an error');
  ok(await rejects(anthropicAdapter({client: fake({...reply, stop_reason: 'max_tokens'})}).call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64}), /cut off/), 'a reply cut at max_tokens is an error');
  const none = anthropicAdapter({client: null}), st = await none.status();
  ok(!none.configured() && st.ok === false && /no ANTHROPIC_API_KEY/.test(st.error), 'without a key: status says "no ANTHROPIC_API_KEY"');
  ok(await rejects(none.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64}), /not configured \(no ANTHROPIC_API_KEY\)/), 'and a call says it is not configured, naming the key');
}

const ol = await startMockOllama(), oa = await startMockOpenAI();
try {
  console.log('Ollama (mock)');
  {
    const ad = ollamaAdapter({url: ol.url, defaultModel: 'mock-tools:1b'});
    const s = await ad.status();
    ok(s.ok && s.models.includes('mock-tools:1b'), `status lists the pulled models (${s.models.length})`);
    const c = await ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 16, model: 'mock-tools:1b'});
    ok(c.text === '{"ready": true}' && c.usage.cost === 0, 'a structured call answers, at no cost');
    const run = async model => {const g = game(), sx = sess(); const st = await localTurn({chat: ad.chat, call: g.call, sess: sx, prompt: 'Turn 1. Look first.', model}); return {st, g, sx}};
    const t = await run('mock-tools:1b');
    ok(t.g.calls[0] === 'look' && t.st.tools === 2 && t.st.rejected === 1 && t.st.narration, `tools mode: look, a bad tool refused before the game, then words ("${t.st.narration}")`);
    const j = await run('mock-json:1b');
    ok(j.st.mode === 'json' && j.g.calls.includes('look'), 'a model without tools plays in JSON-action mode');
    const x = await run('mock-text:1b');
    ok(x.g.calls[0] === 'look', 'a call written as text is understood');
    const z = await run('mock-zh:1b');
    ok(!z.st.narration && z.st.reprompted, 'an answer in another language is kept out of the game and the model is told to answer in English');
    const l1 = await run('mock-loop1:1b');
    ok(l1.g.calls[0] === 'look' && l1.st.loopRetried, 'a generation that loops is retried cooler and plays');
    ok(await rejects(ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 16, model: 'mock-down:1b'}), /ollama/), 'a model that is down is an error');
    const off = await ollamaAdapter({url: 'http://127.0.0.1:9'}).status();
    ok(off.ok === false && /not reachable/.test(off.error || ''), 'no Ollama: status says it is not reachable');
  }

  console.log('OpenAI (mock)');
  {
    const ad = openaiAdapter({apiKey: KEY, baseUrl: oa.url, defaultModel: 'gpt-6-luna'});
    const s = await ad.status();
    ok(s.ok && s.models.includes('gpt-6-luna') && !s.models.some(m => /embedding|whisper|dall-e|moderation|realtime/.test(m)), `status lists chat models only (${s.models.join(', ')})`);
    const c = await ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64, model: 'gpt-6-luna'});
    ok(JSON.parse(c.text).ready === true && c.usage.cost > 0, `a structured call answers and is priced ($${c.usage.cost})`);
    const g = game(), st = await localTurn({chat: ad.chat, call: g.call, sess: sess(), prompt: 'Turn 1.', model: 'gpt-6-luna'});
    ok(g.calls[0] === 'look' && st.cost > 0 && st.costKnown && oa.problems.length === 0, `the tool loop plays and is priced ($${st.cost.toFixed(6)}); the chats are well formed`);
    const u = await localTurn({chat: ad.chat, call: game().call, sess: sess(), prompt: 'Turn 1.', model: 'gpt-future-1'});
    ok(u.costKnown === false, 'a model missing from the price table says its cost is unknown');
    oa.set('refusal'); ok(await rejects(ad.call({system: 's', user: 'u', schema: SCHEMA, maxTokens: 64, model: 'gpt-6-luna'}), /refus/i), 'a refusal is an error'); oa.set('ok');
    const bad = await openaiAdapter({apiKey: 'sk-wrong', baseUrl: oa.url}).status();
    ok(bad.ok === false && /bad or missing key/.test(bad.error || ''), 'a wrong key: status says the key is bad');
    const none = await openaiAdapter({apiKey: null, baseUrl: oa.url}).status();
    ok(none.ok === false && none.error === 'no OPENAI_API_KEY', 'no key: status says "no OPENAI_API_KEY"');
  }

  console.log('no key, every provider');
  {
    const P = makeProviders({anthropicClient: null, env: {OLLAMA_URL: 'http://127.0.0.1:9'}});
    for (const n of ['anthropic', 'openai', 'huggingface', 'google']) {const s = await P[n].status(); ok(s.ok === false && /no [A-Z_]+/.test(s.error || ''), `${n}: ${s.error}`)}
    for (const p of ['openai', 'huggingface', 'google']) {const r = await openaiRunner({provider: p, model: null}, {}); ok(!!r.error && /^No [A-Z_]+ in the environment or \.env/.test(r.error), `a ${p} runner start without a key says: ${r.error.slice(0, 60)}...`)}
    ok(hfAdapter({apiKey: null}).configured() === false && googleFromEnv({}).configured() === false, 'Hugging Face and Gemini are not configured without their keys');
  }
} finally {ol.close(); oa.close()}

console.log(fails ? `${fails} provider check(s) failed` : 'provider check: all ok');
process.exit(fails ? 1 : 0);
