// KEPT FOR NOW: the cost section of the behavior report; it reads the runners' turn lines as they are today, while its
// company and table rows are the borrowed game's and go with the behavior report's rebuild.
// npm run cost-report: where the runners' money goes, from what the runners and the relay already logged. Reads
// logs/behavior/<game>/{turns,game,decisions}.jsonl, logs/runners/*.log and logs/fellowship-runs.jsonl; writes
// logs/cost/<date>.md and one line per game and day in logs/cost/history.jsonl. The behavior report carries the same
// tables as its Cost section (costSection) and the launcher's `s` one line (todayLine).
//
//   npm run cost-report the game whose logs changed last
//   npm run cost-report -- --game stepping
//   npm run cost-report -- --all every game under logs/behavior/, and their total
//   options: --dir DIR (the behavior root, as behavior-report), --hours N (only the last N real hours; history is then left
//   alone), --out DIR (default logs/cost beside the behavior root), --stdout (print the report too)
//
// Money is always the cost the turn line logged, never recomputed from tokens: the runners price cached reads and the price
// line, and an older line has no way to redo that. Fields that may be missing: cacheRead, cacheWrite (before ), ctx (the
// last call's prompt), tokensCached (the cached part of tokensIn, OpenAI). tokensCached is inside tokensIn, so it
// is never added to the prompt; cacheRead is outside it. Numbers, seats, names and model ids only: no narration, wake text,
// tool results or runner log text ever reaches the report. Plain Node, no dependency.
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {behaviorRoot, FILES, scrub, legacyTokens} from './behavior-log.mjs';
import {readJsonl, games, lastGame, table} from './behavior-report.mjs';
import {pctile} from './mind-compare.mjs';
import {WRITE_KINDS} from '../src/data/prompts.js';

export const COST = {
  LINE: 100000,      // prompt tokens a call: past this Haiku's input costs about five times as much
  SEATS: 15,         // rows of the seat table; the rest are one line
  ACTIVE_GAP: 15,    // real minutes between turns that still count as one stretch of play
  CLOCK_DROP: 720,   // without digests: game minutes the clock must fall to count as another game (a slow turn's line lands late)
  CLOCK_JUMP: 360,   // without digests: the most game minutes one step may add (a loaded save is not play)
};
// Wake reasons, in the order the tables show them.
export const WAKES = ['start-up', 'scene', 'fireside', 'reflection', 'hear: party', 'hear: others', 'urgent', 'soft', 'heartbeat', 'storyteller turn'];
const VOICES = ['talk', 'table', 'ruling', 'companion'];

