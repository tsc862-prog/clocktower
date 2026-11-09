// Runner pacing: a runner's turns follow the game, not a stopwatch. Shared by the seat runners; plain Node.
//
// Between turns the runner long-polls POST /play/pace (scripts/relay-mcp.mjs, answered by the game) and starts the next turn when
//   - something cannot wait (a night choice, a vote, a nomination aimed at the seat): at once, even inside the minimum gap (at
//     most NOW_MAX such turns per NOW_WINDOW of real time; past that they wait for the gap, except what must be answered in time);
//   - something happened the seat has not read (a line at the table, the Storyteller's narration), or `heartbeat` game minutes
//     passed: once `minGap` real seconds have passed since the last turn.
// With no game behind the relay (the stub) every poll ends with a heartbeat, so a runner plays a turn per gap.
// Hosts without /play/pace fall back to the real-time estimate of the heartbeat, never less than the gap.
// Safety stop: failTracker(maxFails) counts failed or empty turns in a row (a turn that threw, made no tool call, or had every
// call rejected); the runner stops after maxFails of them.
import {PRICES} from './providers/anthropic.mjs';
import {SLOT_BEAT_MS} from './runners.mjs';
export const PACE_DEFAULTS = {heartbeat: 120, minGap: 20, maxFails: 5};
// Another local model held by Ollama (the relay's minds, another runner) evicts ours on a single GPU: say so.
// And our own model held at another context size reloads on every call that asks ours.
export async function localModelNote(adapter, model) {
  const rows = adapter && adapter.held ? await adapter.held() : adapter && adapter.loaded ? ((await adapter.loaded()) || []).map(name => ({name, ctx: null})) : null;
  const others = (rows || []).map(m => m.name).filter(m => m !== model), notes = [];
  if (others.length) notes.push(`note: Ollama also holds ${others.join(', ')} in memory (the relay's minds or another runner?). On one GPU two local models evict each other and every call waits for a reload: use one local model for minds and runners.`);
  const ours = (rows || []).find(m => m.name === model), want = adapter && adapter.numCtx;
  if (ours && ours.ctx && want && ours.ctx !== want) notes.push(ctxNote(model, ours.ctx, want));
  return notes.length ? notes.join(' ') : null;
}
export const ctxNote = (model, held, want) => `note: Ollama holds ${model} at ${held}; runners ask ${want}, so it reloads each time. Set OLLAMA_NUM_CTX=${want} for everything that uses it (the relay, every runner) or restart them with one value.`;
// The local model a runner should use when nobody picked one (no --model): the one Ollama already holds in
// memory, when it is pulled (the relay's minds keep it loaded; a second model would never get the GPU).
// -> {model, note}
export async function preferLoaded(adapter, model, pulled = []) {
  const held = adapter && adapter.loaded ? await adapter.loaded() : null;
  if (!held || !held.length || held.includes(model)) return {model, note: null};
  const alt = held.find(m => pulled.includes(m));
  return alt ? {model: alt, note: `Ollama already holds ${alt} in memory (the relay's minds?), so this runner plays with it instead of ${model}; pick a model explicitly to override.`} : {model, note: null};
}
export const NOW_MAX = 2, NOW_WINDOW = 60000, POLL_REAL_MS = 10000, LEGACY_SEC_PER_GAME_MIN = 10 / 60; // 1x: 1 real s = 6 game min

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = (v, d) => {const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? d : n};

// The pacing settings from flags (--heartbeat MIN, --min-gap S, --max-fails N), then env (AGENT_HEARTBEAT, AGENT_MIN_GAP,
// AGENT_MAX_FAILS), then the defaults.
export function paceSettings(opt, env = {}) {
  return {
    heartbeat: Math.min(1440, Math.max(5, num(opt('heartbeat', null), num(env.AGENT_HEARTBEAT, PACE_DEFAULTS.heartbeat)))),
    minGap: Math.max(0, num(opt('min-gap', null), num(env.AGENT_MIN_GAP, PACE_DEFAULTS.minGap))),
    maxFails: Math.max(1, Math.round(num(opt('max-fails', null), num(env.AGENT_MAX_FAILS, PACE_DEFAULTS.maxFails)))),
  };
}
export const paceText = p => `a turn on an event, else every ${p.heartbeat} game min, at least ${p.minGap} s apart`;
// --max-turns when asked, else until stopped: a paid mind is limited by its budget in dollars, not by turns; a local mind costs
// nothing. There is no default turn cap.
export const turnCap = asked => asked != null && asked !== '' ? Math.max(1, Number(asked)) : Infinity;
export const capText = n => n === Infinity ? 'until stopped' : `up to ${n} turns`;

