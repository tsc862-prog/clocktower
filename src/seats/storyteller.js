// What the Storyteller sees each turn: the state header, and the plain-words helpers its tools share (role and seat
// names, a decision and its options in words, the grimoire's tokens as short words). The Storyteller may know
// everything; what it may say goes through the game only (night information by answering a decision, narration to
// the whole table). Nothing here changes the game: every read goes through the api (src/game/api.js), bound to the
// Storyteller (forSeat), which may read any seat's view and pending but never a seat's notes or whispers.
import {SCRIPT} from '../data/script.js';
import {forSeat} from '../game/api.js';
import {touchFor} from '../data/colour.js';

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
  return null; // the Mayor's bounce has no truth: where the kill lands is the Storyteller's call (#90), see choiceWords
}

// A call the rules leave wholly to the Storyteller, said so plainly (#90: a Mayor ruling called "no bounce" the true outcome).
export function choiceWords(game, p) {
  if (p.kind !== 'mayor-bounce') return null;
  const m = seatLabel(game, p.subject), others = (p.options || []).filter(v => v !== p.subject).length;
  return `Your call, not a rule: the kill may land on ${m} (the Mayor dies) or bounce to any of ${others} other players; neither is "the truth". Weigh how close the game is and who a bounce would hit, and say what you weighed`;
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
  const truth = truthWords(game, p), bad = malfunctionWords(game, p), choice = choiceWords(game, p);
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
    ...(choice ? {yourCall: choice} : {}),
    pick: p.count ? `exactly ${p.count} different options` : 'one option',
    options: opts.length > max ? [...opts.slice(0, max), `... and ${opts.length - max} more of the same form`] : opts,
    count: opts.length,
    offered: offeredWords(p),
    howToAnswer: howToAnswer(game, p),
  };
}

