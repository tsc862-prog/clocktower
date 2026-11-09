// The watcher's page: the People view (src/ui/stage.js, the default) or the Table view of six panels, fed by the relay. createApp() wires the panels to one state and exposes the polls, so the page
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
//   voices                                                the socket's {type: 'clip'} (the relay's clip for an event), /tts/*, and
//                                                         POST /play/heard (how far the voices have got; src/ui/voice.js)
// Two views of the same panels, switched on the game bar and remembered per browser (clocktower.view): People, the characters as the
// main screen with the talk, the grimoire, the Storyteller's log and the agents in drawers over the stage's edge; Table, every panel
// at once. Both are always built and fed, so switching, or opening a drawer, keeps every scroll position and open row.
// The page's actions are the supervisor's: start, stop, stop all, resume; and New game once the relay serves it. The pace knob on the
// game bar goes with every start (minGap, heartbeat); a running runner keeps the pace it was started with.
import {createSquare} from './square.js';
import {createTalk} from './talk.js';
import {createGrimoire} from './grimoire.js';
import {createRulings} from './rulings.js';
import {createAgents} from './agents.js';
import {createStage} from './stage.js';
import {openRooms, roomsLine} from './square.js';
import {fixtureMoments, clockText, mergeFrame, mergePush, seatNames, PACES, DEFAULT_PACE, runnerGap} from './model.js';
import {esc} from './dom.js';
import {probeArt, artNote, imageLoad} from './art.js';
import {loadPortraits} from './portraits.js';
import {createVoice, voiceBar} from './voice.js';

const PACE_KEY = 'clocktower.pace';
function storedPace() {try {const v = globalThis.localStorage && localStorage.getItem(PACE_KEY); return PACES[v] ? v : DEFAULT_PACE} catch {return DEFAULT_PACE}}
export const VIEW_KEY = 'clocktower.view', ROLES_KEY = 'clocktower.roles', VIEWS = ['people', 'table'], DRAWERS = ['talk', 'grimoire', 'rulings', 'agents'];
const stored = k => {try {return globalThis.localStorage ? localStorage.getItem(k) : null} catch {return null}};
const store = (k, v) => {try {if (globalThis.localStorage) localStorage.setItem(k, v)} catch {}};
const FRAME_NAMES = {talk: 'day 1, talking', vote: 'day 1, a vote', night: 'a night', dawn: 'dawn', rooms: 'day 2, in the rooms', end: 'the end'};