// Failed or empty turns in a row. ok(turnWorked) -> true when the runner must stop.
export function failTracker(maxFails) {
  let n = 0;
  return {ok(worked) {if (worked === null) return n >= maxFails; n = worked ? 0 : n + 1; return n >= maxFails}, get count() {return n}, why: () => `${n} failed or empty turns in a row`};
}
// Did a local-loop turn (scripts/local-agent.mjs result) do anything? A turn with no call, every call rejected, or a narration
// repeating the last one with no acting call is empty. null (neither): a turn Ollama aborted twice for repeating tokens with no
// call made, or a turn whose calls failed because the game was not answering (not the runner's fault).
export const localWorked = r => r && r.looped && !r.tools ? null : r && r.gameDown && !r.acts ? null : !!(r && r.tools > 0 && r.rejected < r.tools && !(r.repeat && !r.acts) && !r.repeatAct && !r.foreign && !(r.chatbot && !r.acts));

// makePacer({base, player | role: 'storyteller', runner, heartbeat, minGap, log, stopped}) -> {next(), turnDone(), state}
//   next(): waits for the next turn. -> {wake:'now'|'soft'|'heartbeat', why, table, clock} or {dead} / {gone, why} / {stopped}
//   turnDone(): call when a turn ends (the gap and the heartbeat count from here).
export function makePacer({base, player, role = undefined, runner, heartbeat: heartbeat0 = PACE_DEFAULTS.heartbeat, minGap: minGap0 = PACE_DEFAULTS.minGap, pollMs = POLL_REAL_MS, log = () => {}, stopped = () => false, fetchImpl = fetch}) {
  let heartbeat = heartbeat0, minGap = minGap0; // the supervisor may change both live: the pace answer's `pace` overrides
  let lastEnd = null, since = null, nows = [], legacy = false, said = false;
  const st = {waiting: false, wake: null};
  async function pace(wake, realMs) {
    try {
      const r = await fetchImpl(base + '/play/pace', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({player, role, runner, since, minutes: heartbeat, minGap, heartbeat, wake, realMs}), signal: AbortSignal.timeout(realMs + 20000)});
      if (r.status === 404) return {unsupported: true};
      const j = await r.json().catch(() => ({ok: false, error: 'bad answer'}));
      if (j && j.pace && typeof j.pace === 'object') {
        const g = Number(j.pace.minGap), h = Number(j.pace.heartbeat);
        if (Number.isFinite(g) && g >= 0 && g !== minGap) {log(`[pace] min gap now ${g} s`); minGap = g}
        if (Number.isFinite(h) && h > 0 && h !== heartbeat) {log(`[pace] heartbeat now ${h} game min`); heartbeat = h}
      }
      if (j && j.ok === false && /unknown tool pace|not found/i.test(String(j.error || ''))) return {unsupported: true};
      return j;
    } catch (e) {return {ok: false, offline: true, error: e.message}}
  }
  async function next() {
    st.waiting = true; said = false;
    try {
      for (;;) {
        if (stopped()) return {stopped: true};
        const gapLeft = lastEnd == null ? 0 : lastEnd + minGap * 1000 - Date.now();
        if (legacy) { // an older host: real time only, as if at 1x
          const left = Math.max(gapLeft, lastEnd == null ? 0 : lastEnd + heartbeat * LEGACY_SEC_PER_GAME_MIN * 1000 - Date.now());
          if (!said) {said = true; log(`[pace] this game has no /play/pace (older relay or page): next turn in ${Math.ceil(left / 1000)} s`)}
          if (left <= 0) return {wake: 'heartbeat', why: 'real-time fallback', legacy: true};
          await sleep(Math.min(left, 1000)); continue;
        }
        nows = nows.filter(t => Date.now() - t < NOW_WINDOW);
        const mode = gapLeft <= 0 ? 'all' : nows.length < NOW_MAX ? 'now' : 'must';
        if (!said) {said = true; log(`[pace] waiting: ${paceText({heartbeat, minGap})}`)}
        const r = await pace(mode, mode !== 'all' ? Math.max(50, Math.min(gapLeft, pollMs)) : pollMs);
        if (r.unsupported) {legacy = true; said = false; continue}
        if (r.ok === false) {
          if (r.dead) return {dead: true, why: r.error};
          if (r.gone) return {gone: true, why: r.error};
          if (r.refused) return {gone: true, why: r.error};
          await sleep(2000); continue; // the game is not answering: keep the claim, try again
        }
        if (r.since != null) since = r.since;
        if (!r.wake) continue;
        if (r.wake === 'now' && gapLeft > 0 && !r.must) nows.push(Date.now());
        st.wake = r.wake;
        log(`[pace] woke (${r.wake}${r.clock ? ', ' + r.clock : ''}): ${String(r.why || '').slice(0, 160)}`);
        return r;
      }
    } finally {st.waiting = false}
  }
  // The seat's state header for a turn prompt, or null on an older host.
  async function brief() {
    if (legacy) return null;
    try {
      const r = await fetchImpl(base + '/play/pace', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({player, role, runner, brief: true}), signal: AbortSignal.timeout(8000)});
      if (r.status === 404) return null;
      const j = await r.json(); return j && j.ok && j.brief ? j.brief : null;
    } catch {return null}
  }
  // The first turn of a run: wait while the start gate holds the game, as a paced turn does.
  // -> {} when it may start, or {dead}/{gone}/{stopped}. An older host, or one that does not answer, never blocks it.
  async function ready() {
    let said = false;
    for (;;) {
      if (stopped()) return {stopped: true};
      let r = null;
      try {
        const x = await fetchImpl(base + '/play/pace', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({player, role, runner, held: true}), signal: AbortSignal.timeout(8000)});
        r = x.status === 404 ? null : await x.json().catch(() => null);
      } catch {r = null}
      if (!r) return {};
      if (r.ok === false) {if (r.dead) return {dead: true, why: r.error}; if (r.gone) return {gone: true, why: r.error}; return {}}
      if (!r.held) return {};
      if (!said) {said = true; log(`[pace] the game is held (${r.held}): the first turn waits`)}
      await sleep(1000);
    }
  }
  return {next, ready, brief, turnDone() {lastEnd = Date.now(); since = null}, state: st};
}

