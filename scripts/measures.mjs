// The milestone's measures per game, from the logs (issue #98, slice 7): one column per game, the table the playtest-reviewer
// built by hand for games 1, 3 and 4 (#40, #72, #93). Pure functions over parsed lines; scripts/behavior-report.mjs reads the
// files and prints. Numbers only where the logs hold them; what needs judgement (the demon found by reasoning, a seat
// contradicting its own words, a leak) comes as the evidence a reviewer needs, never as a verdict.
//
// Games are told apart by the game id (#76) where a line carries it (the loggers write it on every line from #98 on); older
// lines are cut by the Storyteller runner's start events (each run of the supervisor is one dealt game), and the id of such a
// run is taken from the runner logs ("new session (game 31-...)") when one was written within a minute of its start.
// Sources: turns.jsonl (one line per agent turn), anomalies.jsonl, logs/runners/events.jsonl, and logs/play.jsonl (the relay's
// verbose tool log: what every seat asked and was answered; its read_talk results rebuild the talk).
export const ROLE_WORDS = /\b(Washerwoman|Librarian|Investigator|Chef|Empath|Fortune Teller|Undertaker|Monk|Ravenkeeper|Virgin|Slayer|Soldier|Mayor|Butler|Drunk|Recluse|Saint|Poisoner|Spy|Scarlet Woman|Baron|Imp)\b/i;
const TOWN_WORDS = /Thistlewick|Lamp Row|millpond|millwheel|\bmill\b|heron|\bTower\b|\brooks?\b|Wick and Candle|baker|\bfog\b|frost|gulls?|\blamps?\b|milk cart|landlord|\bpump\b|tower clock|\bbell\b/i;
const DODGE = /dodg|won'?t (say|name|answer|tell)|refus(ed|es|ing) to (name|say|answer|tell)|(never|hasn'?t|haven'?t|didn'?t|did not|still no|no) (answered|answer|named|said|say|name)|ignored (my|the|every) question|unanswered|evad|sidestep|still (hasn'?t|won'?t)/i;
const PRIVATE_TOOLS = new Set(['my_role', 'my_whispers', 'look', 'where', 'who_voted', 'what_is_asked']);
const REFUSALS = [ // [kind, test on "tool: error"]; the first that matches names the call
  ['after the game', /game is over/i], ['said that already', /said that already/i], ['had your turn', /had your turn/i],
  ['invite', /^invite:/], ['night: speak or pass', /only in the day/i], ['nomination race', /^(nominate|vote|who_voted):/],
];
export const refusalKind = (tool, error) => {const s = `${tool}: ${error || ''}`; for (const [k, re] of REFUSALS) if (re.test(s)) return k; return 'other'};

import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {STORYTELLER_TOOLS} from '../src/data/storyteller-tools.js';
const ACT = new Set(STORYTELLER_TOOLS.filter(x => x.act).map(x => x.name)); // the tools that spend a turn: a turn with none of them only looked
const t = s => Date.parse(s);
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const mean = xs => xs.length ? sum(xs) / xs.length : null;
const r4 = v => v == null ? null : Math.round(v * 1e4) / 1e4;
const clip = (s, n = 140) => {s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s};
const inc = (o, k, n = 1) => {o[k] = (o[k] || 0) + n};
const esc = s => JSON.stringify(s).slice(1, -1); // a text as it sits inside a JSON string