export function createApp({client, view = null, fixture = null, runnersFixture = null, seed = null, refreshMs = 1500, frame = 'end', artLoad = imageLoad, pageFetch = undefined, audio = undefined, voiceFile = undefined, voiceTick = undefined, clipWait = undefined}) {
  const $ = id => document.getElementById(id);
  const state = {watch: null, runners: null, links: null, asides: [], health: null, source: fixture ? 'recorded' : 'live', watchMissing: false, frame: null, msg: '', epoch: 0, socket: false, pace: storedPace()};
  const bar = {seed: $('seed'), rounds: $('rounds'), phase: $('phase'), winner: $('winner'), source: $('source'), relay: $('relay-state'), newGame: $('new-game'), frames: $('frames'), msg: $('act-msg'), empty: $('empty'), pace: $('pace'), paceNote: $('pace-note'), art: $('art-note'), rooms: $('rooms-line'), startAll: $('bar-start-all')};
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

  let voice = null;
  const panels = {square: createSquare($('square')), talk: createTalk($('talk')), grimoire: createGrimoire($('grimoire')), rulings: createRulings($('rulings')), agents: createAgents($('agents'), {act}),
    stage: createStage($('stage'), {voiceState: () => voice ? voice.state : null, recorded: !!fixture})};
  // the view: People (the default) or Table, remembered per browser; ?view= on the address picks one for this visit only
  const body = document.body;
  function setView(v, remember = true) {
    const next = VIEWS.includes(v) ? v : 'people';
    body.dataset.view = next;
    for (const b of document.querySelectorAll('#view-switch button')) b.setAttribute('aria-pressed', b.dataset.view === next ? 'true' : 'false');
    if (remember) store(VIEW_KEY, next);
    if (next === 'table') setDrawer(null);
  }
  // a drawer over the stage's edge (People view): one at a time; its tab again, Close or Esc shuts it
  function setDrawer(d) {
    const next = DRAWERS.includes(d) ? d : '';
    body.dataset.drawer = next;
    for (const b of document.querySelectorAll('#drawer-tabs button')) b.setAttribute('aria-expanded', b.dataset.drawer === next ? 'true' : 'false');
    if (next === 'talk' && panels.talk.follower.following) {const box = panels.talk.box; box.scrollTop = box.scrollHeight}
  }
  for (const b of document.querySelectorAll('#view-switch button')) b.addEventListener('click', () => setView(b.dataset.view));
  for (const b of document.querySelectorAll('#drawer-tabs button')) b.addEventListener('click', () => setDrawer(body.dataset.drawer === b.dataset.drawer ? null : b.dataset.drawer));
  {const c = document.querySelector('#board .drawer-close'); if (c) c.addEventListener('click', () => setDrawer(null))}
  document.addEventListener('keydown', e => {if (e && e.key === 'Escape' && body.dataset.drawer) setDrawer(null)});
  // the roles switch: the true role in each card's corner, or not, for a tenser watch
  const rolesBox = $('roles-toggle');
  function setRoles(on, remember = true) {
    body.dataset.roles = on ? 'on' : 'off';
    if (rolesBox) rolesBox.checked = !!on;
    if (remember) store(ROLES_KEY, on ? 'on' : 'off');
    panels.stage.refresh();
  }
  if (rolesBox) rolesBox.addEventListener('change', () => setRoles(rolesBox.checked));
  setDrawer(null);
  setView(view || stored(VIEW_KEY) || 'people', false);
  setRoles(stored(ROLES_KEY) !== 'off', false);
  {const b = $('bar-start-all'); if (b) b.addEventListener('click', () => panels.agents.startAll())}
  if (bar.newGame) bar.newGame.addEventListener('click', () => act('newGame'));
  // the voices: every public line read aloud through the relay's local engine, when the owner turns them on
  let drawVoice = () => {};
  voice = createVoice({client, recorded: !!fixture, onSpeaker: who => {panels.square.setSpeaking(who); panels.stage.setSpeaking(who)}, onChange: st => {drawVoice(st); panels.stage.refresh()},
    ...(audio !== undefined ? {audio} : {}), ...(voiceFile !== undefined ? {voiceFile} : {}), ...(voiceTick !== undefined ? {tick: voiceTick} : {}), ...(clipWait !== undefined ? {clipWait} : {})});
  drawVoice = voiceBar(voice, {box: $('voice'), toggle: $('voice-toggle'), skip: $('voice-skip'), mute: $('voice-mute'), whispers: $('voice-whispers'), note: $('voice-note'), time: $('voice-time')});
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
    if (bar.rooms) {const o = openRooms(w), t = o ? roomsLine(o.rooms, seatNames(w)) : ''; if (bar.rooms.textContent !== t) bar.rooms.textContent = t; bar.rooms.hidden = !o}
    if (bar.startAll) {const a = panels.agents.canStartAll(); bar.startAll.disabled = !live || !a; bar.startAll.title = !live ? 'The recorded game: nothing is sent to the relay' : a ? 'Start a runner for the Storyteller and every seat that has none' : 'Every seat has a runner, or the runner supervisor is off'}
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
    for (const p of Object.values(panels)) p.render(s);
    renderBar(); // after the panels: the bar's Start all asks the agents panel
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
    if (msg.type === 'clip') {voice.clip(msg.id, msg.clip); return}
    if (msg.type === 'narrate' && typeof msg.text === 'string') {
      const names = seatNames(state.watch), who = msg.player == null || msg.player === 'storyteller' ? 'Storyteller' : names[Number(msg.player) - 1] || `seat ${msg.player}`;
      state.asides.push({n: ++asideN, who, text: msg.text, after: state.watch ? state.watch.last : -1});
      if (state.asides.length > 500) state.asides.splice(0, state.asides.length - 500);
      render();
    }
  }
  // the recorded moments: the recording's own, and a night and a dawn cut from its end
  const moments = fixture ? (() => {const m = {...fixture.frames, ...fixtureMoments(fixture.frames.end)}, order = ['talk', 'vote', 'night', 'dawn', 'rooms', 'end'];
    return Object.fromEntries([...order.filter(k => m[k]), ...Object.keys(m).filter(k => !order.includes(k))].map(k => [k, m[k]]))})() : null;
  function showFrame(name) {
    if (!fixture) return;
    const f = moments[name] || moments.end;
    state.frame = name; state.watch = f; state.epoch++;
    if (runnersFixture) {state.runners = runnersFixture.runners; state.links = runnersFixture.links}
    render();
  }
  if (fixture) {
    if (bar.frames) {bar.frames.replaceChildren(...Object.keys(moments).map(k => {const o = document.createElement('option'); o.value = k; o.textContent = k === 'night' ? `night ${moments[k].night}` : k === 'dawn' ? `dawn, day ${moments[k].day}` : FRAME_NAMES[k] || k; return o}));
      bar.frames.addEventListener('change', () => showFrame(bar.frames.value))}
    const first = moments[frame] ? frame : 'end';
    showFrame(first); if (bar.frames) bar.frames.value = first;
  } else render();
  // the owner's own token images: looked for once per page load; the drawn tokens stay until (and unless) one is found
  const art = probeArt({load: artLoad}).then(n => {render(); return n});
  // the seats' portraits (assets/portraits/index.json, read once per page load); the initials until then, or for good without it
  const portraits = loadPortraits(pageFetch ? {fetchImpl: pageFetch} : {}).then(m => {render(); return m});
  return {art, portraits, voice, state, panels, act, setView, setDrawer, setRoles, render, pollWatch, tickWatch, pollRunners, pollHealth, onSocket, onSocketOpen, onSocketClose, flushRefresh, showFrame};
}