// What is due from the Storyteller now (#90, #91), asked of its own `look` tool (a read: no model, no cost; storytellerDue of
// src/seats/storyteller.js). post(path, body, ms) is the runner's Storyteller post. -> {tool, why} when something is due, null when
// nothing is, undefined when the game did not say (an older relay, an error): a caller then plays the turn as before.
export async function storytellerDueNow(post) {
  try {
    const r = await post('/play/storyteller', {tool: 'look', args: {}}, 8000);
    if (!r || r.ok === false || !('due' in r)) return undefined;
    if (r.dueTool) return {tool: r.dueTool, why: String(r.due || '')};
    return r.due === 'nothing' ? null : undefined;
  } catch {return undefined}
}

// The state header as prompt text: fresh from the game every turn, so a model never plays from a stale picture.
export const briefText = b => b ? '\nThe game now: ' + JSON.stringify(b).slice(0, 1500) : '';
// The line a turn prompt carries about why it started (the seat's own events only).
export function wakeNote(w) {
  if (!w || !w.wake) return '';
  if (w.wake === 'heartbeat') return w.legacy ? '' : ` Some quiet time has passed (${w.clock || 'now'}).`;
  return ` ${w.wake === 'now' ? 'Something needs you now' : 'Something happened'}: ${String(w.why || '').slice(0, 200)}`;
}

