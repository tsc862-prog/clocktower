// Runner supervisor: lets the page start and stop the seats' runners, so the owner never needs a terminal per seat. The relay
// (scripts/relay.mjs --runners) attaches it next to the seat routes of relay-mcp.mjs.
//
//   GET  /play/runner         {ok, enabled, how?, session, max, seats, claude: {slots, used, waiting, ...}, kinds, providers, runners: [...]}
//   POST /play/runner/start   {kind?: 'player'|'storyteller', player?, provider?, model?, maxTurns?, budget?, fresh?} -> {ok, runner} | 4xx {error}
//   POST /play/runner/stop    {kind?, player?} (or {key}) -> {ok, runner}
//   POST /play/runner/stop-all {why?, waitMs?}: every runner, before a new game replaces the seats
//   POST /play/runner/fresh   {key?} -> {ok, asked: [key]}: that live runner, or all, set their conversations aside at the next safe
//                             moment (a "fresh" line on stdin; scripts/session-roll.mjs)
//   POST /play/runner/limits  {sessionBudget?: number|null} and/or {key, maxTurns?, budget?} -> {ok, session, runner?, applies?}: the
//                             session budget caps what all paid runners started here spend together (a paid runner's budget is clipped
//                             to what is left; when it runs out every paid runner is stopped and new paid starts are refused); a
//                             running runner's own turn cap or budget can be lowered live (the supervisor stops it on reaching it)
//   POST /play/runner/slot, /slot/release, /slot/cancel, /slot/beat: the Claude slot leases (scripts/pacing.mjs takeClaudeSlot)
//   POST /play/runner/resume  {scripted?: true} -> {ok, runner}: the owner resumes a game whose Storyteller runner is gone; by
//                             default the scripted Storyteller (scripts/storyteller-runner.mjs --scripted) answers from here on
//
// The game budget (issue #12): GAME_BUDGET dollars (default 5.00) across every paid runner of the game, split in two pools so the
// game never loses its Storyteller first: the Storyteller's share (STORYTELLER_SHARE, default 0.30) set apart, the rest for the
// seven players. A runner started with no budget gets its default (a player: the players' pool / 7; the Storyteller: its pool);
// any budget is clipped to what is left in its pool, and when a pool is spent its paid runners stop ("game budget reached").
// POST /play/runner/limits {gameBudget} changes the total; a new game (stop-all) starts the pools over.
// A gone Storyteller pauses the game: when the Storyteller's runner ends while the game runs, the supervisor marks the game paused
// (GET /play/runner: paused) and nothing answers for the Storyteller; the owner's resume starts the scripted fallback.
//
// Cost is the limit, not turns: no runner has a turn cap unless one is asked. A paid runner plays until stopped or until its budget
// in dollars is spent; a local one (Ollama) costs nothing and plays until stopped.
// A budget stop: a runner whose budget is spent (its own "stopped after N turns (budget reached)", a lowered cap or the session
// budget) is marked (r.budgetOut, `budgetSpent` in the view) and is never started again by anything but a person: it leaves the
// active list and resume() skips it across a relay restart (the list's `spent`). Every start and end goes to
// logs/runners/events.jsonl with who asked (`by`: owner, page, setup, resume, local) and why it ended (`why`).
//
// A runner is one child process of a known kind (RUNNER_KINDS): 'player' plays one player seat (a Claude seat:
// scripts/agent-seat.mjs; any other mind: scripts/seat-runner.mjs --player <id>), 'storyteller' the Storyteller seat
// (scripts/storyteller-runner.mjs; one at most). Each runner has a key
// ('player:3', 'storyteller'), a state (starting, live, waiting, stopping, stopped, crashed), pid, uptime, turns and cost (read
// from its turn lines: "[turn N ..." and "| run $x"), turns per minute, what its pacing waits for (its last "[pace]" line),
// provider and model, the last lines of its output and, when it crashed, its last error line. Output goes to
// logs/runners/<key>.log (AGENT_LOGS moves logs/ for tests).
//
// Children are spawned with process.execPath and an argument array (no npm, no shell). They inherit the host's environment as a
// terminal runner would (the relay has read .env; a key is never put in arguments or logs) plus CLOCKTOWER_SUPERVISED=1: a
// supervised runner stops cleanly on a "stop" line on stdin and also when stdin closes, so a relay that dies takes its runners
// with it. On stop the supervisor writes "stop", waits STOP_GRACE_MS, then kills; on host exit every child is killed.
//
// Safety: off unless enabled (--runners / RELAY_RUNNERS=1); only loopback sockets with a localhost Host; only no Origin (local tools)
// or the page's origin; a player seat must be one the game names (and not already held by a live runner); providers limited to
// RUNNER_PROVIDERS, model names to MODEL_RE; budgets capped per kind; at most MAX_RUNNERS at once (the seven players and the
// Storyteller), and at most RUNNER_CLAUDE_MAX concurrent Claude turns across them. The runners' output lines are for the watcher's
// page only: a request without the page's origin gets the states without the lines.
import {spawn} from 'node:child_process';
import {mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {hostname} from 'node:os';
import {fileURLToPath} from 'node:url';
import {LOGS, RUNNER_PROVIDERS, sessionPath} from './agent-sessions.mjs';
import {numCtxFrom} from './providers/ollama.mjs';
import {askFresh} from './session-roll.mjs';
import {DEFAULT_CLAUDE_MODEL} from '../src/data/prompts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Claude slots: concurrent Claude turns the runners may run (env RUNNER_CLAUDE_MAX, at least 1). A supervised Claude runner leases a
// slot for each turn and waits when all are taken, so any number of Claude runners can be started while at most this many talk to
// the API at once. The Storyteller has slots of its own (RUNNER_STORYTELLER_SLOTS, default 1; 0 = it queues with the players),
// outside RUNNER_CLAUDE_MAX. RUNNER_SCENE_SLOTS (default 1) of RUNNER_CLAUDE_MAX are kept for a seat the game waits on (a vote):
// other turns stop one short of the cap. A lease lives while its holder beats (SLOT_BEAT_MS): silent for SLOT_LOST_MS it is
// reclaimed, and a holder with no tool call for SLOT_MAX_MS is told it lost the slot and ends its turn. Local (Ollama) runners take none.
export const CLAUDE_SLOTS = 3, STORYTELLER_SLOTS = 1, SCENE_SLOTS = 1, LEASE_WAIT_MS = 20000;
export const SLOT_BEAT_MS = 30000, SLOT_LOST_MS = 95000, SLOT_MAX_MS = 10 * 60000;
export const PLAYER_SEATS = 7, SEATS = PLAYER_SEATS + 1; // seven players and the Storyteller
export const RESET_WAIT_MS = 5000;
// The Claude model a runner started from the page plays when neither the request nor the seat's saved settings name one: the
// cheapest (src/data/prompts.js). AGENT_MODEL / STORYTELLER_MODEL in the relay's environment override it.
export const APP_CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
export const MAX_RUNNERS = SEATS, STOP_GRACE_MS = 6000, KEEP_LINES = 12, MAX_BODY = 4096, KEEP_DONE = 20, TPM_WINDOW = 10 * 60000;
export const MODEL_RE = /^[A-Za-z0-9][\w.:\/+-]{0,99}$/; // the relay's (providers/index.mjs), kept here so this module has no SDK imports
export const HOW = 'Runners are off. Start the relay with runners on: npm run relay -- --runners (or set RELAY_RUNNERS=1).';
// Kinds of runner. defaults: what a start uses; caps: the most a request may ask. No turn cap by default: maxTurns stays optional.
// The game budget in dollars and the Storyteller's share of it, set apart (issue #12: $5 a game, Haiku on every seat).
export const GAME_BUDGET = 5, STORYTELLER_SHARE = 0.3, GAME_BUDGET_MAX = 500;
const cents = v => Math.floor(v * 100 + 1e-9) / 100;
// The two pools and each runner's default budget for a game of `total` dollars.
export function gameShares(total = GAME_BUDGET, share = STORYTELLER_SHARE) {
  const st = total * share, players = total - st;
  return {total, share, pools: {storyteller: st, players}, player: Math.max(.01, cents(players / PLAYER_SEATS)), storyteller: Math.max(.01, cents(st))};
}
const envNum = (v, d) => v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v);
export const gameFromEnv = (env = {}) => gameShares(Math.min(GAME_BUDGET_MAX, Math.max(.01, envNum(env.GAME_BUDGET, GAME_BUDGET))), Math.min(.9, Math.max(.05, envNum(env.STORYTELLER_SHARE, STORYTELLER_SHARE))));
// A runner's default budget when none is asked: {player, storyteller}; RUNNER_BUDGET overrides both.
export const defaultBudgets = (env = {}) => {const g = gameFromEnv(env), r = envNum(env.RUNNER_BUDGET, null); return r != null ? {player: r, storyteller: r} : {player: g.player, storyteller: g.storyteller}};
export const RUNNER_KINDS = {
  player: {script: 'scripts/seat-runner.mjs', claudeScript: 'scripts/agent-seat.mjs', label: 'player runner', needsPlayer: true,
    defaults: {maxTurns: null, budget: gameShares().player}, caps: {maxTurns: 500, budget: 5},
    key: r => 'player:' + r.player, args: r => ['--player', String(r.player)]},
  storyteller: {script: 'scripts/storyteller-runner.mjs', label: 'Storyteller runner', needsPlayer: false, seat: 'storyteller',
    missing: 'The Storyteller runner is not installed.',
    defaults: {maxTurns: null, budget: gameShares().storyteller}, caps: {maxTurns: 500, budget: 5},
    key: () => 'storyteller', args: r => r.scripted ? ['--scripted'] : []},
};
// The script a runner runs: a Claude player seat plays through the Agent SDK runner, every other mind through the local loop.
export const scriptOf = req => {const K = RUNNER_KINDS[req.kind]; return K.claudeScript && (req.claude || req.provider === 'anthropic') ? K.claudeScript : K.script};
export const kindInstalled = K => existsSync(join(ROOT, K.script));

