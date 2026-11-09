// The seat bridge. Adds to an http.Server (the relay) everything AI agents need to play the seats, several at once, one
// runner per seat: seven player seats and the Storyteller's.
//
//   POST /mcp            MCP over streamable HTTP (stateless, JSON responses): the tools of src/data/player-tools.js for a
//                        player seat, or of src/data/storyteller-tools.js with X-Clocktower-Role: storyteller (or ?role=storyteller).
//                        ?lazy=1: tools/list marks the tools to keep in the prompt (scripts/lazy-tools.mjs).
//   WS   /play           the watcher's page (its origin only): seat links and runners as they change. It drives nothing.
//   POST /play/call      {tool, args, player?, runner} -> result: a player tool without MCP
//   POST /play/storyteller {tool, args, runner} -> result: a Storyteller tool without MCP
//   POST /play/narrate   {text, player?, runner}: the runner's narration, for the watcher only
//   POST /play/pace      {player, runner, realMs?, brief?}: runner pacing (scripts/pacing.mjs): answers when the seat's next turn
//                        should start ({wake: 'now'|'soft'|'heartbeat'}) or after realMs with wake null; not a tool, does not
//                        count as activity for the link state; {brief: true} answers at once with the seat's state header;
//                        {role: 'storyteller', runner, ...} is the Storyteller runner's own pace and header (never a player's)
//   POST /play/claim     {player, runner, provider?, model?} (or {role: 'storyteller', runner, ...}): a runner binds itself to one
//                        seat and refreshes the claim every few seconds; 409 when another live runner holds it
//   POST /play/release   {player | role: 'storyteller', runner}: the runner lets go (on exit)
//   POST /play/ready     {player | role: 'storyteller', runner, state: 'warming'|'ready'|'failed', model?, ms?, error?}: the seat's
//                        warm-up model call (the start gate); only the claiming runner
//   POST /play/behavior/turn {player | role: 'storyteller', runner, rec}: a runner's turn line for the behavior logs
//                        (scripts/behavior-log.mjs); only from the runner that holds the seat. 404 when the host keeps none.
//   GET  /play/health    {ok, connected, gameId (a game backend: one id per dealt game, #66), phase, players: [{id, name, alive, link, claimed, runner?, ready}], storyteller: {...}, calls}; local tools and
//                        the page's origin (CORS)
//   POST /play/heard     {last, voice} (the page's origin only): the newest event id the page finished playing and whether its voice
//                        is on; while it lags more than one spoken line, backend.pace holds soft wakes ({wake: null, holdMs}, capped)
//   GET  /play/watch?since=N the watcher's whole view (the page's origin only): backend.watch(since), src/game/backend.js
//   POST /play/game/new  {seed?, rounds?} (the page's origin only): the backend's game replaced by a fresh seeded one; claims stay
//
// Which seat: a player call names its seat by id, as the X-Clocktower-Player header, a ?player= query, or a `player` field in a
// /play/* body. The runner: X-Clocktower-Runner, ?runner= or `runner` in the body.
// Seats stay apart: a claimed seat answers only the runner that claimed it (anyone else gets 409); the Storyteller seat answers
// only its runner; a player (or a runner holding one) has no Storyteller tools and the Storyteller has no player tools; one
// runner never holds a player seat and the Storyteller seat. /play/narrate reaches the watcher only. No route carries text from
// one seat to another: seats reach each other through the game alone.
// Safety: the server listens on 127.0.0.1 only. Requests must carry a localhost Host header (DNS rebinding). /mcp and /play/*
// refuse any request with an Origin header (a web page cannot drive a seat), except the watcher's reads the page makes (/play/watch,
// /play/game/new, /play/health: its origin only); the WebSocket accepts only the page's origin.
// Verbose (RELAY_VERBOSE=1 or --verbose) appends each tool call to logs/play.jsonl.
//
// A backend is {info() -> {connected, phase, players: [{id, name, alive}], storyteller}, call(playerId, tool, args),
// storytellerCall(tool, args), narrate(playerId, text), links?(map, runners, storyteller, ready), attach?(ws)}.
// Until the engine exists (slice 2 of issue #1) the relay serves stubBackend(): the seats of seatList() and the stub tool handlers.
import {mkdirSync, appendFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {PLAYER_TOOLS, ATTEMPT_INVITE} from '../src/data/player-tools.js';
import {STORYTELLER_TOOLS} from '../src/data/storyteller-tools.js';
import {lazyMeta} from './lazy-tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLAY_LOG = join(ROOT, 'logs', 'play.jsonl');
export const MAX_BODY = 16 * 1024, PACE_MAX_MS = 30000;
export const CLAIM_MS = 45000, LINK_MS = 20000; // a runner claim lives this long unrefreshed; a call keeps the link 'connected' this long
export const PLAYER_HEADER = 'x-clocktower-player', ROLE_HEADER = 'x-clocktower-role', RUNNER_HEADER = 'x-clocktower-runner';
export const STORYTELLER_KEY = 'storyteller'; // the Storyteller seat's key in the claim and link maps
export const STORYTELLER_INSTRUCTIONS = 'You are the Storyteller of a Clocktower game. Read the game with your tools; you reach the players only through the game.';
export const INSTRUCTIONS = 'You play one seat in a Clocktower game. Look before you act; you reach the others only through the game.';
const paused = why => ({ok: false, error: 'The game is not answering; wait and try again (your runner picks up when it is back).', offline: true, why});

// The seats: seven players named in docs/ROLES.md and the Storyteller. The one function a game replaces with the engine's list.
export const SEAT_NAMES = ['Odette', 'Bram', 'Ines', 'Corwin', 'Thea', 'Fitch', 'Yusuf'];
export const seatList = () => SEAT_NAMES.map((name, i) => ({id: i + 1, name, alive: true}));

// A runner id from a header, query or body value, or null.
export const runnerParam = v => typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
// The runner's mind as a claim reports it: {provider, model} with safe names, or null.
export const runnerInfo = b => {const p = typeof b.provider === 'string' && /^[a-z][a-z0-9_-]{0,19}$/.test(b.provider) ? b.provider : null;
  const m = typeof b.model === 'string' && /^[A-Za-z0-9][\w.:\/+-]{0,99}$/.test(b.model) ? b.model : null;
  return p ? {provider: p, model: m} : null};
const localHost = h => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ''));
// A player seat id from a header, query or body value: a positive integer, null when absent, NaN when bad.
export const playerParam = v => v == null || v === '' ? null : /^\d{1,9}$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;

