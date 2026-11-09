// A fake Claude Agent SDK for the checks (npm run mockgamecheck): the runners load it instead of @anthropic-ai/claude-agent-sdk
// when CLOCKTOWER_FAKE_SDK names this file (scripts/claude-turn.mjs loadSdk; only a module under scripts/ is accepted). No key,
// no network beyond the relay, no model: query() plays the turn with the mock mind (scripts/mock-mind.mjs) through the seat's own
// MCP server (the URL and headers the runner passes, so the relay's claims and walls apply), and reports the messages the real
// SDK streams: system init, assistant messages with tool_use blocks and usage, user messages with tool_result blocks, the last
// words, and a result with the session's cumulative cost and modelUsage (as the real one: cumulative, read the latest).
// Usage per model call: FAKE_USAGE below, with the cached prompt growing per call so a session grows and rolls as a real one
// does. Prices from src/data/prompts.js (MODELS), so a dearer model crosses a budget sooner.
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {nextCall} from './mock-mind.mjs';
import {MODELS} from '../src/data/prompts.js';

export const FAKE_USAGE = {in: 300, out: 80, cache0: 1500, grow: 500};
const sessions = new Map(); // session id -> {calls, cost, usage}
// Sessions outlive the process as the real SDK's do (a resumed session carries its context): kept under AGENT_LOGS when the
// checks set it, so a check can tell a resumed session (its context grows on) from a fresh one (#66).
const store = process.env.AGENT_LOGS ? join(process.env.AGENT_LOGS, 'fake-sdk') : null, fileOf = sid => join(store, String(sid).replace(/[^A-Za-z0-9_-]+/g, '_') + '.json');
const stored = sid => {try {return store && existsSync(fileOf(sid)) ? JSON.parse(readFileSync(fileOf(sid), 'utf8')) : null} catch {return null}};
const keep = (sid, S) => {if (!store) return; try {mkdirSync(store, {recursive: true}); writeFileSync(fileOf(sid), JSON.stringify(S))} catch {}};

let ids = 0;
const price = (model, u) => {const m = MODELS[model] || MODELS['claude-haiku-5-5'];
  return (u.input_tokens * m.in + u.cache_read_input_tokens * (m.cacheRead ?? m.in * .1) + u.output_tokens * m.out) / 1e6};

// The warm-up call of the start gate (scripts/warmup.mjs): nothing to warm.
export async function warm() {}

export function query({prompt, options = {}}) {
  const o = options, srv = (o.mcpServers && Object.values(o.mcpServers)[0]) || null, model = o.model || 'claude-haiku-5-5';
  const kind = /Storyteller of/.test(String(o.systemPrompt || '')) ? 'storyteller' : 'player';
  const sid = o.resume && sessions.has(o.resume) ? o.resume : o.resume || `fake-${process.pid}-${++ids}`;
  const S = sessions.get(sid) || (o.resume && stored(sid)) || {calls: 0, cost: 0, usage: {inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0}};
  sessions.set(sid, S);
  const signal = o.abortController && o.abortController.signal;
  const usage = () => {S.calls++; const u = {input_tokens: FAKE_USAGE.in, output_tokens: FAKE_USAGE.out, cache_read_input_tokens: FAKE_USAGE.cache0 + FAKE_USAGE.grow * S.calls, cache_creation_input_tokens: 0};
    S.cost += price(model, u); S.usage.inputTokens += u.input_tokens; S.usage.outputTokens += u.output_tokens; S.usage.cacheReadInputTokens += u.cache_read_input_tokens; return u};
  const mcp = async (name, args) => {
    const r = await fetch(srv.url, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(srv.headers || {})},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}), signal: AbortSignal.timeout(srv.timeout || 30000)});
    const j = await r.json().catch(() => ({}));
    if (!j.result) return {text: JSON.stringify({ok: false, error: j.error ? j.error.message : 'HTTP ' + r.status}), isError: true};
    return {text: (j.result.content || []).map(c => c.text || '').join(''), isError: !!j.result.isError};
  };
  return (async function* () {
    if (!srv) throw new Error('fake SDK: no MCP server given');
    yield {type: 'system', subtype: 'init', session_id: sid, model};
    const seen = []; let n = 0;
    void prompt;
    for (;;) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
      const step = nextCall(kind, seen); n++;
      if (step.text || n > (o.maxTurns || 12)) {
        yield {type: 'assistant', parent_tool_use_id: null, message: {id: `msg-${sid}-${S.calls + 1}`, content: [{type: 'text', text: step.text || 'The turn ends.'}], usage: usage()}};
        break;
      }
      const id = `tu-${sid}-${S.calls + 1}`;
      yield {type: 'assistant', parent_tool_use_id: null, message: {id: `msg-${sid}-${S.calls + 1}`, content: [{type: 'tool_use', id, name: 'mcp__clocktower__' + step.tool, input: step.args}], usage: usage()}};
      const r = await mcp(step.tool, step.args);
      let result = null; try {result = JSON.parse(r.text)} catch {}
      seen.push({tool: step.tool, args: step.args, result});
      yield {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: id, content: [{type: 'text', text: r.text}], is_error: r.isError}]}};
    }
    keep(sid, S);
    yield {type: 'result', subtype: 'success', num_turns: n, total_cost_usd: S.cost, modelUsage: {[model]: {...S.usage}}, session_id: sid};
  })();
}