const localHost = h => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ''));
const loopback = a => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));
// The reason a runner gives for ending by itself, and how a budget stop reads.
const OWN_END = /^(?:\[[\d:]+\] )?\[(?:agent|storyteller)\] stopped after \d+ turns[^()]*\(([^)]{1,80})\)/, BUDGET_WHY = /^((?:session|game) )?budget reached/;
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const num = v => v === undefined || v === null || v === '' ? null : Number(v);
export const SESSION_BUDGET_MAX = 500; // dollars: the most a session budget may be set to

// Check a start request against the kinds, providers and caps. players: the game's player seats. Returns {req} or {error, code}.
export function checkStart(b, players, {running = [], max = MAX_RUNNERS, budgets = null} = {}) {
  if (!b || typeof b !== 'object') return {error: 'bad body', code: 400};
  const kind = b.kind == null ? 'player' : b.kind, K = RUNNER_KINDS[kind];
  if (!K) return {error: 'unknown runner kind (one of: ' + Object.keys(RUNNER_KINDS).join(', ') + ')', code: 400};
  const req = {kind};
  if (b.provider != null && b.provider !== '') {if (!RUNNER_PROVIDERS.includes(b.provider)) return {error: 'unknown provider (one of: ' + RUNNER_PROVIDERS.join(', ') + ')', code: 400}; req.provider = b.provider}
  if (b.model != null && b.model !== '') {if (typeof b.model !== 'string' || !MODEL_RE.test(b.model)) return {error: 'bad model name', code: 400}; req.model = b.model}
  if (kind === 'storyteller' && b.scripted === true) {req.scripted = true; delete req.provider; delete req.model} // the scripted fallback: no mind
  const local = req.provider === 'ollama' || !!req.scripted; // every other provider is paid: it keeps a budget
  const mt = num(b.maxTurns), bu = num(b.budget);
  if (mt !== null && !(Number.isInteger(mt) && mt >= 1 && mt <= K.caps.maxTurns)) return {error: `maxTurns must be a whole number from 1 to ${K.caps.maxTurns}`, code: 400};
  if (bu !== null && !(Number.isFinite(bu) && bu >= .01 && bu <= K.caps.budget)) return {error: `budget must be from $0.01 to $${K.caps.budget.toFixed(2)}`, code: 400};
  if (b.fresh === true) req.fresh = true; // this start only: never saved to the active list, so a resume does not wipe a session
  req.maxTurns = mt; // null: until stopped (a paid mind until its budget is spent)
  req.budget = local ? null : bu ?? (budgets && budgets[kind] != null ? budgets[kind] : K.defaults.budget); // a local model costs nothing
  if (K.needsPlayer) {
    const id = typeof b.player === 'number' ? b.player : /^\d{1,9}$/.test(String(b.player ?? '').trim()) ? Number(String(b.player).trim()) : NaN;
    if (!Number.isInteger(id)) return {error: 'start needs the player seat id', code: 400};
    const h = (players || []).find(x => x.id === id);
    if (!h) return {error: `Seat #${id} is not at the table.`, code: 404};
    if (h.alive === false) return {error: `${h.name} is out of the game.`, code: 409};
    req.player = id; req.name = h.name;
  } else {
    if (!kindInstalled(K)) return {error: K.missing || `${K.label} is not installed.`, code: 501};
    req.name = K.label;
  }
  req.key = K.key(req);
  if (running.some(r => r.key === req.key)) return {error: `A ${K.label} for ${req.name} is already running.`, code: 409};
  if (running.length >= max) return {error: `At most ${max} runners at once (RELAY_MAX_RUNNERS). Stop one first.`, code: 429};
  return {req};
}