// ---- the backend while no game is behind the relay: the seat list and the tool tables' stub handlers ----
// seats: () => [{id, name, alive}]; the watcher's page sockets get the links.
export function stubBackend({seats = seatList, players = PLAYER_TOOLS, storyteller = STORYTELLER_TOOLS, log = () => {}} = {}) {
  const socks = new Set();
  const answer = (list, tool, args, ctx) => {const t = list.find(x => x.name === tool);
    if (!t) return {ok: false, error: `No tool ${tool}. ${ATTEMPT_INVITE}`};
    if (!t.handler) return paused('no game yet');
    try {return t.handler(args || {}, ctx)} catch (e) {return {ok: false, error: String(e.message || e)}}};
  const sendAll = o => {const s = JSON.stringify(o); for (const ws of socks) if (ws.readyState === 1) ws.send(s)};
  return {
    info: () => ({connected: true, phase: 'no game yet', players: seats(), storyteller: true}),
    async call(id, tool, args) {
      const seat = seats().find(s => s.id === id); if (!seat) return {ok: false, error: `Seat #${id} is not at the table.`};
      if (tool === 'pace') { // no game: nothing happens to wake a seat early; a heartbeat when the wait asked ends (capped)
        if (args && args.brief) return {ok: true, brief: {phase: 'no game yet', seat: seat.name}};
        await new Promise(r => setTimeout(r, Math.min(PACE_MAX_MS, Math.max(0, Number(args && args.realMs) || 0))));
        return args && args.wake === 'all' ? {ok: true, wake: 'heartbeat', why: 'no game yet: a quiet beat'} : {ok: true, wake: null, why: 'no game yet'};
      }
      return answer(players, tool, args, {seat});
    },
    storytellerCall: async (tool, args) => answer(storyteller, tool, args, {seat: {id: STORYTELLER_KEY, name: 'Storyteller'}}),
    narrate(id, text) {sendAll({type: 'narrate', player: id, text: String(text).slice(0, 600)})},
    links(map, runners = {}, st = null, ready = {}) {sendAll({type: 'links', links: map, runners, ready, ...(st ? {storyteller: st} : {})})},
    attach(ws) {socks.add(ws); log('[play] watcher page connected'); ws.on('close', () => {socks.delete(ws); log('[play] watcher page disconnected')}); ws.on('message', () => {})},
  };
}