// A Claude turn under the runner supervisor (scripts/runners.mjs): lease one of the Claude slots for the turn and release it after,
// so any number of Claude runners can be started (seven players and the Storyteller) while at most RUNNER_CLAUDE_MAX talk to the
// API at once (the Storyteller has its own, RUNNER_STORYTELLER_SLOTS). Outside the supervisor (a terminal runner) or when the
// supervisor does not answer, the turn just runs. One slot of RUNNER_CLAUDE_MAX is kept for forced answers (RUNNER_SCENE_SLOTS):
// an everyone-at-once moment such as a vote, where the game waits on the seat.
// due() says whether such a moment waits on this seat; while the runner waits for a slot it asks every DUE_POLL_MS, and once due,
// onDue() runs once and the request is asked again with scene: true, which the supervisor serves first. The release function
// carries .scene = true when that happened, so the turn answers it first.
// A lease is held by a turn that says so: every SLOT_BEAT_MS the holder posts /play/runner/slot/beat with its tool-call count
// (tools()), so the supervisor can reclaim what nobody holds any more. onLost() runs when the slot was taken back (a turn with no
// tool call for SLOT_MAX_MS): the runner ends that turn. Each request names a ticket; a request cut off here is cancelled by it,
// so a grant whose answer never reached us goes back at once. The release function carries .idle(on): the runner reports while it
// sits in a wait call. member: who the lease is for.
export const DUE_POLL_MS = 1000;
let slotTickets = 0;
export async function takeClaudeSlot(base, log = () => {}, {key = process.env.CLOCKTOWER_RUNNER_KEY, stopped = () => false, fetchImpl = fetch, due = null, onDue = null, member = null, tools = () => 0, onLost = null, beatMs = SLOT_BEAT_MS} = {}) {
  if (!key || !base) return Object.assign(() => {}, {scene: false, idle: () => {}});
  const post = (path, body, ms, signal) => fetchImpl(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)});
  const isDue = async () => {try {return !!(due && await due())} catch {return false}};
  let lease = null, said = false, scene = await isDue(), told = false, waitedFor = false;
  while (!stopped()) {
    const ac = new AbortController(), ticket = process.pid + '-' + (++slotTickets);
    const watch = due ? setInterval(async () => {if (!(await isDue())) return; waitedFor = true;
      if (!told) {told = true; try {if (onDue) await onDue()} catch {}}
      if (!scene) {scene = true; ac.abort()}}, DUE_POLL_MS) : null;
    let j = null, cut = false, late = false;
    try {const r = await post('/play/runner/slot', {key, ticket, ...(member ? {member} : {}), ...(scene ? {scene: true} : {})}, 30000, ac.signal); j = r.status === 200 ? await r.json() : null} catch (e) {cut = ac.signal.aborted; late = !cut && e && e.name === 'TimeoutError'}
    if (watch) clearInterval(watch);
    if (cut || late) await post('/play/runner/slot/cancel', {key, ticket}, 5000).catch(() => {}); // it may have been granted as we gave up on it
    if (cut) {log('[pace] the game waits on this seat now; while it waited for a Claude slot: asking again, scene first'); continue}
    if (late) continue;
    if (!j) break; // no supervisor here: run without a lease
    if (j.ok) {lease = j.lease; if (said) log('[pace] got a ' + (j.storyteller ? 'Storyteller slot' : 'Claude slot') + (waitedFor ? ' (scene first)' : '')); break}
    if (!said || (j.prep ? said !== 'prep' : said === 'prep')) {said = j.prep ? 'prep' : true;
      log(j.prep ? '[pace] the Storyteller prepares the table: no Claude turn until it is done' : j.storyteller ? `[pace] waiting for the Storyteller slot (its ${j.storytellerSlots ?? 1} and all ${j.slots} player slots in use; RUNNER_STORYTELLER_SLOTS)` : `[pace] waiting for a Claude slot (all ${j.slots} in use; RUNNER_CLAUDE_MAX)`)}
  }
  const beat = async idle => {if (!lease) return;
    try {const r = await post('/play/runner/slot/beat', {key, lease, tools: tools(), ...(idle == null ? {} : {idle})}, 5000), b = await r.json();
      if (b && b.lost && lease) {lease = null; clearInterval(timer); log('[pace] the supervisor took this Claude slot back: ' + (b.why || 'no tool call for too long') + '; the turn ends'); if (onLost) onLost()}} catch {}};
  const timer = lease ? setInterval(() => beat(), beatMs) : null; if (timer && timer.unref) timer.unref();
  return Object.assign(() => {if (timer) clearInterval(timer); if (lease) {post('/play/runner/slot/release', {key, lease}, 5000).catch(() => {}); lease = null}}, {scene: waitedFor, idle: on => {beat(!!on)}});
}
// opts.onLease(release): the turn's lease, for release.idle. A runner told to stop runs no turn on the way out (it would run unleased).
export async function withClaudeSlot(base, fn, log, opts = {}) {const release = await takeClaudeSlot(base, log, opts); if (opts.onLease) opts.onLease(release);
  try {return opts.stopped && opts.stopped() ? false : await fn()} finally {release()}}

