// What a player seat sees at the top of each turn: the state header, and what is new since its last look. Built only
// from the api's seat-scoped reads (view, pendingFor, events), so a header can carry nothing the seat may not know.
// Pure: no node: imports, no model calls. The tool table (src/data/player-tools.js) shares the helpers below.
//
// The api: src/game/api.js. A test may hand in another (a fake) with useApi(api) or as the last argument; useApi(null)
// goes back to the game's.
import * as gameApi from '../game/api.js';
let API = gameApi;
export const useApi = api => {API = api || gameApi; return API};
const apiOr = api => api || API;

// The seat index from an index or {index, name}.
export const seatIndex = seat => (seat && typeof seat === 'object' ? seat.index : seat);

// ---- what a seat has seen ----
// The id of the last event each seat has read (read_talk advances it; -1 before any, as event ids start at 0). Kept
// beside the game, not in it: handlers never change the game except through the api. A restarted relay forgets it, and
// the seat sees the recent talk again.
const SEEN = new WeakMap();
const seenMap = game => {let m = SEEN.get(game); if (!m) {m = new Map(); SEEN.set(game, m)} return m};
export const lastSeen = (game, seat) => seenMap(game).get(seatIndex(seat)) ?? -1;
export const markSeen = (game, seat, id) => {
  const m = seenMap(game), i = seatIndex(seat);
  if (Number.isFinite(id) && id > (m.get(i) ?? -1)) m.set(i, id);
};

// ---- names ----
// A seat's name from an index (or the name itself when the api already gave one).
export const nameOf = (view, x) => {
  if (x == null) return null;
  if (typeof x === 'number') return view?.seats?.find(s => s.index === x)?.name ?? `seat ${x + 1}`;
  return String(x);
};
export const listNames = names => names.length ? names.join(', ') : 'nobody';

// ---- events: the only kinds and fields a seat is ever shown ----
// Anything else the api might hand back (a ruling, a grimoire line, another seat's whisper or night information) is
// dropped here, so a mistake on the game side still stops at this door.
export const EVENT_KINDS = ['say', 'pass', 'whisper', 'whisper-seen', 'dawn', 'phase', 'narration', 'nomination', 'vote-result',
  'vote-closed', 'execution', 'no-execution', 'slayer-shot', 'virgin', 'death', 'win', 'told', 'move'];
// a shot or a Virgin's answer is counted apart from the death it may bring (the death has its own event): one count each (#37)
const DEATHS = ['execution', 'death'];

// ---- places: the Square and the rooms (#28) ----
// A room's name from its id ('parlour' -> 'the parlour'), from the view's room list; null is the Square.
export const placeNameOf = (view, id) => id == null ? 'the Square' : (view?.rooms || []).find(r => r.id === id)?.name || String(id);
const bare = name => String(name).replace(/^the\s+/i, '');
export function cleanEvent(view, me, e) {
  if (!e || typeof e !== 'object' || !EVENT_KINDS.includes(e.type)) return null;
  const isMe = x => x === me || (x != null && x === view?.name);
  if (e.type === 'whisper' && !isMe(e.from) && !isMe(e.to)) return null;
  if (e.type === 'told' && e.seat != null && !isMe(e.seat)) return null;
  // an entry that names its audience and leaves this seat out (a room line said elsewhere) never reaches it
  if (Array.isArray(e.audience) && me != null && !e.audience.includes(me)) return null;
  const n = x => nameOf(view, x);
  const out = {id: e.id, type: e.type};
  if (e.day != null) out.day = e.day;
  if (e.night != null) out.night = e.night;
  switch (e.type) {
    case 'say': out.from = n(e.seat ?? e.from); if (e.room != null) out.in = placeNameOf(view, e.room); break;
    case 'move': out.seats = (Array.isArray(e.seats) ? e.seats : []).map(n); out.to = placeNameOf(view, e.room);
      if (e.from !== undefined) out.from = placeNameOf(view, e.from); if (e.by != null) out.by = n(e.by); break;
    case 'pass': out.from = n(e.seat ?? e.from); break;
    case 'whisper': case 'whisper-seen': out.from = n(e.from ?? e.seat); out.to = n(e.to); break;
    case 'nomination': out.by = n(e.by); out.target = n(e.target); break;
    case 'vote-result': out.by = n(e.by); out.target = n(e.target); if (Array.isArray(e.yes)) out.yes = e.yes.map(n);
      if (e.tally != null) out.tally = e.tally; if (e.needed != null) out.needed = e.needed; break;
    case 'dawn': if (Array.isArray(e.deaths)) out.died = e.deaths.map(n); break;
    case 'phase': if (typeof e.what === 'string') out.what = e.what; break;
    case 'execution': case 'death': out.who = n(e.seat ?? e.target); break;
    case 'slayer-shot': case 'virgin': out.by = n(e.seat); out.target = n(e.target); break;
    case 'win': if (typeof e.team === 'string') out.team = e.team; break;
  }
  if (e.type === 'whisper-seen') out.text = `${out.from} whispered to ${out.to}.`;
  else if (typeof e.text === 'string') out.text = e.text;
  return out;
}
export function cleanEvents(view, me, list) {
  return (Array.isArray(list) ? list : []).map(e => cleanEvent(view, me, e)).filter(Boolean);
}