// ---- cutting the lines into games ----
// data: {turns, anomalies, play, events, ids}: parsed lines (any order); ids: [{id, at}] from the runner logs.
// Returns [{id, start, end, finished, turns, anomalies, play, events}] oldest first.
export function splitGames({turns = [], anomalies = [], play = [], events = [], ids = []}) {
  const cuts = events.filter(e => e.event === 'start' && e.key === 'storyteller').map(e => t(e.at)).filter(Number.isFinite).sort((a, b) => a - b);
  cuts.unshift(-Infinity); // lines before the first start (or all of them, with no events) are run 0
  const runOf = ts => {let i = 0; for (let k = 0; k < cuts.length; k++) if (ts >= cuts[k]) i = k; return i};
  const runs = cuts.map(() => ({turns: [], anomalies: [], play: [], events: [], ids: new Map()}));
  const put = (kind, line, ts) => {if (!Number.isFinite(ts)) return; const r = runs[runOf(ts)]; r[kind].push(line); if (line.gameId) r.ids.set(line.gameId, (r.ids.get(line.gameId) || 0) + 1)};
  turns.forEach(l => put('turns', l, t(l.ts))); anomalies.forEach(l => put('anomalies', l, t(l.ts))); play.forEach(l => put('play', l, t(l.ts))); events.forEach(l => put('events', l, t(l.at)));
  // a game is the lines of one id; a run's lines with no id take the run's own id (the one most of its lines carry, else the id the
  // runner logs name within 90 s of the run's start), else the run stands as a game of its own
  const games = new Map();
  runs.forEach((r, i) => {
    if (!r.turns.length) return;
    const first = Math.min(...[...r.turns, ...r.play].map(l => t(l.ts)).filter(Number.isFinite)), at = Number.isFinite(cuts[i]) ? cuts[i] : first;
    const near = ids.map(x => ({...x, d: Math.abs(x.at - at)})).filter(x => x.d < 90e3).sort((a, b) => a.d - b.d)[0];
    const own = [...r.ids].sort((a, b) => b[1] - a[1])[0], runId = own ? own[0] : near ? near.id : null, runKey = runId || 'run' + i;
    for (const kind of ['turns', 'anomalies', 'play', 'events']) for (const l of r[kind]) {
      const key = l.gameId || runKey; let g = games.get(key);
      if (!g) games.set(key, g = {id: /^run\d+$/.test(key) ? null : key, runStart: Number.isFinite(cuts[i]) ? new Date(cuts[i]).toISOString() : null, turns: [], anomalies: [], play: [], events: []});
      g[kind].push(l);
    }
  });
  const out = [];
  for (const g of games.values()) {
    if (!g.turns.length) continue;
    const all = [...g.turns, ...g.play, ...g.anomalies].map(l => t(l.ts)).filter(Number.isFinite);
    const stEnd = g.events.filter(e => e.event === 'end' && e.key === 'storyteller').pop();
    out.push({...g, start: new Date(Math.min(...all)).toISOString(), end: new Date(Math.max(...all)).toISOString(), endedBy: stEnd ? stEnd.why : null});
  }
  return out.sort((a, b) => t(a.start) - t(b.start));
}

// ---- the talk, rebuilt from what the seats read ----
export function transcript(play) {
  const m = new Map();
  for (const e of play) if (e.tool === 'read_talk' && e.result && Array.isArray(e.result.entries)) for (const x of e.result.entries) if (!m.has(x.id)) m.set(x.id, x);
  return [...m.values()].sort((a, b) => a.id - b.id);
}

// Who is where when a room line is said: rooms fill and empty by the move entries.
function roomParties(tx) {
  const at = new Map(); // room name -> Set
  const parties = new Map(); // entry id -> Set of names who could hear it
  for (const x of tx) {
    if (x.type === 'move') {for (const s of at.values()) for (const n of x.seats || []) s.delete(n); if (x.to && !/Square/i.test(x.to)) {const s = at.get(x.to) || new Set(); (x.seats || []).forEach(n => s.add(n)); at.set(x.to, s)}}
    else if (x.type === 'say' && x.in) parties.set(x.id, new Set([x.from, ...(at.get(x.in) || [])]));
    else if (x.type === 'whisper') parties.set(x.id, new Set([x.from, x.to]));
  }
  return parties;
}