const fin = v => Number.isFinite(v);
const tsOf = r => {const t = Date.parse(r.ts); return fin(t) ? t : 0};
const usd = (v, d = 2) => v == null ? '-' : '$' + v.toFixed(d);
const pc = (a, b) => b ? Math.round(a / b * 100) + '%' : '-';
const r1 = v => v == null ? '-' : String(Math.round(v * 10) / 10);
const kTok = v => v == null ? '-' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v));
const div = (a, b) => b ? a / b : null;
const mindOf = t => (t.provider || '?') + '/' + (t.model || '?');
const playerId = s => {const m = /^player:(\d+)$/.exec(s || ''); return m ? Number(m[1]) : null};
const dateOf = ms => {const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`};

// Why a turn happened. Flags first (a reflection or a scene is what the turn was spent on, whatever woke it); the wake's text is
// read here and goes no further. A turn with no wake is a runner's first turn. The Storyteller seat has no /play/pace.
export function wakeClass(t) {
  if (t.seat === 'storyteller') return 'storyteller turn';
  const f = new Set(t.flags || []), w = t.wake || null, why = String(w && w.why || '');
  if (/^a scene at the table: Round the fire/.test(why)) return 'fireside';
  if (f.has('reflection') || /^a moment to reflect/.test(why)) return 'reflection';
  if (f.has('scene') || f.has('forced-scene') || f.has('scene-first') || f.has('scene-grab') || f.has('scene-jump') || /^a scene at the table/.test(why)) return 'scene';
  if (!w || !w.wake) return 'start-up';
  if (w.wake === 'heartbeat') return 'heartbeat';
  if (/^\[party\] /.test(why)) return 'hear: party';
  if (/^[^"]{1,60} says: "/.test(why)) return 'hear: others';
  return w.wake === 'soft' ? 'soft' : 'urgent';
}

// A turn's prompt size: {calls, perCall, prompt, cached}, or null when the line cannot say (a cumulative line, no tokens).
// Model calls are not logged per turn: each tool call is followed by one more call (a forced scene answer is the one call, and
// the runner sends its tool). ctx is the real size of the last call; without it, the turn's prompt tokens over its calls.
export function promptOf(t) {
  if (legacyTokens(t)) return null;
  const prompt = (t.tokensIn || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  if (!prompt) return null;
  const calls = (t.flags || []).includes('forced-scene') ? Math.max(1, t.calls || 0) : (t.calls || 0) + 1;
  return {calls, prompt, perCall: fin(t.ctx) ? t.ctx : prompt / calls, cached: (t.cacheRead || 0) + (t.tokensCached || 0)};
}

const clockMin = c => {const m = /^Day (\d+) (\d\d):(\d\d)/.exec(c || ''); return m ? (m[1] - 1) * 1440 + m[2] * 60 + +m[3] : null};
const gameMinOf = r => fin(r.gameMin) ? r.gameMin : clockMin(r.clock || r.brief && r.brief.clock);
// Game hours played. Every digest is one game hour that really passed, whatever games came and went. With no digests (a host
// without them) the clock's forward steps over the turn lines; a fall of more than CLOCK_DROP is a new game.
export function gameHours(T = [], W = []) {
  if (W.length) return W.reduce((s, w) => s + (w.minutes || 60), 0) / 60;
  const xs = T.map(r => [tsOf(r), gameMinOf(r)]).filter(x => x[1] != null).sort((a, b) => a[0] - b[0]);
  let cur = null, min = 0;
  for (const [, g] of xs) {if (cur == null || g < cur - COST.CLOCK_DROP) cur = g; else if (g > cur) {min += Math.min(g - cur, COST.CLOCK_JUMP); cur = g}}
  return min / 60;
}
// Real hours in play: the gaps between turns up to ACTIVE_GAP.
export function activeHours(T = []) {
  const xs = T.map(tsOf).filter(Boolean).sort((a, b) => a - b); let ms = 0;
  for (let i = 1; i < xs.length; i++) {const d = xs[i] - xs[i - 1]; if (d <= COST.ACTIVE_GAP * 60e3) ms += d}
  return ms / 3600e3;
}
const runnerKind = t => t.seat === 'storyteller' ? 'storyteller' : /:(fellowship|company)/.test(t.runner || '') ? 'company runner' : 'player runner';

// The runner logs, cut into runs at their "=== <iso> start..." lines. Only the money at the end of a line is read: a voice line
// quotes what was said, so its text is never kept. Run: {file, seat, start, end, turn, turnN, voices: {kind: {n, cost}}}.
export function readRunnerLogs(dir) {
  const runs = []; if (!existsSync(dir)) return runs;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.log')).sort()) {
    let cur = null, text; try {text = readFileSync(join(dir, f), 'utf8')} catch {continue}
    const open = at => {cur = {file: f, seat: f === 'storyteller.log' ? 'storyteller' : f === 'fellowship.log' || f.startsWith('company') ? 'company' : 'player', start: at, end: at, turn: 0, turnN: 0, voices: {}}; runs.push(cur)};
    for (const line of text.split(/\r?\n/)) {
      const h = /^=== (\d{4}-\d\d-\d\dT[\d:.]+Z) (\w+)/.exec(line);
      if (h) {const at = Date.parse(h[1]); if (h[2] === 'start' || !cur) open(at); else cur.end = at; continue}
      if (!cur) open(0);
      const v = /^\[(talk|table|ruling|companion)\] .*, \$(\d+\.\d+)\s*$/.exec(line);
      if (v) {const x = cur.voices[v[1]] || (cur.voices[v[1]] = {n: 0, cost: 0}); x.n++; x.cost += +v[2]; continue}
      const c = /\[turn \d+[^\]]*\] .*\| (?:turn )?\$(\d+\.\d+)(?: \(|\s*\|)/.exec(line);
      if (c) {cur.turn += +c[1]; cur.turnN++}
    }
  }
  runs.sort((a, b) => a.start - b.start);
  runs.forEach((r, i) => {const n = runs.slice(i + 1).find(x => x.file === r.file); if (r.end <= r.start) r.end = n ? n.start : Date.now()});
  return runs;
}
const pickRuns = (runs, sinceMs) => runs.filter(r => !sinceMs || r.end >= sinceMs);
// The Storyteller's voices are not in the turn lines and the log names no game: a Storyteller run belongs to the game with most of the Storyteller's turn
// lines inside it. storytellerTurns: {game: [ms]}. Returns {game: {kind: {n, cost}}}; a run with no turn line goes under 'null'.
export function voicesByGame(runs, storytellerTurns) {
  const out = {};
  for (const r of runs) {
    if (r.seat !== 'storyteller' || !Object.keys(r.voices).length) continue;
    let best = null, n = 0; for (const [w, xs] of Object.entries(storytellerTurns)) {const c = xs.filter(t => t >= r.start && t <= r.end).length; if (c > n) {n = c; best = w}}
    const to = out[best] || (out[best] = {});
    for (const [k, v] of Object.entries(r.voices)) {const x = to[k] || (to[k] = {n: 0, cost: 0}); x.n += v.n; x.cost += v.cost}
  }
  return out;
}
export function readRuns(file, sinceMs = 0) {
  if (!existsSync(file)) return [];
  const out = []; for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {if (!l.trim()) continue; let j; try {j = JSON.parse(l)} catch {continue} if (fin(j.spent) && (!sinceMs || Date.parse(j.at) >= sinceMs)) out.push(j)}
  return out;
}

// The numbers. T, W, D: parsed turn, game and decision lines. voices: {kind: {n, cost}} of this game.
export function costData(T = [], W = [], D = [], {voices = {}} = {}) {
  const seen = new Map(); // player id -> [[ms, name]], for lines that carry no name
  const note = (id, ms, name) => {if (id == null || !name) return; let L = seen.get(id); if (!L) seen.set(id, L = []); L.push([ms, name])};
  const hours = new Map(); // id:name -> game hours in the digests
  for (const w of W) for (const m of w.members || []) {note(m.id, tsOf(w), m.name); const k = m.id + ':' + m.name; hours.set(k, (hours.get(k) || 0) + (w.minutes || 60) / 60)}
  for (const t of T) note(playerId(t.seat), tsOf(t), t.player && t.player.name);
  for (const L of seen.values()) L.sort((a, b) => a[0] - b[0]);
  const nameOf = (id, ms) => {const L = seen.get(id); if (!L) return null; let n = L[0][1]; for (const [t, x] of L) {if (t > ms) break; n = x} return n};

  const gh = gameHours(T, W), real = activeHours(T);
  const blank = o => ({...o, turns: 0, cost: 0, noCost: 0, calls: 0, callsPast: 0, costPast: 0, turnsPast: 0, turnsUnder: 0, costUnder: 0, per: [], ctx: null, prompt: 0, cached: 0});
  const add = (x, t, p) => {
    x.turns++; if (fin(t.cost)) x.cost += t.cost; else x.noCost++;
    if (!p) return;
    const past = p.perCall > COST.LINE; x.calls += p.calls; x.per.push(p.perCall); x.prompt += p.prompt; x.cached += p.cached;
    if (past) {x.callsPast += p.calls; x.turnsPast++; x.costPast += t.cost || 0} else {x.turnsUnder++; x.costUnder += t.cost || 0}
    if (fin(t.ctx)) x.ctx = Math.max(x.ctx || 0, t.ctx)};
  const seats = new Map(), minds = new Map(), wakes = new Map(), kinds = new Map(), total = blank({});
  const get = (m, k, o) => {let x = m.get(k); if (!x) m.set(k, x = blank(o)); return x};
  for (const t of T) {
    const p = promptOf(t), id = playerId(t.seat), name = t.seat === 'storyteller' ? 'Storyteller' : t.player && t.player.name || nameOf(id, tsOf(t)) || t.seat, mind = mindOf(t), wk = wakeClass(t), rk = runnerKind(t);
    for (const x of [total, get(seats, t.seat + '|' + name + '|' + mind, {seat: t.seat, id, name, mind}), get(minds, mind, {mind}), get(wakes, wk, {wake: wk}), get(kinds, rk, {kind: rk})]) add(x, t, p);
  }
  const relay = new Map();
  for (const d of D) {if (d.src !== 'relay') continue; const k = d.kind || '?'; let x = relay.get(k); if (!x) relay.set(k, x = {kind: k, writing: WRITE_KINDS.includes(k), calls: 0, failed: 0, cost: 0, costN: 0}); x.calls++; if (!d.ok) x.failed++; if (fin(d.cost)) {x.cost += d.cost; x.costN++}}
  const relayCost = [...relay.values()].reduce((s, x) => s + x.cost, 0), voiceCost = Object.values(voices).reduce((s, v) => s + v.cost, 0);
  const storytellerTurns = [...seats.values()].filter(s => s.seat === 'storyteller').reduce((s, x) => s + x.cost, 0), spend = total.cost + voiceCost + relayCost;
  const seatList = [...seats.values()].map(s => ({...s, hours: s.seat === 'storyteller' ? gh : hours.get(s.id + ':' + s.name) || null})).sort((a, b) => b.cost - a.cost || b.turns - a.turns);
  return {spend, turnCost: total.cost, voiceCost, relayCost, storytellerCost: storytellerTurns + voiceCost, storytellerShare: div(storytellerTurns + voiceCost, spend), total, gameHours: gh, realHours: real, perTurn: div(total.cost, total.turns), perGameHour: div(spend, gh), perRealHour: div(spend, real),
    seats: seatList, minds: [...minds.values()].sort((a, b) => b.cost - a.cost || b.turns - a.turns), wakes: WAKES.filter(w => wakes.has(w)).map(w => wakes.get(w)), kinds: [...kinds.values()].sort((a, b) => b.cost - a.cost), relay: [...relay.values()].sort((a, b) => b.calls - a.calls), voices};
}

const tok = x => {const p = pctile(x.per, 50); return p == null ? '-' : `${kTok(p)} / ${kTok(x.per.reduce((a, b) => Math.max(a, b), 0))}`};
const pastCell = x => x.calls ? `${pc(x.callsPast, x.calls)} (${x.callsPast} of ${x.calls})` : '-';
// The tables, as Markdown lines. head: the section heading, null for none.
export function costLines(c, tableFn = table, head = '## Cost') {
  const L = head ? [head, ''] : [];
  if (!c.total.turns && !c.relay.length && !c.voiceCost) {L.push('_No runner turn logged yet._', ''); return L}
  L.push(`Spend ${usd(c.spend)}: runner turns ${usd(c.turnCost)}, Storyteller voices ${usd(c.voiceCost)}, relay calls ${usd(c.relayCost)}. ${c.total.turns} turns at ${usd(c.perTurn, 4)} a turn; ${r1(c.gameHours)} game hours at ${usd(c.perGameHour, 3)} a game hour; ${r1(c.realHours)} real hours in play at ${usd(c.perRealHour)} an hour. The Storyteller's share: ${c.storytellerShare == null ? '-' : pc(c.storytellerCost, c.spend)} (${usd(c.storytellerCost)}). Calls past ${kTok(COST.LINE)} tokens: ${pastCell(c.total)}, on turns that cost ${usd(c.total.costPast)}.`, '');
  L.push('Money is the cost each turn line logged. Model calls are estimated (one per tool call, plus one), and so are tokens a call (the turn\'s prompt tokens over its calls) on lines without the logged last-call size.' + (c.total.noCost ? ` ${c.total.noCost} turn${c.total.noCost === 1 ? '' : 's'} logged no cost.` : ''), '');
  L.push('Per seat and model:', '');
  L.push(tableFn(['seat', 'model', 'turns', 'spend', 'share', '$ / turn', '$ / game hour', 'tokens a call p50 / max', 'calls past the line'],
    c.seats.slice(0, COST.SEATS).map(s => [s.name, s.mind, s.turns, usd(s.cost), pc(s.cost, c.spend), usd(div(s.cost, s.turns), 4), usd(div(s.cost, s.hours), 3), tok(s), pastCell(s)])), '');
  const rest = c.seats.slice(COST.SEATS);
  if (rest.length) L.push(`${rest.length} more seat${rest.length === 1 ? '' : 's'}: ${rest.reduce((t, s) => t + s.turns, 0)} turns, ${usd(rest.reduce((t, s) => t + s.cost, 0))}.`, '');
  L.push('Per model:', '');
  L.push(tableFn(['model', 'turns', 'spend', 'share', '$ / turn', '$ / turn under the line', '$ / turn past the line', 'tokens a call p50 / max', 'cached share of prompt', 'calls past the line'],
    c.minds.map(m => [m.mind, m.turns, usd(m.cost), pc(m.cost, c.spend), usd(div(m.cost, m.turns), 4), usd(div(m.costUnder, m.turnsUnder), 4), usd(div(m.costPast, m.turnsPast), 4), tok(m), m.prompt ? pc(m.cached, m.prompt) : '-', pastCell(m)])), '');
  L.push('Turns by wake reason (scene, fireside and reflection are what the turn was for, whatever woke it; start-up is a runner\'s first turn):', '');
  L.push(tableFn(['reason', 'turns', 'turns / game hour', 'spend', 'share', '$ / turn'],
    c.wakes.map(w => [w.wake, w.turns, r1(div(w.turns, c.gameHours)), usd(w.cost), pc(w.cost, c.spend), usd(div(w.cost, w.turns), 4)])), '');
  L.push('By runner:', '');
  L.push(tableFn(['runner', 'turns', 'spend', 'share', '$ / turn'], c.kinds.map(k => [k.kind, k.turns, usd(k.cost), pc(k.cost, c.spend), usd(div(k.cost, k.turns), 4)])), '');
  const vs = VOICES.filter(k => c.voices[k]);
  if (vs.length) {L.push('Storyteller voices (from the runner log; not in the turn lines):', ''); L.push(tableFn(['voice', 'calls', 'spend'], vs.map(k => [k, c.voices[k].n, usd(c.voices[k].cost, 4)])), '')}
  if (c.relay.length) {
    L.push('The relay\'s own calls (decisions and writing):', '');
    L.push(tableFn(['kind', 'writing', 'calls', 'failed', 'spend'], c.relay.map(x => [x.kind, x.writing ? 'yes' : '-', x.calls, x.failed, x.costN ? usd(x.cost, 4) + (x.costN < x.calls ? ` (${x.costN} calls priced)` : '') : 'not logged'])), '');
  }
  return L;
}
// The Cost section of the behavior report.
export function costSection(T, W, D, tableFn, {voices} = {}) {const data = costData(T, W, D, {voices}); return {lines: costLines(data, tableFn), data}}

