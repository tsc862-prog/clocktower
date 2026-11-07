// The Claude seat runner: one process plays one seat (a player, or the Storyteller) with the Claude Agent SDK through the relay,
// turn after turn, until it is stopped or its budget in dollars is spent. Ported from Eldmoor's agent-player.mjs and dm-agent.mjs
// (hero to player, dm to storyteller); dropped what the table has no use for (scenes, reflections, journals, personas, couriers,
// the world watch). scripts/agent-seat.mjs (a player) and scripts/storyteller-runner.mjs (the Storyteller) start it.
//
// Each run: claims the seat (refreshed every 10 s, released on exit), makes one warm-up call (the start gate,
// scripts/warmup.mjs), then each turn waits for the game (scripts/pacing.mjs, /play/pace), takes the seat's header as the turn
// prompt, leases a Claude slot under the supervisor, and plays one query() with the seat's own MCP tools and nothing else (no
// files, no shell, no web). Every turn prints one line with its cost and the session's size ("| ctx 23k | turn $x | run $y"),
// writes one behavior line (/play/behavior/turn, with the header it played from) and saves the session (logs/agents/).
// Between turns, never while the game waits on the seat, a session that reached its roll point is set aside and the next turn
// starts fresh (scripts/session-roll.mjs: under Haiku's 5x price line at 100k prompt tokens), with the SDK's compaction as a net.
// Cost is the limit, not turns: the run stops when its spend reaches --budget ("stopped after N turns (budget reached)"); there
// is no turn cap unless --max-turns is given. --tool-turns caps the model calls inside one turn (a runaway turn), not the game.
// The key comes from the environment or .env and goes to the SDK process only: never printed, never in an argument.
// CLOCKTOWER_FAKE_SDK (checks only): a module under scripts/ that stands in for the SDK (scripts/fake-agent-sdk.mjs).
import {mkdirSync} from 'node:fs';
import {join, dirname, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {makePacer, paceSettings, failTracker, turnCap, capText, wakeNote, briefText, takeClaudeSlot, grabSpend, paceText} from './pacing.mjs';
import {warmUp, claudeWarmAdapter} from './warmup.mjs';
import {loadSession, saveSession, setAside, runnerSettings, loadStorytellerSession, saveStorytellerSession, setAsideStoryteller, LOGS} from './agent-sessions.mjs';
import {ctxOf, ctxText, rollDue, rollPoint, rollSession, withCompactWindow, reportThreshold} from './session-roll.mjs';
import {turnCollector, usageDelta} from './behavior-turn.mjs';
import {toolOptions} from './lazy-tools.mjs';
import {defaultBudgets} from './runners.mjs';
import {systemFor, MODELS, DEFAULT_CLAUDE_MODEL} from '../src/data/prompts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_TURNS = 12, CLAIM_EVERY_MS = 10000;
const money = v => '$' + (v || 0).toFixed(4);
const short = (v, n = 160) => {const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s};

// The Agent SDK, or the checks' stand-in. -> {query, warm?, fake}
export async function loadSdk(env = process.env) {
  const f = env.CLOCKTOWER_FAKE_SDK;
  if (f) {
    const p = resolve(ROOT, f), rel = relative(join(ROOT, 'scripts'), p);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('CLOCKTOWER_FAKE_SDK must name a module under scripts/');
    return {...await import(pathToFileURL(p).href), fake: true};
  }
  return {...await import('@anthropic-ai/claude-agent-sdk'), fake: false};
}

// The turn prompt: the header, fresh from the game every turn, and why the turn started.
export function turnPrompt(kind, n, w, brief, rolled) {
  const recall = !rolled ? '' : kind === 'storyteller' ? ' Your conversation was set aside to stay small; the game keeps everything: read grimoire, rulings and talk first.'
    : ' Your conversation was set aside to stay small; your memory is in the game: read my_role, my_notes and read_talk first.';
  const ask = kind === 'storyteller' ? 'When a decision waits on you, answer it with a reason; otherwise narrate when there is something to tell, or end the turn.'
    : 'Read what you need, then make one move (speak, whisper, nominate, vote, a night choice) or pass. End with one short sentence on what you did.';
  return `Turn ${n}.${wakeNote(w)}${recall}${briefText(brief)}\n${ask}`;
}

// runClaudeSeat({kind: 'player'|'storyteller', opt, flag, env, base, runner, say, ctl}) -> exit code; ctl.stop(why) is set to end the run
export async function runClaudeSeat({kind, opt, flag, env, base, runner, say, ctl = null}) {
  const st = kind === 'storyteller', tag = st ? '[storyteller]' : '[agent]';
  const seatId = st ? {role: 'storyteller'} : {player: Number(opt('player', NaN))};
  if (!st && !Number.isInteger(seatId.player)) {say(`${tag} give the seat: --player <id> (1-7)`); return 2}
  const post = (path, body, ms = 15000) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({runner, ...seatId, ...body}), signal: AbortSignal.timeout(ms)})
    .then(async r => ({status: r.status, ...(await r.json().catch(() => ({ok: false, error: 'bad answer (' + r.status + ')'})))}));
  let health; try {health = await fetch(base + '/play/health', {signal: AbortSignal.timeout(5000)}).then(r => r.json())} catch (e) {say(`${tag} the relay at ${base} does not answer (${e.message}); start it with npm run relay`); return 1}
  const seat = st ? {name: 'Storyteller'} : (health.players || []).find(p => p.id === seatId.player);
  if (!seat) {say(`${tag} no seat #${seatId.player} at the table (seats: ${(health.players || []).map(p => p.name + ' #' + p.id).join(', ')})`); return 2}
  if (st && !(health.storyteller && health.storyteller.seat)) {say(`${tag} the Storyteller seat is closed`); return 2}

  // the session: logs/agents/<id>.json or logs/agents/storyteller.json
  const game = env.CLOCKTOWER_GAME || 'clocktower';
  const fresh = () => ({...(st ? {game} : {playerId: seatId.player, playerName: seat.name}), sessionId: null, system: systemFor(st ? 'storyteller' : 'player', seat.name), turns: 0, costUsd: 0, lastTotal: 0, started: new Date().toISOString()});
  const {sess, note} = st ? loadStorytellerSession(game, fresh, {startNew: flag('new')}) : loadSession(seatId.player, seat.name, fresh, {startNew: flag('new')});
  if (note) say('[session] ' + note);
  if (!sess.sessionId) sess.system = systemFor(st ? 'storyteller' : 'player', seat.name); // a fresh conversation takes today's prompt
  const save = () => st ? saveStorytellerSession(sess, {url: base}) : saveSession(sess, {url: base});
  const aside = s => st ? setAsideStoryteller(s) : setAside(s);
  const {runner: rs} = runnerSettings(sess, {provider: opt('provider', null), model: opt('model', null), effort: opt('effort', null)},
    {provider: 'anthropic', model: (st ? env.STORYTELLER_MODEL : env.AGENT_MODEL) || DEFAULT_CLAUDE_MODEL, effort: (st ? env.STORYTELLER_EFFORT : env.AGENT_EFFORT) || 'medium'});
  if (rs.provider !== 'anthropic') {say(`${tag} this runner plays Claude; ${rs.provider} seats play through scripts/seat-runner.mjs`); return 2}
  if (!rs.model || !/^claude-/.test(rs.model)) rs.model = (st ? env.STORYTELLER_MODEL : env.AGENT_MODEL) || DEFAULT_CLAUDE_MODEL;
  sess.runner = rs;
  const {model, effort} = rs;
  if (!MODELS[model]) say(`${tag} note: ${model} is not in the price table (src/data/prompts.js); its spend is what the SDK reports`);
  const budget = Math.max(.01, Number(opt('budget', env.RUNNER_BUDGET || defaultBudgets(env)[st ? 'storyteller' : 'player'])));
  const cap = turnCap(opt('max-turns', null)), toolTurns = Math.max(2, Number(opt('tool-turns', TOOL_TURNS))), pace = paceSettings(opt, env);

  let sdk; try {sdk = await loadSdk(env)} catch (e) {say(`${tag} ${e.message}`); return 1}
  if (!sdk.fake && !env.ANTHROPIC_API_KEY) {say(`${tag} No ANTHROPIC_API_KEY in the environment or .env: a Claude seat cannot start (see .env.example).`); return 1}

  // the claim, refreshed well inside the relay's CLAIM_MS; a refresh refused means another runner holds the seat
  let stopReq = false, stopWhy = null, turnAbort = null;
  const claim = () => post('/play/claim', {provider: 'anthropic', model}, 5000).catch(e => ({status: 0, error: e.message}));
  const c0 = await claim(); if (c0.status !== 200) {say(`${tag} could not take ${seat.name}: ${c0.error || c0.status}`); return 1}
  let beating = null;
  const beat = setInterval(() => {beating = claim().then(c => {if (c.status === 409) {say(`${tag} ${c.error}`); stopReq = true; stopWhy = 'the seat is held by another runner'; if (turnAbort) turnAbort.abort()}}).finally(() => {beating = null})}, CLAIM_EVERY_MS); beat.unref();
  const release = async () => {clearInterval(beat); try {await beating} catch {} for (let i = 0; i < 3; i++) {const r = await post('/play/release', {}, 5000).catch(() => null); if (r && r.ok) return}};
  const stop = why => {stopReq = true; stopWhy = stopWhy || why; if (turnAbort) turnAbort.abort()};
  if (ctl) ctl.stop = stop;

  say(`${tag} playing ${seat.name}${st ? '' : ' #' + seatId.player}: ${model} (effort ${effort}) | ${sess.sessionId ? 'resuming session ' + sess.sessionId : 'new session'} | ${capText(cap)}, budget ${money(budget)} | ${paceText(pace)}${sdk.fake ? ' | fake SDK (checks)' : ''}`);
  const rollAt = rollPoint(st ? 'storyteller' : 'player', model, env);
  const childEnv = withCompactWindow({...process.env, ...(env.ANTHROPIC_API_KEY ? {ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY} : {}), CLAUDE_AGENT_SDK_CLIENT_APP: 'clocktower-seat/1.0'}, rollAt, env);
  delete childEnv.CLAUDECODE; delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  const cwd = join(LOGS, 'agents'); mkdirSync(cwd, {recursive: true}); // the agent's working directory (it has no file tools)
  const mcpUrl = `${base}/mcp?${st ? 'role=storyteller' : 'player=' + seatId.player}&runner=${encodeURIComponent(runner)}`;
  const headers = {...(st ? {'X-Clocktower-Role': 'storyteller'} : {'X-Clocktower-Player': String(seatId.player)}), 'X-Clocktower-Runner': runner};
  const to = toolOptions(false, mcpUrl);
  let spent = 0, ended = null, turns = 0, netSaid = false;
  try {
    await warmUp({base, seat: seatId, runner, model, ...(sdk.warm ? {call: sdk.warm} : {adapter: await claudeWarmAdapter(env.ANTHROPIC_API_KEY)}), log: s => say(`${tag} ${s}`)});
    const pacer = makePacer({base, ...(st ? {role: 'storyteller'} : {player: seatId.player}), runner, heartbeat: pace.heartbeat, minGap: pace.minGap, pollMs: Number(env.AGENT_POLL_MS) || undefined, log: say, stopped: () => stopReq});
    const fails = failTracker(pace.maxFails);
    const r0 = await pacer.ready(); if (r0.stopped) ended = stopWhy || 'stopped'; else if (r0.dead || r0.gone) ended = r0.dead ? 'out of the game' : 'the game is over';
    while (!ended && turns < cap) {
      if (spent >= budget) {ended = 'budget reached'; break}
      const w = await pacer.next();
      if (w.stopped || stopReq) {ended = stopWhy || 'stopped'; break}
      if (w.dead || w.gone) {ended = w.dead ? 'out of the game' : 'the game is over'; break}
      const rd = rollDue(sess, rollAt, {busy: w.wake === 'now'});
      if (rd) {rollSession(sess, aside); save(); say('  ' + rd.line)}
      const b = await pacer.brief(), prompt = turnPrompt(kind, sess.turns + 1, w, b, !!sess.rolled);
      const tc = turnCollector(), t0 = Date.now(); let tools = 0, result = null, err = null;
      const free = await takeClaudeSlot(base, say, {stopped: () => stopReq, member: seat.name, tools: () => tools, onLost: () => {if (turnAbort) turnAbort.abort()}});
      turnAbort = new AbortController();
      const gs = grabSpend();
      try {
        const q = sdk.query({prompt, options: {
          abortController: turnAbort, model, effort, systemPrompt: sess.system, resume: sess.sessionId || undefined,
          mcpServers: {clocktower: {type: 'http', url: to.url, headers, timeout: 60000}},
          tools: to.tools, allowedTools: to.allowedTools, permissionMode: 'dontAsk', settingSources: [], settings: {autoCompactEnabled: true},
          maxTurns: toolTurns, maxBudgetUsd: Math.max(.01, budget - spent), cwd, env: childEnv,
        }});
        for await (const m of q) {
          if (m.type === 'assistant') gs.add(m);
          if (m.type === 'system' && m.subtype === 'init') {sess.sessionId = m.session_id; delete sess.rolled; save(); if (!netSaid && !sdk.fake) {netSaid = true; reportThreshold(q, Number(childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW), s => say('  ' + s))}}
          else if (m.type === 'system' && m.subtype === 'compact_boundary') {sess.compacts = (sess.compacts || 0) + 1; say(`  [compacted: ${m.compact_metadata.pre_tokens} -> ${m.compact_metadata.post_tokens ?? '?'} tokens]`)}
          else if (m.type === 'assistant' && !m.parent_tool_use_id) {
            sess.ctx = ctxOf(m.message.usage) ?? sess.ctx; // the last call's prompt: what the price line is measured on
            for (const x of m.message.content || []) {
              if (x.type === 'text' && x.text.trim()) {say(`  ${seat.name}: ${x.text.trim()}`); tc.text(x.text); if (!st) post('/play/narrate', {text: x.text.trim()}, 5000).catch(() => {})}
              else if (x.type === 'tool_use') {tools++; tc.tool(x.name, x.id); say(`  > ${String(x.name).replace(/^mcp__clocktower__/, '')}(${x.input && Object.keys(x.input).length ? short(x.input, 120) : ''})`)}
            }
          } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
            for (const x of m.message.content) if (x.type === 'tool_result') {const c = Array.isArray(x.content) ? x.content.map(y => y.text || '').join('') : String(x.content || ''); say(`    < ${short(c, 220)}`); tc.result(x.tool_use_id, c, x.is_error)}
          } else if (m.type === 'result') result = m;
        }
      } catch (e) {
        if (result && result.subtype === 'error_max_turns') say(`${tag} the turn hit the ${toolTurns} model-call cap; the next turn carries on`);
        else if (!stopReq) {err = String(e && e.message || e).split(/\r?\n/)[0].slice(0, 300); say(`${tag} turn failed: ${err}`)}
      }
      turnAbort = null; free(); pacer.turnDone(); turns++; sess.turns++;
      let cost = 0, u = {tokensIn: null, tokensOut: null, cacheRead: null, cacheWrite: null}, how = '';
      if (result) {
        u = usageDelta(sess, result); // before the cost baseline moves
        const tot = result.total_cost_usd || 0; cost = tot >= sess.lastTotal ? tot - sess.lastTotal : tot; sess.lastTotal = tot;
      } else if (gs.reported() || tools) {const g = gs.cost(model, {sent: String(sess.system || '').length + prompt.length}); cost = g.usd; how = `, ${g.how} spend`} // a cut turn sends no result: count what it spent
      spent += cost; sess.costUsd = (sess.costUsd || 0) + cost;
      // One shape for every turn line: the cost part first ("| ctx 23k | turn $x | run $y | session $z", what the supervisor and the
      // checks read), then why a turn did not complete: "| failed: <error>" or "| cut: <why>, <how> spend" (no result came back).
      const endNote = result ? (result.subtype !== 'success' ? ' | ' + result.subtype : '') : err ? ` | failed: ${err.slice(0, 160)}` : ` | cut: ${stopReq ? stopWhy || 'stopped' : 'no result'}${how}`;
      say(`[turn ${sess.turns}] ${tools} tool calls, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${result ? result.num_turns : '?'} model calls | in ${u.tokensIn ?? '?'} / cache read ${u.cacheRead ?? '?'} / cache write ${u.cacheWrite ?? '?'} / out ${u.tokensOut ?? '?'} | ${ctxText(sess.ctx)} | turn ${money(cost)} | run ${money(spent)} | session ${money(sess.costUsd)}${endNote}`);
      await post('/play/behavior/turn', {rec: {turn: sess.turns, provider: 'anthropic', model, wake: w && w.wake ? {wake: w.wake, why: String(w.why || '').slice(0, 160)} : null,
        brief: {text: typeof b === 'string' ? b.slice(0, 2000) : b ? JSON.stringify(b).slice(0, 2000) : null}, tools: tc.tools, narration: tc.narration,
        seconds: +((Date.now() - t0) / 1000).toFixed(1), ...u, cost, ...(sess.ctx != null ? {ctx: sess.ctx} : {}), flags: [...(rd ? ['session-rolled'] : []), ...(result && result.subtype !== 'success' ? [result.subtype] : []), ...(result ? [] : [err ? 'failed' : 'cut'])], ...(err ? {error: err} : {})}}, 8000).catch(() => {}); // awaited: a stop right after the turn must not lose its line
      save();
      if (spent >= budget) {ended = 'budget reached'; break}
      if (fails.ok(!err && tools > 0) && !ended) ended = fails.why();
    }
    if (!ended) ended = stopReq ? stopWhy || 'stopped' : 'turn cap reached';
    say(`${tag} stopped after ${turns} turns (${ended}); this run ${money(spent)}, session ${money(sess.costUsd)}, ${sess.rolls || 0} rolls, ${sess.compacts || 0} compactions`);
    return 0;
  } finally {save(); await release()}
}