// The option count stated plainly, every time: "20 options offered, pick one" or "1 option offered: it is the only legal answer".
export function offeredWords(p) {
  const n = (p.options || []).length;
  if (p.count) return `${n} options offered, pick exactly ${p.count}`;
  return n === 1 ? '1 option offered: it is the only legal answer' : `${n} options offered, pick one`;
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

// ---- the true clock, deaths and executions: what a narration may say ----
export function nominationsWords(game) {
  const c = game.clock || {};
  if (phaseOf(game) !== 'day') return null;
  const open = c.nominationsOpen ?? game.step === 'nominations';
  return open ? 'nominations are OPEN' : `nominations are CLOSED (they open when round ${c.roundsBeforeNominations ?? '?'} is done${c.round != null ? `; it is round ${c.round}` : ''})`;
}
const diedNames = game => (game.diedTonight || []).map(i => seatLabel(game, i));
// A quiet night in words (#110): the first night never has a death by the rules (the demon does not kill on it), so day 1's
// dawn says so as the rule it is; from day 2 a quiet night is news.
export const FIRST_NIGHT_QUIET = 'the first night passes without a death, as it always does';
export const quietWords = day => (day === 1 ? FIRST_NIGHT_QUIET : 'nobody died in the night');
const deathWords = (deaths, day) => (deaths.length ? `${deaths.join(' and ')} died in the night` : quietWords(day));
export const diedWords = game => deathWords(diedNames(game), game.day);
const executedNames = game => (game.executed || []).map(e => seatLabel(game, e.seat));
export const executedWords = game => (executedNames(game).length ? `executed so far: ${executedNames(game).join(', ')}` : 'nobody has been executed yet');

// A narration against the game: an error naming the truth when it states a clock fact that is false, or tells the owed
// happening otherwise than it happened, else null.
export function narrationError(game, text, api = ST_API) {
  const ph = phaseOf(game), sentences = String(text).split(/(?<=[.!?])\s+/);
  const names = sent => (game.seats || []).map(x => x.name).filter(n => new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sent));
  const dated = t => /\bday\s*\d|yesterday|last (?:day|night)/i.test(t);
  for (const t of sentences) {
    if (ph === 'day' && /nominat/i.test(t) && !/\b(not|n't|yet|until|before|once|when|after|will|soon|then|if)\b/i.test(t)) {
      const claimsOpen = /\bopen/i.test(t) && !/\bclosed?\b/i.test(t), claimsShut = /\b(closed|shut)\b/i.test(t);
      const open = game.clock?.nominationsOpen ?? game.step === 'nominations';
      if ((claimsOpen && !open) || (claimsShut && open)) return `Not true: ${nominationsWords(game)}. Say that, or leave the clock out.`;
    }
    if (ph === 'day' && /\b(died|dies|dead|killed|perished)\b/i.test(t) && /\b(night|dawn|overnight|tonight)\b/i.test(t)) {
      const nobody = /\b(nobody|no one|none)\b/i.test(t), who = names(t);
      if (nobody && diedNames(game).length) return `Not true: ${diedWords(game)}. Say who died.`;
      if (!nobody && who.length && !who.some(n => diedNames(game).includes(n))) return `Not true: ${diedWords(game)}; ${who.join(' and ')} did not die last night.`;
    }
    if (/\b(executed|hanged)\b/i.test(t) && !/\b(will|would|if|may|might|could|be executed)\b/i.test(t) && !dated(t)) {
      const nobody = /\b(nobody|no one)\b/i.test(t), who = names(t);
      if (nobody && game.today?.executed != null) return `Not true: ${seatLabel(game, game.today.executed)} was executed today.`;
      if (!nobody && who.length && !who.some(n => executedNames(game).includes(n))) return `Not true: ${executedWords(game)}.`;
    }
  }
  // the owed narration as it happened (#90): a death by a nomination had no vote; a shot that missed killed nobody; the end
  // names the side that won
  let owed = null; try {owed = narrationOwed(game, api)} catch {}
  const all = String(text), esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (owed?.kind === 'execution' && owed.how === 'virgin' && /\bvot(?:e|ed|es|ing)\b/i.test(all) && !/\b(?:no|without|never|nor|not|before any|before a)\b[^.;]{0,30}\bvot/i.test(all)) {
    return `Not true: ${owed.fact}. Say what happened as it happened.`;
  }
  if (owed?.kind === 'shot' && !owed.died && new RegExp(`\\b${esc(owed.name)}\\b[^.;]{0,40}\\b(?:died|dies|dead|fell|killed)\\b`, 'i').test(all) && !/\b(?:not|n't|never|no)\b/i.test(all)) {
    return `Not true: ${owed.fact}.`;
  }
  if (owed?.kind === 'end' && (owed.team === 'good' || owed.team === 'evil')) {
    const other = owed.team === 'good' ? 'evil' : 'good';
    if (new RegExp(`\\b${other}\\b[^.;]{0,40}\\b(?:wins?|won|prevails?|prevailed|triumphs?|triumphed)\\b`, 'i').test(all)) return `Not true: ${owed.text}.`;
  }
  return null;
}

// The dawn of this day, when it has not been narrated: {day, deaths: [names], touch}; null when none is owed.
export function dawnOwed(game, api = ST_API) {
  if (phaseOf(game) !== 'day') return null;
  const evs = tableEvents(game, api, 0), dawn = evs.filter(e => e.type === 'dawn' && e.day === game.day).at(-1);
  if (!dawn || evs.some(e => e.type === 'narration' && e.id > dawn.id)) return null;
  return {day: game.day, deaths: diedNames(game), touch: touchFor(seedOf(game), game.day, 'dawn')};
}
const seedOf = game => game?.config?.seed ?? 0;

// ---- what happened by day, as it happened (#90): an execution by the vote, one at once by a nomination (the Virgin), a shot ----
// The day's public happenings after event id `after`: executions and shots, each with how it came about. Never a role: the
// facts are what the table saw. [{kind: 'execution'|'shot', how, day, seat, name, fact, ...}]
export function dayHappenings(game, evs, after = 0) {
  const out = [];
  for (const e of evs) {
    if (!(e.id > after)) continue;
    if (e.type === 'execution' && Number.isInteger(e.seat)) {
      const name = seatLabel(game, e.seat), day = e.day ?? game.day;
      const how = e.how || (game.executed || []).find(x => x.seat === e.seat && (x.day ?? day) === day)?.how || 'vote';
      if (how === 'virgin') {
        const v = evs.filter(x => x.type === 'virgin' && x.id < e.id && x.nominator === e.seat).at(-1);
        const nominee = v && Number.isInteger(v.seat) ? seatLabel(game, v.seat) : null;
        out.push({kind: 'execution', how, day, seat: e.seat, name, nominee,
          fact: `${name} nominated ${nominee || 'a player'} and was executed at once on Day ${day}, by the nomination itself: no vote was taken`});
      } else {
        const vote = evs.filter(x => x.type === 'vote' && x.id < e.id && x.block && x.block.seat === e.seat && (x.day ?? day) === day).at(-1);
        const tally = vote && Number.isFinite(vote.tally) ? `, ${vote.tally} votes${Number.isFinite(vote.need) ? ` (${vote.need} needed)` : ''}${Number.isInteger(vote.by) ? `, nominated by ${seatLabel(game, vote.by)}` : ''}` : '';
        out.push({kind: 'execution', how: 'vote', day, seat: e.seat, name, fact: `${name} was executed at dusk on Day ${day}, by the town's vote${tally}`});
      }
    } else if (e.type === 'slayer-shot' && Number.isInteger(e.target)) {
      const shooter = seatLabel(game, e.seat), target = seatLabel(game, e.target), day = e.day ?? game.day;
      const died = evs.some(x => x.type === 'death' && x.seat === e.target && x.id > e.id && (x.cause ?? 'slayer') === 'slayer');
      out.push({kind: 'shot', how: 'shot', day, seat: e.target, name: target, shooter, died,
        fact: `${shooter} shot at ${target} on Day ${day}: ${died ? `${target} fell dead` : `nothing happened, ${target} lives`}`});
    }
  }
  return out;
}

// The last execution or shot the table has not heard the Storyteller on (no narration and no dawn since):
// {kind: 'execution'|'shot', day, name, how, fact, touch, also: [earlier facts not yet narrated]}; null when none is owed.
export function executionOwed(game, api = ST_API) {
  const ph = phaseOf(game);
  if (ph !== 'day' && ph !== 'night') return null;
  const evs = tableEvents(game, api, 0);
  const told = evs.filter(e => e.type === 'narration' || e.type === 'dawn').at(-1)?.id ?? 0;
  const hs = dayHappenings(game, evs, told);
  if (!hs.length) return null;
  const last = hs.at(-1);
  return {...last, touch: touchFor(seedOf(game), last.day, 'dusk'), also: hs.slice(0, -1).map(h => h.fact)};
}

// The end of the game, when it has not been narrated: {text, team, unheard: [facts the table never heard told], roles: [...]}.
export function endOwed(game, api = ST_API) {
  if (phaseOf(game) !== 'ended') return null;
  const evs = tableEvents(game, api, 0), win = evs.filter(e => e.type === 'win').at(-1);
  if (evs.some(e => e.type === 'narration' && (!win || e.id > win.id))) return null;
  const w = game.winner || {}, told = evs.filter(e => e.type === 'narration' || e.type === 'dawn').at(-1)?.id ?? 0;
  const unheard = dayHappenings(game, evs, told).map(h => h.fact);
  // a game that ends in the night ends before its dawn (last, as it came last): the night's deaths were never told (#90: game 4's last night)
  if (w.phase === 'night' && diedNames(game).length) unheard.push(`in the night ${diedNames(game).join(' and ')} died`);
  const roles = (game.seats || []).map(s => `${s.name} the ${roleLabel(game, s.role)}${s.believed && s.believed !== s.role ? ` (believed ${roleLabel(game, s.believed)})` : ''}`);
  return {text: w.text || win?.text || 'the game has ended', team: w.team || win?.team || null, unheard, roles};
}

// The narration the table is owed now, the first of: the end, the dawn, an execution or a shot. {kind, ...} or null.
export function narrationOwed(game, api = ST_API) {
  try {
    const end = endOwed(game, api); if (end) return {...end, kind: 'end'};
    const dawn = dawnOwed(game, api); if (dawn) return {...dawn, kind: 'dawn'};
    const ex = executionOwed(game, api); if (ex) return {...ex, kind: ex.kind === 'shot' ? 'shot' : 'execution'};
  } catch {}
  return null;
}
const owedWhy = owed => owed.kind === 'dawn' ? `the dawn of day ${owed.day} is not yet narrated`
  : owed.kind === 'execution' ? `${owed.name}'s execution is not yet narrated`
  : owed.kind === 'shot' ? `${owed.shooter}'s shot at ${owed.name} is not yet narrated`
  : 'the end of the game is not yet narrated';

// The owed narration in the header: the call (its first line) and the makings of the line (what happened and how, a touch).
export function owedLines(game, owed) {
  if (!owed) return [];
  const notRole = 'about the person, never a role, nothing that echoes what they claimed';
  if (owed.kind === 'dawn') {
    const died = deathWords(owed.deaths, owed.day);
    const first = owed.day === 1 && !owed.deaths.length ? ' The first night is quiet by the rules, not by luck: no reprieve, no demon that spared anyone.' : '';
    const person = owed.deaths.length ? ` A death deserves a sentence about the person: ${owed.deaths.join(' and ')} as a neighbour (where found, what is left), never a role, nothing that echoes what they claimed.` : '';
    return [`DAWN NOT YET NARRATED (Day ${owed.day}): ${died}. Narrate it now, before anything else.`,
      `Makings: Day ${owed.day}; ${died}; touch of the town: ${owed.touch}. Exactly two sentences: what happened, then the touch in your words.${first}${person}`];
  }
  const also = owed.also?.length ? ` Also not yet told: ${owed.also.join('; ')}.` : '';
  if (owed.kind === 'execution' && owed.how === 'virgin') {
    return [`EXECUTION NOT YET NARRATED: ${owed.fact}. Narrate it now, before anything else.`,
      `Makings: ${owed.name} died the moment the nomination was made: no vote, no wait for dusk; touch: ${owed.touch}. One sentence: what happened as it happened, ${notRole}.${also}`];
  }
  if (owed.kind === 'execution') {
    return [`EXECUTION NOT YET NARRATED: ${owed.fact}. Narrate it now, before anything else.`,
      `Makings: ${owed.name}, put to death by the vote, and the dusk: ${owed.touch}. One sentence: the execution and that touch in your own words, ${notRole}.${also}`];
  }
  if (owed.kind === 'shot') {
    return [`SHOT NOT YET NARRATED: ${owed.fact}. Narrate it now, before anything else.`,
      `Makings: ${owed.shooter} fired at ${owed.name} in front of the town; ${owed.died ? `${owed.name} fell dead` : 'nothing happened'}. One sentence: what came of it, ${owed.died ? 'about the person' : 'plainly'}, never a role (not even the one claimed).${also}`];
  }
  const unheard = owed.unheard?.length ? ` Not yet told: ${owed.unheard.join('; ')}.` : '';
  return [`THE END NOT YET NARRATED: ${owed.text}. Narrate it now, before anything else.`,
    `Makings:${unheard} Who was who: ${owed.roles.join(', ')}. Two or three sentences: what happened last, who won and how, and who the demon and its minions were; roles may be named now.`];
}

// A plain narration of what is owed, for the scripted fallback (the runner gone and the owner resumed): the facts, no colour.
const sentence = f => f.charAt(0).toUpperCase() + f.slice(1) + '.';
export function scriptedNarration(game, owed) {
  if (!owed) return null;
  if (owed.kind === 'dawn') return `Day ${owed.day} begins in Thistlewick: ${deathWords(owed.deaths, owed.day)}.`;
  if (owed.kind === 'execution' || owed.kind === 'shot') return [...(owed.also || []), owed.fact].map(sentence).join(' ');
  const t = `The game is over: ${owed.text}.${owed.unheard?.length ? ' ' + owed.unheard.map(sentence).join(' ') : ''} Who was who: ${owed.roles.join(', ')}.`;
  return t.length > 600 ? t.slice(0, 597) + '...' : t;
}

// The day is done: nominations open, nothing on the table, every living seat has nominated or passed on nominating.
export function dayDone(game) {
  if (phaseOf(game) !== 'day' || game.pending?.kind !== 'nomination') return false;
  const c = game.clock || {}, t = game.today || {};
  if (!c.nominationsOpen) return false;
  const nominators = t.nominators || [], passed = c.passedNominating || [];
  const alive = (game.seats || []).filter(s => s.alive);
  return alive.length > 0 && alive.every(s => nominators.includes(s.index) || passed.includes(s.index));
}

// What is due from the Storyteller now, for the header and for the pace (a due act is worth an urgent wake): {tool, why} or null.
// null means nothing waits on it: a turn now could only read.
export function storytellerDue(game, api = ST_API) {
  if (!game) return null;
  let p = null;
  try {p = api.pendingFor(game, 'storyteller')} catch {}
  const owed = narrationOwed(game, api);
  if (owed) return {tool: 'narrate', why: owedWhy(owed)};
  if (p) return {tool: 'decide', why: `${KIND_WORDS[p.kind] || p.kind} waits on you`};
  if (dayDone(game)) return {tool: 'end_day', why: 'every living player has nominated or passed'};
  return null;
}

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

// The tools that fit now, two or three, an acting tool first whenever one is due: narrate when a narration is owed (the dawn,
// an execution, the end), decide when a decision waits, end_day when every living seat has nominated or passed. `owed`: a
// narration is owed (narrationOwed); undefined when the caller does not know (an older caller), false when none is.
export function toolsNow(game, mine, owed = undefined) {
  const ph = phaseOf(game);
  if (owed) return ['narrate', ...toolsNow(game, mine, false).filter(t => t !== 'narrate')].slice(0, 3);
  if (mine) return ['decide', 'what_is_asked', 'fallback'];
  if (ph === 'ended') return ['narrate', 'rulings'];
  if (ph === 'day') {
    if (game.pending?.kind === 'vote') return ['day_state', 'close_vote'];
    if (dayDone(game)) return ['end_day', 'day_state'];
    const c = game.clock || {};
    if (owed === undefined && (game.step === 'dawn' || (c.round === 1 && !c.nominationsOpen && !(c.spoke || []).length))) return ['narrate', 'talk', 'open_nominations'];
    return c.nominationsOpen ? ['day_state', 'end_day'] : ['talk', 'open_nominations', 'end_day'];
  }
  return ['night_order', 'grimoire'];
}
// The "Now:" line: the tools in order; an act that is due is named; when nothing is due, a turn that only reads is wasted.
export function nowLine(game, mine, owed) {
  const tools = toolsNow(game, mine, owed);
  if (owed || mine || tools[0] === 'end_day') return `Now: ${tools.join(', ')}. Act first: ${tools[0]} is due.`;
  return `Now: ${tools.join(', ')}. Nothing is due from you: unless the talk needs a ruling or the day needs moving, end this turn without a call (a turn that only reads is wasted).`;
}

// The state header for one Storyteller turn. Short: the phase, the grimoire one line a seat, the decision waiting
// (in bold), what was said since the last header (counted), the tools that fit now.
export function storytellerHeader(game, api = ST_API) {
  const lines = [], ph = phaseOf(game);
  const alive = (game.seats || []).filter(s => s.alive).length;
  // An owed narration is the header's first line, so the first turn that reads it narrates (#70).
  const nom = nominationsWords(game), owed = narrationOwed(game, api);
  const [call, makings] = owedLines(game, owed);
  if (call) lines.push(call);
  lines.push(`Storyteller. ${clockWords(game)}. ${alive} of ${(game.seats || []).length} alive.`);
  if (makings) lines.push(makings);
  if (nom) lines.push(`Clock fact for narration: ${nom}. Announce nothing the clock does not say.`);
  for (const r of grimoireRows(game, api)) lines.push('- ' + grimoireLine(game, r));
  const p = api.pendingFor(game, 'storyteller');
  if (p) {
    const d = describePending(game, p);
    const all = d.options.join('; ');
    const onlyTruth = p.kind === 'info' && !p.malfunctioning && Array.isArray(p.truth) && p.truth.length === d.count;
    const opts = onlyTruth ? `the truth only, #1 to #${d.count}` : all.length <= 400 && d.count <= 16 ? all : 'what_is_asked lists them';
    lines.push(`**Waiting on you: ${d.what}${d.about ? ' for ' + d.about : ''}.** ${p.question}`);
    if (d.truth) {
      const ts = d.truth.split(' | '), truth = ts.length > 3 ? `${ts.slice(0, 3).join(' | ')} | and ${ts.length - 3} more true` : d.truth;
      lines.push(`Truth: ${truth}.${d.malfunctioning ? ' ' + malfunctionWords(game, p) + '.' : ''}`);
    }
    if (d.yourCall) lines.push(d.yourCall + '.');
    lines.push(`Legal (${d.offered}): ${opts}`);
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
  // the Now line always survives the cap: the body is cut before it
  const now = nowLine(game, !!p, !!owed);
  let out = lines.join('\n');
  if (out.length + 1 + now.length > HEADER_CAP) out = out.slice(0, HEADER_CAP - now.length - 2) + '…';
  return out + '\n' + now;
}