// What only the runner records know, across games: budgets, and the runner logs beside the turn lines.
export function budgetLines(runs, tableFn = table) {
  if (!runs.length) return ['_No company run on record._', ''];
  const over = runs.filter(r => fin(r.budget) && r.spent >= r.budget), spent = runs.reduce((s, r) => s + r.spent, 0), by = new Map();
  for (const r of runs) {const k = r.budget == null ? 'none' : usd(r.budget); let x = by.get(k); if (!x) by.set(k, x = {k, n: 0, spent: 0, past: 0}); x.n++; x.spent += r.spent; if (fin(r.budget)) x.past += Math.max(0, r.spent - r.budget)}
  return [`${runs.length} company runs spent ${usd(spent)}; ${over.length} ended on their budget.`, '', tableFn(['budget', 'runs', 'spent', 'spent past the budget'], [...by.values()].map(x => [x.k, x.n, usd(x.spent), usd(x.past)])), ''];
}
export function checkLines(turnCost, logRuns) {
  const inLogs = logRuns.reduce((s, r) => s + r.turn, 0), n = logRuns.reduce((s, r) => s + r.turnN, 0);
  if (!n) return [];
  return [`Runner logs beside the turn lines: ${n} priced turns, ${usd(inLogs)} in the logs, ${usd(turnCost)} in the turn lines (a gap means turns the host did not log, or a game left out of this report).`, ''];
}

