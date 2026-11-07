// A mock OpenAI server for tests (scripts/providercheck.mjs): no network and no key. Speaks the two
// endpoints the adapter uses, under /v1: GET /models and POST /chat/completions.
//   KEY            the only key it accepts (Authorization: Bearer sk-test-key); anything else is a 401
//   models         MODELS: chat models plus ids the adapter must filter out (embeddings, speech, images, moderation, realtime, codex)
//   mode           'ok' | 'refusal' | 'length' | 'invalid' (a choice outside the options) | 'rate' (429 with retry-after: 1, `rateLeft` times)
//   model 'gpt-4o-mini' rejects reasoning_effort (400), like a model that predates it; 'gpt-future-1' is not in the price table
// Structured requests (response_format json_schema) are answered from the schema, as OpenAI's strict
// mode would. Tool requests play a scripted turn: look, a bad tool (fly), then words.
// The server checks the chat shape the real API demands and records `problems`: every tool message
// must answer a tool_call id of the assistant message before it, ids unique, arguments JSON strings.
// startMockOpenAI() -> {url (the base, ends in /v1), seen (every chat body), problems, set(mode, n), close()}
import http from 'node:http';
import {schemaFill, toolsProblem, isStorytellerTurn, storytellerTurnMessage, strictProblem} from './mock-storyteller.mjs';

export const KEY = 'sk-test-key';
export const MODELS = ['gpt-6-luna', 'gpt-6-astra', 'gpt-4o-mini', 'gpt-future-1', 'text-embedding-3-small', 'whisper-1', 'dall-e-3', 'omni-moderation-latest', 'gpt-4o-realtime-preview', 'gpt-5.3-codex'];
const answer = f => schemaFill(f); // a structured answer from its own schema
const PLAN = [['look'], ['fly']];

export async function startMockOpenAI() {
  const st = {mode: 'ok', rateLeft: 0, cached: 0}, seen = [], problems = [], auths = [];
  const server = http.createServer((req, res) => {
    const send = (code, o, h = {}) => {res.writeHead(code, {'content-type': 'application/json', ...h}); res.end(JSON.stringify(o))};
    auths.push(req.headers.authorization || '');
    if (req.headers.authorization !== 'Bearer ' + KEY) return send(401, {error: {message: 'Incorrect API key provided: ' + String(req.headers.authorization || '').replace('Bearer ', '') + '. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', code: 'invalid_api_key'}});
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, {object: 'list', data: MODELS.map(id => ({id, object: 'model'}))});
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, {error: {message: 'not found'}});
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b); seen.push(body);
      if (body.model === 'gpt-4o-mini' && 'reasoning_effort' in body) return send(400, {error: {message: "Unrecognized request argument supplied: reasoning_effort", type: 'invalid_request_error'}});
      if (!MODELS.includes(body.model)) return send(404, {error: {message: `The model \`${body.model}\` does not exist or you do not have access to it.`, code: 'model_not_found'}});
      if (st.mode === 'rate' && st.rateLeft > 0) {st.rateLeft--; return send(429, {error: {message: 'Rate limit reached for ' + body.model + ' in organization org-x on requests per min.', type: 'requests', code: 'rate_limit_exceeded'}}, {'retry-after': '1'})}
      if (st.mode === 'quota') return send(429, {error: {message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota'}});
      // the shape the real API enforces on tool messages
      const ids = new Set(), open = [];
      for (const m of body.messages) {
        if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) {
          if (ids.has(c.id)) problems.push('duplicate tool_call id ' + c.id); ids.add(c.id); open.push(c.id);
          if (c.type !== 'function' || typeof c.function.arguments !== 'string') problems.push('tool_call ' + c.id + ' is not a function call with string arguments');
        } else if (m.role === 'tool') {
          if (!m.tool_call_id || !open.includes(m.tool_call_id)) problems.push('tool message answers no open call: ' + m.tool_call_id); else open.splice(open.indexOf(m.tool_call_id), 1);
        } else if (open.length) problems.push('assistant tool calls unanswered before a ' + m.role + ' message: ' + open.join(','));
      }
      const tp = toolsProblem(body); if (tp) return send(400, {error: {message: tp, type: 'invalid_request_error'}});
      const sp = body.response_format && body.response_format.type === 'json_schema' && strictProblem(body.response_format.json_schema.schema); if (sp) return send(400, {error: {message: 'Invalid schema for response_format: ' + sp, type: 'invalid_request_error'}});
      const usage = {prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, ...(st.cached ? {prompt_tokens_details: {cached_tokens: st.cached}} : {})}; // st.cached
      const reply = (message, finish = 'stop') => send(200, {id: 'chatcmpl-mock', object: 'chat.completion', model: body.model + '-2026-01-01', usage, choices: [{index: 0, finish_reason: finish, message}]});
      if (st.mode === 'refusal') return reply({role: 'assistant', content: null, refusal: "I can't help with that."});
      if (st.mode === 'length') return reply({role: 'assistant', content: '{"choice":"Thorn'}, 'length');
      const rf = body.response_format;
      if (rf && rf.type === 'json_schema') {
        const a = answer(rf.json_schema.schema);
        return reply({role: 'assistant', content: JSON.stringify(a), refusal: null});
      }
      if (rf && rf.type === 'json_object') return reply({role: 'assistant', content: JSON.stringify({tool: 'end', args: {}, narration: 'The player waited.'})});
      if (isStorytellerTurn(body)) {const m = storytellerTurnMessage(body); return reply(m, m.tool_calls ? 'tool_calls' : 'stop')}
      // a scripted agent turn: count the assistant tool-call messages since the last plain user message
      const last = body.messages.map((m, i) => m.role === 'user' && !/^Result of/.test(m.content) ? i : -1).filter(i => i >= 0).pop();
      const n = body.messages.slice(last + 1).filter(m => m.role === 'assistant').length;
      if (!body.tools || n >= PLAN.length) return reply({role: 'assistant', content: 'The player looked about the table.'});
      const [name, args = {}] = PLAN[n];
      reply({role: 'assistant', content: null, tool_calls: [{id: 'call_srv' + seen.length, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}, 'tool_calls');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, seen, problems, auths, set: (mode, n = 0) => {st.mode = mode; st.rateLeft = n}, setCached: n => {st.cached = n}, close: () => server.close()};
}
