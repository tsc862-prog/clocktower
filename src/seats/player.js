// What a player seat sees at the top of each turn: the state header, and what is new since its last look. Built only
// from the api's seat-scoped reads (view, pendingFor, events), so a header can carry nothing the seat may not know.
// Pure: no node: imports, no model calls. The tool table (src/data/player-tools.js) shares the helpers below.
//
// The api: src/game/api.js. A test may hand in another (a fake) with useApi(api) or as the last argument; useApi(null)
// goes back to the game's.
import * as gameApi from '../game/api.js';
import {SCRIPT} from '../data/script.js';
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
// Day 1's dawn with nobody dead, in words that say why: the demon does not kill on the first night (#110).
export const FIRST_DAWN = 'Day 1 breaks. Nobody died, as always on the first night: the demon does not kill then, so this says nothing about anyone.';
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
  else if (e.type === 'nomination' && out.by && out.target) out.text = nominationText(out.by, out.target); // both parts named (#89)
  else if (e.type === 'virgin' && out.by && out.target) out.text = virginText(out.by, out.target);
  else if (e.type === 'dawn' && e.day === 1 && !(e.deaths || []).length) out.text = FIRST_DAWN; // the first night is quiet by the rules (#110)
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
    told: n('told'), phase: n('phase'), moves: moved.length,
    moveTexts: moved.filter(e => e.day == null || e.day === view.day).map(e => e.text).filter(Boolean)}; // the header names today's moves only
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
  // a seat that has not read for a long while: the first four kinds, then a count (the header stays short)
  if (parts.length > 5) {const rest = parts.splice(4).reduce((n, p) => n + (parseInt(p, 10) || 0), 0); parts.push(`${rest} more`)}
  return parts.length ? `New (read_talk): ${parts.join(', ')}.` : 'Nothing new since your last look.';
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
  if (p.kind === 'thoughts') { // the night's thought before dawn (#111): once answered, nothing waits
    if (p.mine != null) return null;
    const tonight = String(p.tonight || '').trim();
    return {kind: 'thoughts', tool: 'think', tonight, text: `${String(p.question || 'The night is ending. In a sentence or two, what are you thinking?').trim()}${tonight ? ` Tonight: ${tonight}` : ''}`};
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
  return `Rooms until nominations open: ${v.rooms.map(r => `${bare(r.name)} ${r.free > 0 ? `${r.free} free` : 'full'}`).join(', ')}.`;
}
// The moves since the last look, the newest few: "Moves: Odette and Bram went to the nook." Shown by day only: at night
// everyone is at the Square and the moves tell nothing about now.
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
  if (asked?.kind === 'thoughts') return ['think', 'my_role', 'my_notes', 'read_talk'];
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

// ---- what a role has to tell (#87, #89) ----
// When a role learns something it can tell the table: 'first' on the first night only, 'nightly' every night from the
// first, 'later' from night 2 on (or only when it dies at night), 'never' (it learns nothing at night, or nothing true).
// Game 4 hanged a Monk on day 1 for not naming whom she would guard: a question her role could not answer yet.
const LEARNS = {washerwoman: 'first', librarian: 'first', investigator: 'first', chef: 'first', empath: 'nightly', 'fortune-teller': 'nightly',
  spy: 'nightly', undertaker: 'later', monk: 'later', ravenkeeper: 'later', imp: 'later'};
const roleIdOf = name => SCRIPT.roles.find(r => r.name.toLowerCase() === String(name || '').toLowerCase())?.id || null;
export const learnsOf = role => LEARNS[roleIdOf(role) || role] || 'never';
// Why a role has nothing to tell on day 1, in a few words; null for a role that learned something on the first night.
export function nothingYet(role) {
  const id = roleIdOf(role) || role;
  if (['monk', 'undertaker', 'imp'].includes(id)) return 'first acts on night 2';
  if (id === 'ravenkeeper') return 'learns only if killed at night';
  return learnsOf(id) === 'never' ? 'learns nothing at night' : null;
}
// What a role's information can and cannot show, one sentence each (my_role's "reads"); null for a role with none.
const READS = {
  washerwoman: 'One of your two names holds that townsfolk role; the other can be anyone, good or evil.',
  librarian: 'One of your two names holds that outsider role; the other can be anyone. "No outsiders" names nobody.',
  investigator: 'One of your two names is that minion; the other can be anyone, even good.',
  chef: 'Your number counts pairs of evil players sitting side by side anywhere around the table, not your own neighbours (that is the Empath). It names nobody: 0 means no two evil sit together, not who is evil.',
  empath: 'Your number counts the evil among your two nearest living neighbours that night; it does not say which one, and your neighbours change as players die.',
  'fortune-teller': 'A yes means one of your two picks reads as the demon, and one good player reads as the demon to you all game; a no clears both of being the demon, nothing more.',
  undertaker: 'You learn the role of the player executed that day; it says nothing about who voted or why.',
  ravenkeeper: 'You learn one player\'s role, and only on the night you are killed.',
  spy: 'You see the grimoire as it is that night; tell it only in a way that does not give you away.',
};
export const readsOf = role => READS[roleIdOf(role) || role] || null;

