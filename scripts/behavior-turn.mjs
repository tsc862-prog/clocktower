// KEPT FOR NOW: the turn record builder of the borrowed Claude runner; scripts/seat-runner.mjs posts its own lighter
// record today, and the Claude seat runner (slice 3) uses this one.
// Turn lines for the behavior logs, runner side: scripts/seat-runner.mjs, scripts/fellowship.mjs
// and scripts/storyteller-agent.mjs build one record per turn and send it to POST /play/behavior/turn, where the relay
// (or the headless host) checks that this runner holds the seat, adds the player's state after the turn and
// writes logs/behavior/<game>/turns.jsonl (scripts/behavior-log.mjs). Fire and forget: an older host (404),
// a host without behavior logs or a slow one never holds up a turn. The record carries this seat's own
// narration, tool names with ok/error and its numbers; never tool results, prompts or another seat's text.
// Nothing here is read back by any agent.

const cut = (s, n) => {s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s};
// A tool result (an object, or the JSON text the MCP tool returned) -> {ok, error?, refused?}
export function resultOf(r) {
  let j = r; if (typeof r === 'string') {try {j = JSON.parse(r)} catch {j = /"ok":\s*false/.test(r) ? {ok: false, error: (r.match(/"error":\s*"([^"]{0,160})/) || [])[1] || 'error'} : {ok: true}}}
  if (!j || typeof j !== 'object') return {ok: true};
  if (j.ok === false) return {ok: false, error: cut(j.error || j.reason || 'error', 140), ...(j.refused ? {refused: true} : {})};
  return {ok: true};
}
const brief = b => b ? {state: b.state, doing: b.doing || null, hp: b.hp, level: b.level, place: b.place || null, foe: b.foe || null, autopilot: !!b.autopilot, table: !!b.table, news: Array.isArray(b.news) ? b.news.length : 0, clock: b.clock || null} : null;

// The Agent SDK side: feed it the stream's tool_use / tool_result / text blocks, then build.
export function turnCollector() {
  const tools = [], ids = new Map(); let narr = [];
  return {
    tool(name, id, args) {const t = {name: String(name || '').replace(/^mcp__clocktower__/, ''), ok: true, ...(args && typeof args === 'object' ? {args} : {})}; tools.push(t); if (id) ids.set(id, t)},
    result(id, content, isError) {const t = ids.get(id) || tools[tools.length - 1]; if (!t) return; const r = resultOf(content); if (isError && r.ok) {r.ok = false; r.error = cut(content, 140)} Object.assign(t, r)},
    text(s) {if (s && String(s).trim()) narr.push(String(s).trim())},
    get tools() {return tools},
    // the turn's narration: the last thing the agent said (the closing sentence)
    get narration() {return narr.length ? narr[narr.length - 1] : ''},
  };
}
// Agent SDK usage. The result's `modelUsage` is CUMULATIVE for the query call and, on a resumed session,
// already carries the earlier turns (sdk.d.ts: "read the latest result rather than summing"), so summing it per turn logged
// ~3.3M tokens. This takes the difference from the totals saved on the session (`sess.lastUsage`, like `lastTotal` for cost)
// and reports four numbers per turn: tokensIn = uncached input, cacheRead, cacheWrite, tokensOut. A total that went down
// (a /clear, a new query) is a fresh count. A session saved before this field with cost history (lastTotal > 0) has no baseline: that one
// turn reports null and sets it. No usable modelUsage -> all null, baseline untouched.
export function usageDelta(sess, result) {
  const none = {tokensIn: null, tokensOut: null, cacheRead: null, cacheWrite: null};
  const mu = result && result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage).filter(u => u && typeof u === 'object') : [];
  if (!mu.length) return none;
  const n = v => Number.isFinite(v) && v > 0 ? v : 0, sum = k => mu.reduce((t, u) => t + n(u[k]), 0);
  const cur = {tokensIn: sum('inputTokens'), tokensOut: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens')};
  const last = sess.lastUsage; sess.lastUsage = cur;
  if (!last) return sess.lastTotal > 0 ? none : cur; // call before the cost baseline moves
  const reset = Object.keys(cur).some(k => cur[k] < (last[k] || 0));
  const d = {}; for (const k of Object.keys(cur)) d[k] = reset ? cur[k] : cur[k] - (last[k] || 0);
  return d;
}
// A local-loop turn (scripts/local-agent.mjs result) -> the record's numbers and flags.
export function localRec(r) {
  if (!r) return {tools: [], narration: '', flags: ['failed']};
  const flags = []; if (r.fresh) flags.push('fresh'); if (r.reprompted) flags.push('reprompted'); if (r.foreign) flags.push('foreign'); if (r.chatbot) flags.push('chatbot'); if (r.repeat) flags.push('repeat'); if (r.repeatAct) flags.push('repeat-act'); if (r.capped) flags.push('capped'); if (r.looped) flags.push('looped'); else if (r.loopRetried) flags.push('loop-retried'); if (r.mode === 'json') flags.push('json-mode'); if (r.mode === 'reflect') flags.push('reflection');
  if (r.broke) flags.push('breaker'); if (r.throttled) flags.push('throttled'); // ended early
  if (r.aimDropped) flags.push('stale-aim-dropped'); // a forced answer's aim copied a finished one word for word: not set
  if (r.tableRest) flags.push('table-rest'); // a wait at the table ended the turn
  if (r.sceneJump && !r.tools) flags.push('scene-cut'); // cut by its scene before any call: not an empty turn
  if (r.sceneJump) flags.push('scene-jump'); // the player's scene opened mid-turn and was answered first
  return {tools: (r.calls || []).map(c => ({name: c.name, ok: c.ok, ...(c.ok ? {} : {error: c.error}), ...(c.refused ? {refused: true} : {})})), narration: r.narration || '', seconds: +(r.ms / 1000).toFixed(1), tokensIn: r.in, ...(r.cached ? {tokensCached: r.cached} : {}), tokensOut: r.out, cost: r.cost || 0, ...(r.sceneS && r.sceneS.length ? {sceneS: r.sceneS} : {}), flags};
}

// Send one turn line. seat: {player: id} or {role: 'storyteller'}. Returns a promise that never rejects.
export function reportTurn(base, {player = null, role = null, runner, provider, model, turn, wake = null, brief: b = null, ...rest}, {fetchImpl = fetch} = {}) {
  if (!base) return Promise.resolve(false);
  const body = {...(player != null ? {player} : {}), ...(role ? {role} : {}), runner, rec: {provider, model, turn, wake: wake && wake.wake ? {wake: wake.wake, why: cut(wake.why, 160)} : null, brief: brief(b), ...rest, narration: cut(rest.narration, 600)}};
  try {
    return fetchImpl(base + '/play/behavior/turn', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(8000)})
      .then(r => r.status === 200).catch(() => false);
  } catch {return Promise.resolve(false)}
}
export {brief as briefRec};
