// The game as the seats reach it. Every seat's tool (src/data/player-tools.js, storyteller-tools.js) reads and changes the
// game only through these functions; each takes (game, seat, ...) with seat a seat index or 'storyteller', and throws an
// ApiError with a plain message naming what is legal now when the seat may not do or know the thing.
//
// Privacy: a player sees its own role (the one it believes it is), what it was told, what was said in its hearing and its
// own notes. Every log entry carries an audience ('all', [seat indexes] or 'storyteller', src/game/grimoire.js); events()
// shows a seat only the entries whose audience includes it, as a short projection (never the raw entry, so never a token,
// another seat's role or a Storyteller reason). forSeat(seat) is the api a seat's tool handler gets: bound to that seat.
//
// The day clock (decided here; slice 5 changes it): a day has `roundsBeforeNominations` speaking rounds (default 3,
// newGame({rounds})). In a round each seat says one line or passes; a round ends when every living seat has. Then
// nominations open (or earlier when the Storyteller opens them) and the talk is free. The day ends when the Storyteller
// calls endDay or every living seat has nominated or passed on nominating. A table vote is cast one seat at a time into
// game.ballot and handed to the engine when every voter has voted (or the Storyteller closes the vote).
//
// A day's clock starts when the engine reaches the day's table decision (step 'nominations'); before that (night, or a
// dawn still being resolved) say and pass are refused, and a refused call never counts as a seat's turn (#30). A standing
// day action (the Slayer's shot, pending.dayActions) is the seat's to call when it likes: pendingFor shows it as a choose
// with standing: true when nothing else waits on the seat, it never makes mustAct true, and dayAction() spends it (#37).
// canAct(game, seat) says whether a seat has anything to do now; nextTurnText(game, seat) says when it next will (#29).
//
// Places (#28): by day a seat is at the Square (place null: the table hears it) or in one of the rooms of src/data/rooms.js
// (at most `size` seats each). go, invite and leave move seats; every move is public (a 'move' entry, audience all), the words
// are not: a line said in a room reaches the seats in that room at the moment of the line (a late joiner hears nothing said
// before it came in). A line anywhere is the seat's turn of the round. Whispers happen only at the Square and only between a
// seat and its nearest living neighbour on either side (dead seats are skipped; both at the Square); a room has no whispers.
// The rooms open with the day's talk and close when nominations open (or the day ends): everyone comes back to the Square.
// The dead may go to rooms and talk there. The Storyteller hears neither whispers nor room talk; the watcher hears both.
//
// The night's thoughts (#111): at the end of every night the engine asks every living seat at once for a thought (pending kind
// 'thoughts'). Each seat answers its own, like a vote (answer or think: a text, empty for none), into game.thinking; when every
// seat has answered the engine gets {seat: text}. A thought is logged with audience 'watcher': no seat (its own included) and not
// the Storyteller ever reads it through this api; the watcher's page and the behavior log do (src/game/backend.js).
//
// Everything the api keeps lives in the state (game.clock, game.ballot, game.thinking, game.notes, game.actions), and every call that
// changes the game is recorded in game.actions, so restore(plainCopy) rebuilds the same live game.
import {answer as engineAnswer, validate, isLive, thoughtText, THOUGHT_MAX} from './engine.js';
import {newGame} from './state.js';
import {roleOf, roleName, alive, log, livingNeighbours, grimoire as fullGrimoire} from './grimoire.js';
import {ROOMS, SQUARE} from '../data/rooms.js';
import {HOOKS, TELLINGS} from './abilities.js';
import {notEnglish} from './lang.js';

export class ApiError extends Error {
  constructor(message) {super(message); this.name = 'ApiError'}
}

export const ST = 'storyteller';
export const LIMITS = {line: 600, note: 600, notes: 50, repeatWindow: 3, reason: 1000};
export const REPEAT_MESSAGE = 'You said that already; say something new or pass.';
const PHASES = {setup: 'setup', night: 'night', day: 'day', end: 'ended'};

