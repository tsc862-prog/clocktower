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
//                                been shown, and only for a seat that can act now: api.canAct; only with wake 'all'), else
//                                'heartbeat' (wake 'all'; why names when the seat next acts: api.nextTurnText) or wake null. The
//                                Storyteller wakes 'now' whenever an act is due (storytellerDue of src/seats/storyteller.js: a
//                                narration owed, a decision, end_day), never held for the voice, and soft only on new public
//                                events it did not make itself. Once the
//                                game is over: {ok: false, gone: true} at once, for every seat (#69: nothing is woken after the
//                                win). Nominations (#69): a 'nomination' decision wakes the seats that may nominate one at a
//                                time in seat order (from seat (day - 1) mod n), `stagger` ms apart; a seat that nominates or
//                                passes moves the next one up. stagger 0 (the default): all at once.
//   gameId                       one id per dealt game (#66): `<seed>-<deal time, UTC, yyyymmddThhmmssZ>` (".N" added when two
//                                deals share a second); info(), the watch body and newGame() carry it. Runners keep a model
//                                session only for the same id.
//   scripted: true               a Storyteller decision nobody answers within `grace` ms (counted from the decision or the
//                                Storyteller's last call) is answered by the scripted default, with that as its reason.
// now: the clock, given from outside (the relay passes its own clock); the engine folder reads none.
// No node: import; timers only, so it runs in a browser too.
import {newGame} from './state.js';
import {createScripted} from './scripted.js';
import * as api from './api.js';
import {PLAYER_TOOLS, ATTEMPT_INVITE} from '../data/player-tools.js';
import {STORYTELLER_TOOLS} from '../data/storyteller-tools.js';
import {playerHeader} from '../seats/player.js';
import {STORYTELLER_SPOKEN, SEAT_SPOKEN} from '../data/spoken.js';
import {storytellerHeader} from '../seats/storyteller.js';
import * as stSeat from '../seats/storyteller.js'; // storytellerDue (PR #74), read behind a guard: the backend runs without it

export const SCRIPTED_GRACE_MS = 2000, PACE_MAX_MS = 30000, PUSH_MS = 250;
// The voice's clock (issue #50): a page that reported within HEARD_FRESH_MS with its voice on, and more than one spoken line ahead
// of what it has heard, makes a soft wake wait (HOLD_MS per poll), never longer than HOLD_CAP_MS for one seat.
export const HEARD_FRESH_MS = 90000, HOLD_MS = 1500, HOLD_CAP_MS = 30000;
const SPOKEN = new Set(STORYTELLER_SPOKEN), SEAT_SAYS = new Set(SEAT_SPOKEN); // the lists the page reads too (src/data/spoken.js)
export const SCRIPTED_REASON = 'scripted default: no Storyteller answered in time';
const ST = api.ST;

// A UTC time stamp yyyymmddThhmmssZ from ms since 1970, by arithmetic (the engine folder constructs no Date): civil from days.
export function utcStamp(ms) {
  const p = n => String(n).padStart(2, '0'), d = Math.floor(ms / 864e5), s = Math.floor((ms - d * 864e5) / 1000);
  const z = d + 719468, era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), dd = doy - Math.floor((153 * mp + 2) / 5) + 1, mm = mp < 10 ? mp + 3 : mp - 9;
  return `${yoe + era * 400 + (mm <= 2 ? 1 : 0)}${p(mm)}${p(dd)}T${p(Math.floor(s / 3600))}${p(Math.floor(s % 3600 / 60))}${p(s % 60)}Z`;
}