// With no read_talk in the play log (a mind that never reads), the talk is rebuilt from the calls that went through: what was said,
// passed, whispered and nominated, the day taken from the seat's next header.
export function callsAsTalk(play, ids, turns) {
  const out = [], dayOf = (id, ts) => {const nx = turns.filter(x => x.player && x.player.id === id && t(x.ts) >= t(ts)).sort((a, b) => t(a.ts) - t(b.ts))[0], d = nx && /^Day (\d+)/m.exec(nx.brief && nx.brief.text || ''); return d ? Number(d[1]) : 0};
  for (const e of [...play].sort((a, b) => t(a.ts) - t(b.ts))) {
    if (e.player == null || !e.result || !e.result.ok) continue; const from = ids.get(e.player) || String(e.player), day = dayOf(e.player, e.ts), id = out.length + 1;
    if (e.tool === 'speak') {const room = /^in (the [A-Za-z]+)/.exec(e.result.heard || ''); out.push({id, type: 'say', day, from, text: e.args && e.args.text || '', ...(room ? {in: room[1]} : {})})}
    else if (e.tool === 'pass') out.push({id, type: 'pass', day, from});
    else if (e.tool === 'whisper') out.push({id, type: 'whisper', day, from, to: e.args && e.args.to, text: e.args && e.args.text || ''});
    else if (e.tool === 'nominate') out.push({id, type: 'nomination', day, by: from, target: e.args && e.args.target});
  }
  return out;
}