// What is new for a seat since an event id (default: its last read_talk). Counts only; read_talk shows the lines.
export function whatsNew(game, seat, since, api) {
  const a = apiOr(api), me = seatIndex(seat);
  const from = since ?? lastSeen(game, me);
  const view = a.view(game, me);
  const evs = cleanEvents(view, me, a.events(game, me, from));
  const n = t => evs.filter(e => e.type === t).length;
  const others = evs.filter(e => e.type === 'say' && e.from !== view.name);
  const said = others.filter(e => !e.in).length, roomSaid = others.filter(e => e.in).length;
  // moves by others (or that took me along): the header names them; my own go and leave are not news
  const moved = evs.filter(e => e.type === 'move' && e.by !== view.name);
  const out = {since: from, last: evs.length ? evs[evs.length - 1].id : from, said, roomSaid,
    whispers: evs.filter(e => e.type === 'whisper' && e.from !== view.name).length, seen: n('whisper-seen'),
    nominations: n('nomination'), shots: n('slayer-shot'), votes: n('vote-result'), dawn: n('dawn'), deaths: evs.filter(e => DEATHS.includes(e.type)).length, narration: n('narration'),
    told: n('told'), phase: n('phase'), moves: moved.length, moveTexts: moved.map(e => e.text).filter(Boolean)};
  out.total = said + roomSaid + out.whispers + out.seen + out.nominations + out.shots + out.votes + out.dawn + out.deaths + out.narration + out.told + out.phase + out.moves;
  return out;
}
export function newsLine(w) {
  const parts = [];
  const add = (k, one, many) => {if (w[k]) parts.push(`${w[k]} ${w[k] === 1 ? one : many}`)};
  add('said', 'line at the table', 'lines at the table');
  add('roomSaid', 'line in a room with you', 'lines in a room with you');
  add('whispers', 'whisper to you', 'whispers to you');
  add('seen', 'whisper seen', 'whispers seen');
  add('nominations', 'nomination', 'nominations');
  add('shots', "Slayer's shot", "Slayer's shots");
  add('votes', 'vote result', 'vote results');
  add('dawn', 'dawn report', 'dawn reports');
  add('deaths', 'death by day', 'deaths by day');
  add('narration', 'word from the Storyteller', 'words from the Storyteller');
  add('told', 'private word to you', 'private words to you');
  if (!parts.length && w.phase) parts.push('the phase changed');
  return parts.length ? `New since your last look: ${parts.join(', ')}. read_talk to see it.` : 'Nothing new since your last look.';
}

