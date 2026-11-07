// The local agent loop: plays one seat's turn with a local model (Ollama) or a model behind a Chat Completions API (OpenAI, the
// Hugging Face router, Gemini) through the same game tools a Claude runner uses (src/data/player-tools.js, called via
// POST /play/call). scripts/seat-runner.mjs uses it for every provider but Claude.
//
// One turn = a small tool-calling loop: send the conversation with the tools to the model, run the tool calls the model makes
// (validated against the tool table first; a bad call goes back to the model as an error, never to the game), feed the results
// back, and stop when the model answers in plain text (its narration) or after toolTurns model calls.
// Models without tool support (Ollama answers "does not support tools") switch to a JSON-action mode: the tool list goes into the
// prompt and every reply is forced (Ollama `format` = a JSON schema) into {tool, args, narration}; tool "end" closes the turn. The
// mode is kept per seat. A model that writes its call as text (<tool_call>{...}</tool_call>, bare {"name","arguments"}, or
// name("a", "b") / name({...}) inside its narration) is understood too, and the narration it shows is cleaned of written calls and
// made-up labels ("CallCheck...").
//
// History: the seat's conversation lives compactly in its session file (sess.local.history, no system prompt, tool results cut to
// keptChars); when it grows past historyChars the oldest whole turns are dropped. Local calls cost nothing: the loop counts tokens
// and seconds instead; a paid provider reports its cost per call.
// Plain Node, no SDK import.
import {PLAYER_TOOLS, ATTEMPT_INVITE} from '../src/data/player-tools.js';

// temperature/repeatPenalty: a local model looping on one plan, or drifting into another language, is
// nudged out of it; freshAfter: that many empty turns in a row and the next turn starts with a fresh context.
export const LOCAL_DEFAULTS = {historyChars: 24000, resultChars: 1800, keptChars: 400, maxTokens: 700, callsPerReply: 3, endOnWait: true, temperature: 0.6, repeatPenalty: 1.15, freshAfter: 2,
  // the circuit breaker (a local Storyteller sent 21 calls in one turn, all refused): the turn ends after sameRefusals
  // refusals of one tool or consecutiveRefusals refusals in a row; callsPerMin caps one session's tool calls over any real
  // minute, across turns (the relay flags more than 90 as a request flood)
  sameRefusals: 3, consecutiveRefusals: 5, callsPerMin: 60};
