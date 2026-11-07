// A player seat's runner: one process plays one seat through the relay, turn after turn, until it is stopped or its budget in
// dollars is spent. The runner supervisor (scripts/runners.mjs) starts it from the page; it also runs from a terminal:
//   node scripts/seat-runner.mjs --player 3 [--provider ollama|openai|huggingface|google] [--model ID] [--budget 1] [--max-turns N]
//        [--url http://127.0.0.1:8787] [--new] [--min-gap S] [--heartbeat MIN] [--max-fails N]
// What it does: claims the seat (and keeps the claim fresh), makes one warm-up call (the start gate), then each turn waits for the
// game (scripts/pacing.mjs), plays it with the local tool loop (scripts/local-agent.mjs) over the provider's chat, prints one line
// per turn with its cost ("[turn N] ... | turn $x | run $y", the line the supervisor reads), writes the turn to the behavior logs,
// and saves the seat's session (logs/agents/<id>.json).
// Cost is the limit, not turns: a paid provider stops when the run's spend reaches --budget ("[agent] stopped after N turns
// (budget reached)"); a local model costs nothing and plays until stopped. There is no turn cap unless --max-turns is given.
// Claude seats play through the Claude Agent SDK in the player-builder's runner (slice 3 of issue #1); this runner says so and
// exits. Keys come from the environment or .env and go to the provider adapter only: never printed, never in an argument.
import {hostname} from 'node:os';
import {loadEnv} from './relay.mjs';
import {ollamaAdapter, OLLAMA_URL, OLLAMA_MODEL, numCtxFrom} from './providers/ollama.mjs';
import {openaiRunner, isCompat, compatLabel} from './agent-chat.mjs';
import {localTurn, localLine, paidLine} from './local-agent.mjs';
import {makePacer, paceSettings, failTracker, localWorked, turnCap, capText, wakeNote, briefText} from './pacing.mjs';
import {warmUp} from './warmup.mjs';
import {loadSession, saveSession, runnerSettings, setAside} from './agent-sessions.mjs';
import {rollDue, rollSession} from './session-roll.mjs';
import {onSupervisorStop} from './runners.mjs';
import {systemFor} from '../src/data/prompts.js';

const argv = process.argv.slice(2), opt = (k, d) => {const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d}, flag = k => argv.includes('--' + k);
const env = loadEnv();
const base = String(opt('url', 'http://127.0.0.1:' + (env.RELAY_PORT || 8787))).replace(/\/+$/, '');
const runner = `${hostname()}:${process.pid}`;
const ts = () => new Date().toTimeString().slice(0, 8);
const say = line => console.log(`[${ts()}] ${line}`);
const post = (path, body, ms = 15000) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({runner, ...body}), signal: AbortSignal.timeout(ms)}).then(r => r.json().catch(() => ({ok: false, error: 'bad answer (' + r.status + ')'})));
let stopping = false, stopWhy = null;
const stopped = () => stopping;
onSupervisorStop(why => {stopping = true; stopWhy = why});
process.on('SIGINT', () => {stopping = true; stopWhy = 'interrupted'});

