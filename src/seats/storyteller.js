// What the Storyteller sees each turn: the state header, and the plain-words helpers its tools share (role and seat
// names, a decision and its options in words, the grimoire's tokens as short words). The Storyteller may know
// everything; what it may say goes through the game only (night information by answering a decision, narration to
// the whole table). Nothing here changes the game: every read goes through the api (src/game/api.js), bound to the
// Storyteller (forSeat), which may read any seat's view and pending but never a seat's notes or whispers.
import {SCRIPT} from '../data/script.js';
import {forSeat} from '../game/api.js';

const ST_API = forSeat('storyteller');

export const HEADER_CAP = 1200;

// ---- names ----
const roleIndex = game => game?.roleIndex || ROLE_INDEX;
const ROLE_INDEX = Object.fromEntries(SCRIPT.roles.map(r => [r.id, r]));
export const roleLabel = (game, id) => roleIndex(game)[id]?.name || String(id);
export const seatLabel = (game, i) => game?.seats?.[i]?.name ?? `seat ${i}`;
export const phaseOf = game => (game.winner || game.phase === 'end' || game.phase === 'ended' ? 'ended' : game.phase);

// A role or seat named by an agent: the official name, the id, or a seat's name, any case. null when unknown.
export function roleFromWord(game, word) {
  const w = String(word).trim().toLowerCase().replace(/^the\s+/, '');
  for (const r of Object.values(roleIndex(game))) if (r.id === w || r.name.toLowerCase() === w || r.id === w.replace(/\s+/g, '-')) return r.id;
  return null;
}
export function seatFromWord(game, word) {
  const w = String(word).trim().toLowerCase();
  const s = (game.seats || []).find(x => String(x.name).toLowerCase() === w);
  return s ? s.index : null;
}

// ---- a decision in plain words ----
export const KIND_WORDS = {
  'believed-role': 'the Drunk\'s false role',
  'red-herring': 'the Fortune Teller\'s red herring',
  'demon-bluffs': 'the demon\'s bluffs',
  choose: 'a player\'s choice',
  info: 'night information',
  register: 'how a role registers',
  'mayor-bounce': 'where the demon\'s kill on the Mayor lands',
  'star-pass': 'which minion becomes the demon',
  nomination: 'the nominations',
  vote: 'the vote',
};

