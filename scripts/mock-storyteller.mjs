// What the mock provider servers (mock-openai, providercheck) share: a schema answered by its own shape, the turn a Storyteller mock
// plays, and the request rules the real APIs enforce.
const WORDS = ['rain', 'stone', 'lantern', 'crow', 'ember', 'moss', 'iron', 'tide', 'bell', 'thorn', 'ash', 'reed', 'salt', 'owl', 'frost', 'hearth'];
let said = 0;
const line = () => {said++; return ['The', ...Array.from({length: 7}, (_, i) => WORDS[(said * 5 + i * (said % 7 + 1)) % WORDS.length])].join(' ') + ' ' + said + '.'};
export function schemaFill(s) {
  if (!s || typeof s !== 'object') return null;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.type === 'object') return Object.fromEntries(Object.keys(s.properties || {}).map(k => [k, schemaFill(s.properties[k])]));
  if (s.type === 'array') return [];
  if (s.type === 'boolean') return true;
  if (s.type === 'number' || s.type === 'integer') return 0;
  return line();
}
// OpenAI's strict mode refuses a schema with an open object or a property left out of required. -> the first problem, or null
export function strictProblem(s, at = 'schema') {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'object') {
    if (s.additionalProperties !== false) return at + ': additionalProperties must be false';
    const keys = Object.keys(s.properties || {}), req = s.required || [];
    if (keys.some(k => !req.includes(k))) return at + ': every property must be required';
    for (const k of keys) {const p = strictProblem(s.properties[k], at + '.' + k); if (p) return p}
  }
  if (s.type === 'array') {if (!s.items) return at + ': an array needs items'; return strictProblem(s.items, at + '[]')}
  if (Array.isArray(s.enum) && !s.enum.length) return at + ': an empty enum';
  return null;
}
// The request rules of Chat Completions' tools, as the API answers them: -> the error message for a 400, or null.
export function toolsProblem(body) {
  for (const [i, t] of (body.tools || []).entries()) {const d = t.function && t.function.description || '';
    if (d.length > 1024) return `Invalid 'tools[${i}].function.description': string too long. Expected a string with maximum length 1024, but got a string with length ${d.length} instead.`}
  if ((body.tools || []).length > 128) return "Invalid 'tools': array too long. Expected an array with maximum length 128.";
  return null;
}
export const isStorytellerTurn = body => (body.messages || []).some(m => m.role === 'system' && /Storyteller of/.test(String(m.content || '')));
const PLAN = ['look'];
let callId = 0;
// A Storyteller's turn: looks at the game, then one sentence. -> the assistant message
export function storytellerTurnMessage(body) {
  const last = body.messages.map((m, i) => m.role === 'user' && !/^Result of/.test(m.content) ? i : -1).filter(i => i >= 0).pop();
  const n = body.messages.slice(last + 1).filter(m => m.role === 'assistant').length;
  if (n >= PLAN.length) return {role: 'assistant', content: line()}; // never the same twice: a repeat is an empty turn
  return {role: 'assistant', content: null, tool_calls: [{id: 'call_st' + (++callId), type: 'function', function: {name: PLAN[n], arguments: '{}'}}]};
}