// ---- the day's record, unambiguous (#89) ----
// Game 4 reversed nominator and nominee of a Virgin's trap. Each nomination is said with both parts named; the record line
// in the header keeps the days' deaths by day in that wording: who nominated whom, what fired, who died.
export const nominationText = (by, target) => `${by} (nominator) nominated ${target} (nominee).`;
export const virginText = (by, target) => `${by} (nominator) nominated ${target} (nominee); ${target} is the Virgin, so the trap fired: ${by}, the nominator, is executed at once.`;
// From a seat's cleaned events: [{day, text}] for a Virgin's trap, a Slayer's shot that killed and an execution, oldest first.
export function recordOf(evs) {
  const out = [], died = new Set(evs.filter(e => e.type === 'death' && e.who).map(e => `${e.day}/${e.who}`));
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (e.type === 'virgin') out.push({day: e.day, who: e.by, text: `${e.by} nominated ${e.target}, the Virgin's trap fired and ${e.by} (the nominator) died`});
    else if (e.type === 'slayer-shot' && died.has(`${e.day}/${e.target}`)) out.push({day: e.day, text: `${e.by} shot ${e.target} as the Slayer and ${e.target} died`});
    else if (e.type === 'execution' && !out.some(x => x.who === e.who && x.day === e.day)) out.push({day: e.day, text: `${e.who} was executed`});
  }
  return out;
}
// "Record: day 1, Ines nominated Odette, the Virgin's trap fired and Ines (the nominator) died; day 2, Corwin was executed."
export function recordText(rec, max = 3) {
  if (!rec?.length) return null;
  const shown = rec.slice(-max).map(r => `day ${r.day ?? '?'}, ${r.text}`);
  return `Record: ${rec.length > max ? `${rec.length - max} earlier (read_talk); ` : ''}${shown.join('; ')}.`;
}

// ---- a nudge for a quiet table (#31) ----
// On day 1 a good seat whose role has nothing to tell yet is told so, with what to say instead (#87).
function nudgeLine(v, asked, waiting) {
  if (v.phase !== 'day' || v.winner || waiting || stakesLine(v)) return null; // the stakes say more than a nudge
  if (asked?.kind === 'nomination' && !(v.today?.nominations || []).length)
    return 'Nobody nominated yet. With nothing solid, nominate someone anyway and let the vote decide: a day with no execution is a day given to the demon.';
  if (v.day === 1 && v.alive !== false && !v.clock?.nominationsOpen && !asked) {
    const why = ['townsfolk', 'outsider'].includes(v.role?.team) && nothingYet(v.role.id);
    if (why) return `First day: the ${v.role.name} ${why}, so you have nothing to tell yet; say so if asked, and ask a player a question by name. A quiet night 1 is the rule, no clue.`;
    return 'First day: say something about yourself or ask a player a question by name, rather than pass. A quiet night 1 is the rule, no clue.';
  }
  return null;
}

// ---- the Poisoner's targets (#88) ----
// Game 4's Poisoner poisoned a guess, the demon's own kill and a Virgin whose trap had fired. At night, with the poison to
// pick, the header sorts the other living players by what this seat heard: a claimed ability still working (worth it), one
// already used (wasted), no claim. Public facts only: the claims the seat heard and the Virgin's and Slayer's public events.
export function poisonOf(v, asked, ledger, evs) {
  if (asked?.tool !== 'night_choice' || v.role?.id !== 'poisoner' || !(v.night > 1)) return null;
  const team = new Set();
  for (const t of v.told || []) if (t.what ? ['minion-info', 'demon-info'].includes(t.what) : /\b(?:demon|minions?)\b/i.test(t.text || ''))
    for (const s of v.seats || []) if (new RegExp(String.raw`\b` + reEsc(s.name) + String.raw`\b`).test(String(t.text || ''))) team.add(s.name);
  const fired = new Map((evs || []).filter(e => e.type === 'virgin').map(e => [e.target, `fired day ${e.day}`]));
  const shot = new Map((evs || []).filter(e => e.type === 'slayer-shot').map(e => [e.by, `shot day ${e.day}`]));
  const live = [], spent = [], none = [];
  for (const s of (v.seats || []).filter(x => x.alive && x.name !== v.name && !team.has(x.name))) {
    const cs = (ledger || []).find(p => p.player === s.name)?.claims || [];
    const c = cs.filter(x => !x.whispered).at(-1) || cs.at(-1);
    if (!c) {none.push(s.name); continue}
    const id = roleIdOf(c.role);
    const used = id === 'virgin' ? fired.get(s.name) : id === 'slayer' ? shot.get(s.name) : learnsOf(id) === 'first' ? 'first night only' : null;
    if (used) spent.push(`${s.name} (${c.role}, ${used})`);
    else if (['saint', 'recluse', 'drunk', 'butler'].includes(id)) none.push(s.name);
    else live.push(`${s.name} (${c.role})`);
  }
  const parts = [live.length && `worth it on ${andList(live)}`, spent.length && `wasted on ${andList(spent)}`, none.length && `no working claim: ${andList(none)}`].filter(Boolean);
  return `Poison: ${parts.join('; ')}. Never on the player your demon kills tonight.`;
}

