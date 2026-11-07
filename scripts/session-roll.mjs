// Keeping Claude sessions small. An Agent SDK session grows with every turn and is resent on every model call.
// Claude Haiku 5.5 bills a request by its prompt length, all input tokens counted (uncached, cache reads, cache writes): past
// ROLL.LINE every rate is 5x (read 2026-11-04 from the pricing page, "Long context pricing"; no other current model has such a
// line). The SDK left alone compacts near the 1M window, 967k on Haiku, so a long-lived session lives its whole life past it.
//
// Two levers, both between the runner and the SDK, no game state:
//   the roll the main one. Between turns, when the last call's prompt reached the seat's roll point, the session file is set
//                aside in logs/agents/old/ and the next turn starts a fresh SDK session. Standing orders, runner
//                settings, turn count and spend stay on the session object; the seat's memory is in the game
//                and the first turn after a roll is told to read it. Never inside a turn, never while the game waits
//                on the seat. The claim and the pacer are not touched.
//                The last hours of talk come along as a short recap in that first prompt (scripts/session-recap.mjs).
// A fresh session asked from the page reaches the runner as a "fresh" line on stdin (askFresh) and rolls by the same rules.
//   compaction the net, for one very long turn or a roll held back by a scene. CLAUDE_CODE_AUTO_COMPACT_WINDOW through query's
//                env (read by the CLI; `npm run sessioncheck` proves it on the real binary). The CLI's threshold is the window less
//                20k of output room less 13k of buffer, so a window of roll + NET compacts 7k above the roll point: the roll,
//                which never touches a scene, goes first, and compaction still fires before ROLL.LINE.
// Plain Node, no SDK import.
export const ROLL = {PLAYER: 80000, STORYTELLER: 150000, HAIKU: 80000, LINE: 100000, NET: 40000, WINDOW_MIN: 100000, WINDOW_MAX: 1000000, CLI_MARGIN: 33000, LEGACY_TURNS: 15};

const tokens = (v, d) => {if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : d};
// The tokens at which a seat rolls; 0 means never. SESSION_ROLL_TOKENS for players. STORYTELLER_ROLL_TOKENS for the Storyteller, whose default stays
// under the price line when it plays Haiku (the app's default Storyteller does): the line is the model's, not the seat's.
export function rollPoint(kind, model, env = {}) {
  if (kind !== 'storyteller') return tokens(env.SESSION_ROLL_TOKENS, ROLL.PLAYER);
  return tokens(env.STORYTELLER_ROLL_TOKENS, /haiku/i.test(String(model || '')) ? ROLL.HAIKU : ROLL.STORYTELLER);
}
// The auto-compact window for a roll point (the CLI takes 100000 to 1000000). With the roll off it sits at the minimum: the net stays.
export const compactWindow = roll => Math.min(ROLL.WINDOW_MAX, Math.max(ROLL.WINDOW_MIN, roll > 0 ? roll + ROLL.NET : 0));
export const compactThreshold = window => window - ROLL.CLI_MARGIN;
// The child environment with the window set. An owner's own CLAUDE_CODE_AUTO_COMPACT_WINDOW wins.
export function withCompactWindow(childEnv, roll, env = {}) {
  childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW || compactWindow(roll));
  return childEnv;
}
// The prompt of one model call (an SDK assistant message's `usage`): what the price line is measured on. null without usage.
export function ctxOf(u) {
  if (!u || typeof u !== 'object') return null;
  const n = v => Number.isFinite(v) && v > 0 ? v : 0, t = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return t > 0 ? t : null;
}
export const ctxText = n => Number.isFinite(n) ? `ctx ${Math.round(n / 1000)}k` : 'ctx ?';
// Is a roll due now? busy: the game waits on the seat. -> null or {why, line}.
// A session saved before ctx was kept has no size: past ROLL.LEGACY_TURNS it is rolled rather than paid for once more (about 4k
// tokens a turn on top of 25k measured live, so it is at the roll point by then, and a resume after a pause reads it all uncached).
// askFresh: the page asked for fresh sessions (a "fresh" line on stdin, scripts/runners.mjs): every session this process plays rolls
// at its next safe moment, a multi-player runner's each on its own. Counted per session object, never saved.
let freshAsks = 0; const freshSeen = new WeakMap();
export const askFresh = () => {freshAsks++};
// lazy: whether this runner plays with lazy tools (undefined for seats with no such switch): a session started the other way rolls, so
// none carries both tool shapes.
export function rollDue(sess, limit, {busy = false, legacy = true, lazy} = {}) {
  if (busy) return null;
  if (lazy !== undefined && sess.sessionId && !!sess.lazyTools !== lazy) return {why: 'tools', line: `[session rolled: lazy tools ${lazy ? 'on' : 'off'}]`};
  if (freshAsks > (freshSeen.get(sess) || 0)) {
    if (sess.sessionId || (sess.local && sess.local.history && sess.local.history.length)) return {why: 'asked', line: '[session rolled: a fresh session was asked for]'};
    freshSeen.set(sess, freshAsks); // nothing to set aside yet
  }
  if (!sess.sessionId || !(limit > 0)) return null;
  if (sess.ctx == null) return legacy && sess.turns >= ROLL.LEGACY_TURNS ? {why: 'legacy', line: `[session rolled: size not kept, ${sess.turns} turns]`} : null;
  return sess.ctx >= limit ? {why: 'size', line: `[session rolled: ${Math.round(sess.ctx / 1000)}k tokens]`} : null;
}
// Roll in place, so everything the runner holds on the session object (standing orders, runner settings,
// turns, spend) carries on. setAside(sess): the seat's own archive. The cost and usage baselines restart with the new SDK session.
export function rollSession(sess, setAside) {
  const to = setAside(sess);
  sess.sessionId = null; sess.lastTotal = 0; sess.lastUsage = null; sess.ctx = null; sess.rolls = (sess.rolls || 0) + 1; sess.rolled = true; // rolled: the next ordinary turn is told to re-read (resumeNote); cleared once that turn has started
  if (sess.local) sess.local = {...sess.local, history: []}; // a fresh session asked of a local or OpenAI mind
  freshSeen.set(sess, freshAsks);
  return to;
}
// What the CLI says it will do, once a run: a threshold that is not ours means the SDK stopped honouring the variable.
export async function reportThreshold(q, window, log) {
  try {
    const u = await q.getContextUsage({detail: 'summary'}), t = u && u.autoCompactThreshold, want = compactThreshold(window);
    if (t == null) return log('[session] the SDK reports no compaction threshold; the roll still keeps the session small');
    log(t <= want ? `[session] compaction net at ${Math.round(t / 1000)}k tokens` : `[session] warning: the SDK compacts at ${Math.round(t / 1000)}k, not ${Math.round(want / 1000)}k; the roll still keeps the session small`);
  } catch {}
}