// The Agent SDK hooks of a Claude seat's turn: a wait that came back with turn_over ends the turn right there (the PostToolUse hook
// stops the query), so nobody keeps a Claude slot while the game waits. idle(on) reports the wait to the lease.
export const WAIT_TOOL = 'mcp__clocktower__wait';
export const turnOver = v => /turn_over\\*"\s*:\s*true/.test(typeof v === 'string' ? v : JSON.stringify(v) || '');
export function tableHooks({idle = () => {}, onOver = () => {}} = {}) {
  return {PreToolUse: [{matcher: WAIT_TOOL, hooks: [async () => {idle(true); return {}}]}],
    PostToolUse: [{matcher: WAIT_TOOL, hooks: [async i => {idle(false); if (!turnOver(i && i.tool_response)) return {}; onOver(); return {continue: false, stopReason: 'your turn is over at the table'}}]}]};
}

// An aborted query sends no result message, so its spend would never reach the run budget. grabSpend() watches the stream:
// every assistant message carries the usage of its model call (one call can repeat under the same id as it streams; the largest
// figure per field wins). grabSpend(...).cost(model, {sent}) prices what was reported with the Anthropic price table (cache reads at
// 0.1x and cache writes at 1.25x the input rate) -> {usd, how: 'reported'}; with nothing reported (cut before the first model call
// finished) it estimates from the characters sent (system + prompt, 3 chars a token, all at the full input rate, plus GRAB_EST_OUT
// output tokens) -> {usd, how: 'estimated'}. An unpriced model counts as the dearest listed. No RNG, no network.
export const GRAB_EST_OUT = 400;
export function grabSpend() {
  const calls = new Map(); let n = 0;
  return {
    add(msg) {const u = msg && msg.message && msg.message.usage; if (!u) return; const id = msg.message.id || ('anon' + n++), c = calls.get(id) || {in: 0, out: 0, cr: 0, cw: 0};
      c.in = Math.max(c.in, u.input_tokens || 0); c.out = Math.max(c.out, u.output_tokens || 0); c.cr = Math.max(c.cr, u.cache_read_input_tokens || 0); c.cw = Math.max(c.cw, u.cache_creation_input_tokens || 0); calls.set(id, c)},
    reported: () => calls.size,
    cost(model, {sent = 0} = {}) {
      const p = PRICES[model] || Object.values(PRICES).reduce((a, b) => b.out > a.out ? b : a);
      if (calls.size) {let usd = 0; for (const c of calls.values()) usd += (c.in * p.in + c.cr * p.in * .1 + c.cw * p.in * 1.25 + c.out * p.out) / 1e6; return {usd, how: 'reported', calls: calls.size}}
      return {usd: (Math.ceil(sent / 3) * p.in + GRAB_EST_OUT * p.out) / 1e6, how: 'estimated', calls: 0}}};
}
