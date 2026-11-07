// The watcher's page: six panels fed by the relay. createApp() wires the panels to one state and exposes the polls, so the page
// (src/ui/main.js) drives them on timers and the smoke (scripts/uismoke.mjs) drives them by hand.
//
// Where each panel's data comes from:
//   game bar, square, talk, grimoire, Storyteller's log   GET /play/watch (asked of the backend; until the relay serves it, the page
//                                                         says so and offers the recorded game, src/ui/fixtures/game.json)
//   agents                                                GET /play/runner (the supervisor) and the WebSocket /play (links, runners,
//                                                         readiness; a runner's narration for the watcher becomes an aside in the talk)
//   relay state                                           GET /health
// The page's actions are the supervisor's: start, stop, stop all, resume; and New game once the relay serves it.
import {createSquare} from './square.js';
import {createTalk} from './talk.js';
import {createGrimoire} from './grimoire.js';
import {createRulings} from './rulings.js';
import {createAgents} from './agents.js';
import {clockText, mergeFrame, seatNames} from './model.js';
import {esc} from './dom.js';

export function createApp({client, fixture = null, runnersFixture = null, seed = null}) {
  const $ = id => document.getElementById(id);
  const state = {watch: null, runners: null, links: null, asides: [], health: null, source: fixture ? 'recorded' : 'live', watchMissing: false, frame: null, msg: '', epoch: 0};
  const bar = {seed: $('seed'), rounds: $('rounds'), phase: $('phase'), winner: $('winner'), source: $('source'), relay: $('relay-state'), newGame: $('new-game'), frames: $('frames'), msg: $('act-msg'), empty: $('empty')};
  if (seed != null && bar.seed && !bar.seed.value) bar.seed.value = String(seed);
  let asideN = 0, seedTouched = false;
  if (bar.seed) bar.seed.addEventListener('input', () => {seedTouched = true});

  async function act(name, body) {
    if (state.source === 'recorded') {say('This is the recorded game: nothing is sent to the relay.'); return {ok: false}}
    let r;
    if (name === 'start') r = await client.start(body);
    else if (name === 'stop') r = await client.stop(body);
    else if (name === 'stopAll') r = await client.stopAll();
    else if (name === 'resume') r = await client.resume();
    else if (name === 'startAll') {
      // the Storyteller first, so the game never waits on a seat with nobody to run it
      const seats = [...(body.seats || [])].sort((a, b) => (a.kind === 'storyteller' ? -1 : 0) - (b.kind === 'storyteller' ? -1 : 0));
      const out = []; for (const s of seats) out.push(await client.start(s));
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
  }
  function render() {
    const s = {watch: state.watch, runners: state.runners, links: state.links, asides: state.asides, epoch: state.epoch};
    renderBar();
    for (const p of Object.values(panels)) p.render(s);
  }

  async function pollWatch() {
    if (state.source !== 'live') return;
    const w = state.watch, r = await client.watch(w ? w.last : -1);
    if (r.missing) {state.watchMissing = true; render(); return}
    if (r.down || r.error) {render(); return}
    state.watchMissing = false;
    if (w && w.events.length && r.events && r.events.length && r.events[0].id === 0) state.epoch++; // the relay serves a new game
    state.watch = mergeFrame(w, r);
    render();
  }
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
    showFrame('end'); if (bar.frames) bar.frames.value = 'end';
  } else render();
  return {state, panels, act, render, pollWatch, pollRunners, pollHealth, onSocket, showFrame};
}
