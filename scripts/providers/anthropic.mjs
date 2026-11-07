// Anthropic adapter: one structured-output call to Claude. Structured output through output_config.format (json_schema),
// effort low, no retries, hard abort. Thinking: 'disabled' on Haiku 5.5 (accepted at effort high or below); Sonnet 5.5 rejects
// 'disabled', so it gets 'between_tools' plus the server-side refusal fallback through the beta namespace; Opus 5.5 rejects any
// way of turning thinking off, so it gets none and low effort keeps it short.
// Model ids and prices come from the claude-api skill (cached 2026-10-06).
//
// Adapter interface shared by every provider in scripts/providers/:
//   {name, local, configured(), status() -> Promise<{ok, models, default?, error?}>,
//    call({system, user, schema, maxTokens, model, effort, signal, timeoutMs}) -> Promise<{json, text, usage:{in,out,cost}, model, ms}>}
// call() throws an Error on any failure; err.raw carries the model's text when there was some.

import {MODELS, DEFAULT_CLAUDE_MODEL, priceOf} from '../../src/data/prompts.js';
export const DEFAULT_MODEL = DEFAULT_CLAUDE_MODEL;
export const PRICES = Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, {in: m.in, out: m.out}])); // $ per 1M tokens (src/data/prompts.js MODELS)
export const costOf = priceOf; // the long-prompt rates of Haiku 5.5 past 100k included

const fail = (msg, raw) => Object.assign(new Error(msg), raw != null ? {raw} : {});

// client: the @anthropic-ai/sdk client (or a fake with messages.create in tests); null when no key.
export function anthropicAdapter({client = null, defaultModel = DEFAULT_MODEL, allow = null} = {}) {
  const listed = () => allow && allow.length ? allow.filter(m => PRICES[m]) : Object.keys(PRICES); // ANTHROPIC_MODELS: only models the price table knows
  return {
    name: 'anthropic', local: false, defaultModel,
    configured: () => !!client,
    status: async () => client ? {ok: true, models: listed(), prices: PRICES, default: defaultModel} : {ok: false, models: [], error: 'no ANTHROPIC_API_KEY'},
    async call({system, user, schema, maxTokens, model, effort = 'low', signal, timeoutMs}) {
      if (!client) throw fail('anthropic is not configured (no ANTHROPIC_API_KEY)');
      const mdl = model || defaultModel, t0 = Date.now();
      const req = {
        model: mdl, max_tokens: maxTokens,
        system,
        thinking: {type: 'disabled'},
        output_config: {effort, format: {type: 'json_schema', schema}},
        messages: [{role: 'user', content: user}],
      };
      let call = client.messages;
      if (mdl.startsWith('claude-opus-5-5')) delete req.thinking; // 400 on 'disabled' at any effort
      if (mdl.startsWith('claude-sonnet-5-5')) {
        // Sonnet 5.5 rejects thinking 'disabled'; 'between_tools' is its no-extended-thinking setting (effort high or
        // below). Server-side refusal fallback ("default" form, Claude API only) through the beta namespace when present.
        req.thinking = {type: 'between_tools'};
        if (client.beta && client.beta.messages) {call = client.beta.messages; req.betas = ['server-side-fallback-2026-07-01']; req.fallbacks = 'default'}
      }
      const res = await call.create(req, {signal, timeout: timeoutMs, maxRetries: 0});
      const billed = res.model && PRICES[res.model] ? res.model : mdl;
      const u = res.usage || {}, usage = {in: u.input_tokens || 0, out: u.output_tokens || 0, cost: costOf(billed, u.input_tokens || 0, u.output_tokens || 0)};
      const block = (res.content || []).find(b => b.type === 'text'), text = block ? block.text : null;
      const out = {text, usage, model: billed, ms: Date.now() - t0};
      if (res.stop_reason === 'refusal') throw Object.assign(fail('model refused', text), {result: out});
      if (res.stop_reason === 'max_tokens') throw Object.assign(fail('reply cut off', text), {result: out});
      if (!block) throw Object.assign(fail('no text in reply'), {result: out});
      return out;
    },
  };
}