// The command line for a runner (no key, no shell): node <script> --url <base> ...
export function runnerArgs(req, base) {
  const K = RUNNER_KINDS[req.kind], a = [scriptOf(req), '--url', base, ...K.args(req)];
  if (req.maxTurns != null) a.push('--max-turns', String(req.maxTurns));
  if (req.budget != null) a.push('--budget', String(req.budget));
  if (req.provider) a.push('--provider', req.provider);
  if (req.model) a.push('--model', req.model);
  if (req.fresh) a.push('--new');
  return a;
}

// attachRunners(server, {play, enabled, origin, base, log, spawnImpl, logs, env, now}) -> {list, start, stop, stopAll, resetAll, ...}
//   play: attachPlay()'s return (backend, linkOf, runnerOf, claimed, holderOf, dropRunner, storytellerInfo)
//   base: () => the URL runners use to reach this server (http://127.0.0.1:<port>)
export function attachRunners(server, {play, enabled = false, origin = 'http://localhost:5173', base, log = console.log, spawnImpl = spawn, logs = LOGS, env = process.env, now = () => Date.now()} = {}) {
  const claudeMax = Number.isFinite(Number(env.RUNNER_CLAUDE_MAX)) && env.RUNNER_CLAUDE_MAX !== '' && env.RUNNER_CLAUDE_MAX != null ? Math.max(1, Number(env.RUNNER_CLAUDE_MAX)) : CLAUDE_SLOTS;
  const storytellerSlots = env.RUNNER_STORYTELLER_SLOTS !== '' && env.RUNNER_STORYTELLER_SLOTS != null && Number.isFinite(Number(env.RUNNER_STORYTELLER_SLOTS)) ? Math.max(0, Math.round(Number(env.RUNNER_STORYTELLER_SLOTS))) : STORYTELLER_SLOTS;
  const sceneSlots = env.RUNNER_SCENE_SLOTS !== '' && env.RUNNER_SCENE_SLOTS != null && Number.isFinite(Number(env.RUNNER_SCENE_SLOTS)) ? Math.min(claudeMax - 1, Math.max(0, Math.round(Number(env.RUNNER_SCENE_SLOTS)))) : Math.min(claudeMax - 1, SCENE_SLOTS);
  const maxRunners = Number(env.RELAY_MAX_RUNNERS) >= 1 ? Math.round(Number(env.RELAY_MAX_RUNNERS)) : MAX_RUNNERS;
  // Claude slot leases: lease id -> {key, member, at, beat, act, tools, idle, scene, ticket}. Waiters are served in order, scene
  // requests ahead of the rest; every grant goes through grantNext, which never grants to a request whose client has gone.
  const leases = new Map(), stLeases = new Map(), waiters = []; let leaseSeq = 0;
  const newLease = ({key, member = null, scene = false, ticket = null}) => ({key, member, scene, ticket, at: now(), beat: now(), act: now(), tools: 0, idle: false});
  const leaseName = l => l.member ? l.key + ' (' + l.member + ')' : l.key;
  const sweep = () => {for (const m of [leases, stLeases]) for (const [id, l] of m) if (now() - l.beat > SLOT_LOST_MS) {m.delete(id); log(`[runners] slot ${id} of ${leaseName(l)} reclaimed: no heartbeat for ${Math.round((now() - l.beat) / 1000)} s`)}};
  const grantNext = () => {sweep();
    while (waiters.length) {const w = waiters[0];
      if (w.http.destroyed) {waiters.shift(); clearTimeout(w.t); w.res(null); continue}
      if (leases.size >= (w.scene ? claudeMax : claudeMax - sceneSlots)) break;
      waiters.shift(); const id = 'L' + (++leaseSeq); leases.set(id, newLease(w)); clearTimeout(w.t); w.res(id)}};
  const dropLeases = key => {for (const m of [leases, stLeases]) for (const [id, l] of m) if (l.key === key) m.delete(id); grantNext()};
  const stLease = o => {sweep(); if (stLeases.size >= storytellerSlots) return null; const id = 'S' + (++leaseSeq); stLeases.set(id, newLease(o)); return id};
  const leaseOf = id => leases.get(id) || stLeases.get(id) || null;
  const dropLease = id => {const had = leases.delete(id) || stLeases.delete(id); grantNext(); return had};
  const leaseView = () => [...leases, ...stLeases].map(([id, l]) => ({id, key: l.key, member: l.member, age_s: Math.round((now() - l.at) / 1000), quiet_s: Math.round((now() - l.act) / 1000), idle: !!l.idle, scene: !!l.scene}));
  const beatTimer = setInterval(grantNext, SLOT_BEAT_MS); if (beatTimer.unref) beatTimer.unref();
  // the provider a seat's runner will use: the request's, else the seat's saved runner settings, else the default
  const providerFor = (id, asked) => {if (asked) return asked;
    try {const f = typeof id === 'string' ? join(logs, 'agents', id + '.json') : sessionPath(id, logs); if (existsSync(f)) {const j = JSON.parse(readFileSync(f, 'utf8')); if (j && j.runner && j.runner.provider) return j.runner.provider}} catch {}
    return env.AGENT_PROVIDER || 'anthropic'};
  const table = new Map(); // key -> runner record (running and recently finished)
  let closing = false; // the host is shutting down: what is running stays on the active list so a restart can resume it
  const session = {budget: null, spent: 0}; // one budget across every paid runner of this supervisor
  // the game budget: two pools, the Storyteller's set apart (issue #12)
  let game = gameFromEnv(env); const gameSpent = {players: 0, storyteller: 0};
  const r4 = v => Math.round(v * 10000) / 10000;
  const poolOf = r => RUNNER_KINDS[r.kind].seat === 'storyteller' ? 'storyteller' : 'players';
  const poolLeft = pool => Math.max(0, game.pools[pool] - gameSpent[pool]);
  const gameView = () => ({budget: game.total, storytellerShare: game.share, defaults: {player: game.player, storyteller: game.storyteller},
    players: {budget: r4(game.pools.players), spent: r4(gameSpent.players), left: r4(poolLeft('players'))}, storyteller: {budget: r4(game.pools.storyteller), spent: r4(gameSpent.storyteller), left: r4(poolLeft('storyteller'))}});
  const budgetsNow = () => defaultBudgets({...env, GAME_BUDGET: game.total, STORYTELLER_SHARE: game.share});
  // the game is paused while its Storyteller's runner is gone: {why, at}, until the owner resumes or a Storyteller runner starts
  let paused = null;
  const gameLive = () => {try {const g = play.backend.game; return !!g && !g.winner} catch {return false}};
  const left = () => session.budget == null ? Infinity : Math.max(0, session.budget - session.spent);
  const paid = r => r.budget != null;
  const sessionView = () => ({budget: session.budget, spent: Math.round(session.spent * 10000) / 10000, left: session.budget == null ? null : Math.round(left() * 10000) / 10000});
  const dir = join(logs, 'runners'), activeFile = join(dir, 'active.json'), eventsFile = join(dir, 'events.jsonl');
  const spentOut = new Map(); // key -> {key, kind, player, name, why, cost, budget, turns, at}: runners whose budget is spent
  const players = () => (play.backend.info().players || []);
  const running = () => [...table.values()].filter(r => !r.done);
  const host = hostname();

  // One line per start and end, for reports.
  function event(ev, r, more = {}) {try {mkdirSync(dir, {recursive: true}); appendFileSync(eventsFile, JSON.stringify({at: new Date(now()).toISOString(), event: ev, key: r.key, kind: r.kind, name: r.name, ...more}) + '\n')} catch {}}
  const budgetOf = r => r.capBudget ?? r.budget ?? null;
  const spendText = r => '$' + r.cost.toFixed(2) + ' of $' + Number(budgetOf(r) || 0).toFixed(2);
  const spentEntry = r => ({key: r.key, kind: r.kind, player: r.player ?? null, name: r.name, why: r.budgetOut.why, cost: r.cost, budget: budgetOf(r), turns: r.turns, at: new Date(r.budgetOut.at).toISOString()});
  // The runner's budget is spent: nothing automatic may bring it back.
  function budgetOut(r, why) {if (r.budgetOut) return; r.budgetOut = {why, at: now()}; spentOut.set(r.key, spentEntry(r));
    log(`[runners] ${r.key} ${r.name}: ${why}, ${spendText(r)}: it stays stopped until you start it`); event('budget', r, {why, cost: r.cost, budget: budgetOf(r)}); saveActive()}
  // A runner's state from its process and its seat's claim and link.
  function stateOf(r) {
    if (r.done) return r.state;
    if (r.stopping) return 'stopping';
    const seat = RUNNER_KINDS[r.kind].seat || r.player;
    if (!play.claimed(seat)) return 'starting';
    return play.linkOf(seat) === 'connected' ? 'live' : 'waiting';
  }
  function view(r) {
    const seat = RUNNER_KINDS[r.kind].seat || r.player, mind = play.runnerOf(seat);
    return {key: r.key, kind: r.kind, player: r.player ?? null, name: r.name, state: stateOf(r), pid: r.pid,
      startedAt: new Date(r.started).toISOString(), uptime: Math.round(((r.ended || now()) - r.started) / 1000),
      turns: r.turns, cost: Math.round(r.cost * 10000) / 10000, provider: (mind && mind.provider) || r.provider || null, model: (mind && mind.model) || r.model || null,
      capTurns: r.capTurns ?? null, capBudget: r.capBudget ?? null, stopWhy: r.stopWhy || null, by: r.by || null, endWhy: r.endWhy || null,
      ...(r.budgetOut ? {budgetSpent: true, spentWhy: r.budgetOut.why} : {}),
      maxTurns: r.maxTurns ?? null, turnCap: r.maxTurns != null ? 'up to ' + r.maxTurns + ' turns' : 'until stopped',
      ...(((mind && mind.provider) || r.provider) === 'ollama' ? {numCtx: numCtxFrom(env)} : {}),
      ...ctxView(r), ...turnRate(r), pace: r.pace || null, budget: r.budget, lines: r.lines.slice(-8), error: r.error || null, exit: r.exit ?? null,
      log: relative(ROOT, r.logFile).replace(/\\/g, '/')};
  }
  // the session's size in thousands of tokens, from the `ctx 83k` of its turn lines
  const ctxView = r => ({ctx: r.ctx ?? null, rolls: r.rolls || 0});
  // turns per minute over the last TPM_WINDOW (or the uptime when shorter) and the last turn's time
  function turnRate(r) {const t = now(), since = Math.max(r.started, t - TPM_WINDOW), n = (r.turnTimes || []).filter(x => x >= since).length, mins = Math.max(1 / 6, ((r.ended || t) - since) / 60000);
    const last = r.turnTimes && r.turnTimes.length ? r.turnTimes[r.turnTimes.length - 1] : null;
    return {turnsPerMin: Math.round(n / mins * 10) / 10, lastTurnAt: last ? new Date(last).toISOString() : null, lastTurnAgo: last ? Math.round(((r.ended || t) - last) / 1000) : null}}
  const list = () => [...table.values()].map(view);

  // The running runners, kept in logs/runners/active.json so `npm run up` can bring them back after a relay restart
  // (--resume-runners). A stop from the page, a crash or a runner that finished leaves the list; a host shutdown does not.
  function saveActive() {
    if (closing || !enabled) return;
    const rs = running().filter(r => !r.stopping && !r.budgetOut && !r.fresh).map(r => ({kind: r.kind, player: r.player ?? null, name: r.name, provider: r.provider || null, model: r.model || null, maxTurns: r.maxTurns ?? null, budget: r.budget ?? null}));
    try {mkdirSync(dir, {recursive: true}); const tmp = activeFile + '.tmp'; writeFileSync(tmp, JSON.stringify({saved: new Date(now()).toISOString(), runners: rs, ...(spentOut.size ? {spent: [...spentOut.values()]} : {})}, null, 1)); renameSync(tmp, activeFile)} catch {}
  }

  function start(req) {
    const args = runnerArgs(req, base());
    mkdirSync(dir, {recursive: true});
    const logFile = join(dir, req.key.replace(/[^A-Za-z0-9_-]+/g, '-') + '.log');
    const r = {...req, started: now(), turns: 0, cost: 0, lines: [], logFile, done: false};
    const write = line => {try {appendFileSync(logFile, line + '\n')} catch {}};
    write(`=== ${new Date().toISOString()} start ${req.kind} ${req.name} | node ${args.join(' ')} | by ${req.by || 'local'}`);
    let child;
    try {child = spawnImpl(process.execPath, args, {cwd: ROOT, env: {...env, CLOCKTOWER_SUPERVISED: '1', CLOCKTOWER_RUNNER_KEY: req.key, AGENT_MODEL: env.AGENT_MODEL || APP_CLAUDE_MODEL, STORYTELLER_MODEL: env.STORYTELLER_MODEL || APP_CLAUDE_MODEL}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true})}
    catch (e) {return {error: 'could not start: ' + e.message}}
    r.child = child; r.pid = child.pid;
    const take = (buf, err) => {
      r.partial = (r.partial || '') + stripAnsi(String(buf));
      const parts = r.partial.split(/\r?\n/); r.partial = parts.pop();
      for (const line of parts) {if (!line.trim()) continue;
        write(line); r.lines.push(line.slice(0, 300)); if (r.lines.length > KEEP_LINES) r.lines.shift();
        if (/\[turn \d+/.test(line)) {r.turns++; (r.turnTimes || (r.turnTimes = [])).push(now()); if (r.turnTimes.length > 200) r.turnTimes.shift()}
        const pc = line.match(/\[pace\] (.*)$/); if (pc) r.pace = pc[1].slice(0, 160);
        const cx = line.match(/\| ctx (\d+)k\b/); if (cx) r.ctx = Number(cx[1]);
        if (/\[session rolled/.test(line)) r.rolls = (r.rolls || 0) + 1;
        const c = line.match(/\| run \$(\d+\.\d+)/); if (c) {const v = Number(c[1]); if (v > r.cost) {session.spent += v - r.cost; gameSpent[poolOf(r)] += v - r.cost} r.cost = v}
        const oe = line.match(OWN_END); if (oe) r.ownEnd = oe[1];
        if (oe && oe[1] === 'budget reached') budgetOut(r, 'budget reached'); // the runner's own word on its budget
        if (err || /failed|error|not ready|refused|No ANTHROPIC|is not|cannot|could not/i.test(line)) r.lastErr = line.slice(0, 300);
      }};
    child.stdout && child.stdout.on('data', d => {take(d, false); checkCaps()});
    child.stderr && child.stderr.on('data', d => {take(d, true); checkCaps()});
    if (child.stdin) child.stdin.on('error', () => {});
    child.on('error', e => {r.lastErr = 'could not start: ' + e.message; finish(null)});
    child.on('exit', code => finish(code));
    function finish(code) {
      if (r.done) return;
      if (r.partial) take('\n', false);
      r.done = true; r.ended = now(); r.exit = code; clearTimeout(r.killT);
      r.state = r.stopping || code === 0 ? 'stopped' : 'crashed';
      if (r.state === 'crashed') r.error = r.lastErr || (code == null ? 'the process could not start' : 'exited with code ' + code);
      r.endWhy = r.budgetOut ? r.budgetOut.why : r.state === 'crashed' ? 'crash' : r.stopWhy || r.ownEnd || (r.stopping ? 'stopped by ' + (r.stopBy || 'the supervisor') : 'ended');
      if (r.budgetOut) spentOut.set(r.key, spentEntry(r));
      write(`=== ${new Date().toISOString()} ${r.state}${code != null ? ' (exit ' + code + ')' : ''}${r.error ? ': ' + r.error : ''} | why ${r.endWhy}${r.budgetOut ? ', ' + spendText(r) : ''}`);
      log(`[runners] ${r.key} ${r.name} ${r.state} (${r.endWhy})${r.error ? ': ' + r.error : ''} (${r.turns} turns${r.cost ? ', $' + r.cost.toFixed(4) : ''})`);
      event('end', r, {why: r.endWhy, state: r.state, exit: code, by: r.stopping ? r.stopBy || 'supervisor' : 'runner', turns: r.turns, cost: r.cost, budget: budgetOf(r), uptime: Math.round((r.ended - r.started) / 1000)});
      if (r.pid) play.dropRunner(`${host}:${r.pid}`); // its claims, in case it could not release them
      if (RUNNER_KINDS[r.kind].seat === 'storyteller' && !closing && gameLive()) { // nobody answers for the Storyteller now: the game waits for the owner
        paused = {why: `the Storyteller's runner ended (${r.endWhy})`, at: new Date(now()).toISOString()};
        log(`[runners] the game is paused: ${paused.why}; resume (POST /play/runner/resume) lets the scripted Storyteller answer`); event('pause', r, {why: paused.why})}
      dropLeases(r.key); saveActive();
      const done = [...table.values()].filter(x => x.done); // keep a few finished runners for the page
      if (done.length > KEEP_DONE) table.delete(done[0].key);
    }
    table.delete(req.key); table.set(req.key, r);
    if (RUNNER_KINDS[req.kind].seat === 'storyteller' && paused) {log(`[runners] the game resumes: ${req.scripted ? 'the scripted Storyteller' : 'a Storyteller runner'} answers`); paused = null}
    log(`[runners] started ${req.kind} runner for ${req.name} (pid ${r.pid}, by ${req.by || 'local'}): ${req.provider || 'saved provider'}${req.model ? ' ' + req.model : ''}, ${req.maxTurns != null ? req.maxTurns + ' turns' : 'until stopped'}${req.budget != null ? ', $' + req.budget.toFixed(2) : ''}`);
    event('start', r, {by: req.by || 'local', budget: req.budget ?? null, provider: req.provider || null, model: req.model || null, ...(spentOut.has(req.key) ? {afterBudget: spentOut.get(req.key).cost} : {})});
    spentOut.delete(req.key);
    saveActive();
    return {runner: view(r)};
  }

  // Limits set from the page: a lowered turn cap or budget, and the session budget.
  function checkCaps() {
    for (const r of running()) {if (r.stopping) continue;
      const why = r.capTurns != null && r.turns >= r.capTurns ? `turn cap reached: ${r.turns} of ${r.capTurns}`
        : r.capBudget != null && r.cost >= r.capBudget ? `budget reached: $${r.cost.toFixed(2)} of $${r.capBudget.toFixed(2)}`
        : paid(r) && session.budget != null && left() <= 0 ? `session budget reached: $${session.spent.toFixed(2)} of $${session.budget.toFixed(2)}`
        : paid(r) && poolLeft(poolOf(r)) <= 0 ? `game budget reached: ${poolOf(r) === 'storyteller' ? "the Storyteller's" : "the players'"} $${game.pools[poolOf(r)].toFixed(2)} of $${game.total.toFixed(2)} is spent` : null;
      if (why) {r.lines.push(`[runners] stopped after ${r.turns} turns (${why})`); if (r.lines.length > KEEP_LINES) r.lines.shift(); stop(r.key, why)}}}
  // Change limits. Returns {session, runner?, applies?} or {error, code}.
  function limits(b) {
    if (!b || typeof b !== 'object') return {error: 'bad body', code: 400};
    if ('sessionBudget' in b) {const v = num(b.sessionBudget);
      if (v !== null && !(Number.isFinite(v) && v >= .01 && v <= SESSION_BUDGET_MAX)) return {error: `sessionBudget must be from $0.01 to $${SESSION_BUDGET_MAX}, or null for none`, code: 400};
      session.budget = v; log(`[runners] session budget ${v == null ? 'off' : '$' + v.toFixed(2)} (spent $${session.spent.toFixed(4)})`)}
    if ('gameBudget' in b) {const v = num(b.gameBudget);
      if (!(Number.isFinite(v) && v >= .01 && v <= GAME_BUDGET_MAX)) return {error: `gameBudget must be from $0.01 to $${GAME_BUDGET_MAX}`, code: 400};
      game = gameShares(v, game.share); log(`[runners] game budget $${v.toFixed(2)} (the Storyteller's share $${game.pools.storyteller.toFixed(2)} set apart)`)}
    let out = {session: sessionView(), game: gameView()};
    if (b.key != null) {const r = table.get(String(b.key)); if (!r || r.done) return {error: 'no such live runner', code: 404};
      const K = RUNNER_KINDS[r.kind], mt = num(b.maxTurns), bu = num(b.budget); let later = false;
      if ('maxTurns' in b) {if (mt !== null && !(Number.isInteger(mt) && mt >= 1 && mt <= K.caps.maxTurns)) return {error: `maxTurns must be a whole number from 1 to ${K.caps.maxTurns}`, code: 400};
        const own = r.maxTurns ?? Infinity; r.capTurns = mt; if (mt == null ? own !== Infinity : mt > own) later = true}
      if ('budget' in b) {if (!paid(r)) return {error: 'a local runner has no budget', code: 400};
        if (bu !== null && !(Number.isFinite(bu) && bu >= .01 && bu <= K.caps.budget)) return {error: `budget must be from $0.01 to $${K.caps.budget.toFixed(2)}`, code: 400};
        r.capBudget = bu; if (bu == null || bu > r.budget) later = true}
      out = {...out, runner: view(r), applies: later ? 'next start' : 'now'}}
    checkCaps(); out.session = sessionView(); return out}

  function stop(key, why, by) {
    const r = table.get(key);
    if (!r) return {error: 'no such runner', code: 404};
    if (r.done) return {runner: view(r)};
    if (!r.stopping) {
      r.stopping = true; if (why) r.stopWhy = why; if (by) r.stopBy = by;
      if (why && BUDGET_WHY.test(why)) budgetOut(r, why.match(BUDGET_WHY)[0]);
      try {r.child.stdin && r.child.stdin.write('stop\n')} catch {}
      r.killT = setTimeout(() => {try {r.child.kill()} catch {}}, STOP_GRACE_MS); if (r.killT.unref) r.killT.unref();
      log(`[runners] stopping ${r.key} ${r.name} (pid ${r.pid})${why ? ': ' + why : ''}`);
      saveActive();
    }
    return {runner: view(r)};
  }
  function stopAll() {for (const r of running()) stop(r.key)}
  // Ask live runners to start fresh sessions; the runner rolls at its next safe moment.
  function fresh(key) {
    const rs = key == null ? running().filter(r => !r.stopping) : running().filter(r => r.key === key && !r.stopping);
    if (key != null && !rs.length) return {error: 'no such live runner', code: 404};
    for (const r of rs) {try {r.child.stdin && r.child.stdin.write('fresh\n')} catch {}}
    log(`[runners] fresh session asked of ${rs.map(r => r.key).join(', ') || 'nobody'}`);
    return {asked: rs.map(r => r.key)};
  }
  // A new game: stop every runner with one call, wait (up to waitMs) until they are gone, and leave the active list empty so
  // --resume-runners brings nothing back. -> {stopped: N, keys, left}
  async function resetAll({why = 'new game', waitMs = RESET_WAIT_MS} = {}) {
    const keys = running().map(r => r.key);
    for (const r of running()) stop(r.key, why);
    spentOut.clear(); gameSpent.players = 0; gameSpent.storyteller = 0; paused = null; // a new game: the pools start over
    for (const w of waiters.splice(0)) {clearTimeout(w.t); w.res(null)}
    const t0 = Date.now(); while (running().length && Date.now() - t0 < waitMs) await new Promise(r => setTimeout(r, 50));
    saveActive(); log(`[runners] new game: ${keys.length} runner(s) stopped`);
    return {stopped: keys.length, keys, left: running().length};
  }
  // Host shutdown (relay quit or restart): stop every runner cleanly but keep them on the active list. Resolves when they are all
  // gone, or after maxMs.
  function shutdown(maxMs = STOP_GRACE_MS + 2000) {
    closing = true; stopAll();
    return new Promise(res => {const t0 = Date.now(), poll = () => {if (!running().length || Date.now() - t0 > maxMs) res(); else setTimeout(poll, 100)}; poll()});
  }
  function killAll() {closing = true; for (const r of running()) {try {r.child.kill()} catch {}}}
  process.on('exit', killAll);
  server.on('close', killAll);

  const readBody = req => new Promise((res, rej) => {let size = 0; const chunks = [];
    req.on('data', c => {size += c.length; if (size > MAX_BODY) {rej(new Error('too large')); req.destroy()} else chunks.push(c)});
    req.on('end', () => {try {res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})} catch {rej(new Error('bad json'))}});
    req.on('error', rej)});

  // Every start, from the page or from resume(): the checks, then the child. -> {code, obj}
  function startRequest(b, by = 'local') {
    const c = checkStart(b, players(), {running: running(), max: maxRunners, budgets: budgetsNow()});
    if (c.error) {log(`[runners] start refused: ${c.error}`); return {code: c.code, obj: {ok: false, error: c.error}}}
    c.req.by = by;
    if (by === 'resume' && spentOut.has(c.req.key)) {const x = spentOut.get(c.req.key), error = `${x.name} spent its budget ($${Number(x.cost).toFixed(2)}): only you can start it again.`; log(`[runners] ${by} refused: ${error}`); return {code: 402, obj: {ok: false, error}}}
    const seat = RUNNER_KINDS[c.req.kind].seat || c.req.player;
    if (play.claimed(seat)) return {code: 409, obj: {ok: false, error: `${c.req.name} already has a live runner (one runner per seat).`}};
    if (c.req.kind === 'storyteller' && play.storytellerInfo && !play.storytellerInfo().seat) return {code: 409, obj: {ok: false, error: 'The Storyteller seat is closed.'}};
    c.req.claude = !c.req.scripted && providerFor(seat, c.req.provider) === 'anthropic';
    if (paid(c.req) && session.budget != null) {const l = left(); // the session budget: clip this runner's budget to what is left
      if (l < .01) return {code: 402, obj: {ok: false, error: `Session budget reached ($${session.spent.toFixed(2)} of $${session.budget.toFixed(2)}). Raise it to start another paid runner.`}};
      if (c.req.budget > l) c.req.budget = Math.floor(l * 100) / 100}
    if (paid(c.req)) {const pool = c.req.kind === 'storyteller' ? 'storyteller' : 'players', l = poolLeft(pool); // the game budget: clip to what is left of its pool
      if (l < .01) return {code: 402, obj: {ok: false, error: `Game budget reached: ${pool === 'storyteller' ? "the Storyteller's" : "the players'"} share of $${game.total.toFixed(2)} is spent. Raise it to start another paid runner.`}};
      if (c.req.budget > l) c.req.budget = Math.floor(l * 100) / 100}
    const s = start(c.req); if (s.error) return {code: 500, obj: {ok: false, error: s.error}};
    return {code: 200, obj: {ok: true, runner: s.runner}};
  }

  // Bring back the runners of the last run (logs/runners/active.json; `npm run up` passes --resume-runners): each saved runner whose
  // seat is still the same seat at the table (same id and name). Skipped ones leave the list. -> {resumed: [key], skipped: [{what, why}]}
  async function resume() {
    const out = {resumed: [], skipped: []};
    if (!enabled) return out;
    let saved, spent = []; try {const j = JSON.parse(readFileSync(activeFile, 'utf8')); saved = j.runners; spent = Array.isArray(j.spent) ? j.spent : []} catch {return out}
    saved = (Array.isArray(saved) ? saved : []).filter(x => x && typeof x === 'object' && RUNNER_KINDS[x.kind]);
    // Runners that ended on their budget stay ended across the restart: back on the page as stopped, and nothing below starts them.
    for (const x of spent.filter(x => x && typeof x === 'object' && RUNNER_KINDS[x.kind] && typeof x.key === 'string')) {if (table.has(x.key)) continue; spentOut.set(x.key, x); const at = Date.parse(x.at) || now(), why = x.why || 'budget reached';
      table.set(x.key, {...x, cost: Number(x.cost) || 0, budget: x.budget ?? null, started: at, ended: at, turns: Number(x.turns) || 0, lines: [], logFile: join(dir, x.key.replace(/[^A-Za-z0-9_-]+/g, '-') + '.log'), done: true, state: 'stopped', exit: 0, budgetOut: {why, at}, endWhy: why});
      out.skipped.push({what: x.name, why: 'its budget was spent'}); event('no-restart', x, {by: 'resume', why, cost: x.cost})}
    for (const x of saved) {
      if (closing) break;
      const what = x.name || x.kind, skip = why => {out.skipped.push({what, why}); log(`[runners] resume: skipped ${what}: ${why}`)};
      if (x.kind === 'player') {const h = players().find(y => y.id === x.player);
        if (!h) {skip('not at the table'); continue}
        if (x.name && h.name !== x.name) {skip(`seat #${x.player} is now ${h.name} (a new game?)`); continue}}
      const r = startRequest({kind: x.kind, ...(x.kind === 'player' ? {player: x.player} : {}), provider: x.provider || undefined, model: x.model || undefined, maxTurns: x.maxTurns ?? undefined, budget: x.budget ?? undefined}, 'resume');
      if (r.code === 200) {out.resumed.push(r.obj.runner.key); log(`[runners] resumed ${what}`)} else skip(r.obj.error || 'refused');
    }
    saveActive();
    return out;
  }

  // Routes in front of everything else on the server (the page calls these, so they answer CORS).
  const prior = server.listeners('request'); server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const path = (req.url || '').split('?')[0];
    if (!(path === '/play/runner' || path.startsWith('/play/runner/'))) {for (const f of prior) f.call(server, req, res); return}
    const o = req.headers.origin, okOrigin = !o || o === origin;
    const send = (code, obj) => {const h = {'content-type': 'application/json'}; if (o && o === origin) {h['access-control-allow-origin'] = origin; h.vary = 'origin'} res.writeHead(code, h); res.end(JSON.stringify(obj))};
    if (!localHost(req.headers.host) || !loopback(req.socket.remoteAddress)) return send(403, {error: 'host not allowed'});
    if (!okOrigin) return send(403, {error: 'origin not allowed'});
    if (req.method === 'OPTIONS') {res.writeHead(204, o === origin ? {'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin'} : {}); return res.end()}
    const kinds = Object.fromEntries(Object.entries(RUNNER_KINDS).map(([k, K]) => [k, {defaults: K.defaults, caps: K.caps, installed: kindInstalled(K)}]));
    // The runners' output (narration, tool results) is for the watcher's page only: a request without the page's origin (another
    // local process, a runner) gets the states without the lines.
    if (path === '/play/runner' && req.method === 'GET') {const page = o === origin, rs = enabled ? list().map(v => page ? v : {...v, lines: [], error: v.error ? 'see the runner log' : null}) : [];
      return send(200, {ok: true, enabled, ...(enabled ? {} : {how: HOW}), session: sessionView(), game: gameView(), paused, max: maxRunners, seats: SEATS, claude: {slots: claudeMax, used: leases.size, waiting: waiters.length, storytellerSlots, storytellerUsed: stLeases.size, sceneSlots, leases: leaseView()}, kinds, providers: RUNNER_PROVIDERS, runners: rs})}
    if (req.method !== 'POST') return send(404, {error: 'not found'});
    if (!enabled) return send(403, {error: 'runners are off', how: HOW});
    let b; try {b = await readBody(req)} catch (e) {return send(400, {error: e.message})}
    // who asked: the page says a click or the setup page; only the page's origin may say so
    if (path === '/play/runner/start') {const r = startRequest(b, o !== origin ? 'local' : b.by === 'owner' || b.by === 'setup' ? b.by : 'page'); return send(r.code, r.obj)}
    // A supervised runner's Claude turn: lease a slot (waits up to LEASE_WAIT_MS, then {ok: false, busy}; the runner asks again)
    // and release it after the turn. Only for a live runner of this supervisor.
    if (path === '/play/runner/slot') {
      const key = typeof b.key === 'string' ? b.key : '', r = table.get(key);
      if (!r || r.done) return send(404, {ok: false, error: 'no such live runner'});
      const t0 = Date.now(), isSt = RUNNER_KINDS[r.kind].seat === 'storyteller';
      const who = {key, scene: b.scene === true, member: typeof b.member === 'string' ? b.member.slice(0, 40) : null, ticket: typeof b.ticket === 'string' ? b.ticket.slice(0, 60) : null};
      let gone = res.destroyed; res.on('close', () => {if (!res.writableEnded) gone = true});
      if (isSt) {const id = stLease(who); if (id) return send(200, {ok: true, lease: id, slots: claudeMax, storyteller: true})} // the Storyteller's own slot first
      const id = await new Promise(done => {const w = {...who, http: res, res: done}; w.t = setTimeout(() => {const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); done(null)}, Math.max(1000, LEASE_WAIT_MS - (Date.now() - t0)));
        const at = w.scene ? waiters.findIndex(x => !x.scene) : -1; if (at >= 0) waiters.splice(at, 0, w); else waiters.push(w);
        res.on('close', () => {if (res.writableEnded) return; const i = waiters.indexOf(w); if (i >= 0) {waiters.splice(i, 1); clearTimeout(w.t); done(null)}});
        grantNext()});
      if (id && (gone || res.destroyed || res.writableEnded)) {dropLease(id); return} // granted to a request nobody waits on any more
      return send(200, id ? {ok: true, lease: id, slots: claudeMax} : {ok: false, busy: true, slots: claudeMax, waiting: waiters.length, ...(isSt ? {storyteller: true, storytellerSlots} : {})});
    }
    if (path === '/play/runner/slot/release') {if (typeof b.lease === 'string') dropLease(b.lease); return send(200, {ok: true})}
    if (path === '/play/runner/slot/cancel') {
      const t = typeof b.ticket === 'string' ? b.ticket : null, key = typeof b.key === 'string' ? b.key : null;
      if (t) for (const [id, l] of [...leases, ...stLeases]) if (l.ticket === t && l.key === key) {log(`[runners] slot ${id} of ${leaseName(l)} returned: its request was given up`); dropLease(id)}
      return send(200, {ok: true});
    }
    if (path === '/play/runner/slot/beat') {
      const id = typeof b.lease === 'string' ? b.lease : '', l = leaseOf(id);
      if (!l) return send(200, {ok: false, lost: true, why: 'the lease is gone'});
      l.beat = now(); if (typeof b.idle === 'boolean') l.idle = b.idle;
      if (Number.isFinite(b.tools) && b.tools !== l.tools) {l.tools = b.tools; l.act = now(); if (b.idle == null) l.idle = false}
      if (now() - l.act > SLOT_MAX_MS) {const why = `no tool call for ${Math.round((now() - l.act) / 60000)} min`; log(`[runners] slot ${id} of ${leaseName(l)} reclaimed: ${why}`); dropLease(id); return send(200, {ok: false, lost: true, why})}
      return send(200, {ok: true});
    }
    if (path === '/play/runner/stop-all') {
      const x = await resetAll({why: typeof b.why === 'string' && b.why ? b.why.slice(0, 60) : 'new game', waitMs: Number.isFinite(Number(b.waitMs)) ? Math.min(RESET_WAIT_MS, Math.max(0, Number(b.waitMs))) : RESET_WAIT_MS});
      return send(200, {ok: true, ...x});
    }
    // The owner resumes a game whose Storyteller runner is gone: the scripted fallback answers (or, with scripted: false, a mind).
    if (path === '/play/runner/resume') {
      const scripted = b.scripted !== false;
      const r = startRequest({kind: 'storyteller', ...(scripted ? {scripted: true} : {provider: b.provider, model: b.model, budget: b.budget})}, o !== origin ? 'local' : 'owner');
      return send(r.code, r.obj)}
    if (path === '/play/runner/limits') {const l = limits(b); if (l.error) return send(l.code, {ok: false, error: l.error}); return send(200, {ok: true, ...l})}
    if (path === '/play/runner/fresh') {const f = fresh(typeof b.key === 'string' ? b.key : null); if (f.error) return send(f.code, {ok: false, error: f.error}); return send(200, {ok: true, ...f})}
    if (path === '/play/runner/stop') {
      let key = typeof b.key === 'string' ? b.key : null;
      if (!key) {const K = RUNNER_KINDS[b.kind == null ? 'player' : b.kind]; if (!K) return send(400, {ok: false, error: 'unknown runner kind'}); key = K.key({player: Number(b.player)})}
      const s = stop(key, undefined, o === origin ? 'owner' : 'local'); if (s.error) return send(s.code, {ok: false, error: s.error});
      return send(200, {ok: true, runner: s.runner});
    }
    send(404, {error: 'not found'});
  });
  return {list, start, stop, fresh, stopAll, resetAll, shutdown, killAll, table, limits, resume, session: sessionView, game: gameView, paused: () => paused, activeFile, eventsFile};
}

// A supervised runner (CLOCKTOWER_SUPERVISED=1) calls this once: fn runs on a "stop" line on stdin, or when stdin closes (the
// supervisor went away). Returns false when not supervised.
export function onSupervisorStop(fn) {
  if (process.env.CLOCKTOWER_SUPERVISED !== '1' || !process.stdin) return false;
  let fired = false; const go = why => {if (fired) return; fired = true; fn(why)};
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {if (/\bstop\b/.test(d)) go('stopped from the page'); if (/\bfresh\b/.test(d)) askFresh()});
  process.stdin.on('end', () => go('the supervisor went away'));
  process.stdin.on('error', () => go('the supervisor went away'));
  process.stdin.resume();
  return true;
}