// ---- the decision waiting on a seat, in plain words ----
// Labels for a choose's options: a seat index is the seat's name, null is "nobody", a role id is the role's name.
export function optionLabel(game, view, o) {
  if (o === null) return 'nobody';
  if (typeof o === 'number') return nameOf(view, o);
  if (typeof o === 'string') return game?.roleIndex?.[o]?.name || o;
  return JSON.stringify(o);
}
// The pending decision for this seat, kept to what a player may see: {kind, text, options?, count?, tool} or null.
export function askedOf(game, view, me, p) {
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'choose') {
    if (p.seat != null && p.seat !== me) return null;
    if (p.standing) return null; // a standing day ability waits on nobody: shotOf says it as a may, slay answers it (#37)
    const role = (p.role && p.role === view.role?.id ? view.role.name : optionLabel(game, view, p.role)) || view.role?.name || 'your role';
    const options = (p.options || []).map(o => optionLabel(game, view, o));
    const count = p.count || 1;
    const what = String(p.question || '').replace(/^[^:]*:\s*/, '').replace(/\(null\)/g, '("nobody")').replace(/[.?!\s]+$/, '') || 'make your choice';
    return {kind: 'choose', role, count, options, tool: 'night_choice',
      text: `As the ${role}: ${what}${/\?$/.test(String(p.question || '').trim()) ? '?' : '.'} Pick ${count === 1 ? 'one' : count} of: ${listNames(options)}.`};
  }
  if (p.kind === 'vote') {
    const nominee = nameOf(view, p.nominee), nominator = nameOf(view, p.nominator);
    if (p.mine != null) return {kind: 'vote', nominee, nominator, done: true, mine: p.mine ? 'yes' : 'no', tool: 'who_voted',
      text: `You voted ${p.mine ? 'yes' : 'no'} on ${nominee}; the vote is still open for others.`};
    const ghost = view.alive === false ? ' You are dead: a yes spends your one ghost vote.' : '';
    return {kind: 'vote', nominee, nominator, tool: 'vote',
      text: `Vote on ${nominator}'s nomination of ${nominee}: yes to execute, or no.${ghost}`};
  }
  if (p.kind === 'nomination') {
    const targets = nominationTargets(view, me, p);
    if (!targets.length) return null;
    return {kind: 'nomination', options: targets, tool: 'nominate',
      text: `Nominations are open: you may nominate one of ${listNames(targets)}, or pass.`};
  }
  return null;
}
// Who this seat may nominate, from the api's nomination pending ({targets} or the engine's {by, target} options).
export function nominationTargets(view, me, p) {
  const raw = Array.isArray(p.targets) ? p.targets
    : (p.options || []).filter(o => o && typeof o === 'object' ? o.by === me : o != null).map(o => (o && typeof o === 'object' ? o.target : o));
  return [...new Set(raw.map(x => nameOf(view, x)))];
}

// ---- the clock and the useful tools ----
export function clockLine(v, me) {
  if (v.phase === 'night') return `Night ${v.night}. Nobody talks at night.`;
  if (v.phase === 'day') {
    const c = v.clock || {};
    const round = c.roundsBeforeNominations ? `round ${Math.min(c.round || 1, c.roundsBeforeNominations)} of ${c.roundsBeforeNominations}` : 'talking';
    const turn = c.nominationsOpen || me == null || v.alive === false || !Array.isArray(c.toSpeak) ? '' : c.toSpeak.includes(me) ? ' Your turn this round is still yours.' : ' You have had your turn this round.';
    return `Day ${v.day}, ${round}; nominations ${c.nominationsOpen ? 'open' : 'not open yet'}.${turn}`;
  }
  if (v.phase === 'ended') return `The game is over${v.winner ? `: ${v.winner.team || v.winner} wins` : ''}.`;
  return 'The game is being set up.';
}
// The useful tools: what fits now, then slay while a standing shot is unspent (the shot never narrows the list, #37).
// While the rooms are open a seat at the Square is offered invite, a seat in a room leave (and no whisper: a room has none).
export function usefulTools(v, asked, news, waiting, shot) {
  let list = baseTools(v, asked, news, waiting);
  const away = v.place?.room != null;
  if (away) list = list.filter(n => n !== 'whisper');
  if (v.phase === 'day' && v.roomsOpen && v.place && !(asked && !asked.done)) list = [...list, away ? 'leave' : 'invite'];
  return shot && !list.includes('slay') ? [...list, 'slay'] : list;
}

