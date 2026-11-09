// The channel check (`npm run channelcheck`, slice 3 of issue #1): seats meet only inside the game. No key, no network beyond
// 127.0.0.1, no model; waits go through scripts/ci-clock.mjs (CI_FAST).
//
// 1. Plant. The real relay (scripts/relay.mjs --game --seed 5 --scripted, in this process) plays seed 5 with eight fake runners
//    (seven players and the Storyteller, each claiming its own seat) up to the first day with a dead seat. On the way the
//    Storyteller answers its first decision with a unique reason. That day: seat A (a living seat with night information) writes a
//    note and whispers a unique word to B (its living neighbour: whispers are between neighbours, #28), the Storyteller narrates a
//    unique line, C says a unique line. A room conversation (#28): P takes Q to a room and says a unique line there; then the dead
//    seat D joins the room late and speaks. The table sees the moves, never the words; D never hears the line said before it came
//    in; the Storyteller does not hear room talk either. A's own secrets are its
//    role's ability text and what it was told at night (the check knows them from the grimoire), and its role's name for every seat
//    that was never told it.
// 2. Read. Every other seat, as its own claimed runner: every player tool with sensible and hostile arguments (other seats' names
//    and indexes, since 0, a negative since), over plain JSON and over MCP (tools/list and each tools/call), its header (pace brief),
//    its pace answer, its system prompt, and /play/health. The Storyteller: every Storyteller tool (with refused acts), over JSON
//    and MCP, its header (its pace brief), its prompt.
//    Fails on any secret in a channel that may not carry it; on the narration or C's line missing from any seat, the living and
//    the dead; on the whisper missing from A or B; on the ruling's reason missing from the Storyteller's rulings; on any
//    positive control (A's own secrets in A's own channels) missing.
// 3. Walls. A player's runner reaches no Storyteller route or tool (JSON, MCP, pace, claim); the Storyteller's runner no player
//    tool, pace or seat; a runner that does not hold a seat gets nothing from it (call, MCP, pace, narrate, ready, turn line) and
//    cannot release it.
// 4. A whole game. A second relay (--game --seed 5, no scripted fallback) is played to its end by eight fake runners through plain
//    JSON tool calls: the scripted answers of src/game/scripted.js (the sim's) turned into night_choice, nominate, pass, vote and
//    the Storyteller's decide, with a line of talk from every seat in every speaking round. The winner must be the one
//    `npm run sim -- --seed 5` prints: the talk adds log lines and changes no decision.
import {fileURLToPath} from 'node:url';
import {startRelay} from './relay.mjs';
import {quietEnv, req} from './relaycheck.mjs';
import {ms} from './ci-clock.mjs';
import {createScripted} from '../src/game/scripted.js';
import {optionKey} from '../src/game/mechanics.js';
import * as api from '../src/game/api.js';
import {PLAYER_TOOLS} from '../src/data/player-tools.js';
import {STORYTELLER_TOOLS} from '../src/data/storyteller-tools.js';
import {systemFor} from '../src/data/prompts.js';
import {simulate} from './headless.mjs';

export const SEED = 5;
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; return !!c};
const J = v => typeof v === 'string' ? v : JSON.stringify(v);

// ---- the relay in this process: its backend's live game is what the scripted answers read ----
export async function relayGame(args) {
  const env = await quietEnv(), lines = [];
  const R = startRelay({env, argv: ['node', 'relay.mjs', '--play-only', '--no-behavior', ...args], port: 0, log: l => lines.push(String(l))});
  const port = await R.ready;
  return {base: `http://127.0.0.1:${port}`, backend: R.play.backend, lines, close: () => new Promise(res => {R.sup.killAll(); R.server.close(() => res()); setTimeout(res, 500).unref()})};
}
export const mcp = (base, method, params, headers) => fetch(base + '/mcp', {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})})
  .then(async r => ({status: r.status, ...(await r.json().catch(() => ({})))}));
const post = (base, path, body, headers) => req(base, path, {method: 'POST', body, headers});