// seat names and roles from the headers ("You are Ines, the Monk (townsfolk, good), alive.")
export function deal(turns) {
  const roles = new Map(), ids = new Map(), demons = [];
  for (const x of turns) {
    if (!x.player || !x.brief || typeof x.brief.text !== 'string') continue;
    ids.set(x.player.id, x.player.name);
    const m = x.brief.text.match(/^You are (\w+), the ([A-Za-z ]+?) \((townsfolk|outsider|minion|demon)/);
    if (m && !roles.has(m[1])) roles.set(m[1], {role: m[2], team: m[3]});
    if (m && m[3] === 'demon' && !demons.includes(m[1])) demons.push(m[1]); // the Scarlet Woman's header changes when she takes the demon's place
  }
  return {roles, ids, demons};
}

const roleRe = role => new RegExp('\\b' + role.replace(/ /g, '\\s+') + '\\b', 'i');

// ---- one game's measures ----
export function measure(g) {
  const T = g.turns, PT = T.filter(x => x.seat !== 'storyteller'), ST = T.filter(x => x.seat === 'storyteller');
  const hasPlay = g.play.length > 0, tx = transcript(g.play), {roles, ids, demons} = deal(T);
  const times = [...T, ...g.play].map(x => t(x.ts)).filter(Number.isFinite);
  const m = {id: g.id, seed: g.id && /^\d+-/.test(g.id) ? Number(g.id.split('-')[0]) : null, start: g.start, end: g.end, endedBy: g.endedBy, hasPlay};
  // winner and how
  const winEntry = tx.find(x => x.type === 'win'), over = [];
  const scan = s => {const r = /The game is over:? (good|evil) wins?([^."]*)/i.exec(s || ''); if (r) over.push({team: r[1].toLowerCase(), how: r[2].trim()})};
  for (const e of g.play) if (e.result) scan(JSON.stringify(e.result)); for (const x of T) for (const c of x.tools || []) scan(c.error);
  const narrWin = [...T].reverse().map(x => /\b(good|evil)\s+(won|wins)\b/i.exec(x.narration || '')).find(Boolean);
  const lookWin = g.play.map(e => e.result && e.result.winner).filter(Boolean).pop();
  const team = winEntry ? winEntry.team : lookWin || (over[0] && over[0].team) || (narrWin && narrWin[1].toLowerCase()) || null;
  const lastPhase = [...PT].reverse().map(x => /^(Night|Day) (\d+)/m.exec(x.brief && x.brief.text || '')).find(Boolean);
  m.winner = team; m.winnerHow = winEntry ? winEntry.text : over[0] ? `${over[0].how}` : lastPhase ? `last header ${lastPhase[0].toLowerCase()}` : null;
  m.finished = !!team || /game is over|game over/.test(g.endedBy || '');
  // length and turns
  m.seconds = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : null;
  m.turns = {all: T.length, players: PT.length, storyteller: ST.length};
  // cost
  const bySeat = new Map();
  for (const x of T) {const k = x.seat === 'storyteller' ? 'Storyteller' : x.player ? x.player.name : x.seat; const s = bySeat.get(k) || {seat: k, id: x.player ? x.player.id : 0, turns: 0, cost: 0}; s.turns++; s.cost += Number.isFinite(x.cost) ? x.cost : 0; bySeat.set(k, s)}
  m.costBySeat = [...bySeat.values()].sort((a, b) => a.id - b.id).map(s => ({seat: s.seat, turns: s.turns, cost: r4(s.cost)}));
  m.cost = r4(sum(T.map(x => x.cost))); m.costPlayers = r4(sum(PT.map(x => x.cost))); m.costStoryteller = r4(sum(ST.map(x => x.cost)));
  const ends = g.events.filter(e => e.event === 'end' && Number.isFinite(e.cost)); // the supervisor's own count, the last end of each runner
  const lastEnd = new Map(); ends.forEach(e => lastEnd.set(e.key, e.cost)); m.costSupervisor = lastEnd.size ? r4(sum([...lastEnd.values()])) : null;
  m.costPerPlayerTurn = r4(PT.length ? sum(PT.map(x => x.cost)) / PT.length : null);
  m.ctxMean = Math.round(mean(PT.map(x => x.ctx).filter(Number.isFinite)) || 0) || null; m.ctxMax = Math.max(0, ...PT.map(x => x.ctx || 0)) || null;
  const first = new Map(); for (const x of [...T].sort((a, b) => t(a.ts) - t(b.ts))) if (!first.has(x.seat) && Number.isFinite(x.ctx)) first.set(x.seat, x.ctx);
  const fp = [...first].filter(([k]) => k !== 'storyteller').map(([, v]) => v);
  m.firstCtx = {min: fp.length ? Math.min(...fp) : null, max: fp.length ? Math.max(...fp) : null, storyteller: first.get('storyteller') ?? null};
  m.sessionRolls = T.filter(x => (x.flags || []).includes('session-rolled')).length;
  m.wakes = {}; T.forEach(x => inc(m.wakes, x.wake && x.wake.wake || '?'));
  // the deal
  m.deal = [...roles].map(([name, r]) => ({name, role: r.role, team: r.team}));
  // refused calls by kind
  m.refused = {total: 0, byKind: {}}; m.refusedList = [];
  for (const x of PT) for (const c of x.tools || []) if (!c.ok) {const k = refusalKind(c.name, c.error); m.refused.total++; inc(m.refused.byKind, k); m.refusedList.push({ts: x.ts, seat: x.player && x.player.name, tool: c.name, kind: k, error: clip(c.error, 100)})}
  m.refused.playerTurns = PT.length;
  // storyteller
  const decides = ST.flatMap(x => (x.tools || []).filter(c => c.name === 'decide')), narrs = g.play.filter(e => e.role === 'storyteller' && e.tool === 'narrate' && e.result && e.result.ok).map(e => e.args && e.args.text || '');
  const narrTools = ST.flatMap(x => (x.tools || []).filter(c => c.name === 'narrate' && c.ok)).length;
  m.storyteller = {turns: ST.length, noCall: ST.filter(x => !(x.calls > 0)).length, noAct: ST.filter(x => !(x.tools || []).some(c => ACT.has(c.name) && c.ok)).length, decides: decides.length, narrations: hasPlay ? narrs.length : narrTools, withTown: hasPlay ? narrs.filter(s => TOWN_WORDS.test(s)).length : null};
  // anomalies by kind
  m.anomalies = {}; g.anomalies.forEach(a => inc(m.anomalies, a.kind || '?', 1 + (a.heldBack || 0)));
  // the talk
  if (!tx.length && hasPlay) {tx.push(...callsAsTalk(g.play, ids, T)); m.talkFromCalls = true}
  if (!tx.length) return {...m, talk: null};
  const lines = tx.filter(x => x.type === 'say'), table = lines.filter(x => !x.in), rooms = lines.filter(x => x.in), passes = tx.filter(x => x.type === 'pass');
  const byDay = {}; const dayRow = d => byDay[d] || (byDay[d] = {lines: 0, passes: 0});
  for (const x of lines) dayRow(x.day).lines++;
  // a pass is counted from the calls that went through (the last one may never have been read by anyone); its day is the day of that seat's next header
  const passCalls = g.play.filter(e => e.tool === 'pass' && e.result && e.result.ok && e.player != null);
  // its day: the seat's n-th pass call is its n-th pass entry in the talk; one nobody read yet falls on the last day heard
  if (passCalls.length) for (const [id, name] of ids) {
    const calls = passCalls.filter(e => e.player === id).sort((a, b) => t(a.ts) - t(b.ts)), mine = passes.filter(x => x.from === name);
    calls.forEach((e, i) => dayRow(mine[i] ? mine[i].day : tx[tx.length - 1].day).passes++);
  } else for (const x of passes) dayRow(x.day).passes++;
  m.talk = {lines: lines.length, table: table.length, rooms: rooms.length, passes: passCalls.length || passes.length, byDay,
    whispers: tx.filter(x => x.type === 'whisper').length, moves: tx.filter(x => x.type === 'move').length,
    invites: hasPlay ? g.play.filter(e => e.tool === 'invite' && e.result && e.result.ok).length : null};
  // claims: a seat naming its own role outright, and a seat's claim changing (the claims tool lists more than one role for a player)
  const claim = [];
  for (const x of lines) {
    const me = roles.get(x.from); const re = /\b(?:I am|I'm|as the|my role is|I was) (?:the |a |an )?([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/g; let r;
    while ((r = re.exec(x.text))) {const w = r[1]; const known = [...roles.values()].find(v => v.role.toLowerCase() === w.toLowerCase()) || ROLE_WORDS.test(w) && {role: w};
      if (known) claim.push({id: x.id, day: x.day, by: x.from, role: known.role, true: me ? me.role.toLowerCase() === known.role.toLowerCase() : null, room: !!x.in, text: clip(x.text, 120)})}
  }
  const seen = new Set(), claims = claim.filter(c => {const k = c.by + c.role; if (seen.has(k)) return false; seen.add(k); return true});
  m.claims = {list: claims.map(({by, role, day, true: tr, room}) => ({by, role, day, true: tr, room})), true: claims.filter(c => c.true === true).length, lies: claims.filter(c => c.true === false).length};
  m.claimChanges = [];
  for (const e of g.play) if (e.tool === 'claims' && e.result && Array.isArray(e.result.claims)) for (const c of e.result.claims) if ((c.roles || []).length > 1 && !m.claimChanges.some(z => z.player === c.player && z.n >= c.roles.length)) m.claimChanges.push({ts: e.ts, player: c.player, n: c.roles.length, roles: c.roles.map(r => ({role: r.role, day: r.day, said: clip(r.said, 100)}))});
  // the demon: nominated, executed, and the lines before each nomination of it
  m.demon = null;
  if (demons.length) {
    const noms = tx.filter(x => x.type === 'nomination' && demons.includes(x.target)).map(n => {
      const vr = tx.find(x => x.type === 'vote-result' && x.id > n.id && x.target === n.target);
      return {id: n.id, day: n.day, by: n.by, target: n.target, yes: vr ? vr.yes.length : null, needed: vr ? vr.needed : null, before: tx.filter(x => x.type === 'say' && x.id < n.id && !x.in).slice(-3).map(x => clip(x.text.startsWith(x.from) ? x.text : x.from + ': ' + x.text, 160))};
    });
    m.demon = {names: demons, role: (roles.get(demons[0]) || {}).role || 'demon', nominated: noms.length, executed: tx.filter(x => x.type === 'execution' && demons.includes(x.who)).map(x => ({who: x.who, day: x.day})), nominations: noms};
  }
  // nominations whose stated reason is an unanswered question: the nominator's last public line before it
  m.dodgedNominations = [];
  for (const n of tx.filter(x => x.type === 'nomination')) {
    const line = [...tx].reverse().find(x => x.type === 'say' && x.id < n.id && x.from === n.by && x.day === n.day);
    if (line && DODGE.test(line.text)) m.dodgedNominations.push({day: n.day, by: n.by, target: n.target, line: clip(line.text, 160)});
  }
  m.nominations = tx.filter(x => x.type === 'nomination').length;
  // leaks: private words and rooms in a seat that was not a party to them, another seat's role in a private result
  m.leaks = hasPlay ? leaks(g, tx, roles) : null;
  return m;
}

function leaks(g, tx, roles) {
  const parties = roomParties(tx), secrets = tx.filter(x => (x.type === 'whisper' || (x.type === 'say' && x.in)) && x.text && x.text.length >= 12 && parties.has(x.id));
  const nameOf = new Map(); for (const x of g.turns) if (x.player) nameOf.set(x.seat, x.player.name);
  const found = {text: [], role: []}; let scanned = 0;
  const seatName = e => e.role === 'storyteller' ? 'Storyteller' : [...nameOf].find(([k]) => k === 'player:' + e.player)?.[1] || null;
  // what each player was handed to read (their own read_talk), and what the table said in public
  const read = new Map(); for (const e of g.play) if (e.tool === 'read_talk' && e.result && Array.isArray(e.result.entries) && e.player != null) {const s = read.get(e.player) || []; s.push(...e.result.entries.map(x => x.text || '')); read.set(e.player, s)}
  const pub = tx.filter(x => (x.type === 'say' && !x.in) || x.type === 'narration' || x.type === 'win').map(x => x.text || '').join('\n');
  const items = []; // {who, name, where, at, text}
  for (const e of g.play) {
    if (e.role !== 'storyteller' && e.player == null) continue; if (!e.result) continue;
    items.push({who: e.role === 'storyteller' ? 'storyteller' : e.player, name: seatName(e), where: e.tool, at: e.ts, text: JSON.stringify(e.result), tool: e.tool});
  }
  for (const x of g.turns) if (x.player && x.brief && typeof x.brief.text === 'string') {
    const keep = x.brief.text.split('\n').slice(1).filter(l => !/^Claims so far/.test(l)).join('\n');
    items.push({who: x.player.id, name: x.player.name, where: 'header', at: x.ts, text: keep, tool: 'header'});
  }
  for (const it of items) {
    scanned++;
    for (const s of secrets) {
      const p = parties.get(s.id); if (it.name && p.has(it.name)) continue; if (!it.name && it.who !== 'storyteller') continue;
      if (it.text.includes(esc(s.text)) || it.text.includes(s.text)) found.text.push({at: it.at, seat: it.name || it.who, where: it.where, said: clip(s.text, 80), by: s.from});
    }
    if (it.who === 'storyteller' || !(it.tool === 'header' || PRIVATE_TOOLS.has(it.tool))) continue;
    const own = roles.get(it.name); const mine = read.get(it.who) ? read.get(it.who).join('\n') : '';
    for (const [name, r] of roles) {
      if (name === it.name || (own && own.role === r.role)) continue;
      if (roleRe(r.role).test(it.text) && !roleRe(r.role).test(pub) && !roleRe(r.role).test(mine)) found.role.push({at: it.at, seat: it.name, where: it.where, role: r.role, of: name});
    }
  }
  return {scanned, textLeaks: found.text.length, roleHits: found.role.length, text: found.text.slice(0, 12), role: found.role.slice(0, 12)};
}

// ---- the table: one column per game ----
const min = s => s == null ? '-' : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
const usd = v => v == null ? '-' : '$' + (v >= 0.1 ? v.toFixed(3) : v.toFixed(4)).replace(/0+$/, m => m.length > 2 ? '00' : m);
const k = v => v == null ? '-' : (v / 1000).toFixed(1) + 'k';
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const list = o => Object.entries(o).filter(([, v]) => v).map(([a, b]) => `${a} ${b}`).join(', ') || 'none';
const NA = 'n.a. (no play log)';

export function columnHeader(m, label) {
  const stamp = m.id || m.start.slice(0, 16).replace('T', ' ') + 'Z';
  return label ? `${label} (${stamp})` : stamp;
}

export function rows(ms) {
  const R = [];
  const row = (name, f) => R.push([name, ...ms.map(m => {try {const v = f(m); return v == null ? '-' : v} catch (e) {return 'error: ' + e.message}})]);
  row('Seed', m => m.seed ?? '-');
  row('Deal', m => m.deal.length ? m.deal.map(d => `${d.name} ${d.role}`).join(', ') : '-');
  row('Winner', m => m.winner ? (m.winnerHow && m.winnerHow.toLowerCase().startsWith(m.winner) ? m.winnerHow : `${cap(m.winner)}: ${m.winnerHow || '-'}`) : m.finished ? 'ended, winner not in the logs' : 'not finished (' + (m.endedBy || 'no end event') + ')');
  row('Length / turns', m => `${min(m.seconds)} / ${m.turns.all} (${m.turns.players} player, ${m.turns.storyteller} Storyteller)`);
  row('Cost total', m => `${usd(m.cost)} (players ${usd(m.costPlayers)}, Storyteller ${usd(m.costStoryteller)}${m.costSupervisor != null ? '; supervisor ' + usd(m.costSupervisor) : ''})`);
  row('Cost per seat', m => m.costBySeat.map(s => `${s.seat} ${usd(s.cost)} (${s.turns})`).join('; '));
  row('Cost per player turn / mean ctx', m => `${usd(m.costPerPlayerTurn)} / ${k(m.ctxMean)}`);
  row('First-turn ctx per seat', m => `${k(m.firstCtx.min)} to ${k(m.firstCtx.max)} (Storyteller ${k(m.firstCtx.storyteller)})`);
  row('Session rolls', m => `${m.sessionRolls} (ctx peak ${k(m.ctxMax)})`);
  row('Leaks', m => m.leaks ? `${m.leaks.textLeaks + m.leaks.roleHits}${m.leaks.textLeaks + m.leaks.roleHits ? ` candidates (${m.leaks.textLeaks} private text, ${m.leaks.roleHits} role name)` : ''} (${m.leaks.scanned} headers and results searched)` : NA);
  row('Lines / passes', m => m.talk ? (m.talkFromCalls ? '(from the calls, nobody read the talk) ' : '') + `${m.talk.lines} lines (${m.talk.table} at the table, ${m.talk.rooms} in rooms) / ${m.talk.passes} passes; ${Object.entries(m.talk.byDay).map(([d, v]) => `day ${d} ${v.lines} and ${v.passes}`).join(', ')}` : NA);
  row('Refused calls', m => `${m.refused.total} of ${m.refused.playerTurns} player turns: ${list(m.refused.byKind)}`);
  row('Whispers / room moves', m => m.talk ? `${m.talk.whispers} / ${m.talk.moves} moves${m.talk.invites != null ? ', ' + m.talk.invites + ' successful invites' : ''}` : NA);
  row('Contradictions of own words', m => `not flagged by any runner (${m.anomalies.contradiction || 0} flagged); claim changes in the claims tool: ${m.claimChanges ? m.claimChanges.length : NA}`);
  row('True claims / lies', m => m.claims ? `${m.claims.true} true, ${m.claims.lies} differ from the seat's role (roles named outright: ${m.claims.list.map(c => `${c.by} ${c.role}${c.true === false ? ' (differs)' : ''}`).join(', ') || 'none'})` : NA);
  row('Demon found by reasoning', m => !m.demon ? NA : `${m.demon.role} ${m.demon.names.join(' then ')}: nominated ${m.demon.nominated}x${m.demon.nominations.map(n => ` (${n.target} day ${n.day} by ${n.by}, ${n.yes ?? '?'} of ${n.needed ?? '?'})`).join('')}, ${m.demon.executed.length ? 'executed: ' + m.demon.executed.map(e => e.who + ' day ' + e.day).join(', ') : 'never executed'}; evidence with --evidence`);
  row('Storyteller turns with no acting call', m => `${m.storyteller.noAct} of ${m.storyteller.turns} (${m.storyteller.noCall} with no call at all)`);
  row('Storyteller decides / narrations / with a touch of the town', m => `${m.storyteller.decides} / ${m.storyteller.narrations} / ${m.storyteller.withTown == null ? NA : m.storyteller.withTown + ' of ' + m.storyteller.narrations}`);
  row('Nominations on an unanswered question', m => m.talk ? `${m.dodgedNominations.length} of ${m.nominations}${m.dodgedNominations.length ? ': ' + m.dodgedNominations.map(d => `${d.by} on day ${d.day}`).join(', ') : ''}` : NA);
  row('Wakes, anomalies', m => `${list(m.wakes)}; ${list(m.anomalies)}`);
  return R;
}

export function renderTable(ms, labels = []) {
  const head = ['Measure', ...ms.map((m, i) => columnHeader(m, labels[i]))];
  const cell = s => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const body = rows(ms);
  return ['| ' + head.map(cell).join(' | ') + ' |', '|' + head.map(() => ' --- ').join('|') + '|', ...body.map(r => '| ' + r.map(cell).join(' | ') + ' |')].join('\n');
}

// What the reviewer reads after the table: the evidence behind the rows that need judgement.
export function renderEvidence(ms, labels = []) {
  const L = [];
  ms.forEach((m, i) => {
    L.push(`## Evidence: ${columnHeader(m, labels[i])}`, '');
    if (m.demon) {
      L.push(`Demon ${m.demon.role} ${m.demon.names.join(' then ')}: nominated ${m.demon.nominated} time(s), ${m.demon.executed.length ? 'executed: ' + m.demon.executed.map(e => e.who + ' day ' + e.day).join(', ') : 'never executed'}.`);
      for (const n of m.demon.nominations) {L.push(`- Day ${n.day}: ${n.by} nominates ${n.target}, ${n.yes ?? '?'} yes of ${n.needed ?? '?'} needed. The table's last lines before it:`); n.before.forEach(b => L.push(`  - ${b}`))}
    }
    if (m.claimChanges && m.claimChanges.length) {L.push('Claim changes (the claims tool lists more than one role for a seat):'); m.claimChanges.forEach(c => L.push(`- ${c.player}: ${c.roles.map(r => `${r.role} (day ${r.day}: "${r.said}")`).join(' then ')}`))}
    if (m.dodgedNominations.length) {L.push('Nominations whose last line from the nominator is an unanswered question:'); m.dodgedNominations.forEach(d => L.push(`- Day ${d.day}: ${d.by} nominates ${d.target} after "${d.line}"`))}
    if (m.refusedList.length) {L.push('Refused calls:'); m.refusedList.forEach(r => L.push(`- ${r.ts.slice(11, 19)}Z ${r.seat} ${r.tool} (${r.kind}): ${r.error}`))}
    if (m.leaks && (m.leaks.text.length || m.leaks.role.length)) {L.push('Leak candidates:'); m.leaks.text.forEach(x => L.push(`- ${x.at.slice(11, 19)}Z ${x.seat} ${x.where} carries ${x.by}'s private line "${x.said}"`)); m.leaks.role.forEach(x => L.push(`- ${x.at.slice(11, 19)}Z ${x.seat} ${x.where} names ${x.of}'s role (${x.role}), never said in public`))}
    L.push('');
  });
  return L.join('\n');
}

// ---- reading the files ----
const jsonl = f => existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(l => {try {return [JSON.parse(l)]} catch {return []}}) : [];
const idTime = id => {const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null};
// behaviorRoot: logs/behavior (a folder per game name, as the logger writes them); logs: the folder with play.jsonl and runners/.
export function loadData(behaviorRoot, logs) {
  const turns = [], anomalies = [];
  const dirs = existsSync(behaviorRoot) ? readdirSync(behaviorRoot).filter(d => {try {return statSync(join(behaviorRoot, d)).isDirectory()} catch {return false}}) : [];
  for (const d of dirs) for (const [name, into] of [['turns.jsonl', turns], ['anomalies.jsonl', anomalies]]) {
    for (let i = 3; i >= 1; i--) into.push(...jsonl(join(behaviorRoot, d, name + '.' + i)));
    into.push(...jsonl(join(behaviorRoot, d, name)));
  }
  const ids = [], rdir = join(logs, 'runners');
  if (existsSync(rdir)) for (const f of readdirSync(rdir).filter(f => f.endsWith('.log'))) {
    for (const mm of readFileSync(join(rdir, f), 'utf8').matchAll(/\(game (\d+-\d{8}T\d{6}Z)\)/g)) {
      const at = idTime(mm[1]); if (at != null && !ids.some(x => x.id === mm[1])) ids.push({id: mm[1], at});
    }
  }
  return {turns, anomalies, play: jsonl(join(logs, 'play.jsonl')), events: jsonl(join(rdir, 'events.jsonl')), ids};
}

