// The Storyteller's runner: one process plays the Storyteller seat (X-Clocktower-Role: storyteller), apart from every player.
//   node scripts/storyteller-runner.mjs [--model claude-haiku-5-5] [--effort medium] [--budget 1.50] [--max-turns N] [--tool-turns 12]
//        [--url http://127.0.0.1:8787] [--new] [--min-gap S] [--heartbeat MIN] [--max-fails N]
//   node scripts/storyteller-runner.mjs --scripted   the scripted fallback, costs nothing
// With a mind (the default): the Claude Agent SDK through the Storyteller's MCP tools (scripts/claude-runner.mjs), its header from
// /play/pace {role: 'storyteller'}, a cost line per turn, --budget in dollars (STORYTELLER_MODEL / RUNNER_BUDGET, else the
// Storyteller's share of the game budget set apart in scripts/runners.mjs), the session rolled before the Haiku price line.
// --scripted: only after the owner resumes a game whose Storyteller runner is gone (the supervisor's resume starts it): every
// decision that waits on the Storyteller gets the scripted default through the `fallback` tool, with a reason that says so.
import {fileURLToPath} from 'node:url';
import {main} from './claude-runner.mjs';
import {makePacer, paceSettings, turnCap, failTracker} from './pacing.mjs';
import {warmUp} from './warmup.mjs';

export const SCRIPTED_WHY = 'The owner resumed the game with the scripted Storyteller after its runner was gone.';

// The scripted Storyteller: claims the seat, answers each decision with the scripted default, prints a $0 cost line per turn.
export async function runScripted({opt, env, base, runner, say, ctl = null}) {
  const post = (path, body, ms = 15000) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({runner, role: 'storyteller', ...body}), signal: AbortSignal.timeout(ms)})
    .then(async r => ({status: r.status, ...(await r.json().catch(() => ({ok: false})))}));
  let stopReq = false, why = null;
  if (ctl) ctl.stop = w => {stopReq = true; why = why || w};
  const claim = () => post('/play/claim', {provider: 'scripted', model: 'fallback'}, 5000).catch(e => ({status: 0, error: e.message}));
  const c0 = await claim(); if (c0.status !== 200) {say(`[storyteller] could not take the Storyteller seat: ${c0.error || c0.status}`); return 1}
  const beat = setInterval(() => claim().then(c => {if (c.status === 409) {stopReq = true; why = 'the seat is held by another runner'}}), 10000); beat.unref();
  const pace = paceSettings(opt, env), cap = turnCap(opt('max-turns', null)), fails = failTracker(pace.maxFails);
  say('[storyteller] playing the Storyteller with the scripted fallback: no mind, no cost');
  let turns = 0, ended = null;
  try {
    await warmUp({base, seat: {role: 'storyteller'}, runner, model: 'fallback', call: async () => {}, log: s => say('[storyteller] ' + s)});
    const pacer = makePacer({base, role: 'storyteller', runner, heartbeat: pace.heartbeat, minGap: pace.minGap, pollMs: Number(env.AGENT_POLL_MS) || undefined, log: say, stopped: () => stopReq});
    while (!ended && turns < cap) {
      const w = await pacer.next();
      if (w.stopped || stopReq) {ended = why || 'stopped'; break}
      const over = !!(w.dead || w.gone);
      // what is due (look, a free read: a decision, a narration owed, the end); after the win only the end's narration is played (#90)
      const asked = await post('/play/storyteller', {tool: 'look', args: {}});
      const due = asked.ok !== false ? asked.dueTool || null : null;
      if (over && due !== 'narrate') {ended = 'the game is over'; break}
      const b = await pacer.brief();
      const r = due === 'decide' || due === 'narrate' ? await post('/play/storyteller', {tool: 'fallback', args: {reason: SCRIPTED_WHY}}) : null;
      const wake = over ? {wake: 'now', why: 'narrate: ' + String(asked.due || 'the end')} : w.wake ? {wake: w.wake, why: String(w.why || '').slice(0, 160)} : null;
      pacer.turnDone(); turns++;
      const did = !r ? 'nothing waits' : !r.ok ? 'refused: ' + String(r.error).slice(0, 120) : r.narrated ? 'narrated: ' + String(r.narrated).slice(0, 120) : `${r.decided}: ${r.answer}`;
      say(`[turn ${turns}] scripted | ${did} | turn $0.0000 | run $0.0000`);
      const line = post('/play/behavior/turn', {rec: {turn: turns, provider: 'scripted', model: 'fallback', wake,
        brief: {text: typeof b === 'string' ? b.slice(0, 2000) : b ? JSON.stringify(b).slice(0, 2000) : null},
        tools: [{name: 'look', ok: asked.ok !== false}, ...(r ? [{name: 'fallback', ok: r.ok !== false, ...(r.ok === false ? {error: String(r.error).slice(0, 140)} : {})}] : [])], narration: r && r.narrated ? r.narrated : '', cost: 0, flags: ['scripted']}}, 8000).catch(() => {});
      if (over) {await line; ended = 'the game is over'; break} // the last turn's line is written before the seat is let go
      if (fails.ok(asked.ok !== false && (!r || r.ok !== false))) ended = fails.why();
    }
    say(`[storyteller] stopped after ${turns} turns (${ended || (stopReq ? why || 'stopped' : 'turn cap reached')})`);
    return 0;
  } finally {clearInterval(beat); await post('/play/release', {}, 3000).catch(() => {})}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main('storyteller');