// ---- eight fake runners driven by the sim's scripted answers ----
// table({base, backend}) claims every seat with its own runner. drive(until) plays the game one tool call at a time: a pending
// decision goes to the seat (or the Storyteller) it waits on, with the answer createScripted(seed) gives for it, asked once per
// decision exactly as the sim asks it; speaking rounds get a line from each living seat (sayFor), nominations close with a pass
// from each living seat that has not nominated. Every call names the runner that holds the seat.
export async function table({base, backend, seed = SEED, sayFor = null, reasonFor = null}) {
  const game = () => backend.game, g0 = game();
  const runners = g0.seats.map((s, i) => `fake-${i + 1}`), st = 'fake-storyteller';
  for (const [i, r] of runners.entries()) {const c = await post(base, '/play/claim', {player: i + 1, runner: r, provider: 'ollama', model: 'fake'}); if (c.status !== 200) throw new Error('claim failed: ' + J(c))}
  const sc = await post(base, '/play/claim', {role: 'storyteller', runner: st}); if (sc.status !== 200) throw new Error('Storyteller claim failed: ' + J(sc));
  // each fake runner keeps its claim fresh, as a real runner does
  const keep = setInterval(() => {runners.forEach((r, i) => post(base, '/play/claim', {player: i + 1, runner: r}).catch(() => {})); post(base, '/play/claim', {role: 'storyteller', runner: st}).catch(() => {})}, 10000); keep.unref();
  const scripted = createScripted(seed), memo = new Map();
  const oracle = p => {if (!memo.has(p.id)) memo.set(p.id, scripted(game())); return memo.get(p.id)};
  const call = (i, tool, args = {}) => post(base, '/play/call', {player: i + 1, runner: runners[i], tool, args});
  const stCall = (tool, args = {}) => post(base, '/play/storyteller', {runner: st, tool, args});
  const name = i => game().seats[i].name;
  let talk = 0, calls = 0;
  const must = (r, what) => {calls++; if (!r || r.status !== 200 || r.ok === false) throw new Error(`${what} failed: ${J(r).slice(0, 300)}`); return r};
  async function step() {
    const g = game(); api.pendingFor(g, api.ST); // brings the day clock up to date
    if (g.winner) return false;
    const p = g.pending; if (!p) throw new Error('no decision pending and no winner');
    if (p.seat === api.ST) {
      const v = oracle(p), at = x => p.options.findIndex(o => optionKey(o) === optionKey(x)) + 1;
      const reason = (reasonFor && reasonFor(p)) || `The scripted default for this ${p.kind} decision, as the sim answers it.`;
      must(await stCall('decide', p.count ? {value: v.map(x => '#' + at(x)).join(', '), reason} : {option: at(v), reason}), `the Storyteller's ${p.kind}`);
      return true;
    }
    if (p.kind === 'choose') {
      const v = oracle(p), picks = p.count ? v : [v];
      const asked = must(await call(p.seat, 'what_is_asked'), 'what_is_asked');
      const labels = picks.map(x => asked.options[p.options.findIndex(o => optionKey(o) === optionKey(x))]);
      must(await call(p.seat, 'night_choice', {pick: labels}), `${name(p.seat)}'s ${p.role} choice`);
      return true;
    }
    if (p.kind === 'vote') {
      const v = oracle(p), i = p.seats.find(x => !(x in (g.ballot?.votes || {})));
      must(await call(i, 'vote', {yes: v[i] ? 'yes' : 'no'}), `${name(i)}'s vote`);
      return true;
    }
    if (p.kind === 'nomination') {
      const c = g.clock, living = g.seats.filter(s => s.alive).map(s => s.index);
      if (!c.nominationsOpen) {
        const i = living.find(x => !c.spoke.includes(x));
        const text = (sayFor && sayFor(i, g)) || `${name(i)} speaks in round ${c.round} of day ${g.day} (line ${++talk}).`;
        must(await call(i, 'speak', {text}), `${name(i)}'s line`);
        return true;
      }
      const v = oracle(p);
      if (v) {must(await call(v.by, 'nominate', {target: name(v.target)}), `${name(v.by)}'s nomination`); return true}
      const i = living.find(x => !g.today.nominators.includes(x) && !c.passedNominating.includes(x));
      must(await call(i, 'pass'), `${name(i)}'s pass on nominating`);
      return true;
    }
    throw new Error(`no fake runner answers a ${p.kind} decision`);
  }
  async function drive(until = () => false, maxCalls = 3000) {
    while (calls < maxCalls) {if (until(game())) return true; if (!(await step())) return true}
    throw new Error(`no end after ${maxCalls} calls`);
  }
  return {runners, st, call, stCall, drive, stop: () => clearInterval(keep), get calls() {return calls}};
}