// What the next turn is told after the breaker or the minute cap ended one (kept in the history as a user line).
export const BREAK_NOTE = 'Your last turn ended early: these calls kept failing. Read the refusal, then do one small thing that fits it, or wait.';
export const THROTTLE_NOTE = 'Your last turn ended early: too many calls in one minute. Next turn, make one or two deliberate calls.';
const CALL_TIMES = new WeakMap(); // sess -> times of its recent tool calls (this runner process only, not saved)
// A turn whose first answer is words without a tool call gets this once (a small model narrated
// a long-over fight for 100 turns without acting).
export const REPROMPT = 'Act through a tool (look first). Words alone change nothing in the game; make one call now.';
// Two narrations this alike (shared words) count as a repeat; a repeat with no game-changing call is an empty turn.
export const REPEAT_SIM = 0.8;
export function similar(a, b) {
  const w = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(x => x.length > 2));
  const A = w(a), B = w(b); if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(A.size, B.size);
}
export const REPROMPT_EN = 'Answer in English only, and act through a tool (look first).';
export {notEnglish} from '../src/game/lang.js';
// Chatbot voice: a small model that answers a refused or late tool result as if it were the user ("It seems like
// your last action was after your recent turn ended... What would you like to do next?"). Detected in the narration only,
// by phrases a player in character does not say; a player asking a companion "what should we do next?" is not flagged.
export const REPROMPT_VOICE = 'That was not a message from a person: it was the game. Do not answer it. Act through a tool, or end with one short sentence in the third person about what you did.';
const CHATBOT = [
  /\bwhat would you like to (?:do|try|know|see|ask)\b/i,
  /\bplease let me know\b/i,
  /\blet me know (?:what|which|how long|how you|whether|if you(?:'d| would) like)\b/i,
  /\bcould you (?:please )?(?:specify|clarify|provide|confirm)\b/i,
  /\bit (?:seems|appears|looks) like (?:you|your)\b/i,
  /\bit (?:seems|appears) (?:that )?(?:you(?:'re| are| want| need| haven't| tried| asked)\b|your (?:last|previous|recent|action|request|input|turn))/i,
  /\b(?:your|you(?:'ve)? (?:made|taken|used)) (?:last|previous|recent|latest) (?:action|turn|command|call|request|input)\b/i,
  /\bhere are (?:your|the) (?:options|choices|available (?:actions|options))\b/i,
  /\byou can (?:check|try|either|then|also|choose|use|specify|provide|review|continue|interact|wait)\b/i,
  /\bif you(?:'d| would) like to (?:review|continue|proceed|try|see|know|wait|check|explore|do|take|act)\b/i,
  /\b(?:the|this) (?:game|system|function|tool|response) (?:is expecting|requires|indicates|shows|returned)\b/i,
  /\bas an ai\b|\bi(?:'m| am) (?:just )?an? (?:ai|language model|assistant)\b|\bhow (?:can|may) i (?:help|assist) you\b/i,
];
export function chatbotVoice(text) {const t = String(text || ''); return t.length >= 20 && CHATBOT.some(r => r.test(t))}
const VOICE_MARK = '(not narration)';
const TOOL_NOTE = ' (A refusal from the game, not a message from a person: do not reply to it; act through a tool or end your turn.)';
import {notEnglish} from '../src/game/lang.js';
export const LOCAL_RULES = '\n\nHow your turns work here: call one tool at a time and read its result before the next. When you have given your command and waited, end the turn by replying with one short sentence of narration in plain text (no tool call). Write and speak only in English.';

const BY_NAME = new Map(PLAYER_TOOLS.map(t => [t.name, t]));
// Another tool table (the Storyteller's, src/data/storyteller-tools.js) can be passed as `list` / `tools`.
const MAPS = new WeakMap(); const byName = list => {if (!list || list === PLAYER_TOOLS) return BY_NAME; let m = MAPS.get(list); if (!m) {m = new Map(list.map(t => [t.name, t])); MAPS.set(list, m)} return m};
const jsonType = a => a.type === 'integer' ? 'integer' : a.type === 'number' ? 'number' : a.type === 'object' ? 'object' : a.type === 'array' ? 'array' : 'string';

// The tool table as Ollama function tools.
export function ollamaTools(list = PLAYER_TOOLS) {
  return list.map(t => ({type: 'function', function: {name: t.name, description: t.desc, parameters: {type: 'object',
    properties: Object.fromEntries(Object.entries(t.args || {}).map(([k, a]) => [k, {type: jsonType(a), description: a.desc || k, ...(a.type === 'array' ? {items: {type: 'string'}} : {}), ...(a.enum ? {enum: a.enum} : {})}])),
    required: Object.entries(t.args || {}).filter(([, a]) => !a.optional).map(([k]) => k)}}}));
}

// A model's arguments checked against the tool table: {args} or {error}. Numbers given as strings are
// coerced, unknown keys dropped, enums and required arguments enforced. The game validates again.
const wishInviteOnce = () => '';
export function cleanArgs(name, raw, list = PLAYER_TOOLS) {
  const M = byName(list), t = M.get(name);
  // a Storyteller calling a game lever by name (post_hook, mark_place) is pointed at pull_lever
  if (!t) return {error: `unknown tool "${name}". ${M.has('attempt') ? ATTEMPT_INVITE + ' ' : ''}Tools: ${[...M.keys()].join(', ')}` + (M.has('pull_lever') ? `. If "${name}" is a game lever (see levers), pull it through pull_lever: {"lever":"${name}","params":{...},"reason":"one sentence"}` : '') + (M.has('wish') ? wishInviteOnce() : '')};
  let a = raw; if (typeof a === 'string') {try {a = a.trim() ? JSON.parse(a) : {}} catch {return {error: 'arguments are not valid JSON'}}}
  if (a == null) a = {}; if (typeof a !== 'object' || Array.isArray(a)) return {error: 'arguments must be an object'};
  // a tool with one object argument (pull_lever's params): keys the tool does not take are that object's, not dropped
  const objKeys = Object.entries(t.args || {}).filter(([, s]) => s.type === 'object').map(([k]) => k);
  if (objKeys.length === 1) {const k = objKeys[0], extra = Object.keys(a).filter(x => !(x in (t.args || {})));
    if (extra.length) {let base = a[k]; if (typeof base === 'string') {try {base = base.trim() ? JSON.parse(base) : {}} catch {base = null}}
      if (base == null || (typeof base === 'object' && !Array.isArray(base))) {a = {...a, [k]: {...Object.fromEntries(extra.map(x => [x, a[x]])), ...(base || {})}}}}}
  const out = {};
  for (const [k, spec] of Object.entries(t.args || {})) {
    let v = a[k];
    if (v == null || v === '') {if (!spec.optional) return {error: `${name} needs "${k}" (${spec.desc || k})`}; continue}
    if (spec.type === 'object') {if (typeof v === 'string') {try {v = JSON.parse(v)} catch {return {error: `"${k}" must be a JSON object`}} } if (!v || typeof v !== 'object' || Array.isArray(v)) return {error: `"${k}" must be an object`}}
    else if (spec.type === 'array') {if (typeof v === 'string') {const t = v.trim(); try {v = t.startsWith('[') ? JSON.parse(t) : t.split(',')} catch {v = t.split(',')}} if (!Array.isArray(v)) v = [v]; v = v.map(x => String(x).trim()).filter(Boolean).slice(0, 12)}
    else if (spec.type === 'integer' || spec.type === 'number') {const n = Number(v);
      if (!Number.isFinite(n)) { // a name where an id goes: hand it to the tool's name argument when it has one
        const alt = typeof v === 'string' && (/_id$/.test(k) ? ['target', 'to', 'who'] : k === 'index' ? ['item'] : []).find(x => t.args[x] && t.args[x].type === 'string' && a[x] == null); // give's index as a name
        if (alt) {out[alt] = v.trim().slice(0, 60); continue}
        return {error: `"${k}" must be a number`}}
      v = spec.type === 'integer' ? Math.round(n) : n}
    else v = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (spec.enum && !spec.enum.includes(v)) return {error: `"${k}" must be one of ${spec.enum.join(', ')}`};
    out[k] = v;
  }
  return {args: out};
}

// The JSON-action fallback: the tool list as text, and the schema each reply must follow.
export function actionCatalogue(list = PLAYER_TOOLS) {
  return list.map(t => `- ${t.name}(${Object.entries(t.args || {}).map(([k, a]) => k + (a.optional ? '?' : '') + ': ' + (a.enum ? a.enum.join('|') : a.type)).join(', ')}): ${t.desc}`).join('\n');
}
export const actionSchema = (list = PLAYER_TOOLS) => ({type: 'object', properties: {
  tool: {type: 'string', enum: [...list.map(t => t.name), 'end']}, args: {type: 'object'}, narration: {type: 'string'}}, required: ['tool', 'args', 'narration']});
export const JSON_RULES = 'You cannot call tools directly. Answer every message with ONE JSON object: {"tool": a tool name, "args": {its arguments}, "narration": ""}. The result comes back in the next message. To end your turn answer {"tool": "end", "args": {}, "narration": "one sentence of what you did and why"}.\n\nTools:\n';

// A tool call written as text: <tool_call>{"name":..,"arguments":..}</tool_call>, or the bare object.
export function parseTextCall(content, list = PLAYER_TOOLS) {
  const BY_NAME = byName(list);
  const s = String(content || '').trim(); if (!s) return null;
  const m = s.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/) || (s.startsWith('{') ? [null, s] : null);
  if (!m) return null;
  try {const j = JSON.parse(m[1]); const name = j.name || (j.function && j.function.name); if (typeof name !== 'string' || !(BY_NAME.has(name) || 'arguments' in j || 'parameters' in j)) return null; // an unknown name with arguments is still a call (it is rejected with the tool list)
    return {function: {name, arguments: j.arguments ?? j.parameters ?? (j.function && j.function.arguments) ?? {}}}} catch {return null}
}

// Calls written into the narration (a 14B model wrote `(scene_act("strike", "I'll take care of this boar."))`
// as text, then called wait): <tool_call>{...}</tool_call>, a bare {"name","arguments"} reply, and name(...) for a
// known tool, where (...) is a JSON object, key=value pairs or positional literals mapped onto the tool's argument
// order. Only literals count: `scene_act(option, line)` (bare words, the model quoting the rules) is not a call.
// -> [{function: {name, arguments}, start, end}] in text order (start/end: the span to cut from the narration).
export function parseTextCalls(content, list = PLAYER_TOOLS) {
  const M = byName(list), s = String(content || ''), out = [];
  if (!/<tool_call>/.test(s)) {const one = parseTextCall(s, list); if (one) return [{...one, start: 0, end: s.length}]} // the whole reply is one call object
  for (const m of s.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {const c = parseTextCall(m[0], list); if (c) out.push({...c, start: m.index, end: m.index + m[0].length})}
  // a fenced block inside prose (44 Storyteller calls were lost): ```json {"name":"stage_scene","arguments":{...}} ```,
  // also {"tool","args"}, {"function":{...}} and a list of them; a fence that is not a call stays narration
  for (const m of s.matchAll(/```[ \t]*([A-Za-z_]*)[ \t]*\r?\n?([\s\S]*?)```/g)) {
    if (out.some(c => m.index >= c.start && m.index < c.end)) continue;
    const cs = fencedCalls(m[2], M); if (!cs.length) continue;
    out.push(...cs.map((c, i) => ({function: c, start: m.index + i, end: i === cs.length - 1 ? m.index + m[0].length : m.index + i + 1})));
  }
  // a bare call object inside the text, often behind a junk word and before a stray </tool_call> (live:
  // `Fragistics {"name": "fight", "arguments": {"target_id": 1}} </tool_call>` while a Timber Wolf attacked): it runs
  for (const m of s.matchAll(/\{\s*"(?:name|function|tool)"\s*:/g)) {
    if (out.some(c => m.index >= c.start && m.index < c.end)) continue;
    const close = matchClose(s, m.index); if (close < 0) continue;
    let j; try {j = JSON.parse(s.slice(m.index, close + 1))} catch {continue}
    const f = j && j.function && typeof j.function === 'object' ? j.function : j;
    if (!j || !('arguments' in f || 'parameters' in f || 'args' in j)) continue; // an object that merely has a name is prose
    const cs = fencedCalls(JSON.stringify(j), M); if (cs.length !== 1) continue;
    let start = m.index, end = close + 1;
    const pre = /(^|\n)[ \t]*[A-Za-z_][\w-]*[ \t]*=?[ \t]*$/.exec(s.slice(0, start)); if (pre) start = pre.index + pre[1].length; // the junk word before it on its line
    const post = /^\s*<\/tool_call>/.exec(s.slice(end)); if (post) end += post[0].length;
    out.push({function: cs[0], start, end});
  }
  const names = [...M.keys()].filter(n => /^\w+$/.test(n)).sort((a, b) => b.length - a.length);
  const re = new RegExp('(?<![\\w.])(' + names.join('|') + ')\\s*\\(', 'g');
  for (const m of s.matchAll(re)) {
    const open = m.index + m[0].length - 1, close = matchParen(s, open); if (close < 0) continue;
    if (out.some(c => m.index >= c.start && m.index < c.end)) continue;
    const args = literalArgs(s.slice(open + 1, close), M.get(m[1])); if (!args) continue;
    let start = m.index, end = close + 1; // a call wrapped in its own parentheses or backticks goes with them
    while (start > 0 && end < s.length && ((s[start - 1] === '(' && s[end] === ')') || (s[start - 1] === '`' && s[end] === '`'))) {start--; end++}
    out.push({function: {name: m[1], arguments: args}, start, end});
  }
  return out.sort((a, b) => a.start - b.start);
}
// The calls in one fenced block: a JSON object or a list of them, each {name|tool, arguments|parameters|args} or
// {function: {name, arguments}}. A name the tools do not know counts only with arguments (rejected with the list).
function fencedCalls(body, M) {
  let j; try {j = JSON.parse(String(body || '').trim())} catch {return []}
  const one = x => {if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const f = x.function && typeof x.function === 'object' ? x.function : x, name = f.name || x.tool || x.name;
    if (typeof name !== 'string' || !name) return null;
    const hasArgs = 'arguments' in f || 'parameters' in f || 'args' in x;
    if (!M.has(name) && !hasArgs) return null;
    let args = f.arguments ?? f.parameters ?? x.args ?? {};
    if (typeof args === 'string') {try {args = args.trim() ? JSON.parse(args) : {}} catch {}}
    return {name, arguments: args}};
  const xs = Array.isArray(j) ? j : [j], out = [];
  for (const x of xs) {const c = one(x); if (!c) return []; out.push(c)}
  return out;
}
// The index of the bracket closing the one at i (any of ([{), skipping strings; -1 when it never closes.
function matchClose(s, i) {
  let depth = 0, q = null;
  for (let k = i; k < s.length; k++) {const c = s[k];
    if (q) {if (c === '\\') k++; else if (c === q) q = null; continue}
    if (c === '"') q = c; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c) && --depth === 0) return k}
  return -1;
}
function matchParen(s, i) {
  let depth = 0, q = null;
  for (let k = i; k < s.length; k++) {const c = s[k];
    if (q) {if (c === '\\') k++; else if (c === q) q = null; continue}
    if (c === '"') q = c; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c) && --depth === 0) return c === ')' ? k : -1}
  return -1;
}
// The inside of name(...) as arguments, or null when it is not made of literals.
function literalArgs(inner, tool) {
  const t = inner.trim(), keys = Object.keys(tool && tool.args || {});
  if (!t) return {};
  if (t.startsWith('{')) {try {const j = JSON.parse(t); return j && typeof j === 'object' && !Array.isArray(j) ? j : null} catch {return null}}
  const lit = /^\s*(?:([A-Za-z_]\w*)\s*[=:]\s*)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)\s*(?:,|$)/;
  const out = {}; let rest = t, pos = 0;
  while (rest.trim()) {
    // an unquoted id as the first value (live: `scene_act(deadeye, "I'll take this one down")`, an ability id) counts, unless
    // it is the argument's own name (`scene_act(option, line)` quotes the rules)
    const bare = pos === 0 ? rest.match(/^\s*([A-Za-z_][\w-]*)\s*(?:,|$)/) : null;
    if (bare && !['true', 'false', 'null'].includes(bare[1])) {if (bare[1] === keys[0] || !keys[0]) return null; out[keys[0]] = bare[1]; pos++; rest = rest.slice(bare[0].length); continue}
    const m = rest.match(lit); if (!m) return null;
    let v; try {v = m[2][0] === "'" ? m[2].slice(1, -1).replace(/\\'/g, "'") : JSON.parse(m[2])} catch {return null}
    const k = m[1] || keys[pos]; if (!k) return null; // more positional values than the tool has arguments
    out[k] = v; pos++; rest = rest.slice(m[0].length);
  }
  return out;
}
// Narration as the Agent tab shows it: calls written as text, <think> blocks, separator lines and a
// leading made-up label ("CallCheck...", "scene_act:...", "Narration:") are cut; what remains is the player's words.
const LABEL_PART = /(Call|Check|Tool|Action|Step|Plan|Narrat|Thought|Scene|Turn|Result|Output|Response|Answer|Note|Command)/;
const LABEL_COLON = /^(narration|narrate|action|thought|answer|response|output|note|result|call|check|plan|step|command|tool)$/i;
export function cleanNarration(text, list = PLAYER_TOOLS, calls = null) {
  let s = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const cs = calls || parseTextCalls(s, list);
  for (const c of [...cs].sort((a, b) => b.start - a.start)) s = s.slice(0, c.start) + s.slice(c.end);
  s = stripEcho(s).replace(/<\/?tool_call>/g, '');
  s = s.replace(/^\s*[A-Za-z_]\w*\s*=\s*(["'])([\s\S]*?)\1\s*$/, '$2'); // a junk assignment around the words (live: INdEx="Dovas is taking care of me.")
  const tools = byName(list);
  s = s.split(/\r?\n/).map(l => {
    let x = l;
    const m = x.match(/^\s*\**\s*([A-Za-z_]+)\s*\**\s*(:|-|–)?\s*/);
    if (m) {const w = m[1];
      if (tools.has(w) || (/^(?:[A-Z][a-z]+){2,}$/.test(w) && LABEL_PART.test(w)) || (m[2] === ':' && LABEL_COLON.test(w))) x = x.slice(m[0].length)}
    return x.replace(/\(\s*\)/g, '').replace(/[ \t]+([.,!?])/g, '$1').trimEnd();
  }).filter(l => !/^\s*([-*_=]{3,}|[()`]+)\s*$/.test(l)).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  // English with a Chinese sentence in it or at its end loses that sentence; a reply with little English left stays as it is
  // for the caller to flag and re-prompt (notEnglish)
  if (s && /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(s)) {const c = cutForeign(s); if ((c.match(/[A-Za-z]/g) || []).length >= 12) s = c}
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
// The end-of-turn instruction echoed back (38 of 630 qwen turns). "End your turn now: one short sentence of
// narration in the third person about what you did and why." is cut wherever it appears; at an "End of turn:" label the
// words after it are the narration asked for (live: "... End of turn: Mirora confirms her status..."), else those before.
const ECHO = /\(?\**\s*(?:the wait is over\.?\s*)?\b(?:end|nd)\s+(?:your|the|every)\s+turn(?:\s+now)?\s*(?:[:,-]\s*)?(?:(?:with|by replying with)\s+)?(?:one|a)\s+short\s+sentence(?:\s+of\s+narration)?(?:\s+in\s+(?:the\s+)?third\s+person)?(?:\s+in\s+plain\s+text)?(?:\s+about\s+what\s+you\s+did(?:\s+and\s+why)?)?\s*[.:]?\s*\**\)?/gi;
const END_LABEL = /\**\s*\bend\s+of\s+(?:the\s+|my\s+|this\s+)?turn\b\s*[.:!\-–]*\s*\**/i;
export function stripEcho(text) {
  let s = String(text || '').replace(ECHO, ' ');
  for (let k = 0; k < 4; k++) {const m = END_LABEL.exec(s); if (!m) break;
    const before = s.slice(0, m.index).trim(), after = s.slice(m.index + m[0].length).trim();
    s = (after.match(/\p{L}/gu) || []).length >= 8 ? after : before}
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}
// Non-Latin script runs (Chinese, Japanese, Korean, Thai, Cyrillic, Arabic...) with the punctuation that follows them.
const FOREIGN_RUN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}][^A-Za-zÀ-ɏ]*/gu;
export function cutForeign(text) {return String(text || '').replace(FOREIGN_RUN, ' ').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,!?])/g, '$1').trim()}

// ---- forced answers ----
// ask(system, user, schema) -> {text, usage, ms}: one structured answer, for an everyone-at-once moment (a vote) where the game
// waits on the seat. Over a local chat or a paid adapter's one-shot call.
// urgent: the forced answer goes ahead of every ordinary request waiting in the runner's model queue.
// The context size (num_ctx) is the Ollama adapter's own, the same for every local call.
// A generation Ollama aborts for repeating tokens is asked once more, cooler.
export const chatAsk = (chat, model, {strict = false, timeoutMs = 110000} = {}) => async (system, user, schema) => {
  const req = temperature => ({model, messages: [{role: 'system', content: system}, {role: 'user', content: user}], format: schema, strict, maxTokens: 300, temperature, signal: AbortSignal.timeout(timeoutMs), urgent: true});
  let r; try {r = await chat(req(0.4))} catch (e) {if (!(e && (e.repeatLimit || /repeat limit|prediction aborted/i.test(String(e.message || ''))))) throw e; r = await chat(req(0.2))}
  return {text: String(r.message && r.message.content || ''), usage: r.usage || {}, ms: r.ms || 0};
};
// ask over a provider adapter's one-shot call (Claude: scripts/providers/anthropic.mjs, output_config.format).
export const adapterAsk = (adapter, model, effort = 'low') => async (system, user, schema) => {
  try {const r = await adapter.call({system, user, schema, maxTokens: 400, model, effort, timeoutMs: 20000}); return {text: r.text || '', usage: r.usage || {}, ms: r.ms || 0}}
  catch (e) {if (e.result) return {text: e.raw || '', usage: e.result.usage || {}, ms: e.result.ms || 0}; throw e}
};
const strip = m => {const o ={role: m.role, content: m.content || ''}; if (m.tool_calls) o.tool_calls = m.tool_calls; if (m.tool_name) o.tool_name = m.tool_name; return o};
// Gemini thought signatures go back only within their turn: the kept history (and the session file) drops them.
const noSig = m => m.tool_calls && m.tool_calls.some(c => c && c.extra_content) ? {...m, tool_calls: m.tool_calls.map(c => ({function: c.function}))} : m;
const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
// Drop the oldest whole turns (a turn starts at a message marked turn:1) until the history fits.
export function trimHistory(h, budget) {
  let dropped = 0;
  while (h.length && JSON.stringify(h).length > budget) {
    const next = h.findIndex((m, i) => i > 0 && m.turn);
    if (next < 0) break; // keep at least the latest turn
    h.splice(0, next); dropped++;
  }
  return dropped;
}

// One turn. chat: the adapter's chat; call(tool, args) -> game result; sess: the player's session
// (sess.system, sess.local); on(kind,...): 'text' narration, 'tool' (name, args), 'result' (text),
// 'mode' (new mode). Returns {tools, modelCalls, in, out, modelMs, ms, narration, dead, capped, rejected, mode, calls:[{name, ok, error?}]}.
// tools: the tool table (default the player's; the Storyteller runner passes STORYTELLER_TOOLS); rules: the line appended to the system prompt.
// interrupt: => true when this player's own Table scene opened: the turn stops at once (a model call waiting in
// the runner's queue or in flight is withdrawn) and returns with sceneJump, so the runner can send the forced scene answer.
// A tool result carrying the game's table_waits line (the scene opened while the turn was in flight) does the same.
export async function localTurn({chat, call, sess, prompt, model, toolTurns = 12, on = () => {}, opts = {}, tools: list = PLAYER_TOOLS, rules = LOCAL_RULES, interrupt = null}) {
  const o = {...LOCAL_DEFAULTS, ...opts};
  const L = sess.local = sess.local || {mode: 'tools', history: [], tokensIn: 0, tokensOut: 0, seconds: 0, dropped: 0};
  const t0 = Date.now(); let reprompted = false; const stat = {tools: 0, acts: 0, repeat: false, reprompted: false, foreign: false, fresh: false, modelCalls: 0, in: 0, cached: 0, out: 0, cost: 0, costKnown: true, modelMs: 0, narration: '', dead: false, capped: false, rejected: 0, mode: L.mode, calls: []};
  const addCost = u => {stat.cost += u.cost || 0; if (u.costKnown === false) stat.costKnown = false}; // paid providers (OpenAI) report a cost; Ollama's is 0
  // a run of empty turns (no call, a repeat, another language): start this one from a fresh context
  if ((L.emptyRun || 0) >= o.freshAfter) {L.history = []; L.lastNarr = null; L.emptyRun = 0; stat.fresh = true}
  let sample = {temperature: o.temperature, repeatPenalty: o.repeatPenalty};
  // Ollama aborts a generation that loops on repeated tokens ("token repeat limit reached", the owner's qwen2.5:14b,
  // ). Retry once from a trimmed context (the oldest half of the history dropped) at temperature 0.4, same num_ctx;
  // a second loop ends the turn as empty (stat.looped), which does not count as a failed turn.
  const jumpAc = interrupt ? new AbortController() : null;
  const jumpT = interrupt ? setInterval(() => {if (!stat.sceneJump && interrupt()) {stat.sceneJump = true; on('jump', 'scene'); jumpAc.abort()}}, 200) : null;
  const ask = async req0 => {
    const req = jumpAc ? () => ({...req0(), signal: jumpAc.signal}) : req0;
    if (stat.sceneJump) return null;
    try {return await chat(req())}
    catch (e) {
      if (stat.sceneJump) return null; // withdrawn for the scene answer
      const loop = e && (e.repeatLimit || /repeat limit|prediction aborted/i.test(String(e.message || '')));
      if (!loop) throw e;
      if (stat.loopRetried) {stat.looped = true; return null}
      stat.loopRetried = true; on('loop', String(e.message || e).slice(0, 120));
      L.dropped += trimHistory(L.history, Math.floor(JSON.stringify(L.history).length / 2)); sample = {...sample, temperature: 0.4};
      try {return await chat(req())} catch (e2) {if (stat.sceneJump) return null; if (e2 && (e2.repeatLimit || /repeat limit|prediction aborted/i.test(String(e2.message || '')))) {stat.looped = true; return null} throw e2}
    }
  };
  const turnMsgs = [{role: 'user', content: prompt, turn: 1}];
  const sys = () => sess.system + (L.mode === 'json' ? '\n\n' + JSON_RULES + actionCatalogue(list) : rules);
  const tools = ollamaTools(list);
  const refusedBy = new Map(); let inRow = 0;
  const exec = async (name, rawArgs) => {
    const c = cleanArgs(name, rawArgs, list); stat.tools++;
    on('tool', name, c.args || rawArgs);
    let r; if (c.error) {stat.rejected++; r = {ok: false, error: 'Not done: ' + c.error}} else {try {r = await call(name, c.args)} catch (e) {r = {ok: false, error: String(e.message || e)}}
      const meta = byName(list).get(name); if (meta && meta.act && r && r.ok !== false && r.act !== false) stat.acts++}
    if (!c.error && !(r && r.offline)) (stat.tried || (stat.tried = [])).push({name, args: c.args}); // every call the game answered, refused or not; act:false changes nothing
    const text0 = typeof r === 'string' ? r : JSON.stringify(r);
    const text = r && typeof r === 'object' && r.ok === false && typeof r.error === 'string' ? JSON.stringify({...r, error: r.error + TOOL_NOTE}) : text0;
    on('result', text0);
    stat.calls.push(r && typeof r === 'object' && r.ok === false ? {name, ok: false, error: String(r.error || 'error').slice(0, 140), ...(r.refused ? {refused: true} : {})} : {name, ok: true}); // the behavior log's turn line
    if (r && typeof r === 'object' && r.ok === false && (r.offline || /did not answer in time|page went away|game is not connected|paused or reloading/i.test(String(r.error || '')))) stat.gameDown = (stat.gameDown || 0) + 1; // the page was away, not the model's mistake
    if (/"dead":true/.test(text)) stat.dead = true;
    if (name === 'scene_act' && r && r.ok !== false && Number.isFinite(r.waited_s)) (stat.sceneS = stat.sceneS || []).push(r.waited_s); // the table's wait when it answered
    else if (r && typeof r === 'object' && r.table_waits && !stat.sceneJump) {stat.sceneJump = true; on('jump', 'table_waits')} // its own scene opened mid-turn: answer that first
    else if (r && typeof r === 'object' && r.turn_over) stat.tableRest = true; // the wait has nothing to wait for at the table: the turn ends with no closing call, pacing wakes it
    // the breaker: a refusal (not the page being away) counts per tool and in a row; enough ends the turn
    const refused = r && typeof r === 'object' && r.ok === false && !(r.offline || /did not answer in time|page went away|game is not connected|paused or reloading/i.test(String(r.error || '')));
    if (refused) {refusedBy.set(name, (refusedBy.get(name) || 0) + 1); inRow++;
      if (!stat.broke && (refusedBy.get(name) >= o.sameRefusals || inRow >= o.consecutiveRefusals)) {stat.broke = {tool: name, n: refusedBy.get(name), inRow, error: String(r.error || '').slice(0, 140)}; on('break', stat.broke)}}
    else inRow = 0;
    return text;
  };
  // the minute cap: this session's tool calls over the last real minute, across turns
  const times = CALL_TIMES.get(sess) || []; CALL_TIMES.set(sess, times);
  const capHit = () => {const now = Date.now(); while (times.length && now - times[0] > 60000) times.shift();
    if (times.length < o.callsPerMin) {times.push(now); return false}
    if (!stat.throttled) {stat.throttled = true; on('throttle', times.length)} return true};
  const stopNow = () => stat.dead || !!stat.broke || !!stat.throttled || !!stat.sceneJump || !!stat.tableRest;
  try {
  for (let i = 0; i < toolTurns && !stat.dead; i++) {
    let res;
    try {res = await ask(() => ({model, messages: [{role: 'system', content: sys()}, ...L.history.map(strip), ...turnMsgs.map(strip)], ...(L.mode === 'json' ? {format: actionSchema(list)} : {tools}), maxTokens: o.maxTokens, ...sample}))}
    catch (e) {if (e.noTools && L.mode !== 'json') {L.mode = stat.mode = 'json'; on('mode', 'json'); i--; continue} throw e}
    if (!res) break; // looped twice: the turn ends empty
    stat.modelCalls++; stat.in += res.usage.in; stat.cached += res.usage.cached || 0; stat.out += res.usage.out; stat.modelMs += res.ms; addCost(res.usage);
    const msg = res.message || {}, content = String(msg.content || '');
    if (L.mode === 'json') {
      let j = null; try {j = JSON.parse(content)} catch {}
      turnMsgs.push({role: 'assistant', content});
      if (!j || typeof j.tool !== 'string') {stat.rejected++; turnMsgs.push({role: 'user', content: 'That was not one JSON object with "tool", "args" and "narration". Try again.'}); continue}
      const jn = cleanNarration(j.narration, list);
      if (jn && j.tool !== 'end' && !notEnglish(jn) && !chatbotVoice(jn)) on('text', jn);
      if ((j.tool === 'end' || !j.tool) && (!stat.tools || notEnglish(j.narration) || chatbotVoice(jn)) && !reprompted && i < toolTurns - 1) {reprompted = stat.reprompted = true; turnMsgs.push({role: 'user', content: notEnglish(j.narration) ? REPROMPT_EN : chatbotVoice(jn) ? REPROMPT_VOICE : REPROMPT}); continue}
      if (j.tool === 'end' || !j.tool) {stat.narration = jn; break}
      if (capHit()) break;
      const text = await exec(j.tool, j.args);
      turnMsgs.push({role: 'user', content: `Result of ${j.tool}: ${cut(text, o.resultChars)}`});
      if (stopNow()) break;
      continue;
    }
    // calls written into the text count too, before the real ones (scene_act written out, then a real wait)
    const native = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : [];
    const sig = c => (c.function && c.function.name) + JSON.stringify(c.function && c.function.arguments || {});
    const written = parseTextCalls(content, list), said = cleanNarration(content, list, written);
    let calls = [...written.filter(w => !native.some(n => sig(n) === sig(w))).map(w => ({function: w.function})), ...native];
    if (!calls.length) calls = null;
    const voiced = !calls && chatbotVoice(said);
    if (!calls && (!stat.tools || notEnglish(content) || voiced) && !reprompted && i < toolTurns - 1) {reprompted = stat.reprompted = true; turnMsgs.push({role: 'assistant', content: notEnglish(content) ? '(not in English)' : voiced ? VOICE_MARK : cut(said || content, 300), narr: 1}, {role: 'user', content: notEnglish(content) ? REPROMPT_EN : voiced ? REPROMPT_VOICE : REPROMPT}); continue}
    if (!calls) {stat.narration = said; turnMsgs.push({role: 'assistant', content: stat.narration, narr: 1}); break}
    calls = calls.slice(0, o.callsPerReply);
    turnMsgs.push({role: 'assistant', content: chatbotVoice(said) ? '' : said, tool_calls: calls.map(c => ({function: {name: c.function && c.function.name, arguments: c.function && c.function.arguments || {}}, ...(c.extra_content ? {extra_content: c.extra_content} : {})}))}); // extra_content: a Gemini thought signature, sent back within this turn
    if (said && !notEnglish(said) && !chatbotVoice(said)) on('text', said);
    for (const c of calls) {
      const name = String(c.function && c.function.name || '');
      if (stopNow()) {turnMsgs.push({role: 'tool', tool_name: name, content: '{"ok":false,"error":"Not done: the turn ended early"}'}); continue}
      if (capHit()) {turnMsgs.push({role: 'tool', tool_name: name, content: '{"ok":false,"error":"Not done: too many calls this minute"}'}); continue}
      const text = await exec(name, c.function && c.function.arguments);
      turnMsgs.push({role: 'tool', tool_name: name, content: cut(text, o.resultChars)});
    }
    if (stopNow()) break; // dead, the breaker or the minute cap: no more model calls this turn
    // Small models rarely stop on their own: once the command has played out (a wait returned), the
    // turn ends with one call without tools, which can only answer in words (the narration).
    if (o.endOnWait && !stat.dead && calls.some(c => c.function && c.function.name === 'wait') && /"ok":true/.test(turnMsgs[turnMsgs.length - 1].content)) {
      turnMsgs.push({role: 'user', content: 'The wait is over. End your turn now: one short sentence of narration in the third person about what you did and why.'});
      const fin = await ask(() => ({model, messages: [{role: 'system', content: sys()}, ...L.history.map(strip), ...turnMsgs.map(strip)], maxTokens: o.maxTokens, ...sample}));
      if (!fin) break;
      stat.modelCalls++; stat.in += fin.usage.in; stat.cached += fin.usage.cached || 0; stat.out += fin.usage.out; stat.modelMs += fin.ms; addCost(fin.usage);
      stat.narration = cleanNarration(fin.message && fin.message.content, list);
      turnMsgs.push({role: 'assistant', content: stat.narration, narr: 1}); break;
    }
    if (i === toolTurns - 1) stat.capped = true;
  }
  } finally {if (jumpT) clearInterval(jumpT)}
  // the breaker or the minute cap ended the turn: the next turn reads why, once
  if (stat.broke || stat.throttled) turnMsgs.push({role: 'user', content: stat.broke ? BREAK_NOTE + (stat.broke.error ? ' Last refusal (' + stat.broke.tool + '): ' + stat.broke.error : '') : THROTTLE_NOTE});
  // a narration not in English is not shown, kept or counted: the turn is empty
  if (stat.narration && notEnglish(stat.narration)) {stat.foreign = true; for (const m of turnMsgs) if (m.narr && m.content === stat.narration) m.content = '(not in English)'; stat.narration = ''}
  // chatbot voice: not shown, kept or counted either
  if (stat.narration && chatbotVoice(stat.narration)) {stat.chatbot = true; for (const m of turnMsgs) if (m.narr && m.content === stat.narration) m.content = VOICE_MARK; stat.narration = ''}
  if (stat.narration) on('text', stat.narration);
  // keep the turn compactly: long tool results and musings shortened, then the oldest turns dropped to fit
  for (const m of turnMsgs) if ((m.role === 'tool' || (L.mode === 'json' && m.role === 'user' && !m.turn)) && m.content.length > o.keptChars) m.content = cut(m.content, o.keptChars);
    else if (m.role === 'assistant' && L.mode !== 'json' && m.content.length > o.keptChars * 2) m.content = cut(m.content, o.keptChars * 2);
  // the model's own past narrations are not fed back (a small model copies them instead of looking): only this turn's stays
  const lastNarr = turnMsgs.filter(m => m.narr).pop();
  L.history = L.history.filter(m => !m.narr);
  L.history.push(...turnMsgs.filter(m => !m.narr || m === lastNarr).map(noSig));
  // a narration close to the last one is a repeat; with no game-changing call it makes an empty turn (scripts/pacing.mjs localWorked)
  if (stat.narration && L.lastNarr && similar(stat.narration, L.lastNarr) >= REPEAT_SIM) stat.repeat = true;
  if (stat.narration) L.lastNarr = stat.narration.slice(0, 400);
  const sig = actSig(stat.tried); stat.repeatAct = !!(sig && sig === L.lastAct); L.lastAct = sig; // the same expressive call as last turn's only act
  if (stat.looped) L.emptyRun = Math.max(L.emptyRun || 0, o.freshAfter); else if (stat.sceneJump && !stat.tools) {} else // a turn given up for the scene answer is not an empty one
  L.emptyRun = !stat.tools || stat.rejected >= stat.tools || (stat.repeat && !stat.acts) || stat.repeatAct || stat.foreign || (stat.chatbot && !stat.acts) ? (L.emptyRun || 0) + 1 : 0;
  L.dropped += trimHistory(L.history, o.historyChars);
  L.tokensIn += stat.in; L.tokensOut += stat.out; L.seconds += (Date.now() - t0) / 1000;
  stat.ms = Date.now() - t0;
  return stat;
}

// One turn record from two: a free turn given up for the scene, then the forced scene answer. Numbers add up,
// calls and the scene waits follow each other, the marks of either stay; mode/forced/narration come from the second.
export function joinTurns(a, b) {
  if (!a) return b; if (!b) return a;
  const o = {...a, ...b};
  for (const k of ['tools', 'acts', 'modelCalls', 'in', 'cached', 'out', 'cost', 'modelMs', 'ms', 'rejected', 'misses']) o[k] = (a[k] || 0) + (b[k] || 0);
  for (const k of ['fresh', 'reprompted', 'foreign', 'dead', 'capped', 'looped', 'chatbot', 'loopRetried', 'broke', 'throttled', 'sceneJump', 'repeatAct']) o[k] = a[k] || b[k] || false;
  o.costKnown = a.costKnown !== false && b.costKnown !== false; o.calls = [...(a.calls || []), ...(b.calls || [])];
  o.sceneS = [...(a.sceneS || []), ...(b.sceneS || [])]; if (!o.sceneS.length) delete o.sceneS;
  o.narration = b.narration || a.narration; o.repeat = !!b.repeat;
  return o;
}

// Repeated acts: a model that found one accepted call repeats it every turn, accepted or refused by the game (a refused repeat is no progress either). Only expressive calls whose identical
// repeat is never a plan count; wait, hunt, move_to, follow, rest, scene_act, use_ability, buy/sell, take_quest and the like
// are consistent play and are never flagged, nor are reads (act:false) or a turn with two or more calls. The key is the
// turn's only call, name and arguments; null when there is none or it may legitimately repeat.
export const REPEAT_ACTS = new Set(['emote', 'say', 'party_say', 'whisper']);
export function actSig(acted) {
  if (!Array.isArray(acted) || acted.length !== 1 || !REPEAT_ACTS.has(acted[0].name)) return null;
  try {return acted[0].name + ' ' + JSON.stringify(acted[0].args || {}, Object.keys(acted[0].args || {}).sort())} catch {return null}
}

// Marks on a turn line: the model was told to act, or only repeated itself.
const turnFlags = st => (st.sceneJump ? ' | its scene opened mid-turn: answered it first' : '') + (st.mode === 'reflect' ? ' | reflection (' + (st.wrote || 0) + ' memories' + (st.misses ? ', ' + st.misses + ' missed' : '') + ')' : '') + (st.mode === 'scene' ? ' | forced scene turn' + (st.misses ? ' (' + st.misses + ' missed)' : '') : '') + (st.fresh ? ' | fresh context' : '') + (st.broke ? ' | ended early: ' + st.broke.n + ' refusals of ' + st.broke.tool + (st.broke.inRow > st.broke.n ? ' (' + st.broke.inRow + ' in a row)' : '') : '') + (st.throttled ? ' | ended early: the per-minute call cap' : '') + (st.reprompted ? ' | re-prompted to act' : '') + (st.looped ? ' | empty turn (Ollama stopped the model repeating itself twice; next turn starts afresh, not counted as a failure)' : st.loopRetried ? ' | retried once from a trimmed context (the model repeated itself)' : '') + (st.looped ? '' : st.sceneJump && !st.tools ? ' | cut by its scene before any call (not an empty turn)' : st.foreign ? ' | empty turn (not in English)' : !st.tools ? ' | empty turn (no tool call)' : st.repeat && !st.acts ? ' | empty turn (repeated narration)' : st.repeatAct ? ' | empty turn (repeat-act: the same ' + st.tried[0].name + ' as last turn)' : '');
// The cost line for a local turn: tokens and seconds, cost 0.
export const localLine = (st, model) => `${model} (local) | ${st.tools} tool calls${st.rejected ? ' (' + st.rejected + ' rejected)' : ''}, ${(st.ms / 1000).toFixed(1)} s (${(st.modelMs / 1000).toFixed(1)} s in the model), ${st.modelCalls} model calls${st.mode === 'json' ? ', JSON-action mode' : ''} | tokens in ${st.in} / out ${st.out} | $0 (local)${st.capped ? ' | hit the model-call cap' : ''}${turnFlags(st)}`;

// The cost line for a turn played through a paid provider (OpenAI): like localLine, with the real cost.
// Ends with "| turn $x | run $y" when run is given (the app runner supervisor reads "| run $"); an
// unknown price (a model not in the provider's price table) says so instead of a dollar figure.
export const paidLine = (st, model, provider, {run = null, session = null} = {}) => {
  const money = v => '$' + v.toFixed(v > 0 && v < 0.0001 ? 6 : 4); // estimated costs of a cheap open model can be a few millionths
  return `${model} (${provider}) | ${st.tools} tool calls${st.rejected ? ' (' + st.rejected + ' rejected)' : ''}, ${(st.ms / 1000).toFixed(1)} s (${(st.modelMs / 1000).toFixed(1)} s in the model), ${st.modelCalls} model calls${st.mode === 'json' ? ', JSON-action mode' : ''} | tokens in ${st.in}${st.cached ? ' (' + st.cached + ' cached)' : ''} / out ${st.out} | ${st.costKnown ? 'turn ' + money(st.cost) : 'cost unknown (model not in the price table)'}${run != null ? ' | run ' + money(run) : ''}${session != null ? ' | session ' + money(session) : ''}${st.capped ? ' | hit the model-call cap' : ''}${turnFlags(st)}`;
};