// One answer value in words, by the kind of decision it answers.
export function valueWords(game, p, v) {
  if (v === null || v === undefined) return 'nobody (end it)';
  if (Array.isArray(v)) return v.map(x => valueWords(game, {...p, count: undefined}, x)).join(', ');
  if (typeof v === 'object') {
    if (v.none) return 'there are no outsiders in play';
    if (Array.isArray(v.players)) return `one of ${v.players.map(i => seatLabel(game, i)).join(' and ')} is the ${roleLabel(game, v.role)}`;
    if ('by' in v && 'target' in v) return `${seatLabel(game, v.by)} nominates ${seatLabel(game, v.target)}`;
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return roleLabel(game, v);
  if (typeof v === 'number') {
    const seatKinds = ['red-herring', 'mayor-bounce', 'star-pass', 'choose'];
    if (seatKinds.includes(p.kind)) {
      if (p.kind === 'mayor-bounce' && v === p.subject) return `${seatLabel(game, v)} (the Mayor dies)`;
      return seatLabel(game, v);
    }
    return String(v);
  }
  return String(v);
}

// The truth of a decision, where the rules have one: the true information, or the role registering as itself.
export function truthWords(game, p) {
  if (p.kind === 'info' && Array.isArray(p.truth)) return p.truth.length ? p.truth.map(v => valueWords(game, p, v)).join(' | ') : 'nothing true to say';
  if (p.kind === 'register') return `${roleLabel(game, p.options[0])} (registers as itself)`;
  if (p.kind === 'mayor-bounce') return `${seatLabel(game, p.subject)} dies (no bounce)`;
  return null;
}

// Why the decision is asked, and whether the ability it serves malfunctions.
export function malfunctionWords(game, p) {
  if (!p.malfunctioning) return null;
  const s = game.seats?.[p.subject];
  const drunk = s && roleIndex(game)[s.role]?.disguise;
  return `${seatLabel(game, p.subject)} is ${drunk ? 'the Drunk' : 'poisoned'}: any option is legal`;
}

// The whole decision for the Storyteller: a plain object a tool returns and the header shortens.
export function describePending(game, p, {max = 40} = {}) {
  const truth = truthWords(game, p), bad = malfunctionWords(game, p);
  const opts = (p.options || []).map((v, k) => `#${k + 1} ${valueWords(game, p, v)}`);
  return {
    kind: p.kind,
    what: KIND_WORDS[p.kind] || p.kind,
    question: p.question,
    about: p.subject != null ? seatLabel(game, p.subject) : null,
    role: p.role ? roleLabel(game, p.role) : null,
    ...(truth ? {truth} : {}),
    ...(p.why ? {why: p.why} : {}),
    malfunctioning: !!p.malfunctioning,
    ...(bad ? {note: bad + '; choose what makes the best game'} : {}),
    pick: p.count ? `exactly ${p.count} different options` : 'one option',
    options: opts.length > max ? [...opts.slice(0, max), `... and ${opts.length - max} more of the same form`] : opts,
    count: opts.length,
    howToAnswer: howToAnswer(game, p),
  };
}

export function howToAnswer(game, p) {
  const o = p.options?.[0];
  if (p.count) return `decide with value listing ${p.count} picks by name or number, e.g. "${(p.options || []).slice(0, p.count).map((_, k) => '#' + (k + 1)).join(', ')}"`;
  if (o && typeof o === 'object' && Array.isArray(o.players)) return 'decide with value "Name, Name, Role" (two players and a role), or "none", or an option number like "#3"';
  return 'decide with value as a name or an option number like "#2"';
}

// ---- the grimoire in short words ----
const TOKEN_WORDS = {
  poisoned: 'poisoned', 'red-herring': 'red herring', protected: 'safe tonight', master: 'Butler\'s master',
  'no-ability': 'ability used', executed: 'executed yesterday', dead: 'dead', 'registers-as': 'registers as',
};
export function tokenWords(game, t) {
  let w = TOKEN_WORDS[t.token];
  if (t.token === 'registers-as') w = `registers as ${roleLabel(game, t.value)}`;
  else if (t.token === 'is-the-demon') w = `new demon (was ${roleLabel(game, t.role)})`;
  else if (/^is-the-/.test(t.token)) w = `is the ${roleLabel(game, t.role)}${t.value ? ', thinks ' + roleLabel(game, t.value) : ''}`;
  else if (!w) w = String(t.token).replace(/-/g, ' ');
  if (t.by != null && t.token !== 'registers-as' && !/^is-the-/.test(t.token)) w += ` by ${seatLabel(game, t.by)}`;
  if (t.active === false) w += ' (no effect)';
  return w;
}

// The api's grimoire with who placed each token (from the live seats when the api's copy leaves it out).
export function grimoireRows(game, api) {
  const got = api.grimoire(game) || [], g = Array.isArray(got) ? got : got.seats || [];
  return g.map(r => {
    const live = game.seats?.[r.seat]?.tokens || [];
    return {...r, tokens: (r.tokens || []).map((t, k) => (t.by === undefined && live[k] && live[k].token === t.token ? {...t, by: live[k].by} : t))};
  });
}

export function grimoireLine(game, r) {
  const role = roleLabel(game, r.role), thinks = r.believed && r.believed !== r.role ? ` (thinks ${roleLabel(game, r.believed)})` : '';
  const life = r.alive ? 'alive' : r.ghostVote ? 'dead, ghost vote' : 'dead, no vote';
  const toks = (r.tokens || []).filter(t => !/^is-the-/.test(t.token) || t.token === 'is-the-demon').map(t => tokenWords(game, t));
  return `${r.name}: ${role}${thinks}, ${life}${toks.length ? '; ' + toks.join(', ') : ''}`;
}

// ---- what was said: the Storyteller never reads a whisper's words ----
// Only what the table heard (audience 'all'): the Storyteller's own rulings and the seats' private tellings stay out.
export function tableEvents(game, api, since = 0) {
  const evs = (api.events(game, 'storyteller', since) || []).filter(e => e.audience === undefined || e.audience === 'all' || e.type === 'whisper');
  const marks = evs.some(e => e.type === 'whisper-seen');
  return evs.filter(e => !(marks && e.type === 'whisper'))
    .map(e => (e.type === 'whisper' ? {id: e.id, type: 'whisper-seen', day: e.day, night: e.night, from: e.from, to: e.to} : e));
}

export function eventWords(game, e) {
  switch (e.type) {
    case 'say': return `${seatLabel(game, e.seat)}: ${e.text}`;
    case 'whisper-seen': return `(${seatLabel(game, e.from)} whispers to ${seatLabel(game, e.to)})`;
    default: return e.text || e.type;
  }
}

// What the Storyteller saw last: the id of the newest event when its last header was built. Per live game.
const seen = new WeakMap();
export const lastSeen = game => seen.get(game) || 0;
export const markSeen = (game, id) => {if (id > lastSeen(game)) seen.set(game, id)};

// ---- the day ----
export function clockWords(game) {
  const ph = phaseOf(game);
  if (ph === 'setup') return 'Setup, before the first night';
  if (ph === 'night') return `Night ${game.night}${game.step ? ' (now: ' + stepWords(game, game.step) + ')' : ''}`;
  if (ph === 'ended') return `The game is over: ${game.winner?.text || 'it has ended'}`;
  const c = game.clock || {};
  const round = c.round != null ? `, round ${c.round} of ${c.roundsBeforeNominations ?? '?'}` : '';
  const open = c.nominationsOpen ?? game.step === 'nominations';
  return `Day ${game.day}${round}, nominations ${open ? 'open' : 'closed'}`;
}
const stepWords = (game, step) => (roleIndex(game)[step] ? 'the ' + roleLabel(game, step) : String(step).replace(/-/g, ' '));

// The table's open vote, when one is open: nominee, nominator, who has voted, how many are needed.
export function openVote(game) {
  const p = game.pending;
  if (!p || p.kind !== 'vote') return null;
  const ballot = game.ballot && 'votes' in game.ballot ? game.ballot.votes : game.ballot || {}, alive = (game.seats || []).filter(s => s.alive).length;
  return {nominee: seatLabel(game, p.nominee), nominator: seatLabel(game, p.nominator), voters: p.seats.length,
    voted: Object.keys(ballot).length, yes: Object.values(ballot).filter(Boolean).length, needed: Math.ceil(alive / 2)};
}

// What the game is waiting on when it is not the Storyteller.
export function waitingOn(game) {
  const p = game.pending;
  if (!p) return phaseOf(game) === 'ended' ? 'nothing: the game is over' : 'nothing';
  if (p.seat === 'storyteller') return 'you';
  if (p.kind === 'choose') return `${seatLabel(game, p.seat)} (${roleLabel(game, p.role)}) to make a choice`;
  if (p.kind === 'vote') return `the table to vote on ${seatLabel(game, p.nominee)}`;
  if (p.kind === 'nomination') return 'the table: nominations';
  return String(p.seat);
}

// The tools that fit now, two or three.
export function toolsNow(game, mine) {
  const ph = phaseOf(game);
  if (mine) return ['what_is_asked', 'decide', 'fallback'];
  if (ph === 'ended') return ['narrate', 'rulings'];
  if (ph === 'day') {
    if (game.pending?.kind === 'vote') return ['day_state', 'close_vote'];
    const c = game.clock || {};
    if (game.step === 'dawn' || (c.round === 1 && !c.nominationsOpen && !(c.spoke || []).length)) return ['narrate', 'talk', 'open_nominations'];
    return game.clock?.nominationsOpen ? ['day_state', 'end_day'] : ['talk', 'open_nominations', 'end_day'];
  }
  return ['night_order', 'grimoire'];
}

// The state header for one Storyteller turn. Short: the phase, the grimoire one line a seat, the decision waiting
// (in bold), what was said since the last header (counted), the tools that fit now.
export function storytellerHeader(game, api = ST_API) {
  const lines = [], ph = phaseOf(game);
  const alive = (game.seats || []).filter(s => s.alive).length;
  lines.push(`Storyteller. ${clockWords(game)}. ${alive} of ${(game.seats || []).length} alive.`);
  for (const r of grimoireRows(game, api)) lines.push('- ' + grimoireLine(game, r));
  const p = api.pendingFor(game, 'storyteller');
  if (p) {
    const d = describePending(game, p);
    const all = d.options.join('; ');
    const onlyTruth = p.kind === 'info' && !p.malfunctioning && Array.isArray(p.truth) && p.truth.length === d.count;
    const opts = onlyTruth ? `the truth only, #1 to #${d.count}` : all.length <= 400 && d.count <= 16 ? all : `${d.count} options (what_is_asked lists them)`;
    lines.push(`**Waiting on you: ${d.what}${d.about ? ' for ' + d.about : ''}.** ${p.question}`);
    if (d.truth) {
      const ts = d.truth.split(' | '), truth = ts.length > 3 ? `${ts.slice(0, 3).join(' | ')} | and ${ts.length - 3} more true` : d.truth;
      lines.push(`Truth: ${truth}.${d.malfunctioning ? ' ' + malfunctionWords(game, p) + '.' : ''}`);
    }
    lines.push(`Legal (${d.pick}): ${opts}`);
  } else if (ph !== 'ended') {
    lines.push(`Waiting on ${waitingOn(game)}.`);
    const v = openVote(game);
    if (v) lines.push(`Vote on ${v.nominee} (by ${v.nominator}): ${v.voted} of ${v.voters} voted, ${v.yes} yes, ${v.needed} needed.`);
  }
  if (ph !== 'setup') {
    const evs = tableEvents(game, api, lastSeen(game));
    const said = evs.filter(e => e.type === 'say').length, wh = evs.filter(e => e.type === 'whisper-seen').length;
    const other = evs.filter(e => e.type !== 'say' && e.type !== 'whisper-seen' && !(ph === 'night' && e.type === 'phase')).length;
    lines.push(`Since your last turn: ${said} said, ${wh} whispers seen, ${other} other events.`);
    if (evs.length) markSeen(game, Math.max(...evs.map(e => e.id || 0)));
  }
  lines.push(`Now: ${toolsNow(game, !!p).join(', ')}.`);
  let out = lines.join('\n');
  if (out.length > HEADER_CAP) out = out.slice(0, HEADER_CAP - 1) + '…';
  return out;
}