// ---- 1-3: plant, read, walls ----
async function channels() {
  console.log('plant: seed 5 behind the relay, eight fake runners');
  const R = await relayGame(['--game', '--seed', String(SEED), '--scripted']), {base, backend} = R;
  const game = () => backend.game;
  try {
    let n = 0; const S = {}, plant = (k, words) => (S[k] = `${words} zq${k}${++n}x`);
    plant('ruling', 'Reasonmark');
    let ruled = false;
    let plantDay = null, C = null, Cline = null;
    const T = await table({base, backend,
      reasonFor: () => {if (ruled) return null; ruled = true; return `The planted ruling reason is ${S.ruling} and nobody else hears it.`},
      sayFor: (i, g) => g.day === plantDay && i === C && !Cline ? (Cline = `I have a thought to share: ${plant('say', 'Saymark')}.`) : null});
    const deadDay = g => g.phase === 'day' && g.seats.some(s => !s.alive) && g.pending?.kind === 'nomination' && !g.clock.nominationsOpen && !g.clock.spoke.length;
    await T.drive(g => {api.pendingFor(g, api.ST); return !!g.winner || deadDay(g)});
    const g = game();
    if (!ok(!g.winner && deadDay(g), `the game reaches a day with a dead seat (day ${g.day})`)) return;
    plantDay = g.day;
    const told = i => api.view(g, i).told.filter(t => t.what !== 'role');
    const living = g.seats.filter(s => s.alive).map(s => s.index), D = g.seats.find(s => !s.alive).index;
    const A = living.find(i => told(i).length), B = api.where(g, A).canWhisper[0]; C = living.find(i => i !== A && i !== B);
    const nm = i => g.seats[i].name, vA = api.view(g, A);
    console.log(`  day ${g.day}: A ${nm(A)} (${vA.role.name}), B ${nm(B)}, C ${nm(C)}, dead ${nm(D)}`);
    S.ability = vA.role.ability;
    told(A).forEach((t, k) => {S['told' + k] = t.text});
    // the planting, each through its own seat's runner
    ok((await T.call(A, 'note', {text: `My private note: ${plant('note', 'Notemark')}.`})).ok, `${nm(A)} writes a note`);
    ok((await T.call(A, 'whisper', {to: nm(B), text: `Just between us: ${plant('whisper', 'Whispermark')}.`})).ok, `${nm(A)} whispers to ${nm(B)}`);
    ok((await T.stCall('narrate', {text: `The town clerk notes the morning: ${plant('narr', 'Narrmark')}.`})).ok, 'the Storyteller narrates');
    // the room plant (the player tools for rooms come with the player-builder's PR; the moves go through the seats' own api)
    const [P, Q] = living.filter(i => i !== A && i !== C && !g.clock.spoke.includes(i));
    ok(P != null && Q != null, `P ${nm(P)} and Q ${nm(Q)} are free to take a room`);
    api.invite(g, P, Q, 'parlour');
    api.say(g, P, `Only for this room: ${plant('room', 'Roommark')}.`);
    api.go(g, D, 'parlour');
    api.say(g, D, 'I came in late, and I am dead, but I am listening now.');
    ok(g.log.filter(e => e.type === 'move' && e.room === 'parlour').length === 2, `${nm(P)} takes ${nm(Q)} to the Vestry; ${nm(D)} (dead) joins late`);
    await T.drive(() => !!Cline && game().log.some(e => e.type === 'say' && e.text === Cline));
    ok(!!Cline, `${nm(C)} says a line at the table`);

    // who may carry what: A all of its own; B the whisper; the Storyteller the ruling, A's role, ability and night information
    const roleNameKnown = i => i === A || api.view(g, i).told.some(t => t.text.includes(vA.role.name)) || api.view(g, i).role.name === vA.role.name
      || api.events(g, i, -1).some(e => ['slayer-shot', 'win', 'virgin'].includes(e.type) && e.text.includes(vA.role.name));
    const allowed = (seat, k) => k === 'room' ? seat === P || seat === Q : seat === A ? true : seat === 'st' ? ['ruling', 'ability', 'roleName', 'narr', 'say'].includes(k) || /^told/.test(k)
      : k === 'whisper' ? seat === B : k === 'roleName' ? roleNameKnown(seat) : k === 'narr' || k === 'say';
    S.roleName = vA.role.name;
    const leaksIn = (seat, text) => Object.entries(S).filter(([k, s]) => !allowed(seat, k) && (k === 'roleName' ? new RegExp(`\\b${s}\\b`).test(text) : text.includes(s))).map(([k]) => k);

    // ---- read every channel of every player seat ----
    console.log('read: every player seat as its own runner');
    const names = g.seats.map(s => s.name);
    const variants = i => {const other = names.filter((_, k) => k !== i);
      return {
        look: [{}, {player: A + 1}, {seat: A}], my_role: [{}, {player: A + 1}, {name: nm(A)}], read_talk: [{}, {since: 0}, {since: -5}, {since: 'x'}, {since: 1e9}, {since: 0, player: A + 1}],
        claims: [{}, {player: nm(A)}, {player: String(A)}], // every role each seat named for itself in this seat's hearing (#67)
        my_whispers: [{}, {to: nm(A)}, {player: A + 1}], my_notes: [{}, {seat: A}, {player: A + 1}, {name: nm(A)}], what_is_asked: [{}, {player: A + 1}], who_voted: [{}],
        note: [{text: ''}], speak: [{text: ''}], whisper: [{to: nm(i), text: 'x'}, {to: 'Storyteller', text: 'x'}, {to: String(A), text: 'x'}, ...other.slice(0, 2).map(o => ({to: o, text: ''}))],
        nominate: [{target: nm(A)}, {target: 'Storyteller'}, {target: String(A)}], vote: [{yes: 'yes'}, {yes: 'maybe'}], night_choice: [{pick: [nm(A), 'Storyteller']}, {pick: other}], // never one name: by day one name fires a Slayer's shot (#37)
        slay: [{}, {target: 'Storyteller'}, {target: String(A)}], // hostile but never a real shot: the read must not change the game
        // the rooms (#28): where reads; go and invite only with a room that does not exist, so no seat moves while it is read
        where: [{}, {player: A + 1}, {seat: A}], go: [{}, {room: 'the Storyteller\'s room'}, {room: String(A)}],
        invite: [{player: nm(i)}, {player: 'Storyteller', room: 'parlour'}, {player: nm(A), room: 'the Storyteller\'s room'}],
      }};
    ok(PLAYER_TOOLS.every(t => t.name in variants(0) || t.name === 'pass' || t.name === 'leave'), 'every player tool is read with hostile arguments (pass and leave are played, not probed)');
    const heard = {}, tRead = Date.now();
    for (let i = 0; i < g.seats.length; i++) {
      const out = [], H = {'x-clocktower-player': String(i + 1), 'x-clocktower-runner': T.runners[i]};
      for (const [tool, list] of Object.entries(variants(i))) for (const args of list) {
        out.push(J(await T.call(i, tool, args)));
        out.push(J(await mcp(base, 'tools/call', {name: tool, arguments: args}, H)));
      }
      out.push(J(await mcp(base, 'tools/list', {}, H)));
      out.push(J(await post(base, '/play/pace', {player: i + 1, runner: T.runners[i], brief: true})));
      out.push(J(await post(base, '/play/pace', {player: i + 1, runner: T.runners[i], realMs: 1, wake: 'now'})));
      out.push(J(await req(base, '/play/health')), systemFor('player', nm(i)));
      heard[i] = out.join('\n');
    }
    console.log(`  read ${g.seats.length} seats in ${((Date.now() - tRead) / 1000).toFixed(1)} s`);
    for (let i = 0; i < g.seats.length; i++) {
      const lk = leaksIn(i, heard[i]);
      ok(!lk.length, `${nm(i)}${i === A ? ' (A)' : i === B ? ' (B)' : i === D ? ' (dead)' : ''}: no secret it may not hear (${heard[i].length} chars read)${lk.length ? ': LEAK ' + lk.join(', ') : ''}`);
    }
    // reach: the public lines reach every seat, living and dead; the whisper reaches its two parties
    const talkOf = async i => J(await T.call(i, 'read_talk', {since: 0}));
    for (let i = 0; i < g.seats.length; i++) {const t = await talkOf(i); ok(t.includes(S.narr) && t.includes(S.say), `${nm(i)}${i === D ? ' (dead)' : ''} hears the narration and ${nm(C)}'s line`)}
    for (const i of [A, B]) ok(J(await T.call(i, 'my_whispers')).includes(S.whisper) && (await talkOf(i)).includes(S.whisper), `${nm(i)} has the whisper (my_whispers, read_talk)`);
    for (const i of [P, Q]) ok((await talkOf(i)).includes(S.room), `${nm(i)}, in the room, hears the room line (read_talk)`);
    ok(/I came in late/.test(await talkOf(D)) && !(await talkOf(D)).includes(S.room), `${nm(D)}, the late joiner, hears the room from its arrival on, not before`);
    ok(g.seats.every(s => api.events(g, s.index).filter(e => e.type === 'move' && e.room === 'parlour').length === 2), 'every seat sees who went to the Vestry (presence is public)');
    // positive controls: A's secrets are in A's own channels, so a clean read above means something
    ok(heard[A].includes(S.ability) && Object.keys(S).filter(k => /^told/.test(k)).every(k => heard[A].includes(S[k])), `${nm(A)}'s own channels carry its ability and its night information`);
    ok(J(await T.call(A, 'my_notes')).includes(S.note), `${nm(A)}'s note is in its own my_notes`);

    // ---- the Storyteller's channels ----
    console.log('read: the Storyteller');
    const stOut = [], SH = {'x-clocktower-role': 'storyteller', 'x-clocktower-runner': T.st};
    const stArgs = {look: [{}], grimoire: [{}, {player: A + 1}], night_order: [{}], what_is_asked: [{}], talk: [{}, {since: 0}, {since: -5}], rulings: [{}], day_state: [{}],
      decide: [{value: nm(A), reason: 'A refused act of the check, nothing waits.'}], fallback: [{reason: 'A refused act of the check, nothing waits.'}], narrate: [{text: ''}],
      open_nominations: [], close_vote: [{reason: 'A refused act of the check, nothing waits.'}], end_day: [{}]};
    ok(STORYTELLER_TOOLS.every(t => t.name in stArgs), 'every Storyteller tool is read (open_nominations only listed: it would change the day)');
    for (const [tool, list] of Object.entries(stArgs)) for (const args of list) {
      stOut.push(J(await T.stCall(tool, args)));
      stOut.push(J(await mcp(base, 'tools/call', {name: tool, arguments: args}, SH)));
    }
    stOut.push(J(await mcp(base, 'tools/list', {}, SH)), J(await post(base, '/play/pace', {role: 'storyteller', runner: T.st, brief: true})), systemFor('storyteller'));
    const stText = stOut.join('\n'), stLeak = leaksIn('st', stText);
    ok(!stLeak.length, `the Storyteller: no whisper, no note (${stText.length} chars read)${stLeak.length ? ': LEAK ' + stLeak.join(', ') : ''}`);
    ok(J(await T.stCall('rulings')).includes(S.ruling), "the Storyteller's rulings carry its own reason");
    ok(stText.includes(S.narr) && stText.includes(S.say), 'the Storyteller hears the narration and the line at the table');
    const stBrief = await post(base, '/play/pace', {role: 'storyteller', runner: T.st, brief: true});
    ok(stBrief.status === 200 && stBrief.ok && stBrief.brief, "the Storyteller's runner gets its own header from /play/pace");

    // ---- walls ----
    console.log('walls: seats and runners stay apart');
    const X = 'stranger', pA = A + 1, rB = T.runners[B];
    const sc = async (path, body, headers) => (await post(base, path, body, headers)).status;
    ok(await sc('/play/call', {player: pA, runner: X, tool: 'my_role'}) === 409, 'a runner that holds no seat gets 409 for A\'s tools');
    ok(await sc('/play/call', {player: pA, tool: 'my_role'}) === 409, 'a call naming no runner gets 409 for A\'s tools');
    ok(await sc('/play/call', {player: pA, runner: rB, tool: 'my_notes'}) === 409, "B's runner gets 409 for A's tools");
    const xm = await mcp(base, 'tools/call', {name: 'my_role', arguments: {}}, {'x-clocktower-player': String(pA), 'x-clocktower-runner': X});
    ok(xm.result && xm.result.content && /played by another runner/.test(J(xm.result)) && !J(xm).includes(S.ability), 'over MCP too: A answers only its runner');
    ok(await sc('/play/pace', {player: pA, runner: X, brief: true}) === 409, "a stranger cannot read A's header");
    ok(await sc('/play/narrate', {player: pA, runner: X, text: 'hi'}) === 409, 'a stranger cannot narrate for A');
    ok(await sc('/play/ready', {player: pA, runner: X, state: 'ready'}) === 409, 'a stranger cannot report A ready');
    ok(await sc('/play/behavior/turn', {player: pA, runner: X, rec: {turn: 1}}) === 409, "a stranger cannot write A's turn line");
    await post(base, '/play/release', {player: pA, runner: X});
    ok(await sc('/play/call', {player: pA, runner: X, tool: 'look'}) === 409, "a stranger's release does not free A");
    ok(await sc('/play/storyteller', {runner: rB, tool: 'grimoire'}) === 403, "B's runner has no Storyteller tools (JSON)");
    ok((await mcp(base, 'tools/list', {}, {'x-clocktower-role': 'storyteller', 'x-clocktower-runner': rB})).status === 403, "B's runner has no Storyteller tools (MCP)");
    ok(await sc('/play/pace', {role: 'storyteller', runner: rB, brief: true}) === 403, "B's runner cannot read the Storyteller's header");
    ok(await sc('/play/claim', {role: 'storyteller', runner: rB}) === 409, "B's runner cannot take the Storyteller seat");
    ok(await sc('/play/storyteller', {runner: X, tool: 'grimoire'}) === 409, 'a stranger gets nothing from the held Storyteller seat');
    ok(await sc('/play/pace', {role: 'storyteller', runner: X, brief: true}) === 409, "a stranger cannot read the Storyteller's header");
    ok(await sc('/play/call', {player: pA, runner: T.st, tool: 'my_role'}) === 403, "the Storyteller's runner has no player tools (JSON)");
    ok((await mcp(base, 'tools/list', {}, {'x-clocktower-player': String(pA), 'x-clocktower-runner': T.st})).status === 403, "the Storyteller's runner has no player tools (MCP)");
    ok(await sc('/play/pace', {player: pA, runner: T.st, brief: true}) === 403, "the Storyteller's runner cannot read a player's header");
    ok(await sc('/play/claim', {player: D + 1, runner: T.st}) === 409, "the Storyteller's runner cannot take a player seat");
    const h = J(await req(base, '/play/health'));
    ok(!Object.entries(S).some(([k, s]) => k !== 'roleName' && h.includes(s)), '/play/health carries no secret');
  } finally {await R.close()}
}

