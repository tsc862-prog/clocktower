// The watcher's page: six panels fed by the relay. createApp() wires the panels to one state and exposes the polls, so the page
// (src/ui/main.js) drives them on timers and the smoke (scripts/uismoke.mjs) drives them by hand.
//
// Where each panel's data comes from:
//   game bar, square, talk, grimoire, Storyteller's log   the socket's push ({type: 'watch'}: new events, clock, pending, ballot, phase)
//                                                         as each lands; GET /play/watch?since=last when the socket opens or reopens,
//                                                         and after a push with new events (the grimoire, rulings and night order are
//                                                         not in the push); every second and a half while the socket is down. Until the
//                                                         relay serves the route the page says so and offers the recorded game.
//   agents                                                GET /play/runner (the supervisor) and the WebSocket /play (links, runners,
//                                                         readiness; a runner's narration for the watcher becomes an aside in the talk)
//   relay state                                           GET /health
// The page's actions are the supervisor's: start, stop, stop all, resume; and New game once the relay serves it. The pace knob on the
// game bar goes with every start (minGap, heartbeat); a running runner keeps the pace it was started with.
import {createSquare} from './square.js';
import {createTalk} from './talk.js';
import {createGrimoire} from './grimoire.js';
import {createRulings} from './rulings.js';
import {createAgents} from './agents.js';
import {clockText, mergeFrame, mergePush, seatNames, PACES, DEFAULT_PACE, runnerGap} from './model.js';
import {esc} from './dom.js';
import {probeArt, artNote, imageLoad} from './art.js';
import {loadPortraits} from './portraits.js';
import {createVoice, voiceBar} from './voice.js';

const PACE_KEY = 'clocktower.pace';
function storedPace() {try {const v = globalThis.localStorage && localStorage.getItem(PACE_KEY); return PACES[v] ? v : DEFAULT_PACE} catch {return DEFAULT_PACE}}