const fail = msg => {throw new ApiError(msg)};
const nameOf = (game, i) => game.seats[i]?.name ?? `seat ${i}`;
const list = (game, idx) => {const n = idx.map(i => nameOf(game, i)); return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`};
const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const isSeat = (game, s) => Number.isInteger(s) && s >= 0 && s < game.seats.length;
const canSee = (aud, seat) => aud === 'all' || (Array.isArray(aud) && aud.includes(seat));
const norm = t => String(t).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/, '');

function player(game, seat) {
  if (seat === ST) fail('The Storyteller has no seat at the table; use the Storyteller tools.');
  if (!isSeat(game, seat)) fail(`There is no seat ${JSON.stringify(seat)}: seats are numbered 0 to ${game.seats.length - 1}.`);
  return game.seats[seat];
}
function target(game, t, what = 'player') {
  if (!isSeat(game, t)) fail(`Name the ${what} by seat number, 0 to ${game.seats.length - 1} (${game.seats.map(s => `${s.index} ${s.name}`).join(', ')}).`);
  return t;
}

// The clock follows the engine: a new day resets it. Idempotent, logs nothing, so a read may call it.
function sync(game) {
  const c = game.clock;
  if (game.phase === 'day' && c.day !== game.day) {
    Object.assign(c, {day: game.day, round: 1, nominationsOpen: c.roundsBeforeNominations <= 0, spoke: [], passedNominating: []});
    game.places = game.seats.map(() => null);
  }
  if (!Array.isArray(game.places)) game.places = game.seats.map(() => null);
  const p = game.pending;
  if (p && p.kind === 'vote') {if (!game.ballot || game.ballot.id !== p.id) game.ballot = {id: p.id, nominee: p.nominee, votes: {}}}
  else game.ballot = null;
  if (p && p.kind === 'thoughts') {if (!game.thinking || game.thinking.id !== p.id) game.thinking = {id: p.id, texts: {}}}
  else game.thinking = null;
}

// Whether today's clock runs: it is day and the engine has reached the day's table decision (not night, not a dawn).
export const clockStarted = game => game.phase === 'day' && game.step === 'nominations' && !game.winner;

// ---- places: the Square and the rooms ----
export {ROOMS};
const roomById = id => ROOMS.find(r => r.id === id) || null;
const placeName = id => id == null ? SQUARE.name : roomById(id)?.name ?? String(id);
const placeOf = (game, seat) => game.places?.[seat] ?? null;
const occupants = (game, room) => game.seats.filter(s => placeOf(game, s.index) === room).map(s => s.index);
// The rooms are open while the day's talk runs and the nominations have not opened.
export const roomsOpen = game => clockStarted(game) && !game.clock.nominationsOpen;
// A room named by id or by name ('nook', 'the nook', 'Nook'), or null.
const findRoom = name => {
  if (typeof name !== 'string') return null;
  const k = name.trim().toLowerCase().replace(/^the\s+/, '');
  return ROOMS.find(r => r.id === k || r.name.toLowerCase().replace(/^the\s+/, '') === k) || null;
};
// The seats a seat may whisper to now: its nearest living neighbour on each side, when both are at the Square.
const whisperable = (game, seat) => placeOf(game, seat) != null ? [] : livingNeighbours(game, seat).filter(j => placeOf(game, j) == null);

// Who is where: {place, placeName, with, square, rooms: [{id, name, size, seats, free}], open, neighbours, canWhisper}.
// place: this seat's room id (null: the Square); with: the others in the same place; neighbours: the nearest living seat on each
// side (whom it may whisper to at the Square); canWhisper: those of them it may whisper to now. Presence is public: any seat
// and the Storyteller may read it (the Storyteller has no place).
export function where(game, seat) {
  sync(game);
  const me = seat === ST ? null : (player(game, seat), seat);
  const place = me == null ? null : placeOf(game, me);
  return {
    place, placeName: me == null ? null : placeName(place),
    with: me == null ? [] : occupants(game, place).filter(i => i !== me),
    square: occupants(game, null),
    rooms: ROOMS.map(r => {const seats = occupants(game, r.id); return {id: r.id, name: r.name, size: r.size, seats, free: r.size - seats.length}}),
    open: roomsOpen(game),
    neighbours: me == null ? [] : livingNeighbours(game, me),
    canWhisper: me == null || !clockStarted(game) ? [] : whisperable(game, me),
  };
}

// The standing day action this seat may call now ({by, ability, options, question}), or null: only while the day's
// table decision waits (not during a vote or a Storyteller ruling).
export function dayActionFor(game, seat) {
  sync(game);
  if (seat === ST || !isSeat(game, seat) || !clockStarted(game)) return null;
  const p = game.pending;
  if (!p || p.kind !== 'nomination') return null;
  const d = (p.dayActions || []).find(x => x.by === seat);
  return d ? copy(d) : null;
}
const standingText = (game, seat) => {
  const d = dayActionFor(game, seat);
  return d ? ` Your ${roleName(game, d.ability)} ability is unspent: you may use it at any moment today.` : '';
};

// What a seat may do now, for the end of every refusal.
export function legalNow(game, seat) {
  sync(game);
  if (game.winner) return `The game is over: ${game.winner.text}.`;
  if (seat === ST) {
    const p = game.pending;
    if (p && p.seat === ST) return `A ${p.kind} decision waits on you: ${p.question}`;
    if (game.phase === 'day') return `It is day ${game.day}: you may narrate, open the nominations${p && p.kind === 'vote' ? ', close the vote' : ''} or end the day.`;
    return 'Nothing waits on you now; you may narrate.';
  }
  const p = pendingFor(game, seat);
  if (p && !p.standing && (!ONCE_EACH.includes(p.kind) || p.mine === null)) return p.kind === 'vote' ? `A vote is open on ${nameOf(game, p.nominee)}: vote yes or no.`
    : p.kind === 'thoughts' ? `${p.question} Answer with a sentence or two (or nothing); only the watcher hears it.`
    : p.kind === 'nomination' ? 'Nominations are open: nominate a player or pass.' : `A choice waits on you: ${p.question}`;
  if (game.phase === 'night') return `It is night ${game.night}: nothing is asked of you now; wait for the day.`;
  if (game.phase === 'setup') return 'The Storyteller is setting up the game; wait.';
  if (game.phase === 'day' && !clockStarted(game)) return game.step === 'dusk' ? `Day ${game.day} is ending: wait for the night.` : `Day ${game.day} is breaking: the talk has not begun yet; wait for it.`;
  if (game.phase === 'day') {
    const c = game.clock, more = standingText(game, seat), pl = placeOf(game, seat);
    const here = pl == null ? 'at the Square' : `in ${placeName(pl)}`, wh = pl == null ? 'whisper to a neighbour' : 'leave for the Square';
    if (!c.nominationsOpen) return `It is day ${game.day}, round ${c.round} of ${c.roundsBeforeNominations}, and you are ${here}: ${c.spoke.includes(seat) ? `you have had your turn this round; you may ${wh}, go to a room or wait` : `you may say a line, ${wh}, go to a room or pass`}.${more}`;
    return `It is day ${game.day} and nominations are open: you may say, whisper${game.seats[seat].alive ? ', nominate' : ''}, vote when a vote is open, or pass.${more}`;
  }
  return 'Nothing is asked of you now.';
}
const refuse = (game, seat, msg) => fail(`${msg} ${legalNow(game, seat)}`);
// The everyone-at-once scenes: each seat answers once, and its pending stays (with `mine`) until the scene ends.
const ONCE_EACH = ['vote', 'thoughts'];

// ---- recording: every call that changes the game goes through act(), so restore() can replay it ----
const ACTS = {}, IMPLS = {};
function act(name, impl) {
  IMPLS[name] = impl;
  const f = (game, ...args) => {
    if (!isLive(game)) fail('This game is a plain copy; restore(copy) gives a live game to act on.');
    sync(game);
    const out = impl(game, ...args);
    game.actions.push([name, ...copy(args)]);
    sync(game);
    return out;
  };
  ACTS[name] = f;
  return f;
}
function toEngine(game, value) {
  try {engineAnswer(game, value)} catch (e) {fail(String(e.message || e))}
  sync(game);
}

// A live game rebuilt from a plain (JSON) copy: the same config and the same api calls give the same game.
export function restore(plain) {
  const c = plain.config;
  const game = newGame({seed: c.seed, seats: c.seats, roles: c.roles, ...(c.rounds != null ? {rounds: c.rounds} : {})});
  for (const [name, ...args] of plain.actions || []) ACTS[name](game, ...args);
  return game;
}

// ---- reading ----
const clockView = game => {
  const c = game.clock;
  return {day: c.day, round: c.round, roundsBeforeNominations: c.roundsBeforeNominations, nominationsOpen: c.nominationsOpen,
    toSpeak: game.phase === 'day' && !c.nominationsOpen ? alive(game).filter(s => !c.spoke.includes(s.index)).map(s => s.index) : []};
};

function todayView(game) {
  const t = game.today;
  if (!t) return {day: null, nominations: [], block: null, executed: null};
  const nominations = t.nominators.map((by, k) => {
    const tg = t.nominees[k], v = t.votes.find(x => x.by === by && x.target === tg);
    const voting = !v && game.pending?.kind === 'vote' && game.pending.nominator === by && game.pending.nominee === tg;
    return {by, target: tg, yes: v ? [...v.yes] : null, needed: v ? v.need : null,
      result: v ? (v.tally >= v.need ? 'enough' : 'not enough') : voting ? 'voting' : 'no vote'};
  });
  return {day: t.day, nominations, block: t.block ? {...t.block} : null, executed: t.executed ?? null};
}

// The evil team's first-night words: keep each other covered (#108).
export const DEMON_COVER = 'Keep your minion covered: never name their role or team.';
export const MINION_COVER = 'Agree with your demon, in a room by day, which good role each of you claims.';

// The dawn as the table hears it. The demon never kills on the first night, so day 1's quiet is the rule, not news (#110).
export function dawnText(game, e) {
  if (e.deaths.length) return `Day ${e.day} breaks. ${list(game, e.deaths)} died in the night.`;
  return e.night === 1 ? `Day ${e.day} breaks. The first night passes without a death, as it always does.` : `Day ${e.day} breaks. Nobody died in the night.`;
}

// What a seat was told, as a plain sentence.
export function toldText(game, e) {
  const rn = id => roleName(game, id), v = e.info;
  switch (e.what) {
    case 'role': {const r = roleOf(game, e.role); return `You are the ${r.name} (${r.team}): ${r.ability}`}
    case 'minion-info': {const others = e.minions.filter(m => m !== e.seat);
      return `The demon is ${list(game, e.demon)}.${others.length ? ` The other minion${others.length > 1 ? 's are' : ' is'} ${list(game, others)}.` : ''} ${MINION_COVER}`}
    case 'demon-info': return `Your minion${e.minions.length === 1 ? ' is' : 's are'} ${list(game, e.minions) || 'nobody'}.${e.bluffs?.length ? ` Good roles not in play, to bluff with: ${e.bluffs.map(rn).join(', ')}.` : ''}${e.minions.length ? ' ' + DEMON_COVER : ''}`;
    case 'became-demon': return `You are now the ${rn(e.role)}.`;
    case 'grimoire': return 'You see the grimoire: ' + e.grimoire.map(s => `${s.name} the ${rn(s.role)}${s.believed !== s.role ? ` (believes they are the ${rn(s.believed)})` : ''}${s.alive ? '' : ', dead'}${s.tokens.length ? ` [${s.tokens.map(t => t.token.replace(/-/g, ' ') + (t.value != null ? ': ' + (typeof t.value === 'string' ? rn(t.value) : t.value) : '') + (t.active === false ? ' (no effect)' : '')).join('; ')}]` : ''}`).join('. ') + '.';
  }
  if (v && typeof v === 'object' && v.none) return 'There are no outsiders in play.';
  if (v && typeof v === 'object' && v.players) return `One of ${list(game, v.players)} is the ${rn(v.role)}.`;
  if (typeof v === 'boolean') return v ? `Yes: one of ${list(game, e.picks || [])} is the demon.` : `No: neither ${(e.picks || []).map(i => nameOf(game, i)).join(' nor ')} is the demon.`;
  if (typeof v === 'number') return e.neighbours ? `${v} of your living neighbours (${list(game, e.neighbours)}) ${v === 1 ? 'is' : 'are'} evil.`
    : `${v} pair${v === 1 ? '' : 's'} of evil players sit${v === 1 ? 's' : ''} side by side.`;
  if (typeof v === 'string') return e.target != null ? `${nameOf(game, e.target)} is the ${rn(v)}.` : `The ${rn(v)}.`;
  return `You learn: ${JSON.stringify(v)}.`;
}

// The table's view of one log entry: a whitelist of fields per type, never the raw entry. null: the seat sees nothing of it.
function project(game, e) {
  const base = {id: e.id, type: e.type, day: e.day, night: e.night}, n = i => nameOf(game, i);
  switch (e.type) {
    case 'night': return {...base, type: 'phase', what: 'night', text: `Night ${e.night} falls.`};
    case 'dawn': return {...base, deaths: [...e.deaths], text: dawnText(game, e)};
    case 'phase': return {...base, what: e.what, ...(e.round != null ? {round: e.round} : {}), text: e.text};
    case 'say': return {...base, seat: e.seat, text: e.text, ...(e.room != null ? {room: e.room} : {})};
    case 'move': return {...base, seats: [...e.seats], room: e.room, from: e.from ?? null, by: e.by ?? null, text: e.text};
    case 'whisper': return {...base, from: e.from, to: e.to, text: e.text};
    case 'whisper-seen': return {...base, from: e.from, to: e.to, text: `${n(e.from)} whispers to ${n(e.to)}.`};
    case 'pass': return {...base, seat: e.seat, text: `${n(e.seat)} passes.`};
    case 'narration': return {...base, text: e.text};
    case 'nomination': return {...base, by: e.by, target: e.target, text: `${n(e.by)} nominates ${n(e.target)}.`};
    case 'vote': return {...base, type: 'vote-result', by: e.by, target: e.target, yes: [...e.yes], tally: e.tally, needed: e.need, block: e.block ? {...e.block} : null,
      text: `${e.tally} of ${e.need} needed voted to execute ${n(e.target)}${e.yes.length ? ` (${list(game, e.yes)})` : ''}. ${!e.block ? 'Nobody is on the block.' : e.block.seat == null ? `A tie at ${e.block.votes}: nobody is on the block.` : `${n(e.block.seat)} is on the block with ${e.block.votes}.`}`};
    case 'vote-closed': return {...base, missing: [...e.missing], text: `The Storyteller closes the vote${e.missing.length ? `; ${list(game, e.missing)} did not vote and count as no` : ''}.`};
    case 'execution': return {...base, seat: e.seat, text: `${n(e.seat)} is executed.`};
    case 'no-execution': return {...base, text: 'Nobody is executed today.'};
    case 'slayer-shot': return {...base, seat: e.seat, target: e.target, text: `${n(e.seat)} claims the Slayer and shoots ${n(e.target)}.`};
    case 'virgin': return {...base, seat: e.nominator, target: e.seat, text: `${n(e.nominator)} is executed at once for nominating ${n(e.seat)}.`};
    case 'death': return e.cause === 'execution' ? null : {...base, seat: e.seat, text: `${n(e.seat)} dies.`};
    case 'win': return {...base, team: e.team, text: e.text.charAt(0).toUpperCase() + e.text.slice(1) + '.'};
    case 'told': return {...base, seat: e.seat, what: e.what, text: toldText(game, e)};
  }
  return null; // a type no seat is shown
}

export function view(game, seat) {
  player(game, seat); sync(game);
  const s = game.seats[seat], r = roleOf(game, s.believed);
  return {
    name: s.name, index: s.index, role: {id: r.id, name: r.name, team: r.team, ability: r.ability},
    alive: s.alive, ghostVote: s.alive || s.ghostVote, phase: PHASES[game.phase] || game.phase, night: game.night, day: game.day,
    clock: clockView(game),
    told: game.log.filter(e => e.type === 'told' && canSee(e.audience, seat)).map(e => ({night: e.night, what: e.what, text: toldText(game, e)})),
    seats: game.seats.map(x => ({index: x.index, name: x.name, alive: x.alive, room: placeOf(game, x.index)})),
    place: (w => ({room: w.place, name: w.placeName, with: w.with, neighbours: w.neighbours, canWhisper: w.canWhisper}))(where(game, seat)),
    rooms: where(game, seat).rooms, roomsOpen: roomsOpen(game),
    today: todayView(game),
    dead: game.seats.filter(x => !x.alive).map(x => x.name),
    winner: game.winner ? {team: game.winner.team, text: game.winner.text} : null,
  };
}

// The decision waiting on this seat, or null. The Storyteller sees its decisions whole (truth, options, why).
export function pendingFor(game, seat) {
  sync(game);
  const p = game.pending;
  if (seat === ST) return p && p.seat === ST ? copy(p) : null;
  const s = player(game, seat);
  if (!p) return null;
  if (p.kind === 'choose' && p.seat === seat) return {kind: 'choose', role: p.role, question: p.question, options: copy(p.options), ...(p.count ? {count: p.count} : {})};
  if (p.kind === 'vote' && p.seats.includes(seat)) {
    const votes = game.ballot?.votes || {};
    return {kind: 'vote', nominee: p.nominee, nominator: p.nominator, seats: [...p.seats], voted: Object.keys(votes).map(Number), ballots: copy(votes), mine: votes[seat] ?? null,
      question: `${nameOf(game, p.nominator)} nominates ${nameOf(game, p.nominee)}: do you vote to execute?${s.alive ? '' : ' (You are dead: a yes spends your one ghost vote.)'}`};
  }
  if (p.kind === 'thoughts' && p.seats.includes(seat)) {
    const texts = game.thinking?.texts || {};
    return {kind: 'thoughts', question: p.question, mine: seat in texts ? texts[seat] : null, tonight: tonightText(game, seat)};
  }
  if (p.kind === 'nomination' && game.clock.nominationsOpen && s.alive && !game.today.nominators.includes(seat) && !game.clock.passedNominating.includes(seat)) {
    const targets = p.options.filter(o => o && o.by === seat).map(o => o.target);
    return {kind: 'nomination', targets, question: 'Nominations are open: nominate a player for execution, or pass.'};
  }
  // the standing shot shows once the seat has taken its say-or-pass of the round, so it never hides the turn itself
  const d = game.clock.nominationsOpen || game.clock.spoke.includes(seat) ? dayActionFor(game, seat) : null;
  if (d) return {kind: 'choose', role: d.ability, standing: true, question: `${nameOf(game, seat)} (${roleName(game, d.ability)}): ${d.question}`, options: [null, ...d.options]};
  return null;
}

// Whether the seat must act now (a pending it has not answered): what wakes a runner at once.
export function mustAct(game, seat) {
  const p = pendingFor(game, seat);
  return !!p && !p.standing && (!ONCE_EACH.includes(p.kind) || p.mine === null);
}

// What this seat did and learned tonight, from its own wake, its own choices and what it was told (never anything else): plain
// sentences for the thoughts scene ("You woke as the Empath. 1 of your living neighbours (...) is evil."), or "You slept."
export function tonightText(game, seat) {
  const out = [], night = game.night, rn = id => roleName(game, id);
  for (const e of game.log) {
    if (e.phase !== 'night' || e.night !== night || e.seat !== seat) continue;
    if (e.type === 'wake') out.push(`You woke as the ${rn(e.role)}.`);
    else if (e.type === 'acted' && Number.isInteger(e.target)) out.push(e.target === seat ? 'You chose yourself.' : `You chose ${nameOf(game, e.target)}.`);
    else if (e.type === 'told' && canSee(e.audience, seat)) out.push(e.what === 'role' ? `You learned you are the ${rn(e.role)}.` : e.what === 'grimoire' ? 'You saw the grimoire.' : toldText(game, e));
  }
  return out.length ? out.join(' ') : 'You slept.';
}

// Whether the seat has anything to do now (what a soft wake is for): a decision (mustAct), its say-or-pass in this round,
// a nomination or a pass on nominating, or a standing day action. A seat that has had its turn waits for the next round.
export function canAct(game, seat) {
  player(game, seat); sync(game);
  if (game.winner) return false;
  if (mustAct(game, seat)) return true;
  if (!clockStarted(game)) return false;
  if (dayActionFor(game, seat)) return true;
  const c = game.clock, s = game.seats[seat];
  if (!c.nominationsOpen) return !c.spoke.includes(seat);
  return s.alive && game.pending?.kind === 'nomination' && !game.today.nominators.includes(seat) && !c.passedNominating.includes(seat);
}

// When a seat that cannot act now next will, as a phrase for its header ("until round 2"; the header reads "nothing to do until
// round 2"); null when it can act.
export function nextTurnText(game, seat) {
  if (canAct(game, seat)) return null;
  if (game.winner) return 'the game is over';
  if (game.phase === 'night' || game.phase === 'setup') return `until day ${game.day + 1}${game.phase === 'night' ? ', unless the Storyteller wakes you' : ''}`;
  if (!clockStarted(game)) return `until the talk of day ${game.day} begins`;
  const c = game.clock;
  if (!c.nominationsOpen) return c.round >= c.roundsBeforeNominations ? 'until nominations open' : `until round ${c.round + 1}`;
  if (game.pending?.kind === 'vote') return 'until the vote ends';
  return 'until the day ends (you may still speak or whisper)';
}

export function events(game, seat, since = 0) {
  sync(game);
  const from = Number.isFinite(Number(since)) ? Number(since) : 0;
  if (seat === ST) return game.log.filter(e => e.id > from && e.audience && e.audience !== 'watcher' && e.type !== 'whisper' && !(e.type === 'say' && e.room != null)).map(e => {const {n: _n, ...rest} = e; return copy({...rest, ...(project(game, e)?.text ? {text: project(game, e).text} : {})})});
  player(game, seat);
  const out = [];
  for (const e of game.log) {
    if (!(e.id > from) || !e.audience || !canSee(e.audience, seat)) continue;
    const p = project(game, e);
    if (p) out.push(p);
  }
  return out;
}

export function notes(game, seat) {
  if (seat !== ST) player(game, seat);
  return copy(game.notes[seat] || []);
}

// ---- acting ----
function line(game, seat, text) {
  if (typeof text !== 'string' || !text.trim()) refuse(game, seat, 'Say something, or pass.');
  const t = text.trim();
  if (t.length > LIMITS.line) refuse(game, seat, `That is ${t.length} characters; keep a line under ${LIMITS.line}.`);
  if (notEnglish(t)) refuse(game, seat, 'This table speaks English; say it in English.');
  return t;
}
const dayOnly = (game, seat, what) => {if (game.phase !== 'day') refuse(game, seat, `You can ${what} only in the day.`)};
// Talk and passes wait for the day's clock: a call made from a night header at the moment of dawn is refused, never counted.
const clockOnly = (game, seat) => {if (!clockStarted(game)) refuse(game, seat, game.step === 'dusk' ? 'The day is over; nothing you do now counts.' : 'The day has not begun yet; nothing you do now counts as your turn.')};

// One seat's turn of the round is taken (a line or a pass): the round ends when every living seat has had one.
function turnTaken(game, seat) {
  const c = game.clock;
  if (c.nominationsOpen || c.spoke.includes(seat)) return;
  c.spoke.push(seat);
  if (!alive(game).every(s => c.spoke.includes(s.index))) return;
  if (c.round >= c.roundsBeforeNominations) {openNoms(game, `Round ${c.round} is done. Nominations are open.`); return}
  c.round++; c.spoke = [];
  log(game, 'phase', {what: 'round', round: c.round, text: `Round ${c.round} of ${c.roundsBeforeNominations} begins.`, audience: 'all'});
}
function openNoms(game, text) {
  game.clock.nominationsOpen = true; game.clock.spoke = [];
  log(game, 'phase', {what: 'nominations', text, audience: 'all'});
  closeRooms(game, 'Nominations are open');
}
// Everyone in a room comes back to the Square, in public (nominations open, or the day ends).
function closeRooms(game, why) {
  const away = game.seats.filter(s => placeOf(game, s.index) != null).map(s => s.index);
  if (!away.length) return;
  for (const i of away) game.places[i] = null;
  log(game, 'move', {seats: away, room: null, from: null, by: null, closed: true, text: `${why}: the rooms close and ${list(game, away)} come${away.length === 1 ? 's' : ''} back to the Square.`, audience: 'all'});
}
// The day ends by itself once every living seat has nominated or passed on nominating.
function maybeEndDay(game) {
  const p = game.pending, c = game.clock;
  if (game.phase !== 'day' || !c.nominationsOpen || !p || p.kind !== 'nomination') return;
  if (!alive(game).every(s => game.today.nominators.includes(s.index) || c.passedNominating.includes(s.index))) return;
  log(game, 'phase', {what: 'day-ends', text: 'Every living player has nominated or passed: the day ends.', audience: 'all'});
  toEngine(game, null);
}

export const say = act('say', (game, seat, text) => {
  player(game, seat); dayOnly(game, seat, 'speak to the table'); clockOnly(game, seat);
  const t = line(game, seat, text), c = game.clock;
  const mine = game.log.filter(e => e.type === 'say' && e.seat === seat).slice(-LIMITS.repeatWindow);
  if (mine.some(e => norm(e.text) === norm(t))) refuse(game, seat, REPEAT_MESSAGE);
  if (!c.nominationsOpen && c.spoke.includes(seat)) refuse(game, seat, `You have had your turn in round ${c.round};`);
  // a line reaches the seat's place: the whole table at the Square, the room's occupants (at this moment) in a room
  const room = placeOf(game, seat);
  const e = log(game, 'say', room == null ? {seat, text: t, audience: 'all'} : {seat, text: t, room, audience: occupants(game, room)});
  turnTaken(game, seat);
  return {id: e.id};
});

export const whisper = act('whisper', (game, seat, to, text) => {
  player(game, seat); dayOnly(game, seat, 'whisper');
  target(game, to, 'player to whisper to');
  if (to === seat) refuse(game, seat, 'You cannot whisper to yourself; write a note instead.');
  const pl = placeOf(game, seat);
  if (pl != null) refuse(game, seat, `There are no whispers in a room: everyone in ${placeName(pl)} hears what you say. Say it, or leave for the Square.`);
  const nb = livingNeighbours(game, seat);
  if (!nb.includes(to)) refuse(game, seat, `At the Square you may whisper only to your nearest living neighbour${nb.length === 1 ? '' : 's'}: ${list(game, nb) || 'nobody'}.`);
  if (placeOf(game, to) != null) refuse(game, seat, `${nameOf(game, to)} is in ${placeName(placeOf(game, to))}; whisper when they are back at the Square.`);
  const t = line(game, seat, text);
  const e = log(game, 'whisper', {from: seat, to, text: t, audience: [seat, to]});
  log(game, 'whisper-seen', {from: seat, to, audience: 'all'});
  return {id: e.id};
});

export const pass = act('pass', (game, seat) => {
  const s = player(game, seat); dayOnly(game, seat, 'pass'); clockOnly(game, seat);
  const c = game.clock;
  if (!c.nominationsOpen) {
    if (c.spoke.includes(seat)) refuse(game, seat, `You have had your turn in round ${c.round};`);
    log(game, 'pass', {seat, audience: 'all'});
    turnTaken(game, seat);
    return {passed: 'round'};
  }
  if (s.alive && !c.passedNominating.includes(seat) && !game.today.nominators.includes(seat)) {
    c.passedNominating.push(seat);
    log(game, 'pass', {seat, audience: 'all'});
  }
  maybeEndDay(game);
  return {passed: 'nominations'};
});

// ---- moving between places ----
function roomsOnly(game, seat) {
  dayOnly(game, seat, 'go to a room'); clockOnly(game, seat);
  if (game.clock.nominationsOpen) refuse(game, seat, 'The rooms are closed: nominations are open and everyone is at the Square.');
}
function roomNamed(game, seat, name) {
  const r = findRoom(name);
  if (!r) refuse(game, seat, `There is no room ${JSON.stringify(name)}: the rooms are ${ROOMS.map(x => `${x.id} (${x.name}, for ${x.size})`).join(', ')}.`);
  return r;
}
const fullText = (game, r) => {const o = occupants(game, r.id); return `${r.name.charAt(0).toUpperCase() + r.name.slice(1)} holds ${r.size} and has ${o.length} (${list(game, o)})`};

// The seat goes to a room (from the Square or another room). Public: the table sees it go. Not a turn.
export const go = act('go', (game, seat, room) => {
  player(game, seat); roomsOnly(game, seat);
  const r = roomNamed(game, seat, room), from = placeOf(game, seat);
  if (from === r.id) refuse(game, seat, `You are in ${r.name} already.`);
  if (occupants(game, r.id).length >= r.size) refuse(game, seat, `${fullText(game, r)}: it is full.`);
  game.places[seat] = r.id;
  const n = nameOf(game, seat);
  log(game, 'move', {seats: [seat], room: r.id, from, by: seat, text: from == null ? `${n} went to ${r.name}.` : `${n} left ${placeName(from)} for ${r.name}.`, audience: 'all'});
  return {place: r.id, with: occupants(game, r.id).filter(i => i !== seat)};
});

// The seat takes another seat from the Square to a room (room omitted: the seat's own room). Both go together, in public; the
// other may leave at once. Only a seat at the Square can be invited (a seat in another room is in its own conversation).
export const invite = act('invite', (game, seat, other, room) => {
  player(game, seat); roomsOnly(game, seat);
  target(game, other, 'player to invite');
  if (other === seat) refuse(game, seat, 'You cannot invite yourself; use go to go to a room.');
  const from = placeOf(game, seat);
  if (room == null && from == null) refuse(game, seat, `Name a room: ${ROOMS.map(x => `${x.id} (for ${x.size})`).join(', ')}.`);
  const r = room == null ? roomById(from) : roomNamed(game, seat, room);
  if (placeOf(game, other) === r.id) refuse(game, seat, `${nameOf(game, other)} is in ${r.name} already.`);
  if (placeOf(game, other) != null) refuse(game, seat, `${nameOf(game, other)} is in ${placeName(placeOf(game, other))}; you may invite only someone at the Square.`);
  const need = (from === r.id ? 0 : 1) + 1;
  if (occupants(game, r.id).length + need > r.size) refuse(game, seat, `${fullText(game, r)}: there is no room for ${need === 2 ? 'the two of you' : nameOf(game, other)}.`);
  game.places[seat] = r.id; game.places[other] = r.id;
  const a = nameOf(game, seat), b = nameOf(game, other);
  const text = from === r.id ? `${a} called ${b} into ${r.name}.` : from == null ? `${a} and ${b} went to ${r.name}.` : `${a} left ${placeName(from)} and went to ${r.name} with ${b}.`;
  log(game, 'move', {seats: from === r.id ? [other] : [seat, other], room: r.id, from, by: seat, text, audience: 'all'});
  return {place: r.id, with: occupants(game, r.id).filter(i => i !== seat)};
});

// The seat comes back to the Square from its room. Public. Not a turn.
export const leave = act('leave', (game, seat) => {
  player(game, seat); dayOnly(game, seat, 'leave a room'); clockOnly(game, seat);
  const from = placeOf(game, seat);
  if (from == null) refuse(game, seat, 'You are at the Square already.');
  game.places[seat] = null;
  log(game, 'move', {seats: [seat], room: null, from, by: seat, text: `${nameOf(game, seat)} came back to the Square from ${placeName(from)}.`, audience: 'all'});
  return {place: null};
});

export const nominate = act('nominate', (game, seat, tg) => {
  const s = player(game, seat); target(game, tg, 'player to nominate');
  if (game.phase !== 'day') refuse(game, seat, 'Nominations happen only in the day.');
  if (!s.alive) refuse(game, seat, 'The dead may not nominate; you may still speak, and vote once with your ghost vote.');
  const c = game.clock, p = game.pending, t = game.today;
  if (!c.nominationsOpen) refuse(game, seat, `Nominations are not open yet (round ${c.round} of ${c.roundsBeforeNominations}).`);
  if (t.nominators.includes(seat)) refuse(game, seat, 'You have nominated today already; each player nominates at most once a day.');
  if (t.nominees.includes(tg)) refuse(game, seat, `${nameOf(game, tg)} has been nominated today already; each player is nominated at most once a day.`);
  if (!p || p.kind !== 'nomination') refuse(game, seat, p && p.kind === 'vote' ? `A vote is open on ${nameOf(game, p.nominee)}; it ends first.` : 'The table is not ready for a nomination yet; try again shortly.');
  const opt = p.options.find(o => o && o.by === seat && o.target === tg);
  if (!opt) refuse(game, seat, `You cannot nominate ${nameOf(game, tg)} now.`);
  c.passedNominating = c.passedNominating.filter(x => x !== seat);
  toEngine(game, opt);
  maybeEndDay(game);
  return {nominated: tg};
});

// A standing day action (the Slayer's shot): a seat index, or null to keep it for later. Resolves at once, in public.
export const dayAction = act('dayAction', (game, seat, value) => {
  const s = player(game, seat), p = game.pending;
  if (!HOOKS[s.believed]?.dayAction) refuse(game, seat, 'You have no ability to use by day.');
  if (game.phase !== 'day' || !clockStarted(game)) refuse(game, seat, 'Your ability is used by day, once the talk has begun.');
  if (!s.alive) refuse(game, seat, 'The dead have no ability to use.');
  if (p && p.kind === 'vote') refuse(game, seat, `A vote is open on ${nameOf(game, p.nominee)}; use your ability when it ends.`);
  if (!p || p.kind !== 'nomination') refuse(game, seat, 'The Storyteller is resolving something; try again shortly.');
  const mine = dayActionFor(game, seat);
  if (!mine) refuse(game, seat, 'Your ability is spent.');
  if (value === null || value === undefined) return {kept: true};
  const t = typeof value === 'object' ? value.target : value;
  if (!mine.options.includes(t)) refuse(game, seat, `Pick one of: ${mine.options.map(i => `${i} ${nameOf(game, i)}`).join(', ')}, or null to keep it.`);
  toEngine(game, {by: seat, ability: mine.ability, target: t});
  maybeEndDay(game);
  return {used: mine.ability, target: t};
});

function castVote(game, seat, yes) {
  const p = game.pending;
  if (!p || p.kind !== 'vote') refuse(game, seat, 'No vote is open.');
  if (yes === 'yes' || yes === 'no') yes = yes === 'yes';
  if (typeof yes !== 'boolean') refuse(game, seat, 'A vote is yes (true) or no (false).');
  if (!p.seats.includes(seat)) refuse(game, seat, 'You have no vote: you are dead and your ghost vote is spent.');
  const b = game.ballot;
  if (seat in b.votes) refuse(game, seat, `You voted already (${b.votes[seat] ? 'yes' : 'no'}) on ${nameOf(game, p.nominee)}.`);
  b.votes[seat] = yes;
  const waiting = p.seats.filter(i => !(i in b.votes));
  if (!waiting.length) {toEngine(game, Object.fromEntries(p.seats.map(i => [i, b.votes[i]]))); maybeEndDay(game)}
  return {voted: yes, waitingOn: waiting.length};
}

export const vote = act('vote', (game, seat, yes) => {player(game, seat); return castVote(game, seat, yes)});

// A seat's thought before dawn: a text (cut to THOUGHT_MAX), or empty/null for none. Once a night; the scene ends when every
// living seat has answered. The thought reaches the watcher alone.
function castThought(game, seat, text) {
  const p = game.pending;
  if (!p || p.kind !== 'thoughts') refuse(game, seat, 'Nobody is asked for a thought now.');
  if (!p.seats.includes(seat)) refuse(game, seat, 'Only the living are asked for a thought before dawn.');
  if (text != null && typeof text !== 'string') refuse(game, seat, 'A thought is a sentence or two of text, or nothing.');
  const t = game.thinking;
  if (seat in t.texts) refuse(game, seat, 'You have given your thought for tonight already.');
  t.texts[seat] = thoughtText(text);
  const waiting = p.seats.filter(i => !(i in t.texts));
  if (!waiting.length) toEngine(game, Object.fromEntries(p.seats.map(i => [i, t.texts[i]])));
  return {thought: t.texts[seat], waitingOn: waiting.length, ...(typeof text === 'string' && text.trim().length > THOUGHT_MAX ? {cut: THOUGHT_MAX} : {})};
}

export const think = act('think', (game, seat, text) => {player(game, seat); return castThought(game, seat, text)});

export const note = act('note', (game, seat, text) => {
  if (seat !== ST) player(game, seat);
  if (typeof text !== 'string' || !text.trim()) fail('A note needs some text.');
  const t = text.trim();
  if (t.length > LIMITS.note) fail(`That note is ${t.length} characters; keep a note under ${LIMITS.note}.`);
  const list = game.notes[seat] = game.notes[seat] || [];
  list.push({text: t, phase: PHASES[game.phase] || game.phase, night: game.night, day: game.day});
  if (list.length > LIMITS.notes) list.splice(0, list.length - LIMITS.notes);
  return {notes: list.length};
});

// A seat answers its own pending: a night or day choice, its vote, its thought before dawn (a text), or the nomination round
// (a seat index, or null to pass).
// The Storyteller answers its decisions with a reason, logged as a ruling.
export const answer = act('answer', (game, seat, value, reason) => {
  const p = game.pending;
  if (seat === ST) {
    if (!p || p.seat !== ST) refuse(game, ST, 'Nothing waits on the Storyteller now.');
    if (typeof reason !== 'string' || !reason.trim()) refuse(game, ST, 'Every Storyteller decision carries a reason: say why.');
    let v;
    try {v = validate(p, value)} catch (e) {refuse(game, ST, `${e.message}.`)}
    log(game, 'ruling', {kind: p.kind, decision: p.id, question: p.question, subject: p.subject ?? null, value: v, reason: reason.trim().slice(0, LIMITS.reason), audience: ST});
    toEngine(game, v);
    return {accepted: copy(v)};
  }
  const s = player(game, seat);
  if (p && p.kind === 'vote' && p.seats.includes(seat)) return castVote(game, seat, value);
  if (p && p.kind === 'thoughts') return castThought(game, seat, value);
  if (pendingFor(game, seat)?.standing) return IMPLS.dayAction(game, seat, value);
  if (p && p.kind === 'nomination' && game.phase === 'day' && game.clock.nominationsOpen && s.alive) {
    if (value === null || value === undefined) return IMPLS.pass(game, seat);
    const tg = typeof value === 'object' ? value.target : value;
    return IMPLS.nominate(game, seat, tg);
  }
  if (!p || p.kind !== 'choose' || p.seat !== seat) refuse(game, seat, 'Nothing is asked of you now.');
  let v;
  try {v = validate(p, value)} catch (e) {refuse(game, seat, `${e.message}.`)}
  toEngine(game, v);
  return {accepted: copy(v)};
});

// ---- the Storyteller's ----
export function grimoire(game) {
  sync(game);
  // the engine's grimoire, each token with who placed it (by: a seat index, or null for the Storyteller)
  const seats = fullGrimoire(game).map((s, i) => ({...s, tokens: s.tokens.map((t, k) => ({...t, by: game.seats[i].tokens[k]?.by ?? null}))}));
  return {phase: PHASES[game.phase] || game.phase, night: game.night, day: game.day, seats, bluffs: [...game.bluffs],
    pending: pendingFor(game, ST), winner: copy(game.winner)};
}

// Tonight's waking order (the coming night's, by day), one entry per waking: {role, seat, acted, ...}. A telling (the minions'
// and the demon's first-night information) has seat null; a role not in play is left out. acted: it has woken and acted
// tonight (for a telling: the night is past it). status: 'done' | 'now' | 'to come'; wakes: whether that seat will wake.
export function nightOrder(game) {
  const night = game.phase === 'night' ? game.night : game.night + 1;
  const order = night === 1 ? game.script.firstNight : game.script.otherNights;
  const cur = game.phase !== 'night' ? -1 : game.step === 'thoughts' ? order.length : order.indexOf(game.step); // the thoughts scene: the order is done
  const woke = game.log.filter(e => e.type === 'wake' && e.night === night && e.phase === 'night');
  const out = [];
  order.forEach((id, k) => {
    const status = cur < 0 ? 'to come' : k < cur ? 'done' : k === cur ? 'now' : 'to come';
    if (TELLINGS[id]) {out.push({role: id, seat: null, acted: status === 'done', night, telling: true, status}); return}
    const h = HOOKS[id];
    for (const s of game.seats.filter(x => x.believed === id)) {
      const acted = woke.some(w => w.seat === s.index && w.role === id) && (status === 'done' || status === 'now' && game.pending?.seat !== s.index);
      out.push({role: id, name: roleName(game, id), seat: s.index, seatName: s.name, acted, night, status, alive: s.alive, wakes: h?.wakeIf ? !!h.wakeIf(game, s.index) : s.alive});
    }
  });
  return out;
}

export function rulings(game) {
  return game.log.filter(e => e.type === 'ruling').map(e => ({id: e.id, phase: e.phase, night: e.night, day: e.day, kind: e.kind, question: e.question, subject: e.subject, value: copy(e.value), reason: e.reason}));
}

export const narrate = act('narrate', (game, text) => {
  if (typeof text !== 'string' || !text.trim()) refuse(game, ST, 'Narrate something.');
  const t = text.trim();
  if (t.length > LIMITS.line) refuse(game, ST, `That is ${t.length} characters; keep a narration under ${LIMITS.line}.`);
  const e = log(game, 'narration', {text: t, audience: 'all'});
  return {id: e.id};
});

export const openNominations = act('openNominations', game => {
  if (game.phase !== 'day') refuse(game, ST, 'Nominations open only in the day.');
  if (game.clock.nominationsOpen) return {open: true};
  openNoms(game, 'The Storyteller opens the nominations.');
  return {open: true};
});

// A Storyteller act outside a decision carries its reason too, logged as a ruling.
function stReason(game, kind, reason, question) {
  if (typeof reason !== 'string' || !reason.trim()) refuse(game, ST, 'Say why: this call carries a reason.');
  log(game, 'ruling', {kind, decision: null, question, subject: null, value: null, reason: reason.trim().slice(0, LIMITS.reason), audience: ST});
}

export const closeVote = act('closeVote', (game, reason) => {
  const p = game.pending;
  if (!p || p.kind !== 'vote') refuse(game, ST, 'No vote is open.');
  stReason(game, 'close-vote', reason, `Close the vote on ${nameOf(game, p.nominee)} before every voter has voted?`);
  const missing = p.seats.filter(i => !(i in game.ballot.votes));
  log(game, 'vote-closed', {missing, audience: 'all'});
  for (const i of missing) game.ballot.votes[i] = false;
  toEngine(game, Object.fromEntries(p.seats.map(i => [i, game.ballot.votes[i]])));
  maybeEndDay(game);
  return {missing};
});

export const endDay = act('endDay', (game, reason) => {
  const p = game.pending;
  if (game.phase !== 'day') refuse(game, ST, 'It is not day.');
  if (!p || p.kind !== 'nomination') refuse(game, ST, p && p.kind === 'vote' ? 'A vote is open; close it first (closeVote).' : `The day waits on another decision first (${p ? p.kind : 'none'}).`);
  stReason(game, 'end-day', reason, `End day ${game.day} now?`);
  log(game, 'phase', {what: 'day-ends', text: 'The Storyteller ends the day.', audience: 'all'});
  closeRooms(game, 'The day ends');
  toEngine(game, null);
  return {ended: true};
});

// ---- what a seat's tool handler gets ----
export const PLAYER_FUNCTIONS = ['view', 'pendingFor', 'answer', 'say', 'whisper', 'pass', 'nominate', 'vote', 'think', 'events', 'note', 'notes', 'legalNow', 'mustAct', 'canAct', 'nextTurnText', 'dayActionFor', 'dayAction', 'where', 'go', 'invite', 'leave'];
export const STORYTELLER_FUNCTIONS = ['grimoire', 'nightOrder', 'narrate', 'openNominations', 'closeVote', 'endDay', 'rulings'];
const ALL = {view, pendingFor, answer, say, whisper, pass, nominate, vote, think, events, note, notes, legalNow, mustAct, canAct, nextTurnText, dayActionFor, dayAction, where, go, invite, leave, grimoire, nightOrder, narrate, openNominations, closeVote, endDay, rulings, toldText};

// The api bound to one seat: a player's handler may name only its own seat and has no Storyteller function; the
// Storyteller may read any seat's view and pending but never acts for a player or reads its notes or whispers.
export function forSeat(seat) {
  const out = {ApiError, LIMITS};
  const ST_READS = new Set(['view', 'pendingFor', 'where']);
  for (const name of PLAYER_FUNCTIONS) out[name] = (game, who, ...rest) => {
    if (seat === ST ? (who !== ST && !ST_READS.has(name)) : who !== seat)
      fail(seat === ST ? `The Storyteller does not ${name} for a player.` : `You are ${nameOf(game, seat)} (seat ${seat}); you act and read only as yourself.`);
    return ALL[name](game, who, ...rest);
  };
  for (const name of STORYTELLER_FUNCTIONS) out[name] = seat === ST ? ALL[name] : () => fail('Only the Storyteller has that; a player learns the game only through what it is told and what it hears.');
  out.toldText = toldText;
  return out;
}