// Everything for one run of the command. root: the behavior root.
const logsOf = root => dirname(root);
export function loadGame(root, game, sinceMs = 0) {const dir = join(root, game); return {game, T: readJsonl(dir, FILES.turn, sinceMs), W: readJsonl(dir, FILES.game, sinceMs), D: readJsonl(dir, FILES.decision, sinceMs)}}
function storytellerTurnsOf(root) {const out = {}; for (const w of games(root)) out[w] = readJsonl(join(root, w), FILES.turn).filter(t => t.seat === 'storyteller').map(tsOf); return out}
// This game's Storyteller voices for the behavior report; no runner logs, no voices.
export function gameVoices(root, game, sinceMs = 0) {
  try {const runs = pickRuns(readRunnerLogs(join(logsOf(root), 'runners')), sinceMs); return runs.length ? voicesByGame(runs, storytellerTurnsOf(root))[game] || {} : {}} catch {return {}}
}
export function buildCost(root, list, {sinceMs = 0} = {}) {
  const logRuns = pickRuns(readRunnerLogs(join(logsOf(root), 'runners')), sinceMs), voices = voicesByGame(logRuns, storytellerTurnsOf(root)), runs = readRuns(join(logsOf(root), 'fellowship-runs.jsonl'), sinceMs);
  const parts = list.map(w => {const x = loadGame(root, w, sinceMs); return {...x, data: costData(x.T, x.W, x.D, {voices: voices[w] || {}})}});
  const L = [`# Cost report: ${list.join(', ')}`, '', `Generated ${new Date().toISOString()}${sinceMs ? `, covering the time since ${new Date(sinceMs).toISOString()}` : ''}.`, ''];
  if (parts.length > 1) L.push(`All ${parts.length} games: ${usd(parts.reduce((s, p) => s + p.data.spend, 0))}.`, '');
  for (const p of parts) {
    L.push(...costLines(p.data, table, '## ' + p.game));
    const days = dayLines(p.game, p.T, p.W, p.D);
    if (days.length > 1) L.push('Per day:', '', table(['date', 'spend', 'turns', '$ / turn', 'game hours', '$ / game hour', 'Storyteller turns share', 'calls past the line'], days.map(d => [d.date, usd(d.spend), d.turns, usd(d.perTurn, 4), d.gameHours, usd(d.perGameHour, 3), d.storytellerShare == null ? '-' : Math.round(d.storytellerShare * 100) + '%', d.pastLine == null ? '-' : Math.round(d.pastLine * 100) + '%'])), '');
  }
  L.push('## Company runs and budgets', '', '(All games; these logs name none.)', '', ...budgetLines(runs), ...checkLines(parts.reduce((s, p) => s + p.data.turnCost, 0), logRuns));
  return {md: scrub(L.join('\n') + '\n'), parts};
}
// history.jsonl: one line per game and local day, the newest figures replacing that day's line; days no log holds any more stay.
export function dayLines(game, T, W, D) {
  const by = new Map(), slot = ms => {const d = dateOf(ms); let x = by.get(d); if (!x) by.set(d, x = {T: [], W: [], D: []}); return x};
  for (const t of T) slot(tsOf(t)).T.push(t); for (const w of W) slot(tsOf(w)).W.push(w); for (const d of D) slot(tsOf(d)).D.push(d);
  const rd = (v, n = 4) => v == null ? null : +v.toFixed(n);
  return [...by.entries()].filter(([, x]) => x.T.length).map(([date, x]) => {const c = costData(x.T, x.W, x.D);
    return {date, game, spend: rd(c.spend), turns: c.total.turns, perTurn: rd(c.perTurn, 5), gameHours: rd(c.gameHours, 1), perGameHour: rd(c.perGameHour), storytellerShare: rd(c.storytellerShare, 3), pastLine: rd(div(c.total.callsPast, c.total.calls), 3)}});
}
export function writeHistory(file, lines) {
  const keep = new Map(), key = l => l.date + '|' + l.game;
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {if (!l.trim()) continue; try {const j = JSON.parse(l); keep.set(key(j), j)} catch {}}
  for (const l of lines) keep.set(key(l), l);
  writeFileSync(file, [...keep.values()].sort((a, b) => key(a).localeCompare(key(b))).map(l => JSON.stringify(l)).join('\n') + '\n');
}
// The launcher's line: today's spend over every game, from the turn lines and relay calls (the Storyteller's voices are in the report).
export function todayLine(root = behaviorRoot(), now = new Date()) {
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let spend = 0, turns = 0, hours = 0, storyteller = 0;
  for (const w of games(root)) {const x = loadGame(root, w, since), c = costData(x.T, x.W, x.D); spend += c.spend; turns += c.total.turns; hours += c.gameHours; storyteller += c.storytellerCost}
  if (!turns) return 'cost today: no runner turn yet';
  return `cost today: ${usd(spend)} over ${turns} turns, ${hours ? usd(spend / hours, 3) + ' a game hour' : 'no game hours yet'}, Storyteller ${pc(storyteller, spend)} (npm run cost-report)`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => {const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d};
  const root = opt('dir', behaviorRoot()), hours = Number(opt('hours', 0)), sinceMs = hours > 0 ? Date.now() - hours * 3600e3 : 0, out = opt('out', join(logsOf(root), 'cost'));
  const list = argv.includes('--all') ? games(root) : [opt('game', null) || lastGame(root)].filter(Boolean);
  if (!list.length) {console.error(`No behavior logs under ${root} yet. Run the relay (npm run relay) with agent runners first.`); process.exit(1)}
  for (const w of list) if (!existsSync(join(root, w))) {console.error(`No behavior logs for game "${w}" under ${root} (games: ${games(root).join(', ') || 'none'}).`); process.exit(1)}
  const r = buildCost(root, list, {sinceMs}), file = join(out, dateOf(Date.now()) + '.md');
  mkdirSync(out, {recursive: true}); writeFileSync(file, r.md);
  if (!sinceMs) writeHistory(join(out, 'history.jsonl'), r.parts.flatMap(p => dayLines(p.game, p.T, p.W, p.D)));
  for (const p of r.parts) console.log(`[cost-report] ${p.game}: ${usd(p.data.spend)}, ${p.data.total.turns} turns, ${usd(p.data.perGameHour, 3)} a game hour`);
  console.log(`[cost-report] -> ${file}`);
  if (argv.includes('--stdout')) console.log(r.md);
}
