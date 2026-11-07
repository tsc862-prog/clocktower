// What a player seat sees at the top of each turn: the state header, and what is new since its last look. Built only
// from the api's seat-scoped reads (view, pendingFor, events), so a header can carry nothing the seat may not know.
// Pure: no node: imports, no model calls. The tool table (src/data/player-tools.js) shares the helpers below.
//
// The api: the slice 3 contract's src/game/api.js. Until it is on main, the backend (or a test) hands it in with
// useApi(api) or as playerHeader's third argument; once it lands it is imported here directly.
let API = null;
export const useApi = api => {API = api; return api};
const apiOr = api => {
  const a = api || API;
  if (!a) throw new Error('No game api: call useApi(api) first.');
  return a;
};

// The seat index from an index or {index, name}.
export const seatIndex = seat => (seat && typeof seat === 'object' ? seat.index : seat);

// ---- what a seat has seen ----
// The id of the last event each seat has read (read_talk advances it). Kept beside the game, not in it: handlers never
// change the game except through the api. A restarted relay forgets it, and the seat sees the recent talk again.
const SEEN = new WeakMap();
const seenMap = game => {let m = SEEN.get(game); if (!m) {m = new Map(); SEEN.set(game, m)} return m};
export const lastSeen = (game, seat) => seenMap(game).get(seatIndex(seat)) ?? 0;
export const markSeen = (game, seat, id) => {
  const m = seenMap(game), i = seatIndex(seat);
  if (Number.isFinite(id) && id > (m.get(i) ?? 0)) m.set(i, id);
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
export const EVENT_KINDS = ['say', 'whisper', 'whisper-seen', 'dawn', 'nomination', 'vote-result', 'execution', 'narration', 'phase', 'told'];
export function cleanEvent(view, me, e) {
  if (!e || typeof e !== 'object' || !EVENT_KINDS.includes(e.type)) return null;
  const from = e.from ?? e.seat ?? e.by, to = e.to ?? e.target;
  const isMe = x => x === me || (x != null && x === view?.name);
  if (e.type === 'whisper' && !isMe(from) && !isMe(to)) return null;
  if (e.type === 'told' && e.seat != null && !isMe(e.seat)) return null;
  const out = {id: e.id, type: e.type};
  if (e.day != null) out.day = e.day;
  if (e.night != null) out.night = e.night;
  if (e.type === 'say') out.from = nameOf(view, from);
  if (e.type === 'whisper' || e.type === 'whisper-seen') {out.from = nameOf(view, from); out.to = nameOf(view, to)}
  if (e.type === 'nomination') {out.by = nameOf(view, e.by); out.target = nameOf(view, e.target)}
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
  const said = evs.filter(e => e.type === 'say' && e.from !== view.name).length;
  const out = {since: from, last: evs.length ? evs[evs.length - 1].id : from, said,
    whispers: evs.filter(e => e.type === 'whisper' && e.from !== view.name).length, seen: n('whisper-seen'),
    nominations: n('nomination'), votes: n('vote-result'), dawn: n('dawn'), deaths: n('execution'), narration: n('narration'),
    told: n('told'), phase: n('phase')};
  out.total = said + out.whispers + out.seen + out.nominations + out.votes + out.dawn + out.deaths + out.narration + out.told + out.phase;
  return out;
}
export function newsLine(w) {
  const parts = [];
  const add = (k, one, many) => {if (w[k]) parts.push(`${w[k]} ${w[k] === 1 ? one : many}`)};
  add('said', 'line at the table', 'lines at the table');
  add('whispers', 'whisper to you', 'whispers to you');
  add('seen', 'whisper seen', 'whispers seen');
  add('nominations', 'nomination', 'nominations');
  add('votes', 'vote result', 'vote results');
  add('dawn', 'dawn report', 'dawn reports');
  add('deaths', 'execution', 'executions');
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
    const role = (p.role && p.role === view.role?.id ? view.role.name : optionLabel(game, view, p.role)) || view.role?.name || 'your role';
    const options = (p.options || []).map(o => optionLabel(game, view, o));
    const count = p.count || 1;
    const what = String(p.question || '').replace(/^[^:]*:\s*/, '').replace(/[.?!\s]+$/, '') || 'make your choice';
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
export function clockLine(v) {
  if (v.phase === 'night') return `Night ${v.night}. Nobody talks at night.`;
  if (v.phase === 'day') {
    const c = v.clock || {};
    const round = c.roundsBeforeNominations ? `round ${Math.min(c.round || 1, c.roundsBeforeNominations)} of ${c.roundsBeforeNominations}` : 'talking';
    return `Day ${v.day}, ${round}; nominations ${c.nominationsOpen ? 'open' : 'not open yet'}.`;
  }
  if (v.phase === 'ended') return `The game is over${v.winner ? `: ${v.winner.team || v.winner} wins` : ''}.`;
  return 'The game is being set up.';
}
export function usefulTools(v, asked, news) {
  if (asked?.tool === 'night_choice') return ['night_choice', 'what_is_asked', 'my_role'];
  if (asked?.kind === 'vote' && !asked.done) return ['vote', 'who_voted', 'read_talk'];
  if (asked?.kind === 'nomination') return ['nominate', 'pass', 'read_talk'];
  if (v.phase === 'ended') return ['look', 'read_talk'];
  if (v.phase === 'night' || v.phase === 'setup') return ['my_role', 'my_notes', 'note'];
  return news?.total ? ['read_talk', 'speak', 'whisper'] : ['speak', 'whisper', 'pass'];
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
  const lines = [
    `You are ${v.name}, the ${role.name || 'unknown role'} (${role.team || '?'}, ${sideOf(role.team)}), ${life}.`,
    clockLine(v),
    `Alive (${living.length}): ${listNames(living)}.${dead.length ? ` Dead: ${listNames(dead)}.` : ''}`,
    newsLine(news),
  ];
  if (asked && !asked.done) lines.push(`**WAITING ON YOU: ${asked.text}**`);
  lines.push(`Useful now: ${usefulTools(v, asked, news).join(', ')}.`);
  return lines.join('\n');
}