// ---- places (#28): where I am, who is with me, my whisper neighbours, who is away, the rooms ----
export const andList = xs => xs.length < 2 ? (xs[0] ?? 'nobody') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
// One sentence on where this seat is, by day: at the Square with its two whisper neighbours, or in a room with whom.
export function placeText(v) {
  if (v.phase !== 'day' || v.winner || !v.place) return null;
  const p = v.place, nm = xs => (xs || []).map(x => nameOf(v, x));
  const nb = nm(p.neighbours);
  let here;
  if (p.room == null) here = `You are at the Square; whisper only to your neighbours ${nb.length ? andList(nb) : '(none alive)'}.`;
  else if (!(p.with || []).length) here = `You are alone in ${p.name || placeNameOf(v, p.room)}: nobody hears you here; invite someone or leave.`;
  else here = `You are in ${p.name || placeNameOf(v, p.room)} with ${andList(nm(p.with))}: only you ${p.with.length + 1} hear what is said here; no whispers in a room.`;
  const away = (v.rooms || []).filter(r => (r.seats || []).length && r.id !== p.room).map(r => `${andList(nm(r.seats))} in ${r.name}`);
  return away.length ? `${here} Away: ${away.join('; ')}.` : here;
}
// The rooms while they are open: how many places each has free, and that they close when nominations open.
export function roomsText(v) {
  if (v.phase !== 'day' || v.winner || !v.roomsOpen || !(v.rooms || []).length) return null;
  return `Rooms, closing when nominations open: ${v.rooms.map(r => `${bare(r.name)} ${r.free > 0 ? `${r.free} free` : 'full'}`).join(', ')}.`;
}
// The moves since the last look, the newest few: "Moves: Odette and Bram went to the nook."
export function movesText(news, max = 2) {
  const t = news?.moveTexts || [];
  if (!t.length) return null;
  const shown = t.slice(-max).map(s => s.replace(/[.\s]+$/, '')).join('. ');
  return `Moves: ${t.length > max ? `${t.length - max} earlier (read_talk), then ` : ''}${shown}.`;
}
function baseTools(v, asked, news, waiting) {
  if (waiting) return news?.total ? ['read_talk', 'look', 'my_notes'] : ['look', 'my_notes', 'note']; // nothing to act on: reads only
  // the dead are never in toSpeak: pass means nothing to them; they may still speak and whisper
  if (v.alive === false && v.phase === 'day' && asked?.kind !== 'vote' && asked?.tool !== 'night_choice') return news?.total ? ['read_talk', 'speak', 'whisper'] : ['speak', 'whisper', 'read_talk'];
  if (asked?.tool === 'night_choice') return ['night_choice', 'what_is_asked', 'my_role'];
  if (asked?.kind === 'vote' && !asked.done) return ['vote', 'who_voted', 'read_talk'];
  if (asked?.kind === 'nomination') return ['nominate', 'pass', 'read_talk'];
  if (v.phase === 'ended') return ['look', 'read_talk'];
  if (v.phase === 'night' || v.phase === 'setup') return ['my_role', 'my_notes', 'note'];
  return news?.total ? ['read_talk', 'speak', 'whisper'] : ['speak', 'whisper', 'pass'];
}

// ---- waiting: the seat has nothing to act on now (#29) ----
// The game says whether a seat can act (canAct) and when its next turn comes (nextTurnText) in src/game/api.js; until those
// exist, the clock answers: a living seat by day, before nominations, that has had its turn this round. Null when the seat
// can act, or something waits on it, or it is not day.
// An unspent standing shot makes the game's canAct true; the wait is then judged as if the shot were not there, and the
// text says "nothing else to do" (the shot line beside it says what is still open).
export function waitingOf(game, a, v, me, asked) {
  if (v.phase !== 'day' || v.winner || (asked && !asked.done)) return null;
  const shot = shotOf(game, a, v, me);
  let cannot;
  if (shot) {const c = v.clock || {}; cannot = v.alive !== false && (c.nominationsOpen ? !asked : Array.isArray(c.toSpeak) && !c.toSpeak.includes(me))}
  else if (typeof a?.canAct === 'function') {try {cannot = !a.canAct(game, me)} catch {cannot = false}}
  else {const c = v.clock || {}; cannot = v.alive !== false && !c.nominationsOpen && Array.isArray(c.toSpeak) && !c.toSpeak.includes(me)}
  if (!cannot) return null;
  let next = null;
  if (!shot && typeof a?.nextTurnText === 'function') {try {next = a.nextTurnText(game, me)} catch {next = null}}
  const text = waitText(v, typeof next === 'string' && next.trim() ? next.trim() : nextFromClock(v, asked));
  return {text: shot ? text.replace('nothing to do', 'nothing else to do') : text};
}

// ---- a standing day ability: the Slayer's shot (#37) ----
// The api's dayActionFor says whether this seat may fire a day ability now. Said as a may, never "WAITING ON YOU": the seat
// talks, whispers, passes and nominates as before, and slay fires it (or "hold" keeps it). Null with no shot, or with an api
// that has no dayActionFor.
export function shotOf(game, a, v, me) {
  if (typeof a?.dayActionFor !== 'function' || v.phase !== 'day' || v.winner || v.alive === false) return null;
  let d = null;
  try {d = a.dayActionFor(game, me)} catch {d = null}
  if (!d) return null;
  const role = d.ability === v.role?.id ? v.role.name : optionLabel(game, v, d.ability);
  const options = (d.options || []).filter(o => o !== null).map(o => optionLabel(game, v, o));
  const text = d.ability === 'slayer' ? 'Your shot is unspent: slay <name> any time today, or hold it.'
    : `Your ${role} ability is unspent: slay <name> uses it any time today, or hold it.`;
  return {ability: d.ability, role, options, tool: 'slay', text};
}
function nextFromClock(v, asked) {
  const c = v.clock || {};
  if (!c.nominationsOpen) return (c.round || 1) < (c.roundsBeforeNominations || 0) ? `until round ${(c.round || 1) + 1}` : 'until nominations open';
  return asked?.done ? 'until the vote closes' : 'until a vote opens';
}
// "You have had your turn this round; nothing to do until round 3; reading is fine." The game's text may be a phrase
// ("until round 3", "round 3", "nominations open") or a whole sentence; both read right.
function waitText(v, next) {
  const head = v.clock?.nominationsOpen ? 'Nothing is asked of you now' : 'You have had your turn this round';
  const t = next.replace(/[.\s]+$/, '');
  if (/^(until|when|after|once|till)\b/i.test(t)) return `${head}; nothing to do ${t}; reading is fine.`;
  if (/^(round|nominations|the|day|night|a vote)\b/i.test(t)) return `${head}; nothing to do until ${t}; reading is fine.`;
  return `${t}.${/read/i.test(t) ? '' : ' Reading is fine.'}`;
}