// ---- claims (#67): every role a player named for itself, from the talk this seat heard ----
// A claim is a line in which the speaker names a role of the script for itself: "I'm the Ravenkeeper", "I am Bram, the
// Washerwoman", "As the Empath, ...", "Chef here.". "I'm not the X", "if I'm the X", "you think I'm the X" and a role named
// for someone else are not claims. Built only from the seat's own events (cleanEvents), so a whisper between two others or
// a line said in a room elsewhere never makes a claim here. Game 3 executed a good seat on "she changed her claim" when she
// had made one; the ledger is what a seat checks before it repeats such a thing.
const ROLE_NAMES = SCRIPT.roles.map(r => r.name).sort((x, y) => y.length - x.length);
const reEsc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const roleRe = name => name.split(/\s+/).map(reEsc).join('[\\s-]*');
const ROLE_FIND = new RegExp(String.raw`\b(?:` + ROLE_NAMES.map(roleRe).join('|') + String.raw`)\b`, 'gi');
const roleByText = t => ROLE_NAMES.find(n => new RegExp('^' + roleRe(n) + '$', 'i').test(t.trim())) || null;
const ART = String.raw`(?:\s+(?:the|a|an|your|our))?`;
const LEAD = String.raw`(?:\bi\s*['’]\s*m|\bi\s+am|\bim)(?:\s+(?:really|actually|truly|just|also|still|definitely|honestly|indeed|claiming(?:\s+to\s+be)?))*`;
// the words before "I'm" that make it someone else's claim, a doubt or a supposition, not mine
const NOT_SELF = /\b(?:if|unless|whether|suppose|supposing|pretend|pretending|not|never|think|thinks|thought|say|says|said|believe|believes|suspect|suspects|accuse|accuses|accused|call|calls|claims|claimed|maybe|perhaps)\b[^,]*$/i;
function selfClaims(text, speaker) {
  const t = String(text ?? ''), out = [];
  const nm = speaker ? String.raw`(?:\s+` + reEsc(speaker) + String.raw`\s*,)?` : '';
  const pre = new RegExp(String.raw`(?:` + LEAD + nm + ART + String.raw`|\bmy\s+role\s+is` + ART + String.raw`|\bi\s+claim(?:\s+to\s+be)?` + ART
    + String.raw`|(?:^|,|\band\s+)\s*as` + ART + String.raw`)\s+$`, 'i');
  const lead = new RegExp(String.raw`^\s*(?:` + (speaker ? reEsc(speaker) + String.raw`(?:\s+here)?\s*[,—-]?\s*` : '') + String.raw`)?(?:the\s+)?$`, 'i');
  for (const m of t.matchAll(ROLE_FIND)) {
    const before = t.slice(0, m.index), after = t.slice(m.index + m[0].length);
    const cut = Math.max(...['.', '!', '?', ';', ':', '\n'].map(c => before.lastIndexOf(c)));
    const clause = before.slice(cut + 1);
    const p = clause.match(pre), my = clause.match(MY_BEFORE);
    const hit = p ? !NOT_SELF.test(clause.slice(0, p.index))
      : my ? MY_AFTER.test(after) && !NOT_SELF.test(clause.slice(0, my.index))
      : lead.test(clause) && /^\s*(?:here\b|[,—-]\s*(?:and\s+)?i\s+(?:got|learned|learnt|saw|see|read|was\s+told|have|know))/i.test(after);
    const role = hit && roleByText(m[0]);
    if (role) out.push({role, said: (clause + m[0]).trim()});
  }
  return out;
}
// "my Virgin ability fired", "my Empath number": the role named as the speaker's own by what it does (#92)
const MY_BEFORE = /\bmy\s+$/i;
const MY_AFTER = /^\s*(?:ability|power|trap|shot|info|information|reading|readings|result|results|number|count|check|checks|pick|picks|protection|night)\b/i;