// The runner's own process: flags, the supervisor's stop, the exit code.
export function main(kind) {
  return (async () => {
    const {loadEnv} = await import('./relay.mjs');
    const {onSupervisorStop} = await import('./runners.mjs');
    const {hostname} = await import('node:os');
    const argv = process.argv.slice(2), opt = (k, d) => {const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d}, flag = k => argv.includes('--' + k);
    const env = loadEnv(), base = String(opt('url', 'http://127.0.0.1:' + (env.RELAY_PORT || 8787))).replace(/\/+$/, '');
    const ts = () => new Date().toTimeString().slice(0, 8), say = line => console.log(`[${ts()}] ${line}`);
    const runner = `${hostname()}:${process.pid}`;
    let stopper = null;
    const run = kind === 'storyteller' && flag('scripted') ? (await import('./storyteller-runner.mjs')).runScripted : runClaudeSeat;
    const ctl = {set stop(f) {stopper = f}};
    onSupervisorStop(why => {say(`[${kind === 'storyteller' ? 'storyteller' : 'agent'}] ${why}: letting go of the seat`); if (stopper) stopper(why); else process.exit(0)});
    process.on('SIGINT', () => {if (stopper) stopper('interrupted'); else process.exit(130)});
    return run({kind, opt, flag, env, base, runner, say, ctl});
  })().then(code => process.exit(code ?? 0), e => {console.error(`[${kind === 'storyteller' ? 'storyteller' : 'agent'}] ` + String(e && e.stack || e).split('\n')[0]); process.exit(1)});
}