async function main() {
  const playerId = Number(opt('player', NaN));
  if (!Number.isInteger(playerId)) {say('[agent] give the seat: --player <id> (1-7)'); return 2}
  let health; try {health = await fetch(base + '/play/health', {signal: AbortSignal.timeout(5000)}).then(r => r.json())} catch (e) {say(`[agent] the relay at ${base} does not answer (${e.message}); start it with npm run relay`); return 1}
  const seat = (health.players || []).find(p => p.id === playerId);
  if (!seat) {say(`[agent] no seat #${playerId} at the table (seats: ${(health.players || []).map(p => p.name + ' #' + p.id).join(', ')})`); return 2}
  const fresh = () => ({playerId, playerName: seat.name, system: systemFor('player', seat.name), turns: 0, cost: 0, started: new Date().toISOString()});
  const {sess, note} = loadSession(playerId, seat.name, fresh, {startNew: flag('new')}); if (note) say('[session] ' + note);
  const {runner: rs} = runnerSettings(sess, {provider: opt('provider', null), model: opt('model', null)}, {provider: env.AGENT_PROVIDER || 'ollama'});
  sess.runner = rs;
  // the mind: a local model, or a Chat Completions provider; a Claude seat is the player-builder's runner
  let chat, model, adapter, paid = false, provider = rs.provider;
  if (provider === 'ollama') {
    const ad = ollamaAdapter({url: env.OLLAMA_URL || OLLAMA_URL, defaultModel: rs.model || env.OLLAMA_MODEL || OLLAMA_MODEL, numCtx: numCtxFrom(env)});
    chat = ad.chat; model = rs.model || env.OLLAMA_MODEL || OLLAMA_MODEL; rs.model = model; adapter = ad;
  } else if (isCompat(provider)) {
    const o = await openaiRunner(rs, env, {explicit: opt('model', null) != null});
    if (o.error) {say(`[agent] ${compatLabel(provider)}: ${o.error}`); return 1}
    if (o.note) say(`[agent] ${compatLabel(provider)}: ${o.note}`);
    chat = o.adapter.chat; model = o.model; paid = true; adapter = o.adapter;
  } else if (provider === 'anthropic') {
    say('[agent] Claude seats are played through the Claude Agent SDK by the player runner of slice 3 (issue #1); not this runner. Use --provider ollama, openai, huggingface or google.');
    return 1;
  } else {say(`[agent] unknown provider ${provider}`); return 2}
  const budget = paid ? Number(opt('budget', 1)) : null, cap = turnCap(opt('max-turns', null)), pace = paceSettings(opt, env);
  // the claim, refreshed well inside the relay's CLAIM_MS
  const claim = () => post('/play/claim', {player: playerId, provider, model});
  const c = await claim(); if (!c.ok) {say(`[agent] could not take ${seat.name}: ${c.error}`); return 1}
  const keep = setInterval(() => claim().catch(() => {}), 10000);
  say(`[agent] playing ${seat.name} #${playerId}: ${model} (${provider}), ${capText(cap)}${budget != null ? ', budget $' + budget.toFixed(2) : ', local: no budget'}`);
  try {
    await warmUp({base, seat: {player: playerId}, runner, model, adapter, log: say});
    const pacer = makePacer({base, player: playerId, runner, heartbeat: pace.heartbeat, minGap: pace.minGap, pollMs: Number(env.AGENT_POLL_MS) || undefined, log: say, stopped});
    const fails = failTracker(pace.maxFails);
    const r0 = await pacer.ready(); if (r0.stopped) return 0;
    const call = async (tool, args) => post('/play/call', {player: playerId, tool, args});
    let run = 0, turns = 0;
    while (!stopping && turns < cap) {
      const w = await pacer.next();
      if (w.stopped || stopping) break;
      if (w.dead || w.gone) {say(`[agent] stopped after ${turns} turns (${w.dead ? 'out of the game' : 'the seat is gone'}${w.why ? ': ' + String(w.why).slice(0, 60) : ''})`); return 0}
      const roll = rollDue(sess, 0); if (roll) {rollSession(sess, s => setAside(s)); say(roll.line)}
      const b = await pacer.brief();
      const prompt = `Turn ${sess.turns + 1}.${wakeNote(w)}${briefText(b)}\nLook first, then act or pass.`;
      let st; try {st = await localTurn({chat, call, sess, prompt, model, on: (kind, a) => {if (kind === 'text') say(`[${seat.name}] ${String(a).slice(0, 200)}`)}})}
      catch (e) {st = null; say(`[agent] turn failed: ${String(e.message || e).split('\n')[0].slice(0, 200)}`)}
      pacer.turnDone(); turns++; sess.turns++;
      if (st) {
        run += st.cost || 0; sess.cost = (sess.cost || 0) + (st.cost || 0);
        say(`[turn ${turns}] ${paid ? paidLine(st, model, provider, {run}) : localLine(st, model)}`);
        post('/play/behavior/turn', {player: playerId, rec: {turn: sess.turns, provider, model, wake: w.wake || null, tools: st.calls, speech: st.narration || null, seconds: Math.round(st.ms / 100) / 10, tokensIn: st.in, tokensOut: st.out, cost: st.cost || 0}}).catch(() => {});
      } else say(`[turn ${turns}] failed | run $${run.toFixed(4)}`);
      saveSession(sess);
      if (budget != null && run >= budget) {say(`[agent] stopped after ${turns} turns (budget reached)`); return 0}
      if (fails.ok(st ? localWorked(st) : false)) {say(`[agent] stopped after ${turns} turns (${fails.why()})`); return 0}
    }
    say(`[agent] stopped after ${turns} turns (${stopping ? stopWhy || 'stopped' : 'turn cap reached'})`);
    return 0;
  } finally {
    clearInterval(keep); saveSession(sess);
    await post('/play/release', {player: playerId}, 3000).catch(() => {});
  }
}
main().then(code => process.exit(code ?? 0), e => {console.error('[agent] ' + String(e && e.stack || e).split('\n')[0]); process.exit(1)});