// ---- claims said in other words (#92) ----
// "Ines nominated me, and my trap fired", "I guard one player each night": the role is told by its ability, not its name.
// Each pattern is first person and specific to one role; a line that claims a role by name is not read for these.
const ABILITY_SAYS = [
  ['Virgin', /\bmy\s+trap\b|\b(?:nominat\w*\s+me\b[^.!?]{0,40}\b(?:die|dies|died|executed)\b)|\bif\s+(?:a\s+townsfolk|anyone|someone|somebody|you)\s+nominates?\s+me\b/i],
  ['Monk', /\bi\s+(?:guard|protect|shield)(?:ed|s)?\s+(?:one|a|another|someone|somebody|a\s+player|one\s+player|one\s+neighbou?r)\b|\bmy\s+(?:guard|protection)\b|\b(?:i\s+(?:hold|have|play)|my)\b[^.!?]{0,40}\brole\s+that\s+(?:guards|protects|shields)\b/i],
  ['Soldier', /\b(?:the\s+demon\s+(?:can(?:no|['’])t|cannot|can\s+not)\s+kill\s+me|i\s+(?:can(?:no|['’])t|cannot)\s+(?:be\s+)?(?:killed|die)\s+(?:by\s+the\s+demon|at\s+night))\b/i],
  ['Slayer', /\bmy\s+(?:one\s+)?shot\b|\bi\s+(?:can|could|will)\s+shoot\b/i],
  ['Empath', /\b(?:no|zero|0|one|1|two|2|both)\s+(?:of\s+)?my\s+(?:two\s+)?(?:living\s+)?neighbou?rs\s+(?:is|are|was|were|registered?\s+as)\s+evil\b/i],
  ['Chef', /\b(?:my|i\s+(?:got|learned|learnt|was\s+told))\b[^.!?]{0,40}\b(?:no|zero|0|one|1|two|2)\s+(?:pairs?\s+of\s+evil|evil\s+pairs?|two\s+evil\s+players?\s+(?:sit|sat)|evil\s+players?\s+(?:sit|sat))/i],
  ['Fortune Teller', /\bi\s+(?:checked|picked|tested|read)\s+\w+\s+and\s+\w+\b[^.!?]{0,40}\bdemon\b/i],
  ['Ravenkeeper', /\bif\s+i\s+(?:die|am\s+killed|get\s+killed)\s+(?:at|in\s+the)\s+night\b[^.!?]{0,30}\b(?:learn|pick|choose|see)\b/i],
  ['Saint', /\bif\s+(?:i\s+(?:am|['’]m|get)|you)\s+(?:executed|hang|hanged|execute\s+me)\b[^.!?]{0,30}\b(?:good|we|the\s+town|town)\s+loses?\b/i],
  ['Butler', /\bmy\s+master\b/i],
  ['Librarian', /\bi\s+(?:learned|learnt|was\s+told|got)\s+(?:that\s+)?there\s+(?:are|were)\s+no\s+outsiders\b/i],
];
// a Virgin's trap told in the negative ("nominated me and nobody died") claims nothing
const SAID_NOT = {Virgin: /\b(?:nobody|no\s+one|not|never|didn['’]t|did\s+not|wasn['’]t)\b/i};
function saidClaims(text) {
  const t = String(text ?? ''), out = [];
  for (const sentence of t.split(/(?<=[.!?;])\s+/)) {
    for (const [role, re] of ABILITY_SAYS) {
      const m = sentence.match(re);
      if (!m || SAID_NOT[role]?.test(m[0]) || NOT_SELF.test(sentence.slice(0, m.index))) continue;
      if (!out.some(c => c.role === role)) out.push({role, said: sentence.trim(), unnamed: true});
    }
  }
  return out;
}
// The roles a line claims for its speaker, each once, in the order said: by name, else by what the ability does.
export const claimsInLine = (text, speaker) => {
  const named = selfClaims(text, speaker);
  return [...new Set((named.length ? named : saidClaims(text)).map(c => c.role))];
};
// The same with how: [{role, unnamed}] (unnamed: said by the ability, not the name).
const claimsWithHow = (text, speaker) => {
  const named = selfClaims(text, speaker);
  if (named.length) return [...new Set(named.map(c => c.role))].map(role => ({role, unnamed: false}));
  return saidClaims(text).map(c => ({role: c.role, unnamed: true}));
};
// The ledger, in seat order: [{player, claims: [{role, day, id, said, times, unnamed?, in?, whispered?}]}], each role once per
// player with the first line that claimed it (a role first said by its ability and later named keeps the naming line).
// Lines at the table, in a room this seat was in, and whispers to or from this seat. unnamed: told by what the ability does,
// not by name ("my trap fired", "I guard one player a night", #92).
export function claimsOf(view, me, events) {
  const by = new Map();
  for (const e of cleanEvents(view, me, events)) {
    if (!['say', 'whisper'].includes(e.type) || !e.from || typeof e.text !== 'string') continue;
    for (const {role, unnamed} of claimsWithHow(e.text, e.from)) {
      if (!by.has(e.from)) by.set(e.from, []);
      const list = by.get(e.from), prev = list.find(c => c.role === role);
      if (prev) {
        prev.times++; if (prev.unnamed && !unnamed) {delete prev.unnamed; prev.said = e.text}
        // first said in private, now at the table: the whole table heard it, so the table's line stands (#104)
        if ((prev.whispered || prev.in) && e.type === 'say' && !e.in) {delete prev.whispered; delete prev.in; Object.assign(prev, {day: e.day ?? null, id: e.id, said: e.text})}
        continue;
      }
      list.push({role, day: e.day ?? null, id: e.id, said: e.text, times: 1, ...(unnamed ? {unnamed: true} : {}),
        ...(e.type === 'whisper' ? {whispered: e.to} : e.in ? {in: e.in} : {})});
    }
  }
  const order = (view?.seats || []).map(s => s.name), team = teamOf(view);
  for (const [player, list] of by) for (const c of list) {const m = secretMark(view, team, player, c); if (m) c.secret = m} // #104
  return [...by.entries()].sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])).map(([player, claims]) => ({player, claims}));
}
// The claims line, by role in the order first claimed:
// "Claims (one player per role): Mayor: Corwin (day 1); Monk: Ines (said not named). No night answer to give yet:
// Mayor and Monk (silence there is no dodge)." The day is left out for a claim made today.
// "one player per role" says it plainly (#92: seats said "the only Mayor left" with no second Mayor ever). A role two or more
// players named for themselves (#81) is marked "twice: at most one is". Only what was said aloud (the table or a
// room): a whispered claim stays in the claims tool. day: the day when it is day; on day 1 the claimed roles that have
// nothing to tell yet are named (#87). today: the day count, to leave out the day of a claim made today.
export function claimsText(ledger, day, today = day) {
  const pub = (ledger || []).map(p => ({player: p.player, claims: p.claims.filter(c => !c.whispered && !c.secret)})).filter(p => p.claims.length);
  if (!pub.length) return null;
  const roles = new Map();
  for (const p of pub) for (const c of p.claims) {
    if (!roles.has(c.role)) roles.set(c.role, {first: c.id ?? 0, day: c.day, players: [], unnamed: true});
    const r = roles.get(c.role);
    if ((c.id ?? 0) < r.first) {r.first = c.id ?? 0; r.day = c.day}
    r.players.push(p.player);
    if (!c.unnamed) r.unnamed = false;
  }
  const list = [...roles.entries()].sort((x, y) => x[1].first - y[1].first);
  const twice = list.some(([, r]) => r.players.length > 1);
  const parts = list.map(([role, r]) => {
    const marks = [r.players.length > 1 ? 'twice: at most one is' : '', r.unnamed ? 'said not named' : '', r.day != null && r.day !== today ? `day ${r.day}` : ''].filter(Boolean);
    return `${role}: ${andList(r.players)}${marks.length ? ` (${marks.join(', ')})` : ''}`;
  });
  const two = pub.filter(p => p.claims.length > 1).map(p => `${p.player} named ${p.claims.map(c => c.role).join(' then ')}`);
  const quiet = day === 1 ? list.map(([role]) => role).filter(role => nothingYet(role)) : [];
  return (`Claims (one player per role${twice ? ' unless marked' : ''}): ${parts.join('; ')}. ` + (two.length ? `${two.join('; ')}. ` : '') +
    (quiet.length ? `No night answer to give yet: ${andList(quiet)} (silence there is no dodge).` : '')).trim();
}
// The roles named by two or more players, in the order first claimed: [{role, players: [names in seat order]}]. Every
// character is in play at most once, so two claims to one role are a contradiction, never two holders (#81).
export function clashesOf(ledger) {
  const by = new Map();
  for (const p of openClaims(ledger)) for (const c of p.claims) {
    if (!by.has(c.role)) by.set(c.role, {first: c.id ?? 0, players: []});
    const r = by.get(c.role);
    r.first = Math.min(r.first, c.id ?? 0);
    if (!r.players.includes(p.player)) r.players.push(p.player);
  }
  return [...by.entries()].filter(([, r]) => r.players.length > 1).sort((x, y) => x[1].first - y[1].first).map(([role, r]) => ({role, players: r.players}));
}

// ---- evil seats keep their roles secret (#104) ----
// Game 5 hanged a Spy on day 1: she told her demon "I am the Spy" in a room, he repeated it at the table, and she stood by
// it. An evil seat's true role and its team-mates' are secrets; the header names a good role to claim instead and, once
// claimed, holds the seat to it. Built only from what this seat was told (its demon's bluffs, the Spy's grimoire, who is on
// its team) and the claims it heard.
const ROLE_OF_NAME = new Map(SCRIPT.roles.map(r => [r.name, r]));
const EVIL_ROLES = new Set(SCRIPT.roles.filter(r => ['minion', 'demon'].includes(r.team)).map(r => r.name));
const isEvilSeat = v => ['minion', 'demon'].includes(v?.role?.team);
const teamTold = v => (v?.told || []).filter(t => t.what ? ['minion-info', 'demon-info'].includes(t.what) : /\b(?:demon|minions?)\b/i.test(t.text || ''));
// The team-mates the Storyteller named to this seat, in the order named (the demon first in a minion's word); none for a good seat.
export function teamOf(v) {
  if (!isEvilSeat(v)) return [];
  const out = [];
  for (const t of teamTold(v)) {
    const text = String(t.text || '');
    (v.seats || []).map(s => ({name: s.name, at: text.search(new RegExp(String.raw`\b` + reEsc(s.name) + String.raw`\b`))}))
      .filter(x => x.at >= 0 && x.name !== v.name).sort((x, y) => x.at - y.at).forEach(x => {if (!out.includes(x.name)) out.push(x.name)});
  }
  return out;
}
// A claim that is not one to repeat: the seat's own evil role (said anywhere, it is the mistake), or a team-mate's evil role
// said to this seat in private (a room or a whisper). The same evil role said at the table by anyone stays a claim.
function secretMark(v, team, player, c) {
  if (!isEvilSeat(v) || !EVIL_ROLES.has(c.role)) return null;
  if (player === v.name) return 'own';
  return team.includes(player) && (c.whispered || c.in) ? 'team' : null;
}
const openClaims = ledger => (ledger || []).map(p => ({player: p.player, claims: p.claims.filter(c => !c.secret)})).filter(p => p.claims.length);
// Good roles in play by the grimoire the Spy saw last ("Odette the Chef", "believes they are the Monk"): never a cover.
function grimoireRoles(v) {
  const g = (v.told || []).filter(t => t.what === 'grimoire' || /^You see the grimoire/.test(String(t.text || ''))).at(-1);
  if (!g) return null;
  const text = String(g.text), out = new Set();
  for (const m of text.matchAll(ROLE_FIND)) {
    const before = text.slice(0, m.index);
    if ((v.seats || []).some(s => new RegExp(String.raw`\b` + reEsc(s.name) + String.raw`\s+the\s+$`).test(before)) || /believes they are the\s+$/.test(before)) {
      const r = roleByText(m[0]); if (r) out.add(r);
    }
  }
  return out;
}
// The roles a guess prefers: no night information to invent, and no public test (a Virgin's trap, a Slayer's shot) to fail.
const SAFE_GUESS = ['Soldier', 'Mayor', 'Monk', 'Ravenkeeper', 'Undertaker', 'Empath', 'Chef', 'Washerwoman', 'Librarian', 'Investigator', 'Fortune Teller'];
// {text, role, said?} for an evil seat by day, else null. ledger: claimsOf for this seat.
export function coverOf(v, ledger) {
  if (!isEvilSeat(v) || v.phase !== 'day' || v.winner) return null; // by day only: nobody talks at night
  const team = teamOf(v), placeOf = c => c.whispered ? 'in a whisper' : c.in ? `in ${c.in}` : 'at the table';
  const secrets = (ledger || []).filter(p => p.player !== v.name).map(p => [p.player, [...new Set(p.claims.filter(c => c.secret === 'team').map(placeOf))]])
    .filter(([, at]) => at.length).map(([who, at]) => `${who} (your team-mate) told you the real role ${andList(at)}: a secret; never repeat it.`);
  const mine = (ledger || []).find(p => p.player === v.name)?.claims.filter(c => !c.secret && !EVIL_ROLES.has(c.role) && c.role !== v.role.name && !(c.whispered && team.includes(c.whispered))) || [];
  const said = mine.sort((x, y) => (x.id ?? 0) - (y.id ?? 0)).at(-1);
  let head;
  if (said) head = `Your cover: ${said.role}, said day ${said.day ?? v.day}: keep to it.`;
  else {
    const claimed = new Set((ledger || []).filter(p => p.player !== v.name).flatMap(p => p.claims.map(c => c.role)));
    const open = r => !claimed.has(r) && r !== v.role.name;
    const bluffs = (teamTold(v).map(t => String(t.text || '').match(/to bluff with:\s*([^.]*)/i)?.[1]).filter(Boolean).at(-1) || '')
      .split(/,\s*|\s+and\s+/).map(s => roleByText(s)).filter(Boolean);
    const seen = v.role.id === 'spy' ? grimoireRoles(v) : null;
    const turn = xs => xs.length ? xs[(v.index ?? 0) % xs.length] : null; // two minions guessing apart, by seat
    let pick = bluffs.find(open), how = 'not in play';
    if (!pick && seen) {pick = turn(SCRIPT.roles.filter(r => r.team === 'townsfolk' && !seen.has(r.name) && open(r.name)).map(r => r.name)); how = 'not in the grimoire you saw'}
    if (!pick) {pick = turn(SAFE_GUESS.filter(open).slice(0, 3)); how = 'nobody has claimed it; a guess'}
    if (!pick) return secrets.length ? {text: secrets.join(' ')} : null;
    const demon = v.role.team === 'minion' && team[0];
    head = `Cover: you are evil; your true role is a secret. Claim ${pick} (${how}).${demon ? ` Tell ${demon} in a room, so you two never claim the same.` : ''}`;
    return {role: pick, text: [head, ...secrets].join(' ')};
  }
  return {role: said.role, said: said.day ?? v.day, text: [head, ...secrets].join(' ')};
}

// ---- a role that changed (#71): the Scarlet Woman who became the Imp ----
// From what the Storyteller told this seat ("You are now the Imp."), with the role it held before. Null when it never changed.
export function roleChangeOf(game, a, v, me) {
  let told;
  try {told = cleanEvents(v, me, a.events(game, me, -1)).filter(e => e.type === 'told' && typeof e.text === 'string')} catch {return null}
  let last = -1;
  told.forEach((e, k) => {if (/^You are now the /i.test(e.text)) last = k});
  if (last < 0) return null;
  const e = told[last];
  const now = v.role?.name || e.text.match(/^You are now the (.+?)\.?\s*$/i)?.[1];
  let was = null;
  for (let k = last - 1; k >= 0 && !was; k--) was = told[k].text.match(/^You are (?:now )?the (.+?)(?:\s*\(|[.:]|$)/i)?.[1] || null;
  if (!was || !now || was === now) return null;
  const byDay = e.day != null && e.day > 0 && (e.night == null || e.day >= e.night);
  const when = byDay ? `day ${e.day}` : e.night != null ? `night ${e.night}` : null;
  return {was, now, when, text: `You were the ${was}; you are the ${now} now${when ? `, since ${when}` : ''}.`};
}

// ---- notes that the game has overtaken (#71) ----
// A note stays the seat's own words; this only says when one contradicts what the seat can see now: a living player noted as
// dead, a dead one noted as alive, or a role noted as its own that is not its role now. A note about a bluff is left alone.
export const noteText = n => (typeof n === 'string' ? n : String(n?.text ?? ''));
const BLUFF = /\b(?:bluff|bluffing|pretend|pretending|fake|cover|lie|lying|story|claim|claimed|claiming|publicly|told the table|said)\b/i;
export function staleNote(text, v) {
  const t = String(text ?? '');
  for (const s of v.seats || []) {
    if (s.name === v.name) continue;
    const n = String.raw`\b` + reEsc(s.name) + String.raw`\b`;
    const dead = t.match(new RegExp(n + String.raw`(?:\s+(?:is|was|has|had|got))?(?:\s+(?:now|also|already|just|been))*\s+(?:dead|died|executed|killed)\b|` + n + String.raw`\s*\(dead\)`, 'i'));
    if (s.alive && dead) return {bit: dead[0], why: `${s.name} is alive`};
    const alive = t.match(new RegExp(n + String.raw`\s+is\s+(?:still\s+)?alive\b`, 'i'));
    if (!s.alive && alive) return {bit: alive[0], why: `${s.name} is dead`};
  }
  const mine = v.role?.name;
  if (mine && !BLUFF.test(t)) {
    const other = selfClaims(t, v.name).find(c => c.role !== mine);
    if (other) return {bit: other.said.length > 50 ? '...' + other.said.slice(-47) : other.said, why: `you are the ${mine} now`};
  }
  return null;
}
// Each stale note: {n (1-based, as my_notes counts), bit, why}.
export const staleNotes = (list, v) => (list || []).map((x, k) => ({n: k + 1, ...staleNote(noteText(x), v)})).filter(x => x.why);
// 'Stale notes: note 3 "Thea is dead" (Thea is alive). Write a fresh note.'
export function notesText(stale) {
  if (!stale?.length) return null;
  const shown = stale.slice(-2).map(s => `note ${s.n} "${s.bit}" (${s.why})`);
  return `Stale notes: ${shown.join('; ')}${stale.length > 2 ? `; ${stale.length - 2} more` : ''}. Write a fresh note.`;
}

// ---- a reason to take someone to a room (#68) ----
// Game 3 offered the rooms in 63 turns and nobody went: the offer named no one and no reason. Now, by day while the rooms
// are open and the seat is at the Square with nothing waiting, it names one player and why, from what this seat knows: its
// team-mate from what the Storyteller told it (evil only), else today's line that spoke against it or asked it something,
// else the player its own notes doubt, else a player claiming its own role. Null with no reason, or no empty room.
const DOUBT = /\b(?:suspect|suspects|suspicious|evil|demon|imp|minion|lying|liar|lies|lied|doubt|nominate|execute|don['’]?t\s+trust|not\s+trust|sus)\b/i;
const named = (name, t) => new RegExp(String.raw`\b` + reEsc(name) + String.raw`\b`, 'i').test(String(t || ''));
export function inviteOf(game, a, v, me, asked, ledger, notesList) {
  if (v.phase !== 'day' || v.winner || !v.roomsOpen || v.alive === false || !v.place || v.place.room != null || (asked && !asked.done)) return null;
  const free = (v.seats || []).filter(s => s.alive && s.name !== v.name && s.room == null);
  const room = (v.rooms || []).filter(r => !(r.seats || []).length && (r.free ?? r.size) >= 2).sort((x, y) => (x.size || 0) - (y.size || 0))[0];
  if (!room || !free.length) return null;
  const seatNamed = n => free.find(s => s.name === n);
  let pick = null;
  if (['minion', 'demon'].includes(v.role?.team)) {
    const team = (v.told || []).filter(t => t.what ? ['minion-info', 'demon-info'].includes(t.what) : /\b(?:demon|minions?)\b/i.test(t.text || ''));
    for (const t of team.reverse()) {
      const text = String(t.text || '');
      const hit = free.map(s => ({s, at: text.search(new RegExp(String.raw`\b` + reEsc(s.name) + String.raw`\b`))})).filter(x => x.at >= 0).sort((x, y) => x.at - y.at)[0];
      if (hit) {pick = {name: hit.s.name, why: `${hit.s.name} is on your team`}; break}
    }
  }
  if (!pick) {
    let evs = [];
    try {evs = cleanEvents(v, me, a.events(game, me, -1))} catch {evs = []}
    const lines = evs.filter(e => e.type === 'say' && e.from !== v.name && (e.day == null || e.day === v.day) && seatNamed(e.from) && named(v.name, e.text)).reverse();
    for (const e of lines) {
      if (DOUBT.test(e.text)) {pick = {name: e.from, why: `${e.from} spoke against you`}; break}
      if (/\?/.test(e.text)) {pick = {name: e.from, why: `${e.from} asked you a question`}; break}
    }
  }
  if (!pick) {
    for (const t of (notesList || []).map(noteText).reverse()) {
      const d = t.search(DOUBT);
      if (d < 0) continue;
      const hit = free.map(s => ({s, at: t.search(new RegExp(String.raw`\b` + reEsc(s.name) + String.raw`\b`, 'i'))})).filter(x => x.at >= 0)
        .sort((x, y) => Math.abs(x.at - d) - Math.abs(y.at - d))[0];
      if (hit) {pick = {name: hit.s.name, why: `your notes doubt ${hit.s.name}`}; break}
    }
  }
  if (!pick && v.role?.name) {
    const p = (ledger || []).find(x => x.player !== v.name && seatNamed(x.player) && x.claims.some(c => c.role === v.role.name && !c.whispered));
    if (p) pick = {name: p.player, why: `${p.player} claims to be the ${v.role.name} too`};
  }
  if (!pick) return null;
  const rn = room.name || placeNameOf(v, room.id);
  return {...pick, room: room.id, text: `Take ${pick.name} to ${rn} to talk in private (${pick.why}): invite ${pick.name}, room ${bare(rn)}. Free; rooms close when nominations open.`};
}

// ---- the forced answer: an everyone-at-once scene the seat is slow on ----
// When the game waits on every seat at once (a vote, the night's thoughts, #111) and this seat's turn has not answered, a runner
// may ask for the answer in one structured call: {tool, ask, schema}, the schema's properties being the tool's own arguments
// (vote {yes}, think {text}). The ask carries only what the seat's own header says. Null when no such scene waits on the seat.
export const THOUGHT_ASK = 'Your thought as the night ends, one sentence.';
export function forcedAsk(game, seat, api) {
  const a = apiOr(api), me = seatIndex(seat), v = a.view(game, me);
  const asked = askedOf(game, v, me, a.pendingFor(game, me));
  if (!asked || asked.done) return null;
  const obj = props => ({type: 'object', properties: props, required: Object.keys(props), additionalProperties: false});
  if (asked.kind === 'vote') return {tool: 'vote', ask: `${asked.text} Answer "yes" or "no".`, schema: obj({yes: {type: 'string', enum: ['yes', 'no']}})};
  if (asked.kind === 'thoughts') return {tool: 'think', ask: `${THOUGHT_ASK}${asked.tonight ? ` Tonight: ${asked.tonight}` : ''} First person, for yourself alone.`,
    schema: obj({text: {type: 'string', maxLength: 400}})};
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
  const change = roleChangeOf(game, a, v, me);
  let notesList = [];
  try {notesList = (typeof a.notes === 'function' && a.notes(game, me)) || []} catch {notesList = []}
  let ledger = [];
  let evs = [];
  try {evs = cleanEvents(v, me, a.events(game, me, -1))} catch {evs = []}
  try {ledger = claimsOf(v, me, a.events(game, me, -1))} catch {ledger = []}
  const poison = poisonOf(v, asked, ledger, evs);
  const invite = inviteOf(game, a, v, me, asked, ledger, notesList);
  const cover = coverOf(v, ledger);
  const lines = [
    `You are ${v.name}, the ${role.name || 'unknown role'} (${role.team || '?'}, ${sideOf(role.team)}), ${life}.${change ? ` You were the ${change.was} until ${change.when || 'lately'}.` : ''}`,
    waiting ? clockLine(v, null) : clockLine(v, me),
    `Alive (${living.length}): ${listNames(living)}.${dead.length ? ` Dead: ${listNames(dead)}.` : ''}`,
    ...(stakes ? [stakes] : []),
    newsLine(news),
    ...[v.phase === 'day' ? movesText(news) : null, placeText(v), invite ? invite.text : roomsText(v), recordText(recordOf(evs)), claimsText(ledger, v.phase === 'day' ? v.day : null, v.day), cover?.text, notesText(staleNotes(notesList, v))].filter(Boolean),
  ];
  if (asked && !asked.done) lines.push(`**WAITING ON YOU: ${asked.text}**`);
  if (waiting) lines.push(waiting.text);
  if (shot) lines.push(shot.text);
  if (poison) lines.push(poison);
  if (nudge) lines.push(nudge);
  const useful = usefulTools(v, asked, news, waiting, shot);
  lines.push(`Useful now: ${useful.join(', ')}.${useful.includes('speak') ? ' Speak without your name in front.' : ''}`);
  if (v.alive === false && v.phase === 'day' && !waiting) lines.push(`You are dead: you may still speak and whisper${v.ghostVote ? ', and vote once with your ghost vote' : ''}; there is nothing to pass.`);
  return lines.join('\n');
}