// ---- the stakes when few are alive (#38) ----
// By day with four or fewer alive: the count, the nightly kill, and how many wrong executions the town can still afford
// before the count reaches two (evil wins at two alive). Public arithmetic: every seat may know it.
export function stakesLine(v) {
  if (v.phase !== 'day' || v.winner) return null;
  const n = (v.seats || []).filter(s => s.alive).length;
  if (n > 4 || n < 3) return null;
  const spare = Math.max(0, Math.floor((n - 3) / 2)); // a wrong execution and the night's kill take two
  const wrong = n - 1 <= 2 ? `${n - 1} left, evil wins at once; no execution: 2 after tonight` : `${n - 1} left, ${n - 2} after tonight${n - 2 <= 2 ? ', evil wins' : ''}`;
  return `Stakes: ${n} alive; the demon kills one a night; evil wins at 2. A wrong execution today: ${wrong}. Wrong executions to spare: ${spare || 'none'}.`;
}

// ---- a nudge for a quiet table (#31) ----
function nudgeLine(v, asked, waiting) {
  if (v.phase !== 'day' || v.winner || waiting) return null;
  if (asked?.kind === 'nomination' && !(v.today?.nominations || []).length)
    return 'Nobody nominated yet. With nothing solid, nominate someone anyway and let the vote decide: a day with no execution is a day given to the demon.';
  if (v.day === 1 && v.alive !== false && !v.clock?.nominationsOpen && !asked)
    return 'First day: say something about yourself or ask a player a question by name, rather than pass.';
  return null;
}

const TEAM_SIDE = {townsfolk: 'good', outsider: 'good', minion: 'evil', demon: 'evil'};
export const sideOf = team => TEAM_SIDE[team] || team || 'unknown';

// The header for one turn: who I am, the clock, who lives, what is new, what waits on me, the tools that fit now.
export function playerHeader(game, seat, api) {
  const a = apiOr(api), me = seatIndex(seat);
  const v = a.view(game, me);
  const role = v.role || {};
  const life = v.alive ? 'alive' : `dead, ${v.ghostVote ? 'ghost vote unused' : 'ghost vote spent'}`;
  const seats = v.seats || [];
  const living = seats.filter(s => s.alive).map(s => s.name), dead = seats.filter(s => !s.alive).map(s => s.name);
  const news = whatsNew(game, me, undefined, a);
  const asked = askedOf(game, v, me, a.pendingFor(game, me));
  const waiting = waitingOf(game, a, v, me, asked), shot = shotOf(game, a, v, me);
  const stakes = stakesLine(v), nudge = nudgeLine(v, asked, waiting);
  const lines = [
    `You are ${v.name}, the ${role.name || 'unknown role'} (${role.team || '?'}, ${sideOf(role.team)}), ${life}.`,
    waiting ? clockLine(v, null) : clockLine(v, me),
    `Alive (${living.length}): ${listNames(living)}.${dead.length ? ` Dead: ${listNames(dead)}.` : ''}`,
    ...(stakes ? [stakes] : []),
    newsLine(news),
    ...[movesText(news), placeText(v), roomsText(v)].filter(Boolean),
  ];
  if (asked && !asked.done) lines.push(`**WAITING ON YOU: ${asked.text}**`);
  if (waiting) lines.push(waiting.text);
  if (shot) lines.push(shot.text);
  if (nudge) lines.push(nudge);
  const useful = usefulTools(v, asked, news, waiting, shot);
  lines.push(`Useful now: ${useful.join(', ')}.${useful.includes('speak') ? ' Speak without your name in front.' : ''}`);
  if (v.alive === false && v.phase === 'day' && !waiting) lines.push(`You are dead: you may still speak and whisper${v.ghostVote ? ', and vote once with your ghost vote' : ''}; there is nothing to pass.`);
  return lines.join('\n');
}