export function createApp({client, fixture = null, runnersFixture = null, seed = null, refreshMs = 1500, frame = 'end', artLoad = imageLoad, pageFetch = undefined, audio = undefined, voiceFile = undefined}) {
  const $ = id => document.getElementById(id);
  const state = {watch: null, runners: null, links: null, asides: [], health: null, source: fixture ? 'recorded' : 'live', watchMissing: false, frame: null, msg: '', epoch: 0, socket: false, pace: storedPace()};
  const bar = {seed: $('seed'), rounds: $('rounds'), phase: $('phase'), winner: $('winner'), source: $('source'), relay: $('relay-state'), newGame: $('new-game'), frames: $('frames'), msg: $('act-msg'), empty: $('empty'), pace: $('pace'), paceNote: $('pace-note'), art: $('art-note')};
  if (seed != null && bar.seed && !bar.seed.value) bar.seed.value = String(seed);
  let asideN = 0, seedTouched = false;
  if (bar.seed) bar.seed.addEventListener('input', () => {seedTouched = true});
  if (bar.pace) {
    bar.pace.replaceChildren(...Object.entries(PACES).map(([k, p]) => {const o = document.createElement('option'); o.value = k; o.textContent = p.label; return o}));
    bar.pace.value = state.pace;
    bar.pace.addEventListener('change', () => {
      state.pace = PACES[bar.pace.value] ? bar.pace.value : DEFAULT_PACE;
      try {localStorage.setItem(PACE_KEY, state.pace)} catch {}
      renderBar();
    });
  }
  const paceFlags = () => {const p = PACES[state.pace] || PACES[DEFAULT_PACE]; return {minGap: p.minGap, heartbeat: p.heartbeat}};

  async function act(name, body) {
    if (state.source === 'recorded') {say('This is the recorded game: nothing is sent to the relay.'); return {ok: false}}
    let r;
    if (name === 'start') r = await client.start({...body, ...paceFlags()});
    else if (name === 'stop') r = await client.stop(body);
    else if (name === 'stopAll') r = await client.stopAll();
    else if (name === 'resume') r = await client.resume();
    else if (name === 'startAll') {
      // the Storyteller first, so the game never waits on a seat with nobody to run it
      const seats = [...(body.seats || [])].sort((a, b) => (a.kind === 'storyteller' ? -1 : 0) - (b.kind === 'storyteller' ? -1 : 0));
      const out = []; for (const s of seats) out.push(await client.start({...s, ...paceFlags()}));
      const bad = out.filter(x => x && x.ok === false);
      r = bad.length ? {ok: false, error: `${bad.length} of ${out.length} did not start: ${bad[0].error}`} : {ok: true};
    } else if (name === 'newGame') {
      const s = Number(bar.seed && bar.seed.value);
      const stopped = await client.stopAll('new game');
      r = stopped && stopped.ok === false ? stopped : await client.newGame({seed: Number.isInteger(s) ? s : undefined, rounds: state.watch ? state.watch.rounds : undefined});
      if (r && r.ok !== false) {state.watch = null; state.asides = []; state.epoch++; seedTouched = false}
    } else throw new Error('no such action ' + name);
    say(r && r.ok === false ? `${name}: ${r.error}` : `${name}: done`);
    pollRunners();
    return r;
  }
  const say = m => {state.msg = m; if (bar.msg) bar.msg.textContent = m};

  const panels = {square: createSquare($('square')), talk: createTalk($('talk')), grimoire: createGrimoire($('grimoire')), rulings: createRulings($('rulings')), agents: createAgents($('agents'), {act})};
  if (bar.newGame) bar.newGame.addEventListener('click', () => act('newGame'));
  // the voices: every public line read aloud through the relay's local engine, when the owner turns them on
  let drawVoice = () => {};
  const voice = createVoice({client, recorded: !!fixture, onSpeaker: who => panels.square.setSpeaking(who), onChange: st => drawVoice(st),
    ...(audio !== undefined ? {audio} : {}), ...(voiceFile !== undefined ? {voiceFile} : {})});
  drawVoice = voiceBar(voice, {box: $('voice'), toggle: $('voice-toggle'), skip: $('voice-skip'), mute: $('voice-mute'), whispers: $('voice-whispers'), note: $('voice-note')});
  drawVoice();

  function renderBar() {
    const w = state.watch;
    if (bar.empty) bar.empty.hidden = !!w;
    if (bar.phase) bar.phase.textContent = w ? clockText(w) : '';
    if (bar.rounds) bar.rounds.textContent = w ? `${w.rounds} speaking rounds a day` : '';
    if (bar.winner) {bar.winner.textContent = w && w.winner ? `${w.winner.team === 'good' ? 'Good' : 'Evil'} wins` : ''; bar.winner.hidden = !(w && w.winner)}
    if (bar.seed && w && !seedTouched && document.activeElement !== bar.seed) bar.seed.value = String(w.seed);
    const live = state.source === 'live';
    if (bar.source) bar.source.innerHTML = live
      ? (state.watchMissing ? 'The relay does not send the game to the page yet. <a href="?fixture">Watch the recorded game</a>' : w ? 'live' : '')
      : `recorded game, seed ${esc(fixture.seed)} <a href="?">back to live</a>`;
    const h = state.health;
    if (bar.relay) {bar.relay.textContent = h && !h.down && !h.missing ? 'relay: connected' : 'relay: not connected'; bar.relay.dataset.state = h && !h.down && !h.missing ? 'connected' : 'not-connected'}
    if (bar.newGame) {
      const can = live && !!(w && w.canNewGame);
      bar.newGame.disabled = !can;
      bar.newGame.title = can ? 'Stops every runner, then deals a new game with this seed' : 'Needs the relay to start a new game over the wire (POST /play/game/new), asked of the backend';
    }
    if (bar.frames) bar.frames.hidden = live;
    if (bar.art) {const a = artNote(); if (bar.art.textContent !== a) bar.art.textContent = a; bar.art.hidden = !a}
    if (bar.pace) {
      const p = PACES[state.pace];
      if (bar.pace.value !== state.pace) bar.pace.value = state.pace;
      bar.pace.title = `${p.about}; a turn that cannot wait (a vote, a night choice) still comes at once. Goes with the next start.`;
      const live = ((state.runners && state.runners.runners) || []).filter(r => !['stopped', 'crashed'].includes(r.state));
      const other = live.filter(r => {const g = runnerGap(r); return g != null && g !== p.minGap}).length;
      const n = other ? `${other} running ${other === 1 ? 'runner keeps its' : 'runners keep their'} old pace until restarted` : '';
      if (bar.paceNote && bar.paceNote.textContent !== n) bar.paceNote.textContent = n;
    }
  }
  function render() {
    const s = {watch: state.watch, runners: state.runners, links: state.links, asides: state.asides, epoch: state.epoch};
    renderBar();
    for (const p of Object.values(panels)) p.render(s);
    if (state.source === 'live') voice.feed(state.watch, state.epoch);
  }

  let watchBusy = null, pushSeq = 0;
  const LIVE = ['last', 'clock', 'pending', 'ballot', 'phase', 'day', 'night', 'winner'];
  async function pollWatch() {
    if (state.source !== 'live') return;
    if (watchBusy) return watchBusy;
    watchBusy = (async () => {
      const w = state.watch, seq = pushSeq, r = await client.watch(w ? w.last : -1);
      if (r.missing) {state.watchMissing = true; render(); return}
      if (r.down || r.error) {render(); return}
      state.watchMissing = false;
      if (w && w.events.length && r.events && r.events.length && r.events[0].id === 0) state.epoch++; // the relay serves a new game
      const m = mergeFrame(state.watch, r);
      // a push that landed while this read was out is newer than it: keep the push's clock, ballot and phase
      state.watch = pushSeq !== seq && state.watch && m !== r ? {...m, ...LIVE.reduce((o, k) => (o[k] = state.watch[k], o), {})} : m;
      render();
    })();
    try {await watchBusy} finally {watchBusy = null}
  }
  // The live push. While the socket is open the page reads the route only when the socket opens (pushes that land meanwhile wait
  // and are merged after, deduped by event id) and, once a push brings new events, a moment later for the grimoire side.
  let syncing = false, queued = [], refreshT = null;
  function scheduleRefresh() {
    if (refreshT || refreshMs == null) return;
    refreshT = setTimeout(() => {refreshT = null; pollWatch()}, refreshMs);
    if (refreshT && refreshT.unref) refreshT.unref();
  }
  async function flushRefresh() {if (refreshT) {clearTimeout(refreshT); refreshT = null; await pollWatch()}}
  async function applyPush(msg) {
    if (syncing || !state.watch) {queued.push(msg); if (!syncing && !state.watch) await sync(); return}
    const m = mergePush(state.watch, msg);
    if (m.full) {state.watch = null; state.epoch++; queued = []; await sync(); return}
    const phaseMoved = m.frame.phase !== state.watch.phase || m.frame.day !== state.watch.day || m.frame.night !== state.watch.night;
    state.watch = m.frame; pushSeq++; render();
    if (m.fresh || phaseMoved) scheduleRefresh();
  }
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {await pollWatch()} finally {syncing = false}
    const q = queued; queued = [];
    if (state.watch) for (const x of q) await applyPush(x);
  }
  async function onSocketOpen() {state.socket = true; await sync()}
  function onSocketClose() {state.socket = false}
  // the timer's read: only while the socket is down
  const tickWatch = () => state.socket ? undefined : pollWatch();
  async function pollRunners() {
    if (state.source !== 'live') return;
    const r = await client.runners();
    state.runners = r.missing ? {enabled: false, how: 'This relay has no runner supervisor.'} : r;
    render();
  }
  async function pollHealth() {state.health = await client.health(); renderBar()}
  function onSocket(msg) {
    if (!msg || typeof msg !== 'object' || state.source !== 'live') return;
    if (msg.type === 'links') {state.links = msg; render()}
    if (msg.type === 'watch') return applyPush(msg);
    if (msg.type === 'narrate' && typeof msg.text === 'string') {
      const names = seatNames(state.watch), who = msg.player == null || msg.player === 'storyteller' ? 'Storyteller' : names[Number(msg.player) - 1] || `seat ${msg.player}`;
      state.asides.push({n: ++asideN, who, text: msg.text, after: state.watch ? state.watch.last : -1});
      if (state.asides.length > 500) state.asides.splice(0, state.asides.length - 500);
      render();
    }
  }
  function showFrame(name) {
    if (!fixture) return;
    const f = fixture.frames[name] || fixture.frames.end;
    state.frame = name; state.watch = f; state.epoch++;
    if (runnersFixture) {state.runners = runnersFixture.runners; state.links = runnersFixture.links}
    render();
  }
  if (fixture) {
    if (bar.frames) {bar.frames.replaceChildren(...Object.keys(fixture.frames).map(k => {const o = document.createElement('option'); o.value = k; o.textContent = {talk: 'day 1, talking', vote: 'day 1, a vote', end: 'the end'}[k] || k; return o}));
      bar.frames.addEventListener('change', () => showFrame(bar.frames.value))}
    const first = fixture.frames[frame] ? frame : 'end';
    showFrame(first); if (bar.frames) bar.frames.value = first;
  } else render();
  // the owner's own token images: looked for once per page load; the drawn tokens stay until (and unless) one is found
  const art = probeArt({load: artLoad}).then(n => {render(); return n});
  // the seats' portraits (assets/portraits/index.json, read once per page load); the initials until then, or for good without it
  const portraits = loadPortraits(pageFetch ? {fetchImpl: pageFetch} : {}).then(m => {render(); return m});
  return {art, portraits, voice, state, panels, act, render, pollWatch, tickWatch, pollRunners, pollHealth, onSocket, onSocketOpen, onSocketClose, flushRefresh, showFrame};
}
