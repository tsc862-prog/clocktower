// A seeded game behind the relay: the backend interface of scripts/relay-mcp.mjs ({info, call, storytellerCall, narrate,
// pace, links, attach}) over one live game. `npm run relay -- --game [--seed N] [--rounds N] [--scripted]` serves it.
//
//   call(playerId, tool, args)   a player's tool from src/data/player-tools.js; playerId is the seat index + 1 (the relay's
//                                seatList numbering). 'pace' is the runner's long poll (below), not a tool.
//   storytellerCall(tool, args)  a Storyteller tool from src/data/storyteller-tools.js.
//   handler(args, ctx)           ctx = {game, seat: {index, name}, api, log}. api is src/game/api.js bound to the seat
//                                (forSeat): a player's handler cannot name another seat or reach a Storyteller function.
//                                An ApiError becomes {ok: false, error: message}.
//   pace(id, {brief})            {ok, brief: header} from src/seats/player.js / storyteller.js.
//   pace(id, {realMs, wake})     waits up to realMs for: 'now' (a decision waits on the seat), 'soft' (events it has not
//                                been shown; only with wake 'all'), else 'heartbeat' (wake 'all') or wake null. Once the
//                                game is over and the seat has seen the end: {ok: false, gone: true}.
//   scripted: true               a Storyteller decision nobody answers within `grace` ms (counted from the decision or the
//                                Storyteller's last call) is answered by the scripted default, with that as its reason.
// No node: import; timers only, so it runs in a browser too.
import {newGame} from './state.js';
import {createScripted} from './scripted.js';
import * as api from './api.js';
import {PLAYER_TOOLS, ATTEMPT_INVITE} from '../data/player-tools.js';
import {STORYTELLER_TOOLS} from '../data/storyteller-tools.js';
import {playerHeader} from '../seats/player.js';
import {storytellerHeader} from '../seats/storyteller.js';

export const SCRIPTED_GRACE_MS = 2000, PACE_MAX_MS = 30000, PUSH_MS = 250;
export const SCRIPTED_REASON = 'scripted default: no Storyteller answered in time';
const ST = api.ST;

