// A mock Ollama server for the checks (providercheck, runnercheck): no Ollama and no model needed. Models: mock-tools (tool
// calling), mock-json (no tool support: 400 on tools), mock-text (writes calls as text), mock-zh (answers in Chinese, never calling a
// tool), mock-loop (Ollama aborts every generation: "token repeat limit reached"), mock-loop1 (aborts every call at the play
// temperature; the cooler retry at 0.4 plays like mock-tools), mock-slow (the start gate's warm-up call answers after WARM_SLOW_MS,
// then plays like mock-tools), mock-down (every call fails). Each turn it plays look, a bad tool (fly), then narrates.
// startMockOllama({embed}) -> {url, seen (every /api/chat body; seen.final counts closing calls, seen.warm the warm-ups), close}
import http from 'node:http';

export const MOCK_MODELS = ['mock-tools:1b', 'mock-json:1b', 'mock-text:1b', 'mock-zh:1b', 'mock-loop:1b', 'mock-loop1:1b', 'mock-slow:1b', 'mock-down:1b'];
export const WARM_SLOW_MS = 2500; // mock-slow's warm-up answer takes this long
// Embeddings: startMockOllama({embed: true}) also lists the model MOCK_EMBED_MODEL and answers POST /api/embed with a
// deterministic concept vector: every word of a text adds to the axes of the MOCK_CONCEPTS groups that hold it (a made-up thesaurus, so
// "the woman at the causeway" lands near "a hermit who counts stones" with no word in common), plus a little hashed noise per word.
// handle.embedState: {delay (ms), fail (HTTP 500), down (drops the connection)}; handle.seen.embed: every /api/embed body.
export const MOCK_EMBED_MODEL = 'nomic-embed-text:latest';
export const MOCK_CONCEPTS = [
  'hermit recluse woman crone stones counts counting pebbles causeway ford bridge crossing keeper',
  'tower clock bell hour chime strike midnight thirteen',
  'debt owe owed gold coins borrowed lender ledger repay payment',
  'grudge feud rival enemy nemesis vengeance revenge hatred sworn',
  'food bread stew inn tavern meal ale supper hearth innkeeper',
  'wolf wolves pack howl fangs hunt hunting beast prowl',
];
const words = t => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
export function mockEmbedVector(text) {
  const v = new Array(MOCK_CONCEPTS.length + 64).fill(0);
  for (const w of words(String(text).replace(/^search_(query|document): /, ''))) {
    MOCK_CONCEPTS.forEach((g, i) => {if (g.split(' ').includes(w)) v[i] += 1});
    let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[MOCK_CONCEPTS.length + (h % 64)] += 0.15;
  }
  return v;
}
export async function startMockOllama({embed = false} = {}) {
  const seen = [], embedState = {delay: 0, fail: false, down: false};
  const plan = {
    tools: [['look'], ['fly']],
    json: [{tool: 'look', args: {}}, {tool: 'end', args: {}, narration: 'The player waited, local and free.'}],
  };
  const server = http.createServer((req, res) => {
    let send = (code, o) => {res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o))};
    if (req.url === '/api/tags') return send(200, {models: (embed ? [...MOCK_MODELS, MOCK_EMBED_MODEL] : MOCK_MODELS).map(name => ({name, model: name}))});
    if (req.url === '/api/embed' && req.method === 'POST') {
      let eb = ''; req.on('data', c => eb += c);
      return void req.on('end', () => {
        const body = JSON.parse(eb); (seen.embed || (seen.embed = [])).push(body);
        if (!embed) return send(404, {error: 'not found'});
        if (embedState.down) return void req.socket.destroy();
        if (embedState.fail) return send(500, {error: 'embedding model failed to load'});
        if (body.model !== MOCK_EMBED_MODEL && body.model !== 'nomic-embed-text') return send(404, {error: 'model "' + body.model + '" not found, try pulling it first'});
        const input = Array.isArray(body.input) ? body.input : [body.input];
        setTimeout(() => send(200, {model: body.model, embeddings: input.map(mockEmbedVector), total_duration: 1, prompt_eval_count: input.length}), embedState.delay);
      });
    }
    if (req.url !== '/api/chat' || req.method !== 'POST') return send(404, {error: 'not found'});
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b); seen.push(body);
      const msgs = body.messages, lastTurn = msgs.map((m, i) => m.role === 'user' && !/^(Result of|That was not)/.test(m.content) ? i : -1).filter(i => i >= 0).pop();
      const after = msgs.slice(lastTurn + 1), done = {done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 20, model: body.model};
      if (body.format && body.format.properties && body.format.properties.ready) { // the start gate's warm-up
        seen.warm = (seen.warm || 0) + 1;
        if (body.model === 'mock-down:1b') return send(500, {error: 'model runner has unexpectedly stopped'});
        const answer = () => send(200, {...done, message: {role: 'assistant', content: '{"ready": true}'}});
        return body.model === 'mock-slow:1b' ? void setTimeout(answer, WARM_SLOW_MS) : answer();
      }
      if (body.model === 'mock-down:1b') return send(500, {error: 'model runner has unexpectedly stopped'});
      if (body.model === 'mock-loop:1b' || body.model === 'mock-loop1:1b' && body.options && body.options.temperature !== 0.4) {
        seen.loop = (seen.loop || 0) + 1;
        return send(500, {error: 'an error was encountered while running the model: prediction aborted, token repeat limit reached'});
      }
      if (body.model === 'mock-json:1b') {
        if (body.tools) return send(400, {error: `registry.ollama.ai/library/mock-json does not support tools`});
        const n = after.filter(m => m.role === 'assistant').length;
        return send(200, {...done, message: {role: 'assistant', content: JSON.stringify({narration: '', ...plan.json[Math.min(n, plan.json.length - 1)]})}});
      }
      const n = after.filter(m => m.role === 'assistant').length;
      if (body.model === 'mock-zh:1b') // answers in Chinese, never calling a tool
        return send(200, {...done, message: {role: 'assistant', content: '我会先看看桌上的情况。'}});
      if (!body.tools) seen.final = (seen.final || 0) + 1; // the closing call after a wait: words only
      if (n >= plan.tools.length || !body.tools) return send(200, {...done, message: {role: 'assistant', content: 'The player looked about the table.'}});
      const [name, args = {}] = plan.tools[n];
      if (body.model === 'mock-text:1b') return send(200, {...done, message: {role: 'assistant', content: `<tool_call>${JSON.stringify({name, arguments: args})}</tool_call>`}});
      send(200, {...done, message: {role: 'assistant', content: '', tool_calls: [{function: {name, arguments: args}}]}});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}`, seen, embedState, close: () => server.close()};
}