// ---- MCP: one stateless server per request ----
const zArg = a => a.type === 'object' ? z.record(z.string(), z.any()) : a.type === 'array' ? z.union([z.array(z.string()), z.string()]) : a.enum ? z.enum(a.enum) : a.type === 'integer' ? z.number().int() : a.type === 'number' ? z.number() : z.string();
function zodFor(spec) {
  const shape = {};
  for (const [k, a] of Object.entries(spec.args || {})) {let s = zArg(a).describe(a.desc || k); if (a.optional) s = s.optional(); shape[k] = s}
  return shape;
}
function buildServer(name, instructions, list, call, lazy) {
  const server = new McpServer({name, version: '1.0.0'}, {instructions});
  for (const t of list) {
    const meta = lazy ? lazyMeta(t.name) : undefined;
    server.registerTool(t.name, {description: t.desc, inputSchema: zodFor(t), annotations: {readOnlyHint: !t.act, destructiveHint: false, openWorldHint: false}, ...(meta ? {_meta: meta} : {})},
      async args => {const r = await call(t.name, args || {}); return {content: [{type: 'text', text: JSON.stringify(r)}], isError: !!(r && r.offline)}});
  }
  return server;
}
export const buildMcp = (call, {lazy = false} = {}) => buildServer('clocktower-player', INSTRUCTIONS, PLAYER_TOOLS, call, lazy);
export const buildStorytellerMcp = (call, {lazy = false} = {}) => buildServer('clocktower-storyteller', STORYTELLER_INSTRUCTIONS, STORYTELLER_TOOLS, call, lazy);

const readBody = req => new Promise((res, rej) => {
  let size = 0; const chunks = [];
  req.on('data', c => {size += c.length; if (size > MAX_BODY) {rej(new Error('too large')); req.destroy()} else chunks.push(c)});
  req.on('end', () => {try {res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)} catch {rej(new Error('bad json'))}});
  req.on('error', rej);
});