export function gameBackend({seed = 1, seats, rounds, scripted = false, grace = SCRIPTED_GRACE_MS, players = PLAYER_TOOLS,
  storyteller = STORYTELLER_TOOLS, note = () => {}, log = () => {}} = {}) {
  let game = newGame({seed, ...(seats ? {seats} : {}), ...(rounds != null ? {rounds} : {})});
  let answerer = scripted ? createScripted(seed) : null;
  const socks = new Set(), waiters = new Set(), seen = {}, apis = {};
  let pendingId = null, timer = null, closed = false;

  const keyOf = id => id === ST ? ST : id - 1;
  const seatOf = id => id === ST ? {index: ST, name: 'Storyteller'} : game.seats[id - 1] ? {index: id - 1, name: game.seats[id - 1].name} : null;
  const latest = key => {const ev = api.events(game, key); return ev.length ? ev.at(-1).id : -1};
  const unseen = key => latest(key) > (seen[key] ?? -1);
  const mustAct = key => key === ST ? !!api.pendingFor(game, ST) : api.mustAct(game, key);
  // The api a seat's handler gets; reading events marks them seen (the pace's soft wake).
  const apiFor = key => apis[key] || (apis[key] = (() => {
    const a = api.forSeat(key), ev = a.events;
    a.events = (g, s, since) => {const out = ev(g, s, since); if (out.length) seen[key] = Math.max(seen[key] ?? -1, out.at(-1).id); return out};
    return a;
  })());

  function changed() {
    const p = game.pending, id = p ? p.id : null, fresh = id !== pendingId;
    pendingId = id;
    for (const w of [...waiters]) w();
    if (fresh) arm();
    schedulePush();
  }
  // The watcher's whole view (GET /play/watch, the page only): everything, whispers with their text and every seat's told lines
  // included; events are the log entries after `since` with the table's sentence as `text`. A `since` past the end of this game
  // (a new game began) reads from the start.
  function watchView(since = -1) {
    const last = game.log.length ? game.log.at(-1).id : -1, from = Number.isFinite(Number(since)) && Number(since) <= last ? Number(since) : -1;
    const copy = v => v == null ? v : JSON.parse(JSON.stringify(v)), g = api.grimoire(game), c = game.clock;
    const told = api.events(game, ST, from), whispers = game.log.filter(e => e.type === 'whisper' && e.id > from).map(({n, ...e}) => copy(e));
    return {ok: true, seed: game.config.seed, rounds: game.config.rounds, phase: g.phase, night: game.night, day: game.day,
      clock: {day: c.day, round: c.round, roundsBeforeNominations: c.roundsBeforeNominations, nominationsOpen: c.nominationsOpen, spoke: [...c.spoke], passedNominating: [...c.passedNominating]},
      pending: copy(game.pending), ballot: copy(game.ballot), grimoire: g, nightOrder: api.nightOrder(game), rulings: api.rulings(game),
      winner: copy(game.winner), last, canNewGame: true, events: [...told, ...whispers].sort((a, b) => a.id - b.id)};
  }
  // The live push to the page's sockets: what changed since the last push, batched per PUSH_MS tick (a vote's ballots arrive as they
  // land). {type: 'watch', seed, last, events, clock, pending, ballot, phase, day, night, winner}: the same fields and shapes as the
  // watch body; the page polls ?since only when its socket reconnects.
  let pushed = -1, pushT = null, lastBallot = 'null';
  function schedulePush() {
    if (pushT || closed || !socks.size) return;
    pushT = setTimeout(() => {pushT = null; pushNow()}, PUSH_MS);
    if (pushT.unref) pushT.unref();
  }
  function pushNow() {
    if (!socks.size) return;
    const v = watchView(pushed), ballot = JSON.stringify(v.ballot);
    if (!v.events.length && ballot === lastBallot) return;
    pushed = v.last; lastBallot = ballot;
    sendAll({type: 'watch', seed: v.seed, last: v.last, events: v.events, clock: v.clock, pending: v.pending, ballot: v.ballot, phase: v.phase, day: v.day, night: v.night, winner: v.winner});
  }
  // The scripted Storyteller: answers a Storyteller decision left alone for `grace` ms. The wait starts again with each
  // new decision and each Storyteller call (timers only: the engine's folder reads no clock).
  function arm() {
    if (!answerer || closed) return;
    if (timer) {clearTimeout(timer); timer = null}
    const p = game.pending;
    if (!p || p.seat !== ST) return;
    timer = setTimeout(() => {
      timer = null;
      const q = game.pending;
      if (closed || !q || q.seat !== ST || q.id !== p.id) return;
      try {api.answer(game, ST, answerer(game), SCRIPTED_REASON); log(`[game] scripted Storyteller answered ${q.kind}`)}
      catch (e) {log(`[game] scripted Storyteller failed on ${q.kind}: ${e.message}`); return}
      changed();
    }, Math.max(0, grace));
    if (timer.unref) timer.unref();
  }

  async function run(list, tool, args, seat) {
    const t = list.find(x => x.name === tool);
    if (!t) return {ok: false, error: `No tool ${tool}. ${ATTEMPT_INVITE}`};
    if (typeof t.handler !== 'function') return {ok: false, error: `The tool ${tool} has nothing behind it yet.`};
    const ctx = {game, seat, api: apiFor(seat.index), log: (type, data) => {try {note({type: 'tool-note', seat: seat.index === ST ? ST : 'player:' + (seat.index + 1), tool, note: type, data})} catch {}}};
    let r;
    try {r = await t.handler(args && typeof args === 'object' ? args : {}, ctx)}
    catch (e) {r = {ok: false, error: e instanceof api.ApiError ? e.message : `The game could not do that: ${String(e && e.message || e)}`}}
    changed();
    return r && typeof r === 'object' ? r : {ok: false, error: 'no answer'};
  }

  const clockText = () => {
    if (game.winner) return 'the game is over';
    if (game.phase !== 'day') return `${game.phase} ${game.phase === 'night' ? game.night : ''}`.trim();
    const c = game.clock;
    return c.nominationsOpen ? `day ${game.day}, nominations open` : `day ${game.day}, round ${c.round} of ${c.roundsBeforeNominations}`;
  };

  async function pace(id, args = {}) {
    const key = keyOf(id);
    if (args.brief) {
      seen[key] = Math.max(seen[key] ?? -1, latest(key));
      try {return {ok: true, brief: key === ST ? storytellerHeader(game) : playerHeader(game, key)}}
      catch (e) {return {ok: false, error: String(e.message || e)}}
    }
    const soft = !args.wake || args.wake === 'all';
    const check = () => {
      if (mustAct(key)) return {ok: true, wake: 'now', why: key === ST ? `a ${game.pending.kind} decision waits on you` : api.legalNow(game, key), clock: clockText()};
      if (unseen(key) && (soft || game.winner)) return {ok: true, wake: 'soft', why: 'something happened at the table', clock: clockText()};
      if (game.winner) return {ok: false, gone: true, error: `The game is over: ${game.winner.text}.`};
      return null;
    };
    const mark = r => {if (r.ok) seen[key] = Math.max(seen[key] ?? -1, latest(key)); return r};
    let r = check();
    if (r) return mark(r);
    const ms = Math.min(PACE_MAX_MS, Math.max(0, Number(args.realMs) || 0));
    r = await new Promise(res => {
      const w = () => {const x = check(); if (x) {clearTimeout(t); waiters.delete(w); res(x)}};
      const t = setTimeout(() => {waiters.delete(w); res(null)}, ms);
      waiters.add(w);
    });
    if (r) return mark(r);
    return soft ? mark({ok: true, wake: 'heartbeat', why: 'a quiet beat', clock: clockText()}) : {ok: true, wake: null, why: 'nothing new', clock: clockText()};
  }

  const sendAll = o => {const s = JSON.stringify(o); for (const ws of socks) if (ws.readyState === 1) ws.send(s)};
  arm();
  return {
    get game() {return game},
    info: () => ({connected: true, phase: clockText(), players: game.seats.map(s => ({id: s.index + 1, name: s.name, alive: s.alive})), storyteller: true}),
    async call(id, tool, args) {
      const seat = seatOf(id);
      if (!seat) return {ok: false, error: `Seat #${id} is not at the table.`};
      if (tool === 'pace') return pace(id, args || {});
      return run(players, tool, args, seat);
    },
    async storytellerCall(tool, args) {
      if (tool === 'pace') return pace(ST, args || {});
      if (timer) clearTimeout(timer), timer = null;
      const r = await run(storyteller, tool, args, seatOf(ST));
      arm();
      return r;
    },
    pace: (id, args) => pace(id === ST ? ST : id, args || {}),
    narrate(id, text) {sendAll({type: 'narrate', player: id, text: String(text).slice(0, 600)})},
    links(map, runners = {}, st = null, ready = {}) {sendAll({type: 'links', links: map, runners, ready, ...(st ? {storyteller: st} : {})})},
    attach(ws) {if (!socks.size) {pushed = game.log.length ? game.log.at(-1).id : -1; lastBallot = JSON.stringify(game.ballot ?? null)} socks.add(ws); log('[play] watcher page connected'); ws.on('close', () => {socks.delete(ws); log('[play] watcher page disconnected')}); ws.on('message', () => {})},
    // The watcher's whole view (GET /play/watch, the page only): everything, whispers with their text and every seat's told lines
    // included; events are the log entries after `since` with the table's sentence as `text`. A `since` past the end of this game
    // (a new game began) reads from the start.
    watch: since => watchView(since),
    // A fresh seeded game in place of this one (POST /play/game/new, after the supervisor's stop-all): same seats, so the relay's
    // claims and links stay. -> {seed, rounds}
    newGame(nextSeed = game.config.seed, nextRounds = game.config.rounds) {
      if (timer) clearTimeout(timer); timer = null;
      game = newGame({seed: nextSeed, ...(seats ? {seats} : {}), ...(nextRounds != null ? {rounds: nextRounds} : {})});
      answerer = scripted ? createScripted(nextSeed) : null;
      for (const k of Object.keys(seen)) delete seen[k];
      pendingId = null; pushed = -1; lastBallot = 'null'; changed();
      log(`[game] a new game: seed ${nextSeed}`);
      return {seed: game.config.seed, rounds: game.config.rounds};
    },
    close() {closed = true; if (timer) clearTimeout(timer); timer = null; if (pushT) clearTimeout(pushT); pushT = null; for (const w of [...waiters]) waiters.delete(w)},
  };
}