export function gameBackend({seed = 1, seats, rounds, scripted = false, grace = SCRIPTED_GRACE_MS, players = PLAYER_TOOLS,
  storyteller = STORYTELLER_TOOLS, note = () => {}, onEvent = () => {}, log = () => {}, now = () => 0, stagger = 0} = {}) {
  let game = newGame({seed, ...(seats ? {seats} : {}), ...(rounds != null ? {rounds} : {})});
  // The game id (#66): the seed and the deal time from the clock given to us; a repeat within one second gets ".N".
  let deals = 0, gameId = null;
  const dealId = s => {deals++; const t = Number(now()) || 0, stamp = utcStamp(t), id = `${s}-${stamp}`;
    return gameId && gameId.split('.')[0] === id ? `${id}.${deals}` : id};
  gameId = dealId(seed);
  // The nomination stagger (#69): {at: when the nomination decision opened, order: seat keys in seat order from (day - 1) mod n};
  // it starts again each time the decision opens (after each vote).
  let stag = null;
  const nominating = () => {const p = game.pending; return !!p && p.kind === 'nomination' && game.phase === 'day' && !!game.clock && game.clock.nominationsOpen && !game.winner};
  const newStag = () => {const n = game.seats.length, from = ((game.day || 1) - 1) % n; return {at: now(), order: game.seats.map((_, i) => (from + i) % n)}};
  let answerer = scripted ? createScripted(seed) : null;
  const heardWaiters = new Set();
  const socks = new Set(), waiters = new Set(), seen = {}, apis = {};
  let pendingId = null, timer = null, closed = false;
  // Clips (the relay's voice hook: {clip(name, text) -> Promise<{id, ms}>}) and the page's heard mark.
  let voice = null, heard = null;
  const clips = new Map(), asked = new Set(), holdSince = {};
  // What a public log entry says aloud: {name, text} or null (whispers and night deaths are silent). A seat's line and its night
  // thought (#111, the watcher's alone) are in the seat's own voice.
  const spoken = e => {
    if (!e || typeof e.text !== 'string' || !e.text.trim()) return null;
    if (SEAT_SAYS.has(e.type) && Number.isInteger(e.seat) && game.seats[e.seat]) return {name: game.seats[e.seat].name, text: e.text};
    if (e.type === 'death' ? e.phase === 'day' : SPOKEN.has(e.type)) return {name: 'Storyteller', text: e.text};
    return null;
  };
  const spokenAhead = last => game.log.reduce((n, e) => n + (e.id > last && spoken(e) ? 1 : 0), 0);
  const holding = key => {
    if (!heard || !heard.voice || now() - heard.at > HEARD_FRESH_MS || spokenAhead(heard.last) <= 1) {delete holdSince[key]; return 0}
    const t = now(), t0 = holdSince[key] ?? (holdSince[key] = t), left = HOLD_CAP_MS - (t - t0);
    return left > 0 ? Math.min(HOLD_MS, left) : 0;
  };

  const keyOf = id => id === ST ? ST : id - 1;
  const seatOf = id => id === ST ? {index: ST, name: 'Storyteller'} : game.seats[id - 1] ? {index: id - 1, name: game.seats[id - 1].name} : null;
  const latest = key => {const ev = api.events(game, key); return ev.length ? ev.at(-1).id : -1};
  const unseen = key => latest(key) > (seen[key] ?? -1);
  // The Storyteller's act that is due now (#74, #69): narrate owed at dawn, after an execution or at the end; a decision asked of it;
  // end_day once everyone has nominated or passed. -> {tool, why} or null. Without the seat's storytellerDue: a pending decision only.
  const stApi = api.forSeat(ST);
  const stDue = () => {if (typeof stSeat.storytellerDue !== 'function') return null; try {return stSeat.storytellerDue(game, stApi) || null} catch {return null}};
  // A due act that is not a decision (a narration owed, end_day) wakes the Storyteller now once; the same due again only by the
  // heartbeat, so a Storyteller that lets it pass is not woken in a loop.
  let stDueSaid = null;
  const dueKey = d => d ? d.tool + ': ' + d.why : null;
  const stDueNew = () => {const k = dueKey(stDue()); return k && k !== stDueSaid ? k : null};
  const mustAct = key => key === ST ? !!api.pendingFor(game, ST) || !!stDueNew() : api.mustAct(game, key);
  const stWhy = () => {const d = stDue(); return d ? `${d.tool}: ${d.why}` : game.pending ? `a ${game.pending.kind} decision waits on you` : 'something is due'};
  // A soft wake for the Storyteller only on new public events it did not make itself (its own narrations and rulings do not count).
  const stFresh = () => api.events(game, ST, seen[ST] ?? -1).some(e => e.type !== 'narration' && e.type !== 'ruling');
  // The api a seat's handler gets; reading events marks them seen (the pace's soft wake).
  const apiFor = key => apis[key] || (apis[key] = (() => {
    const a = api.forSeat(key), ev = a.events;
    a.events = (g, s, since) => {const out = ev(g, s, since); if (out.length) seen[key] = Math.max(seen[key] ?? -1, out.at(-1).id); return out};
    return a;
  })());

  // The watcher's events after `from`: the Storyteller's view plus the whispers and room talk it never hears, and the entries for
  // the watcher alone (audience 'watcher': the seats' night thoughts, #111).
  function watchEvents(from) {
    const copy = v => v == null ? v : JSON.parse(JSON.stringify(v));
    const told = api.events(game, ST, from), whispers = game.log.filter(e => (e.type === 'whisper' || e.type === 'say' && e.room != null || e.audience === 'watcher') && e.id > from).map(({n, ...e}) => copy(e));
    return [...told, ...whispers].sort((a, b) => a.id - b.id);
  }
  // The game's public events for the behavior log (#100), once each: every log entry after the watermark, as it happens (changed() runs
  // after every act), seats as names. Only the types the table sees (not what the Storyteller was told or ruled); the grimoire is left out.
  const LOGGED = new Set(['night', 'dawn', 'phase', 'say', 'pass', 'whisper', 'move', 'nomination', 'vote', 'vote-closed', 'execution', 'no-execution', 'slayer-shot', 'virgin', 'death', 'win', 'thought']);
  let emitted = -1;
  function emitEvents() {
    let evs; try {evs = watchEvents(emitted)} catch {return}
    if (!evs.length) return;
    emitted = evs.at(-1).id;
    const nm = i => game.seats[i] ? game.seats[i].name : i, nms = a => Array.isArray(a) ? a.map(nm) : a;
    let rooms; try {rooms = new Map(api.where(game, ST).rooms.map(r => [r.id, r.name]))} catch {rooms = new Map()}
    for (const e of evs) {
      if (!LOGGED.has(e.type)) continue;
      const r = {src: 'event', id: e.id, type: e.type === 'vote' ? 'vote-result' : e.type, phase: e.phase, day: e.day, night: e.night};
      for (const k of ['what', 'round', 'text', 'team', 'reason', 'cause', 'how', 'tally', 'needed', 'need']) if (e[k] != null) r[k] = e[k];
      if (e.room != null) {r.room = e.room; if (rooms.has(e.room)) r.roomName = rooms.get(e.room)}
      for (const k of ['seat', 'by', 'from', 'to', 'target', 'nominator']) if (typeof e[k] === 'number') r[k === 'seat' && ['say', 'pass', 'death', 'execution', 'thought'].includes(e.type) ? 'who' : k] = nm(e[k]);
      for (const k of ['seats', 'yes', 'missing', 'deaths']) if (Array.isArray(e[k])) r[k] = nms(e[k]);
      if (e.block) r.block = {seat: e.block.seat == null ? null : nm(e.block.seat), votes: e.block.votes};
      try {onEvent(r)} catch {}
    }
  }

  // The thoughts scene (#111) waits on the seats only when they have a tool to answer it (the player's `think`); a table without one
  // has no thought to give, so the scene is answered empty for every living seat at once and nothing is logged.
  const seatsThink = players.some(t => t && t.name === 'think');
  function noThoughts() {
    const p = game.pending;
    if (seatsThink || !p || p.kind !== 'thoughts') return;
    for (const i of p.seats) if (game.pending === p && api.pendingFor(game, i)?.mine === null) api.think(game, i, '');
  }

  function changed() {
    try {noThoughts()} catch (e) {log(`[game] the empty thoughts failed: ${e.message}`)}
    const p = game.pending, id = p ? p.id : null, fresh = id !== pendingId;
    pendingId = id;
    if (!nominating()) stag = null; else if (!stag) stag = newStag(); // the stagger starts when the nomination decision opens (again)
    try {emitEvents()} catch {} // never throws into an act or the pace answer
    for (const w of [...waiters]) w();
    if (fresh) arm();
    schedulePush();
  }
  // The watcher's whole view (GET /play/watch, the page only): everything, whispers with their text, room talk with its `room`
  // and every seat's told lines included; events are the log entries after `since` with the table's sentence as `text`. places:
  // who is where now ({square, rooms: [{id, name, size, seats, free}], open}); a move event says who went where. A `since` past
  // the end of this game (a new game began) reads from the start.
  function watchView(since = -1) {
    const last = game.log.length ? game.log.at(-1).id : -1, from = Number.isFinite(Number(since)) && Number(since) <= last ? Number(since) : -1;
    const copy = v => v == null ? v : JSON.parse(JSON.stringify(v)), g = api.grimoire(game), c = game.clock;
    // the Storyteller hears neither whispers nor room talk; the watcher hears both
    const w = api.where(game, ST), places = {square: w.square, rooms: w.rooms, open: w.open};
    const withClip = e => clips.has(e.id) ? {...e, clip: clips.get(e.id)} : e;
    return {ok: true, gameId, seed: game.config.seed, rounds: game.config.rounds, phase: g.phase, night: game.night, day: game.day,
      clock: {day: c.day, round: c.round, roundsBeforeNominations: c.roundsBeforeNominations, nominationsOpen: c.nominationsOpen, spoke: [...c.spoke], passedNominating: [...c.passedNominating]},
      pending: copy(game.pending), ballot: copy(game.ballot), grimoire: g, nightOrder: api.nightOrder(game), rulings: api.rulings(game),
      winner: copy(game.winner), last, canNewGame: true, places, events: watchEvents(from).map(withClip)};
  }
  // The live push to the page's sockets: what changed since the last push, batched per PUSH_MS tick (a vote's ballots arrive as they
  // land). {type: 'watch', seed, last, events, clock, pending, ballot, phase, day, night, winner, places}: the same fields and shapes as the
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
    askClips(v.events);
    sendAll({type: 'watch', seed: v.seed, last: v.last, events: v.events, clock: v.clock, pending: v.pending, ballot: v.ballot, phase: v.phase, day: v.day, night: v.night, winner: v.winner, places: v.places});
  }
  // A clip per new spoken event, made behind the push (never awaited): the page gets {type: 'clip', id, clip: {id, ms}} when it is ready.
  function askClips(events) {
    if (!voice) return;
    for (const e of events) {
      const s = spoken(e); if (!s || asked.has(e.id) || clips.has(e.id)) continue;
      asked.add(e.id);
      const mine = game;
      Promise.resolve().then(() => voice.clip(s.name, s.text)).then(c => {
        if (!c || !c.id || game !== mine) return;
        clips.set(e.id, {id: c.id, ms: c.ms}); sendAll({type: 'clip', id: e.id, clip: {id: c.id, ms: c.ms}});
      }).catch(() => {});
    }
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

  // ms until this seat may be woken for the nomination decision (#69); 0 when it may be now (or there is no stagger).
  function staggerLeft(key) {
    if (!stagger || key === ST || !nominating()) return 0;
    if (!stag) stag = newStag();
    const ahead = stag.order.slice(0, stag.order.indexOf(key)).filter(k => mustAct(k)).length; // seats before this one still to decide
    return ahead ? Math.max(0, stag.at + ahead * stagger - now()) : 0;
  }

  async function pace(id, args = {}) {
    const key = keyOf(id);
    if (args.brief) {
      seen[key] = Math.max(seen[key] ?? -1, latest(key));
      try {return {ok: true, brief: key === ST ? storytellerHeader(game) : playerHeader(game, key)}}
      catch (e) {return {ok: false, error: String(e.message || e)}}
    }
    const soft = !args.wake || args.wake === 'all';
    const check = () => {
      if (game.winner) return {ok: false, gone: true, error: `The game is over: ${game.winner.text}.`};
      if (staggerLeft(key) > 0) return null; // nominations: not this seat's moment yet
      if (mustAct(key)) {if (key === ST && !api.pendingFor(game, ST)) stDueSaid = stDueNew(); return {ok: true, wake: 'now', why: key === ST ? stWhy() : api.legalNow(game, key), clock: clockText()}}
      // soft only for a seat that can act on what it has not seen (#29): one that had its turn this round waits for the next;
      // a seat never shown the game yet (a new runner) gets its first turn to read its role
      if (unseen(key) && soft && (seen[key] === undefined || (key === ST ? stFresh() : api.canAct(game, key)))) return {ok: true, wake: 'soft', why: 'something happened at the table', clock: clockText()};
      return null;
    };
    const mark = r => {if (r.ok) seen[key] = Math.max(seen[key] ?? -1, latest(key)); return r};
    // a soft wake waits while the page is still listening (never a decision, never the end of the game)
    const hold = async r => {
      if (!r.ok || r.wake === 'now' || r.gone || game.winner || (r.wake !== 'soft' && r.wake !== 'heartbeat')) {if (r.wake === 'now') delete holdSince[key]; return mark(r)}
      const h = holding(key);
      if (!h) {delete holdSince[key]; return mark(r)}
      await new Promise(res => {const w = () => {clearTimeout(t); heardWaiters.delete(w); res()}, t = setTimeout(w, h); heardWaiters.add(w)});
      if (!holding(key)) {delete holdSince[key]; return mark(r)} // the page caught up while we waited (or the cap ran out)
      return {ok: true, wake: null, holdMs: h, why: 'the table is still listening to the voices', clock: clockText()};
    };
    let r = check();
    if (r) return hold(r);
    const ms = Math.min(PACE_MAX_MS, Math.max(0, Number(args.realMs) || 0));
    r = await new Promise(res => {
      const w = () => {const x = check(); if (x) {clearTimeout(t); waiters.delete(w); res(x)}};
      const t = setTimeout(() => {waiters.delete(w); res(check())}, ms); // the last look: a staggered nomination may be due by now
      waiters.add(w);
      const due = staggerLeft(key); // a seat waiting its nomination moment is looked at again when it comes
      if (due > 0 && due < ms) {const t2 = setTimeout(w, due + 1); if (t2.unref) t2.unref()}
    });
    if (r) return hold(r);
    if (staggerLeft(key) > 0) return {ok: true, wake: null, why: 'nominations go round in seat order: your moment comes', clock: clockText()};
    const quiet = key === ST ? 'a quiet beat' : `a quiet beat${(t => t ? ': nothing to do ' + t : '')(api.nextTurnText(game, key))}`;
    return soft ? hold({ok: true, wake: 'heartbeat', why: quiet, clock: clockText()}) : {ok: true, wake: null, why: 'nothing new', clock: clockText()};
  }

  const sendAll = o => {const s = JSON.stringify(o); for (const ws of socks) if (ws.readyState === 1) ws.send(s)};
  arm();
  return {
    get game() {return game},
    get gameId() {return gameId},
    info: () => ({connected: true, gameId, phase: clockText(), players: game.seats.map(s => ({id: s.index + 1, name: s.name, alive: s.alive})), storyteller: true}),
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
    // The relay's voice hook ({clip(name, text) -> Promise<{id, ms}>}) and the page's mark of the newest line it finished playing.
    setVoice(v) {voice = v || null},
    heard({last, voice: on} = {}) {
      const n = Number(last); if (!Number.isFinite(n)) return null;
      heard = {last: Math.floor(n), at: now(), voice: on === true};
      for (const w of [...heardWaiters]) {heardWaiters.delete(w); w()}
      return {...heard};
    },
    heardMark: () => heard ? {...heard} : null,
    // A fresh seeded game in place of this one (POST /play/game/new, after the supervisor's stop-all): same seats, so the relay's
    // claims and links stay. -> {gameId, seed, rounds}
    newGame(nextSeed = game.config.seed, nextRounds = game.config.rounds) {
      if (timer) clearTimeout(timer); timer = null;
      game = newGame({seed: nextSeed, ...(seats ? {seats} : {}), ...(nextRounds != null ? {rounds: nextRounds} : {})});
      answerer = scripted ? createScripted(nextSeed) : null;
      for (const k of Object.keys(seen)) delete seen[k];
      clips.clear(); asked.clear(); heard = null; for (const k of Object.keys(holdSince)) delete holdSince[k];
      pendingId = null; pushed = -1; emitted = -1; lastBallot = 'null'; stag = null; stDueSaid = null; gameId = dealId(nextSeed); changed();
      log(`[game] a new game: seed ${nextSeed}, game ${gameId}`);
      return {gameId, seed: game.config.seed, rounds: game.config.rounds};
    },
    close() {closed = true; if (timer) clearTimeout(timer); timer = null; if (pushT) clearTimeout(pushT); pushT = null; for (const w of [...waiters]) waiters.delete(w)},
  };
}