// attachPlay(server, {backend?, origin, log, verbose, now, behavior?}) -> {backend, stats, call, storytellerCall, linkOf, links, runnerOf,
//   readyOf, claimed, holderOf, dropRunner, storytellerInfo, behavior}
// behavior: a scripts/behavior-log.mjs writer; without it the host keeps no behavior logs.
export function attachPlay(server, {backend = null, origin = 'http://localhost:5173', log = console.log, verbose = null, now = () => Date.now(), behavior = null} = {}) {
  const be = backend || stubBackend({log});
  const stats = {calls: 0, errors: 0};
  const claims = new Map(), act = new Map(), readies = new Map(); // seat key -> {runner, at, info} / {last, inflight} / {runner, state, ...}
  const vlog = rec => {if (!verbose) return; try {mkdirSync(dirname(verbose), {recursive: true}); appendFileSync(verbose, JSON.stringify(be.gameId ? {...rec, gameId: be.gameId} : rec) + '\n')} catch (e) {log(`[play] verbose log failed: ${e.message}`)}};
  const players = () => (be.info().players || []);
  const claimOf = id => {const c = claims.get(id); return c && now() - c.at < CLAIM_MS ? c : null};
  const linkOf = id => {const a = act.get(id), busy = a && (a.inflight > 0 || now() - a.last < LINK_MS); return busy ? 'connected' : claimOf(id) ? 'waiting' : 'none'};
  const links = () => Object.fromEntries(players().map(h => [h.id, linkOf(h.id)]));
  const runnerOf = id => {const c = claimOf(id); return c && c.info ? c.info : null};
  const runners = () => Object.fromEntries(players().map(h => [h.id, runnerOf(h.id)]).filter(e => e[1]));
  const readyOf = id => {const c = claimOf(id), r = readies.get(id); if (!c || !r || r.runner !== c.runner) return null; const {runner, ...o} = r; return o};
  const readyMap = () => Object.fromEntries(players().map(h => [h.id, readyOf(h.id)]).filter(e => e[1]));
  const storytellerInfo = () => {const r = runnerOf(STORYTELLER_KEY), rd = readyOf(STORYTELLER_KEY); return {seat: !!be.info().storyteller, link: linkOf(STORYTELLER_KEY), claimed: !!claimOf(STORYTELLER_KEY), ...(r ? {runner: r} : {}), ...(rd ? {ready: rd} : {})}};
  let lastLinks = '';
  const pushLinks = () => {if (!be.links) return; const m = [links(), runners(), storytellerInfo(), readyMap()], k = JSON.stringify(m); if (k === lastLinks) return; lastLinks = k; be.links(...m)};
  const heldBy = (id, rid) => {const c = id != null ? claimOf(id) : null; return c && c.runner !== rid ? c.runner : null};
  const refusedSeat = (id, holder) => ({ok: false, refused: true, error: `Seat #${id} is played by another runner (${holder}). A runner plays only the seat it claimed: name it (X-Clocktower-Runner, or runner in the body).`});
  const holdsPlayer = r => r != null && [...claims.entries()].some(([k, c]) => k !== STORYTELLER_KEY && c.runner === r && now() - c.at < CLAIM_MS);
  const holdsStoryteller = r => r != null && !!claimOf(STORYTELLER_KEY) && claimOf(STORYTELLER_KEY).runner === r;

  // Every tool call goes through here: routed to one seat, counted, logged, never thrown. A claimed seat answers only its runner.
  async function call(player, tool, args, rid = null) {
    const t0 = now(), id = player; stats.calls++;
    const holder = heldBy(id, rid); if (holder) {stats.errors++; log(`[play] #${id} ${tool} refused: held by ${holder}, asked by ${rid || 'no runner'}`); return refusedSeat(id, holder)}
    const a = id != null ? act.get(id) || {last: 0, inflight: 0} : null; if (a) {a.inflight++; a.last = t0; act.set(id, a); pushLinks()}
    if (behavior && id != null) behavior.call('player:' + id);
    let r;
    try {r = id == null ? {ok: false, error: 'Name your seat (X-Clocktower-Player, ?player= or player in the body).'} : await be.call(id, tool, args)} catch (e) {r = {ok: false, error: String(e.message || e)}}
    if (a) {a.inflight--; a.last = now(); pushLinks()}
    if (!r || typeof r !== 'object') r = {ok: false, error: 'no answer'};
    if (r.ok === false) stats.errors++;
    log(`[play] #${id ?? '?'} ${tool}${args && Object.keys(args).length ? ' ' + JSON.stringify(args).slice(0, 200) : ''} -> ${r.ok === false ? 'x ' + String(r.error).slice(0, 80) : 'ok'} (${now() - t0} ms)`);
    vlog({ts: new Date().toISOString(), player: id, tool, args, result: r, ms: now() - t0});
    return r;
  }
  async function storytellerCall(tool, args) {
    const t0 = now(); stats.calls++;
    const a = act.get(STORYTELLER_KEY) || {last: 0, inflight: 0}; a.inflight++; a.last = t0; act.set(STORYTELLER_KEY, a); pushLinks();
    if (behavior) behavior.call('storyteller');
    let r; try {r = await be.storytellerCall(tool, args)} catch (e) {r = {ok: false, error: String(e.message || e)}}
    a.inflight--; a.last = now(); pushLinks();
    if (!r || typeof r !== 'object') r = {ok: false, error: 'no answer'};
    if (r.ok === false) stats.errors++;
    log(`[play] Storyteller ${tool}${args && Object.keys(args).length ? ' ' + JSON.stringify(args).slice(0, 200) : ''} -> ${r.ok === false ? 'x ' + String(r.error).slice(0, 80) : 'ok'} (${now() - t0} ms)`);
    vlog({ts: new Date().toISOString(), role: 'storyteller', tool, args, result: r, ms: now() - t0});
    return r;
  }
  // A runner's turn line: only the runner holding the seat may write it. A turn line also proves the seat's model answers: a claimed
  // seat with no warm-up record counts as ready once its runner has played a turn.
  const turnHooks = new Set(); // onTurn(f): f(seat key, turn record, runner id) for every accepted turn line
  const turnPlayed = (key, rid) => {const r = readies.get(key); if (r && r.runner === rid && r.state !== 'failed') return; readies.set(key, {runner: rid, state: 'ready', implied: true, at: now()}); pushLinks()};
  function behaviorTurn(b, player, rid, st) {
    const rec = b.rec && typeof b.rec === 'object' ? b.rec : null; if (!rec) return [400, {ok: false, error: 'turn needs {rec}'}];
    const key = st ? STORYTELLER_KEY : player;
    if (!st && (player == null || Number.isNaN(player))) return [400, {ok: false, error: 'turn needs the player seat id'}];
    const c = claimOf(key); if (!c || c.runner !== rid) return [409, {ok: false, refused: true, error: 'Only the runner holding this seat writes its turns.'}];
    turnPlayed(key, rid); for (const f of turnHooks) {try {f(key, rec, rid)} catch {}} // the supervisor's last turn (scripts/runners.mjs)
    if (!behavior) return [404, {ok: false, error: 'this host keeps no behavior logs'}];
    const h = st ? null : players().find(x => x.id === player) || {id: player, name: null};
    behavior.turn({...rec, seat: st ? 'storyteller' : 'player:' + player, player: h ? {id: h.id, name: h.name} : null, runner: rid, provider: (c.info && c.info.provider) || rec.provider, model: (c.info && c.info.model) || rec.model});
    return [200, {ok: true}];
  }
  // Link states change with time alone (claims and calls age out); refresh the page now and then.
  const tick = setInterval(pushLinks, 2000); if (tick.unref) tick.unref();
  server.on('close', () => clearInterval(tick));

  const wss = be.attach ? new WebSocketServer({noServer: true, maxPayload: 64 * 1024}) : null;
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/play' || !wss || !localHost(req.headers.host) || req.headers.origin !== origin) {socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return}
    wss.handleUpgrade(req, socket, head, ws => {be.attach(ws); lastLinks = ''; pushLinks()});
  });

  // Our routes in front of whatever the server already handles (the runner routes have their own guard, scripts/runners.mjs).
  const prior = server.listeners('request'); server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const [path, qs] = (req.url || '').split('?');
    if (!(path === '/mcp' || path.startsWith('/play/')) || path === '/play/runner' || path.startsWith('/play/runner/')) {for (const f of prior) f.call(server, req, res); return}
    // The watcher's routes (/play/watch, /play/game/new) answer the page's origin only; /play/health answers local tools and the page.
    // Every other route refuses any Origin: a web page never drives a seat.
    const o = req.headers.origin, page = !!o && o === origin, watcher = path === '/play/watch' || path === '/play/game/new' || path === '/play/heard';
    const cors = page ? {'access-control-allow-origin': origin, vary: 'origin'} : {};
    const send = (code, obj) => {res.writeHead(code, {'content-type': 'application/json', ...cors}); res.end(JSON.stringify(obj))};
    if (!localHost(req.headers.host)) return send(403, {error: 'host not allowed'});
    if (watcher || path === '/play/health') {
      if (o && !page) return send(403, {error: 'origin not allowed'});
      if (req.method === 'OPTIONS') {res.writeHead(204, page ? {...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600'} : {}); return res.end()}
      if (watcher && !page) return send(403, {error: "the watcher's view is the page's alone (its origin only)"});
    } else if (o) return send(403, {error: 'browser origins may not drive a seat'});
    const q = new URLSearchParams(qs || ''), role = String(req.headers[ROLE_HEADER] || q.get('role') || '').trim().toLowerCase();
    let rid = runnerParam(req.headers[RUNNER_HEADER] || q.get('runner'));
    if (role && role !== 'storyteller' && role !== 'player') return send(400, {error: 'unknown role (storyteller or player)'});
    let player = role === 'storyteller' ? null : playerParam(req.headers[PLAYER_HEADER]); if (player === null && role !== 'storyteller') player = playerParam(q.get('player'));
    if (Number.isNaN(player)) return send(400, {error: 'bad seat id (use the number, e.g. X-Clocktower-Player: 3)'});
    try {
      if (path === '/play/watch') {
        if (req.method !== 'GET') return send(405, {error: 'GET only'});
        if (!be.watch) return send(404, {error: 'this relay serves no game (start it with --game)'});
        const s = q.get('since'), since = s == null || s === '' || !Number.isFinite(Number(s)) ? -1 : Math.floor(Number(s));
        return send(200, be.watch(since))}
      if (path === '/play/heard') { // the page's ear: the newest event id it finished playing, and whether its voice is on
        if (req.method !== 'POST') return send(405, {error: 'POST only'});
        if (!be.heard) return send(404, {error: 'this relay serves no game (start it with --game)'});
        const b = await readBody(req) || {}, last = Number(b.last);
        if (!Number.isFinite(last)) return send(400, {ok: false, error: 'last is the newest event id the page has finished playing'});
        const h = be.heard({last, voice: b.voice === true}); return send(200, {ok: true, heard: h})}
      if (path === '/play/game/new') {
        if (req.method !== 'POST') return send(405, {error: 'POST only'});
        if (!be.newGame) return send(404, {error: 'this relay serves no game (start it with --game)'});
        const b = await readBody(req) || {}, int = (v, lo, hi) => v == null || v === '' ? undefined : Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : NaN;
        const seed = int(b.seed, 1, 1e9), rounds = int(b.rounds, 0, 10);
        if (Number.isNaN(seed) || Number.isNaN(rounds)) return send(400, {ok: false, error: 'seed is a whole number from 1, rounds from 0 to 10'});
        const r = be.newGame(seed, rounds); lastLinks = ''; pushLinks();
        log(`[play] the page began a new game: seed ${r.seed}, ${r.rounds} rounds, game ${r.gameId} (seat claims kept; runners start fresh sessions)`);
        return send(200, {ok: true, ...r})}
      if (path === '/play/health' && req.method === 'GET') {const i = be.info();
        return send(200, {ok: true, connected: !!i.connected, ...(i.gameId ? {gameId: i.gameId} : {}), phase: i.phase || null, players: (i.players || []).map(h => {const r = runnerOf(h.id), rd = readyOf(h.id); return {...h, link: linkOf(h.id), claimed: !!claimOf(h.id), ...(r ? {runner: r} : {}), ready: rd ? rd.state : null}}), storyteller: storytellerInfo(), ...stats})}
      if (path === '/mcp') {
        if (req.method !== 'POST') return send(405, {jsonrpc: '2.0', error: {code: -32000, message: 'Method not allowed (stateless server: POST only).'}, id: null});
        const body = await readBody(req), lazy = q.get('lazy') === '1';
        let mcp;
        if (role === 'storyteller') {
          if (playerParam(req.headers[PLAYER_HEADER]) != null || playerParam(q.get('player')) != null || holdsPlayer(rid))
            return send(403, {jsonrpc: '2.0', error: {code: -32000, message: 'Players have no Storyteller tools: a player hears the Storyteller only in the game.'}, id: null});
          const sh = heldBy(STORYTELLER_KEY, rid); if (sh) return send(409, {jsonrpc: '2.0', error: {code: -32000, message: `The Storyteller seat is held by another runner (${sh}).`}, id: null});
          mcp = buildStorytellerMcp((tool, args) => storytellerCall(tool, args), {lazy});
        } else {
          if (holdsStoryteller(rid)) return send(403, {jsonrpc: '2.0', error: {code: -32000, message: 'The Storyteller has no player tools.'}, id: null});
          mcp = buildMcp((tool, args) => call(player, tool, args, rid), {lazy});
        }
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        res.on('close', () => {transport.close(); mcp.close()});
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== 'POST') return send(404, {error: 'not found'});
      const b = await readBody(req) || {};
      if (b.runner !== undefined) rid = runnerParam(b.runner);
      const stAsked = role === 'storyteller' || b.role === 'storyteller';
      if (path === '/play/ready') {
        const id = stAsked ? STORYTELLER_KEY : playerParam(b.player ?? player), runner = rid;
        if (id == null || Number.isNaN(id) || !runner) return send(400, {ok: false, error: 'ready needs {player|role:"storyteller", runner, state}'});
        const c = claimOf(id); if (!c || c.runner !== runner) return send(409, {ok: false, refused: true, error: 'Only the runner holding this seat reports it ready.'});
        const state = ['warming', 'ready', 'failed'].includes(b.state) ? b.state : 'ready', prev = readies.get(id);
        const rec = {runner, state, at: state === 'warming' || !prev || prev.runner !== runner ? now() : prev.at,
          ...(typeof b.model === 'string' && runnerInfo({provider: 'x', model: b.model}).model ? {model: b.model} : {}), ...(Number.isFinite(Number(b.ms)) && b.ms != null ? {ms: Math.max(0, Math.round(Number(b.ms)))} : {}),
          ...(state === 'failed' && b.error ? {error: String(b.error).replace(/sk-[\w-]{8,}/g, '[key]').slice(0, 200)} : {})};
        readies.set(id, rec);
        if (state !== 'warming') log(`[play] ${id === STORYTELLER_KEY ? 'Storyteller seat' : 'seat #' + id} ${state === 'ready' ? 'ready' : 'warm-up failed'}${rec.model ? ' (' + rec.model + ')' : ''}${rec.error ? ': ' + rec.error : ''}`);
        pushLinks(); return send(200, {ok: true, ready: readyOf(id)})}
      if (path === '/play/behavior/turn') return send(...behaviorTurn(b, b.player !== undefined ? playerParam(b.player) : player, rid, stAsked));
      if (path === '/play/storyteller') {
        if (typeof b.tool !== 'string' || !STORYTELLER_TOOLS.some(t => t.name === b.tool)) return send(400, {error: 'unknown Storyteller tool'});
        if (role === 'player' || b.role === 'player' || player != null || b.player != null || holdsPlayer(rid)) return send(403, {ok: false, error: 'Players have no Storyteller tools: a player hears the Storyteller only in the game.'});
        const sh = heldBy(STORYTELLER_KEY, rid); if (sh) return send(409, {ok: false, refused: true, error: `The Storyteller seat is held by another runner (${sh}).`});
        return send(200, await storytellerCall(b.tool, b.args && typeof b.args === 'object' ? b.args : {}))}
      // The Storyteller's own pacing and header: its runner's long poll ({role: 'storyteller'}), never a player's seat.
      if (path === '/play/pace' && stAsked) {
        if (b.role === 'player' || player != null || b.player != null || holdsPlayer(rid)) return send(403, {ok: false, error: 'Players have no Storyteller pace: a player hears the Storyteller only in the game.'});
        const sh = heldBy(STORYTELLER_KEY, rid); if (sh) return send(409, {ok: false, refused: true, error: `The Storyteller seat is held by another runner (${sh}).`});
        const a = b.args && typeof b.args === 'object' ? b.args : b, args = a.brief ? {brief: true} : {realMs: Math.min(PACE_MAX_MS, Math.max(0, Number(a.realMs) || 10000)), wake: a.wake === 'now' || a.wake === 'must' ? a.wake : 'all'};
        let r;
        if (be.pace) {try {r = await be.pace(STORYTELLER_KEY, args)} catch (e) {r = {ok: false, error: String(e.message || e)}}}
        else if (args.brief) r = {ok: true, brief: {phase: 'no game yet', seat: 'Storyteller'}};
        else {await new Promise(res => setTimeout(res, args.realMs)); r = args.wake === 'all' ? {ok: true, wake: 'heartbeat', why: 'no game yet: a quiet beat'} : {ok: true, wake: null, why: 'no game yet'}}
        return send(200, withPace(r, args, STORYTELLER_KEY))}
      if ((path === '/play/call' || path === '/play/narrate' || path === '/play/pace') && (stAsked || holdsStoryteller(rid)))
        return send(403, {ok: false, error: 'The Storyteller seat has no player tools: it speaks to the players only in the game.'});
      if ((path === '/play/claim' || path === '/play/release') && stAsked) {
        const runner = rid;
        if (!runner) return send(400, {error: 'claim needs {role:"storyteller", runner}'});
        const held = claimOf(STORYTELLER_KEY);
        if (path === '/play/release') {if (held && held.runner === runner) {claims.delete(STORYTELLER_KEY); act.delete(STORYTELLER_KEY); log('[play] runner let go of the Storyteller seat'); pushLinks()} return send(200, {ok: true})}
        if (held && held.runner !== runner) return send(409, {ok: false, error: `The Storyteller seat already has a live runner (${held.runner}). One Storyteller at a time.`});
        if (holdsPlayer(runner)) return send(409, {ok: false, error: 'This runner plays a seat; the Storyteller needs a runner of its own (seats stay apart).'});
        if (!be.info().storyteller) return send(404, {ok: false, error: 'The Storyteller seat is closed.'});
        const info = runnerInfo(b) || (held && held.info) || null;
        if (!held) log(`[play] runner ${runner} took the Storyteller seat${info ? ' (' + info.provider + (info.model ? ' ' + info.model : '') + ')' : ''}`);
        claims.set(STORYTELLER_KEY, {runner, at: now(), info}); pushLinks();
        return send(200, {ok: true, storyteller: storytellerInfo(), ...(info ? {runner: info} : {})})}
      if (b.player !== undefined) {player = playerParam(b.player); if (Number.isNaN(player)) return send(400, {error: 'bad seat id'})}
      if (path === '/play/call') {
        if (typeof b.tool !== 'string' || !PLAYER_TOOLS.some(t => t.name === b.tool)) return send(400, {error: 'unknown tool. ' + ATTEMPT_INVITE});
        const r = await call(player, b.tool, b.args && typeof b.args === 'object' ? b.args : {}, rid);
        return send(r && r.refused ? 409 : 200, r)}
      // Runner pacing: the claimed runner's long poll between turns. Not a tool call: not counted, not logged, not 'connected'.
      if (path === '/play/pace') {
        if (player == null) return send(400, {ok: false, error: 'pace needs the seat id'});
        const holder = heldBy(player, rid); if (holder) return send(409, refusedSeat(player, holder));
        const a = b.args && typeof b.args === 'object' ? b.args : b, args = a.brief ? {brief: true} : {realMs: Math.min(PACE_MAX_MS, Math.max(0, Number(a.realMs) || 10000)), wake: a.wake === 'now' || a.wake === 'must' ? a.wake : 'all'};
        let r; try {r = await be.call(player, 'pace', args)} catch (e) {r = {ok: false, error: String(e.message || e)}}
        return send(200, withPace(r, args, player))}
      if (path === '/play/narrate') {
        const holder = heldBy(player, rid); if (holder) return send(409, refusedSeat(player, holder));
        if (player != null && typeof b.text === 'string' && b.text.trim()) {be.narrate(player, b.text.trim()); vlog({ts: new Date().toISOString(), player, narrate: b.text.slice(0, 600)})}
        return send(200, {ok: true})}
      if (path === '/play/claim' || path === '/play/release') {
        const runner = rid;
        if (player == null || !runner) return send(400, {error: 'claim needs {player, runner}'});
        const held = claimOf(player);
        if (path === '/play/release') {if (held && held.runner === runner) {claims.delete(player); act.delete(player); log(`[play] runner let go of #${player}`); pushLinks()} return send(200, {ok: true})}
        if (held && held.runner !== runner) return send(409, {ok: false, error: `Seat #${player} already has a live runner (${held.runner}). One runner per seat.`});
        if (holdsStoryteller(runner)) return send(409, {ok: false, error: 'This runner holds the Storyteller seat; a player seat needs a runner of its own (seats stay apart).'});
        const h = players().find(x => x.id === player);
        if (!h) return send(404, {ok: false, error: `Seat #${player} is not at the table.`});
        const info = runnerInfo(b) || (held && held.info) || null;
        if (!held) log(`[play] runner ${runner} took ${h.name} #${player}${info ? ' (' + info.provider + (info.model ? ' ' + info.model : '') + ')' : ''}`);
        claims.set(player, {runner, at: now(), info}); pushLinks();
        return send(200, {ok: true, player: h, link: linkOf(player), ...(info ? {runner: info} : {})})}
      send(404, {error: 'not found'});
    } catch (e) {if (!res.headersSent) send(400, {error: String(e.message || e)})}
  });
  // For the runner supervisor (scripts/runners.mjs): whether a live runner holds a seat, which runner, and dropping the claims of
  // a runner process that is gone (a stopped child cannot always release on its way out).
  const claimed = id => !!claimOf(id);
  const holderOf = id => {const c = claimOf(id); return c ? c.runner : null};
  // the supervisor's live pace change (scripts/runners.mjs) rides on the pace answer: {pace: {minGap?, heartbeat?}}
  let paceFor = null;
  // a pace answer carries the pace knob's overrides and the game id (#66: a runner that sees the id change starts a fresh session)
  const withPace = (r, args, seat) => {if (!r || typeof r !== 'object') return {ok: false, error: 'no answer'}; const p = !args.brief && paceFor ? paceFor(seat) : null, g = be.gameId;
    return {...r, ...(p ? {pace: p} : {}), ...(g && !args.brief ? {gameId: g} : {})}};
  const dropRunner = prefix => {let n = 0; for (const [id, c] of claims) if (c.runner === prefix || c.runner.startsWith(prefix + ':')) {claims.delete(id); act.delete(id); n++}
    if (n) {log(`[play] runner ${prefix} gone: ${n} claim(s) dropped`); pushLinks()} return n};
  return {backend: be, stats, call, storytellerCall, storytellerInfo, linkOf, links, runnerOf, readyOf, claimed, holderOf, dropRunner, behavior, onPace: f => {paceFor = f}, onTurn: f => {turnHooks.add(f); return () => turnHooks.delete(f)}};
}
