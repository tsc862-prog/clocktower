// KEPT FOR NOW: the append-only writer works as is; the game-side digests and some detectors named below are the
// borrowed game's and are replaced when the engine writes its own (slice 2 on).
// Behavior logs: structured, append-only JSONL under logs/behavior/<game>/ for the
// watcher and the playtest-reviewer agent (.claude/agents/playtest-reviewer.md). Never read by a
// runner, a tool or the game: nothing here is ever fed to an agent.
//
//   turns.jsonl one line per agent turn (players and the Storyteller), sent by the runners
//                    (POST /play/behavior/turn, scripts/behavior-turn.mjs builds the line)
//   decisions.jsonl single decisions: src 'game' = a player's settled Mind entry (outcome applied, late,
//                    rejected, offline, superseded, overruled; sent by the game), src 'relay' = one /decide
//                    call as the relay saw it (status, latency, error; writing kinds too)
//   game.jsonl a game-side digest every game hour (src/sim/behavior.js), from the page through the
//                    play bridge or from the headless game directly
//   wishes.jsonl wish notes the Storyteller and the players leave for the builders (type 'wish', and 'attempt' lines for the
//                    free actions the Storyteller ruled on); sent by the game with the game digest, never read by an agent or a tool
//   anomalies.jsonl detectors, as they fire: here (turns, relay calls) and in the game (src/sim/behavior.js)
//
// Rules (and the owner's): no keys (every string is scrubbed of key-shaped text, headers are never
// logged), and no seat's private text in another seat's lines: a turn line comes only from the runner that
// holds that seat (relay-mcp checks the claim), carries its own narration and tool names with ok/error, never
// tool results or another seat's words; the game digest carries counts and states, never chat text.
// Files rotate by size (ROTATE.bytes;.1...keep), and the folder is under logs/ (gitignored).
import {mkdirSync, appendFileSync, statSync, renameSync, existsSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {notEnglish} from '../src/game/lang.js';
import {similar} from './local-agent.mjs'; // the same likeness the local loop uses for its repeat flag
export {similar};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// AGENT_LOGS moves logs/ for tests (as scripts/agent-sessions.mjs); BEHAVIOR_DIR moves just this folder.
export const behaviorRoot = (env = process.env) => env.BEHAVIOR_DIR ? env.BEHAVIOR_DIR : join(env.AGENT_LOGS || join(ROOT, 'logs'), 'behavior');
export const FILES = {turn: 'turns.jsonl', decision: 'decisions.jsonl', game: 'game.jsonl', anomaly: 'anomalies.jsonl', wish: 'wishes.jsonl'};
export const ROTATE = {bytes: 5 * 1024 * 1024, keep: 3};
// Detector knobs (relay side; the game-side ones are in src/sim/behavior.js BW).
export const BD = {
  EMPTY_RUN: 3,          // turns in a row without a tool call -> no-tool-calls
  REPEAT_SIM: 0.8,       // narration this alike (shared words) to one of the last REPEAT_BACK -> repeated-narration
  REPEAT_BACK: 4,
  REFUSED_RUN: 3,        // turns in a row whose every call failed -> refused-calls
  RELAY_FAILS: 5,        // relay failures (429, timeout, 5xx) within FAIL_WINDOW -> relay-failures
  FAIL_WINDOW: 5 * 60e3,
  FLOOD_PER_MIN: 90,     // tool calls a seat makes in one real minute -> request-flood
  DECIDE_PER_MIN: 240,   // relay /decide calls in one real minute -> request-flood (seat 'relay')
  MODEL_WINDOW: 30 * 60e3, // local models seen within this window (runners and minds) -> ollama-mismatch when more than one
  QUIET: 5 * 60e3,       // one anomaly line per (kind, seat) per this much real time; the rest are counted into the next
};
const FIGHT_WORDS = /\b(fight(s|ing)?|battl(e|es|ing)|strik(e|es|ing)|slash(es|ing)?|clash(es|ing)?|combat|parr(y|ies|ying)|swing(s|ing)?|blade meets|duel(s|ing)?|cut(s|ting)? down|lunge(s|d)?)\b/i;
const FIGHT_TOOLS = new Set(['fight', 'hunt', 'scene_act', 'flee']);
const FIGHT_STATES = new Set(['fight', 'duel', 'assist', 'raid', 'dungeon']);

// Key-shaped text never reaches a log line (Anthropic, OpenAI, Google keys, bearer tokens, key=value pairs).
const SECRET = [/sk-[A-Za-z0-9_\-]{12,}/g, /AIza[0-9A-Za-z_\-]{20,}/g, /\b(Bearer|x-api-key:?)\s+[A-Za-z0-9._\-]{12,}/gi, /\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET))\s*[=:]\s*\S+/g];
export function scrub(v, depth = 0) {
  if (typeof v === 'string') {let s = v; for (const re of SECRET) s = s.replace(re, '[redacted]'); return s}
  if (Array.isArray(v)) return depth > 6 ? [] : v.map(x => scrub(x, depth + 1));
  if (v && typeof v === 'object') {if (depth > 6) return {}; const o = {}; for (const [k, x] of Object.entries(v)) {if (/^(headers?|authorization|api_?key|key|env)$/i.test(k)) continue; o[k] = scrub(x, depth + 1)} return o}
  return v;
}
export const cut = (s, n) => {s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s};
// A safe folder name for a game.
export const gameName = w => String(w || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'clocktower';
// Narration that claims a fight while the game says there is none (the coordinator's bug: a model
// narrated a fight that ended long ago). brief/after: the player's state header before and after the turn.
// : a passing mention is not a claim. Only a sentence that says a fight is going on now counts:
// a present-tense cue, and none of the words of a negation, a plan, a finished fight or a fight someone else is in.
const NOT_CLAIM = /\b(rather than|instead of|avoid(s|ed|ing)?|without|no (more )?(fight|battle|combat)|not (to )?(fight|risk)|risk(ing)?|after (the|a|our|that)|ended|won|over|finish(ed|es)? (off |the |a )|to (finish|fight|avoid)|only|if|once|before|nearby|have been|had|was|were)\b/i;
const NOW_CLAIM = /\b(is|are|am|currently|still|now|let me|continues?|continuing|strikes|slashes|clashes|clashing|parries|swings|lunges|fights|battling)\b|\bI (strike|swing|slash|parry)\b/i;
export const claimsFightNow = text => String(text || '').split(/(?<=[.!?])\s+|\n+/).some(t => FIGHT_WORDS.test(t) && !NOT_CLAIM.test(t) && NOW_CLAIM.test(t));
export function staleClaim(narration, brief, after, tools = []) {
  if (!narration || !FIGHT_WORDS.test(narration) || !claimsFightNow(narration)) return null;
  const fighting = b => b && (b.foe || FIGHT_STATES.has(b.state));
  if (!brief && !after) return null;
  if (fighting(brief) || fighting(after) || tools.some(t => FIGHT_TOOLS.has(t.name))) return null;
  const s = (after || brief);
  return `narrates a fight while the game says ${s.state}${s.place ? ' in ' + s.place : ''}, no foe engaged`;
}

// behaviorLog({root, game, now, log}) -> the writer and the relay-side detectors.
export function behaviorLog({root = behaviorRoot(), game = 'clocktower', now = () => Date.now(), log = () => {}, rotate = ROTATE} = {}) {
  let cur = gameName(game);
  const seats = new Map(); // seat -> {empty, refused, narr:[],...}
  const quiet = new Map(); // kind|seat -> {at, held}
  const fails = []; // relay failure times
  const calls = new Map(); // seat -> [times] for floods
  const decides = [];
  const models = new Map(); // ollama model -> {at, who}
  const counts = {turn: 0, decision: 0, game: 0, anomaly: 0, wish: 0, dropped: 0};
  const dirOf = () => join(root, cur);
  function rot(file) {
    try {if (!existsSync(file) || statSync(file).size < rotate.bytes) return;
      for (let i = rotate.keep; i >= 1; i--) {const from = i === 1 ? file : `${file}.${i - 1}`, to = `${file}.${i}`; if (!existsSync(from)) continue; if (i === rotate.keep && existsSync(to)) rmSync(to); renameSync(from, to)}
    } catch (e) {log(`[behavior] rotate failed: ${e.message}`)}
  }
  function write(kind, rec) {
    const file = join(dirOf(), FILES[kind]);
    try {mkdirSync(dirname(file), {recursive: true}); rot(file); appendFileSync(file, JSON.stringify(scrub({ts: new Date(now()).toISOString(), game: cur, ...rec})) + '\n'); counts[kind]++}
    catch (e) {counts.dropped++; log(`[behavior] write failed: ${e.message}`)}
  }
  // One anomaly line per (kind, seat) per BD.QUIET; the ones held back are counted into the next line.
  function anomaly(a) {
    const k = a.kind + '|' + (a.seat || ''), q = quiet.get(k), t = now();
    if (q && t - q.at < BD.QUIET && !a.force) {q.held++; return false}
    const held = q ? q.held : 0; quiet.set(k, {at: t, held: 0});
    const {force, ...rest} = a;
    write('anomaly', {severity: 'warn', ...rest, ...(held ? {heldBack: held} : {})});
    return true;
  }
  const seatOf = s => {let x = seats.get(s); if (!x) seats.set(s, x = {empty: 0, refused: 0, narr: [], turns: 0}); return x};
  function sawModel(provider, model, who) {
    if (provider !== 'ollama' || !model) return;
    const t = now(); models.set(model, {at: t, who});
    for (const [m, v] of models) if (t - v.at > BD.MODEL_WINDOW) models.delete(m);
    if (models.size > 1) anomaly({kind: 'ollama-mismatch', seat: 'ollama', text: `local models in use at once: ${[...models.entries()].map(([m, v]) => m + ' (' + v.who + ')').join(', ')}; on one GPU they evict each other and every call waits for a reload`, evidence: {models: [...models.keys()]}});
  }
  function relayFail(why, who) {
    const t = now(); fails.push(t); while (fails.length && t - fails[0] > BD.FAIL_WINDOW) fails.shift();
    if (fails.length >= BD.RELAY_FAILS) anomaly({kind: 'relay-failures', seat: 'relay', severity: 'bad', text: `${fails.length} relay failures in ${Math.round(BD.FAIL_WINDOW / 60e3)} min (last: ${why}${who ? ', ' + who : ''})`, evidence: {count: fails.length, last: why}});
  }

  // A runner's turn (already checked to come from the seat's own runner). rec: see scripts/behavior-turn.mjs.
  function turn(rec) {
    const seat = rec.seat, S = seatOf(seat), tools = Array.isArray(rec.tools) ? rec.tools.slice(0, 40) : [];
    const narration = cut(rec.narration, 600), flags = new Set(Array.isArray(rec.flags) ? rec.flags.map(String) : []);
    const failed = tools.filter(t => !t.ok).length, refused = tools.filter(t => t.refused).length;
    if (!tools.length && !flags.has('reflection') && !flags.has('scene-cut')) flags.add('empty'); // a reflection answered "none" is not an empty turn
    if (tools.length && failed === tools.length) flags.add('refused');
    if (narration && S.narr.some(p => similar(p, narration) >= BD.REPEAT_SIM)) flags.add('repeat');
    if (narration && notEnglish(narration)) flags.add('foreign');
    const stale = rec.brief || rec.after ? staleClaim(narration, rec.brief, rec.after, tools) : null; if (stale) flags.add('stale');
    S.turns++; if (Number.isFinite(rec.ctx)) S.ctx = rec.ctx; if (narration) {S.narr.push(narration); if (S.narr.length > BD.REPEAT_BACK) S.narr.shift()}
    const line = {seat, player: rec.player || null, runner: rec.runner || null, provider: rec.provider || null, model: rec.model || null, turn: rec.turn ?? S.turns,
      gameMin: rec.gameMin ?? null, clock: rec.clock || null, wake: rec.wake || null, brief: rec.brief || null, after: rec.after || null,
      tools: tools.map(t => ({name: cut(t.name, 40), ok: !!t.ok, ...(t.ok ? {} : {error: cut(t.error, 140)}), ...(t.refused ? {refused: true} : {})})),
      calls: tools.length, failed, narration, seconds: rec.seconds ?? null, tokensIn: rec.tokensIn ?? null, tokensOut: rec.tokensOut ?? null, ...(Number.isFinite(rec.tokensCached) ? {tokensCached: rec.tokensCached} : {}), cacheRead: rec.cacheRead ?? null, cacheWrite: rec.cacheWrite ?? null, ...(Number.isFinite(rec.ctx) ? {ctx: rec.ctx} : {}), ...(Number.isFinite(rec.toolSearch) ? {toolSearch: rec.toolSearch} : {}), cost: rec.cost ?? null, ...(Array.isArray(rec.sceneS) && rec.sceneS.length ? {sceneS: rec.sceneS.slice(0, 8).map(Number).filter(Number.isFinite)} : {}), flags: [...flags].sort(), ...(rec.error ? {error: cut(rec.error, 200)} : {})};
    write('turn', line);
    sawModel(line.provider, line.model, seat);
    // detectors
    const who = rec.player && rec.player.name ? rec.player.name : seat;
    if (!flags.has('scene-cut')) S.empty = flags.has('empty') ? S.empty + 1 : 0;
    if (S.empty >= BD.EMPTY_RUN && (S.empty === BD.EMPTY_RUN || S.empty % 10 === 0)) anomaly({kind: 'no-tool-calls', seat, player: rec.player || null, severity: 'bad', text: `${who}: ${S.empty} turns in a row without a tool call (${line.provider || '?'}/${line.model || '?'})`, evidence: {run: S.empty, turn: line.turn, narration: narration.slice(0, 200)}, force: S.empty === BD.EMPTY_RUN});
    if (flags.has('repeat')) anomaly({kind: 'repeated-narration', seat, player: rec.player || null, text: `${who} repeats an earlier narration`, evidence: {turn: line.turn, narration: narration.slice(0, 200)}});
    if (flags.has('repeat-act')) anomaly({kind: 'repeated-act', seat, player: rec.player || null, text: `${who} repeats the same ${tools.filter(t => t.ok).map(t => t.name).slice(-1)[0] || 'act'} as last turn`, evidence: {turn: line.turn, tool: (tools.filter(t => t.ok).slice(-1)[0] || {}).name || null}});
    if (flags.has('foreign')) anomaly({kind: 'not-english', seat, player: rec.player || null, text: `${who} answered in another language (${line.model || '?'})`, evidence: {turn: line.turn, narration: narration.slice(0, 120)}});
    if (stale) anomaly({kind: 'stale-claim', seat, player: rec.player || null, severity: (rec.after || rec.brief || {}).state === 'town' ? 'warn' : 'bad', text: `${who} ${stale}`, evidence: {turn: line.turn, narration: narration.slice(0, 200), state: (rec.after || rec.brief || {}).state || null}});
    S.refused = flags.has('refused') ? S.refused + 1 : 0;
    if (S.refused >= BD.REFUSED_RUN) anomaly({kind: 'refused-calls', seat, player: rec.player || null, text: `${who}: every tool call failed for ${S.refused} turns in a row (last: ${line.tools.filter(t => !t.ok).map(t => t.name + ': ' + t.error).slice(-1)[0] || '?'})`, evidence: {run: S.refused, refused}});
    if (rec.error && /429|rate.?limit|overloaded|timed? ?out|timeout/i.test(rec.error)) relayFail(cut(rec.error, 80), seat);
    return line;
  }
  // One /decide call as the relay saw it (scripts/relay.mjs createRelay onDecide).
  function relayDecision(d) {
    const t = now(); decides.push(t); while (decides.length && t - decides[0] > 60e3) decides.shift();
    if (decides.length > BD.DECIDE_PER_MIN) anomaly({kind: 'request-flood', seat: 'relay', text: `${decides.length} brain-relay requests in the last minute`, evidence: {perMin: decides.length}});
    write('decision', {src: 'relay', kind: d.kind, player: d.player || null, provider: d.provider || null, model: d.model || null, ok: !!d.ok, status: d.status || (d.ok ? 200 : null), ms: d.ms ?? null,
      ...(Number.isFinite(d.cost) ? {cost: d.cost, tokensIn: d.tokensIn ?? null, tokensOut: d.tokensOut ?? null} : {}), ...(d.choice != null ? {choice: cut(d.choice, 40)} : {}), ...(d.error ? {error: cut(d.error, 160)} : {})});
    sawModel(d.provider, d.model, 'minds');
    if (!d.ok && (d.status === 429 || d.status === 504 || d.status >= 500 || /timeout|rate/i.test(d.error || ''))) relayFail(d.status === 429 ? '429 rate limited' : cut(d.error || d.status, 60), d.provider);
  }
  // A tool call through the play bridge (flood counting only; relay-mcp logs nothing else per call).
  function call(seat) {
    const t = now(); let l = calls.get(seat); if (!l) calls.set(seat, l = []);
    l.push(t); while (l.length && t - l[0] > 60e3) l.shift();
    if (l.length > BD.FLOOD_PER_MIN) anomaly({kind: 'request-flood', seat, text: `${seat}: ${l.length} tool calls in the last real minute`, evidence: {perMin: l.length}});
  }
  // A record from the game (the page over the play bridge, or the headless game): game digest, game-side
  // anomaly or a settled decision. links: the relay's link states and runner minds, added to the digest.
  function ingest(kind, rec, {links = null, runners = null} = {}) {
    if (!rec || typeof rec !== 'object') return false;
    if (kind === 'game') {
      const r = {...rec}; if (Array.isArray(r.members) && links) r.members = r.members.map(m => ({...m, link: links[m.id] || 'none', ...(runners && runners[m.id] ? {runner: runners[m.id]} : {})}));
      const ctx = {}; for (const [k, v] of seats) if (Number.isFinite(v.ctx)) ctx[k] = v.ctx; if (Object.keys(ctx).length) r.ctx = ctx; // each seat's last prompt size
      write('game', r); return true}
    if (kind === 'wish' && (rec.type === 'wish' || rec.type === 'attempt')) { // #663: the text is the agent's own, English-only and capped by the game; the writer scrubs keys
      const r = {...rec}; for (const k of ['tool', 'what', 'why', 'moment', 'summary', 'place', 'name', 'skill']) if (typeof r[k] === 'string') r[k] = cut(r[k], k === 'what' ? 300 : 200);
      write('wish', r); return true}
    if (kind === 'anomaly' && typeof rec.kind === 'string') {anomaly({...rec, kind: cut(rec.kind, 40), text: cut(rec.text, 300)}); return true}
    if (kind === 'decision') {write('decision', {...rec, src: 'game'}); if (rec.outcome === 'offline' && /429|rate|timeout|unreachable/i.test(rec.error || '')) relayFail(cut(rec.error, 60), rec.provider); sawModel(rec.provider, rec.model, 'minds'); return true}
    return false;
  }
  return {turn, relayDecision, call, ingest, anomaly, setGame(w) {const n = gameName(w); if (n !== cur) {cur = n; seats.clear()} return cur}, get game() {return cur}, dir: dirOf, counts};
}

// A Claude turn line written before has no cacheRead field and its tokensIn is the SDK's cumulative total (millions); readers leave it out of token averages.
export const legacyTokens = t => t.provider === 'anthropic' && !('cacheRead' in t) && Number.isFinite(t.tokensIn);