// ---- 4: a whole game through the relay ----
async function wholeGame() {
  console.log(`a whole game: seed ${SEED} through the relay with eight fake runners`);
  const R = await relayGame(['--game', '--seed', String(SEED)]), {base, backend} = R;
  try {
    const T = await table({base, backend}), t0 = Date.now();
    await T.drive(g => !!g.winner, 5000);
    const g = backend.game, sim = simulate(SEED).summary, ours = `seed ${SEED}: ${g.winner.text}, ${g.winner.alive} alive`;
    console.log(`  ${T.calls} tool calls in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${g.log.filter(e => e.type === 'say').length} lines of talk`);
    ok(ours === sim, `the relay's game ends as the sim does: "${ours}" (sim: "${sim}")`);
    ok(g.log.filter(e => e.type === 'ruling').length > 0 && R.lines.every(l => !/scripted Storyteller answered/.test(l)), 'every Storyteller decision came from its runner, none from the scripted fallback');
  } finally {await R.close()}
}

async function main() {
  console.log('\nClocktower channel check: seats meet only inside the game\n');
  const t0 = Date.now();
  await Promise.race([(async () => {await channels(); await wholeGame()})(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms(600000, 120000)).unref())]);
  console.log(fails ? `\n${fails} channel check(s) failed` : `\nchannel check: all ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fails ? 1 : 0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => {console.error(e); process.exit(1)});
