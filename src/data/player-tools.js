// The tools a player agent uses to play one seat. Shared by the relay's MCP server (scripts/relay-mcp.mjs), the local
// tool loop (scripts/local-agent.mjs) and the docs. Each tool:
//   {name, desc, act, args: {argName: {type: 'string'|'integer'|'number'|'array' (of strings), desc, optional?, enum?}}, handler}
// act: true for a tool that spends the turn (speak, whisper, nominate, vote, a night choice, pass), false for a read.
// handler(args, ctx): ctx = {game, seat: {index, name}, api, log} (the slice 3 contract). A handler reads and acts only
// through the api's seat-scoped functions and copies out only the fields a player may see, so a token, another seat's
// role, a Storyteller reason or a whisper between two others never reaches a seat (npm run playertoolcheck proves it).
// Every refusal comes back as {ok: false, error} with what is open to the seat now. With no game behind the relay (the
// stub backend: no ctx.game or ctx.api) look answers "no game yet" and the rest say so.
import {seatIndex, nameOf, listNames, cleanEvents, markSeen, lastSeen, askedOf, sideOf, usefulTools, whatsNew, clockLine} from '../seats/player.js';

const READ_CAP = 40; // read_talk and my_whispers show at most this many entries

// ---- small helpers ----
const me = ctx => seatIndex(ctx.seat);
const viewOf = ctx => ctx.api.view(ctx.game, me(ctx));
const pendingOf = ctx => ctx.api.pendingFor(ctx.game, me(ctx));
const msg = e => String((e && e.message) || e || 'That did not work.');

// What the seat can do now, in one sentence: added to every refusal.
function openNow(ctx) {
  try {
    const v = viewOf(ctx), asked = askedOf(ctx.game, v, me(ctx), pendingOf(ctx));
    return `${asked && !asked.done ? asked.text + ' ' : ''}Open to you now: ${usefulTools(v, asked, null).join(', ')}.`;
  } catch {return 'Use look or what_is_asked to see what is open.'}
}
function refuse(ctx, error) {
  try {ctx.log?.('refusal', {seat: me(ctx), error})} catch {}
  return {ok: false, error: `${error} ${openNow(ctx)}`.trim()};
}
const NO_GAME = {ok: true, phase: 'no game yet', seats: []};
// A handler whose api refusals come back as {ok: false, error} naming what is open. The api's own refusals (ApiError)
// already end with what is legal now and pass through as they are; anything else gets "Open to you now" added.
const guarded = (fn, name) => (args, ctx = {}) => {
  if (!ctx.api || !ctx.game) return name === 'look' ? {...NO_GAME} : {ok: false, error: 'No game yet: wait for the Storyteller to deal.'};
  try {return fn(args || {}, ctx)} catch (e) {
    if (e && e.name === 'ApiError') {try {ctx.log?.('refusal', {seat: me(ctx), error: msg(e)})} catch {} return {ok: false, error: msg(e)}}
    return refuse(ctx, msg(e));
  }
};

// A seat named by a player: the exact name in any case, or the one name it begins.
function findSeat(v, name) {
  const seats = v.seats || [];
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return {error: `Name a player: ${listNames(seats.map(s => s.name))}.`};
  const starts = seats.filter(s => s.name.toLowerCase().startsWith(n));
  const hit = seats.find(s => s.name.toLowerCase() === n) || (starts.length === 1 ? starts[0] : null);
  return hit ? {seat: hit} : {error: `There is no player "${name}". The players are: ${listNames(seats.map(s => s.name))}.`};
}
// yes or no from what a model may send.
function yesNo(x) {
  const s = String(x ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', 'aye', '1'].includes(s)) return true;
  if (['no', 'n', 'false', 'nay', '0'].includes(s)) return false;
  return null;
}
const toList = x => (Array.isArray(x) ? x : x == null ? [] : String(x).split(',')).map(s => String(s).trim()).filter(Boolean);

// ---- the reads ----
function look(args, ctx) {
  const v = viewOf(ctx), seats = v.seats || [], t = v.today || {};
  return {ok: true, phase: v.phase, day: v.day, night: v.night, clock: clockLine(v, me(ctx)),
    you: {name: v.name, alive: !!v.alive, ghostVote: !!v.ghostVote},
    seats: seats.map(s => ({name: s.name, alive: !!s.alive})),
    alive: seats.filter(s => s.alive).map(s => s.name), dead: seats.filter(s => !s.alive).map(s => s.name),
    today: {nominations: (t.nominations || []).map(n => ({by: nameOf(v, n.by), target: nameOf(v, n.target), yes: Array.isArray(n.yes) ? n.yes.map(x => nameOf(v, x)) : n.yes, needed: n.needed, result: n.result})),
      executed: nameOf(v, t.executed) ?? null},
    ...(v.winner ? {winner: v.winner.team || String(v.winner)} : {})};
}
function myRole(args, ctx) {
  const v = viewOf(ctx), r = v.role || {};
  return {ok: true, name: v.name, role: r.name, team: r.team, side: sideOf(r.team), ability: r.ability,
    alive: !!v.alive, ghostVote: !!v.ghostVote,
    told: (v.told || []).map(x => ({night: x.night, text: String(x.text ?? '')})).filter(x => x.text)};
}
function readTalk(args, ctx) {
  const v = viewOf(ctx), i = me(ctx);
  const given = args.since != null && args.since !== '' && Number.isFinite(Number(args.since));
  const since = given ? Math.max(-1, Number(args.since) || -1) : lastSeen(ctx.game, i); // 0 or less: from the start
  const all = cleanEvents(v, i, ctx.api.events(ctx.game, i, since));
  const shown = all.slice(-READ_CAP);
  const last = all.length ? all[all.length - 1].id : since;
  markSeen(ctx.game, i, last);
  return {ok: true, since, last, entries: shown,
    ...(all.length > shown.length ? {older: `${all.length - shown.length} older entries are not shown; read_talk with a since between ${since} and ${shown[0].id} shows them.`} : {}),
    ...(all.length ? {} : {note: 'Nothing new since then.'})};
}
function myWhispers(args, ctx) {
  const v = viewOf(ctx), i = me(ctx);
  const list = cleanEvents(v, i, ctx.api.events(ctx.game, i, -1)).filter(e => e.type === 'whisper');
  return {ok: true, whispers: list.slice(-READ_CAP), ...(list.length ? {} : {note: 'No whispers to or from you yet.'})};
}
function myNotes(args, ctx) {
  const list = ctx.api.notes(ctx.game, me(ctx)) || [];
  return {ok: true, notes: list.map(n => (typeof n === 'string' ? n : String(n?.text ?? ''))), ...(list.length ? {} : {note: 'No notes yet.'})};
}
function whatIsAsked(args, ctx) {
  const v = viewOf(ctx), asked = askedOf(ctx.game, v, me(ctx), pendingOf(ctx));
  if (!asked) return {ok: true, asked: null, text: `Nothing is asked of you right now. ${clockLine(v, me(ctx))}`, useful: usefulTools(v, null, null)};
  return {ok: true, asked: asked.kind, text: asked.text, ...(asked.options ? {options: asked.options} : {}),
    ...(asked.count > 1 ? {count: asked.count} : {}), tool: asked.tool};
}
function whoVoted(args, ctx) {
  const v = viewOf(ctx), p = pendingOf(ctx);
  if (!p || p.kind !== 'vote') return refuse(ctx, 'No vote is open now.');
  const voted = Array.isArray(p.voted) ? p.voted : [];
  // the voters: the api's list when it gives one, else the living (the dead with a ghost vote may vote too)
  const voters = Array.isArray(p.seats) ? p.seats : (v.seats || []).filter(s => s.alive || voted.includes(s.index)).map(s => s.index);
  // the hands raised so far are public at a real table; shown when the api gives them (see "Asked of the api")
  const b = p.ballots && typeof p.ballots === 'object' ? p.ballots : null;
  const hands = b ? {yes: Object.keys(b).filter(k => b[k] === true).map(k => nameOf(v, Number(k))), no: Object.keys(b).filter(k => b[k] === false).map(k => nameOf(v, Number(k)))} : {};
  return {ok: true, nominee: nameOf(v, p.nominee), nominator: nameOf(v, p.nominator),
    voted: voted.map(x => nameOf(v, x)), waiting: voters.filter(x => !voted.includes(x)).map(x => nameOf(v, x)), ...hands,
    you: p.mine == null ? 'not voted yet' : p.mine ? 'yes' : 'no'};
}

// ---- the acts ----
function speak(args, ctx) {
  const text = String(args.text ?? '').trim();
  if (!text) return refuse(ctx, 'speak needs text: what you say.');
  ctx.api.say(ctx.game, me(ctx), text);
  return {ok: true, said: text};
}
function whisper(args, ctx) {
  const v = viewOf(ctx), text = String(args.text ?? '').trim();
  const f = findSeat(v, args.to);
  if (f.error) return refuse(ctx, f.error);
  if (f.seat.index === me(ctx)) return refuse(ctx, 'You cannot whisper to yourself; use note to remember something.');
  if (!text) return refuse(ctx, 'whisper needs text: what you whisper.');
  ctx.api.whisper(ctx.game, me(ctx), f.seat.index, text);
  return {ok: true, to: f.seat.name, said: text, note: `Only ${f.seat.name} hears this; the table sees that you two whispered.`};
}
function note(args, ctx) {
  const text = String(args.text ?? '').trim();
  if (!text) return refuse(ctx, 'note needs text.');
  ctx.api.note(ctx.game, me(ctx), text);
  return {ok: true, noted: text};
}
function nominate(args, ctx) {
  const v = viewOf(ctx), asked = askedOf(ctx.game, v, me(ctx), pendingOf(ctx));
  if (!asked || asked.kind !== 'nomination') {
    // no nomination pending: a seat that passed on nominating may still change its mind; the game decides the rest
    if (v.alive && v.phase === 'day' && v.clock?.nominationsOpen) {
      const f = findSeat(v, args.target);
      if (f.error) return refuse(ctx, f.error);
      ctx.api.nominate(ctx.game, me(ctx), f.seat.index);
      return {ok: true, nominated: f.seat.name};
    }
    const why = !v.alive ? 'The dead cannot nominate.' : v.phase !== 'day' ? 'Nominations happen by day.' : 'Nominations are not open yet.';
    return refuse(ctx, why);
  }
  const f = findSeat(v, args.target);
  if (f.error) return refuse(ctx, `${f.error} You may nominate: ${listNames(asked.options)}.`);
  if (!asked.options.includes(f.seat.name)) return refuse(ctx, `You cannot nominate ${f.seat.name} today. You may nominate: ${listNames(asked.options)}.`);
  ctx.api.nominate(ctx.game, me(ctx), f.seat.index);
  return {ok: true, nominated: f.seat.name};
}
function vote(args, ctx) {
  const v = viewOf(ctx), p = pendingOf(ctx);
  if (!p || p.kind !== 'vote') return refuse(ctx, 'No vote is open now.');
  if (p.mine != null) return refuse(ctx, `You already voted ${p.mine ? 'yes' : 'no'} on ${nameOf(v, p.nominee)}.`);
  const yes = yesNo(args.yes);
  if (yes === null) return refuse(ctx, `Vote "yes" (execute ${nameOf(v, p.nominee)}) or "no".`);
  ctx.api.vote(ctx.game, me(ctx), yes);
  return {ok: true, voted: yes ? 'yes' : 'no', nominee: nameOf(v, p.nominee)};
}
function nightChoice(args, ctx) {
  const v = viewOf(ctx), p = pendingOf(ctx), asked = askedOf(ctx.game, v, me(ctx), p);
  if (!asked || asked.kind !== 'choose') return refuse(ctx, 'Nothing is asking you to choose now.');
  const picks = toList(args.pick);
  if (picks.length !== asked.count) return refuse(ctx, `Pick exactly ${asked.count === 1 ? 'one' : asked.count} of: ${listNames(asked.options)}.`);
  const labels = asked.options.map(o => o.toLowerCase()), values = [], chose = [];
  for (const x of picks) {
    const k = labels.indexOf(x.toLowerCase());
    if (k < 0) return refuse(ctx, `"${x}" is not one of the choices: ${listNames(asked.options)}.`);
    values.push(p.options[k]); chose.push(asked.options[k]);
  }
  if (new Set(chose).size !== chose.length) return refuse(ctx, `Pick ${asked.count} different players.`);
  ctx.api.answer(ctx.game, me(ctx), asked.count === 1 ? values[0] : values);
  return {ok: true, chose};
}
function pass(args, ctx) {
  ctx.api.pass(ctx.game, me(ctx));
  return {ok: true, passed: true};
}

const T = (name, act, desc, args, fn) => ({name, act, desc, args, handler: guarded(fn, name)});
export const PLAYER_TOOLS = [
  // reads: free, any number per turn
  T('look', false, 'The table now: phase, day, the clock, who is alive and dead in seat order, and today\'s nominations and votes.', {}, look),
  T('my_role', false, 'Your role, team and ability in plain words, and everything the Storyteller has told you in private.', {}, myRole),
  T('read_talk', false, 'What happened since your last read: lines said at the table, whispers to you, who was seen whispering, deaths, nominations, votes. Oldest first, with ids.',
    {since: {type: 'integer', optional: true, desc: 'Show entries after this id; 0 shows everything (default: after the last one you read).'}}, readTalk),
  T('my_whispers', false, 'Every whisper you sent or received, oldest first.', {}, myWhispers),
  T('my_notes', false, 'Your own notes, oldest first. Nobody else can read them.', {}, myNotes),
  T('what_is_asked', false, 'The decision waiting on you, if any (a vote, a nomination, a night choice), with the legal answers.', {}, whatIsAsked),
  T('who_voted', false, 'The open vote: who is nominated, who has voted so far and who has not.', {}, whoVoted),
  T('note', false, 'Write a private note to yourself (a claim you heard, a suspicion, a plan). Does not use your turn.',
    {text: {type: 'string', desc: 'The note, one or two sentences.'}}, note),
  // acts: each one spends the turn
  T('speak', true, 'Say one short line to the whole table (day only). Say something new; a repeat is refused.',
    {text: {type: 'string', desc: 'What you say, in your own voice, at most 600 characters.'}}, speak),
  T('whisper', true, 'Whisper to one player (day only). Only they hear it; the table sees that you two whispered.',
    {to: {type: 'string', desc: 'The player\'s name.'}, text: {type: 'string', desc: 'What you whisper, at most 600 characters.'}}, whisper),
  T('nominate', true, 'Nominate a living or dead player for execution once nominations are open. One nomination each a day; each player can be nominated once a day.',
    {target: {type: 'string', desc: 'The name of the player you nominate.'}}, nominate),
  T('vote', true, 'Your vote on the open nomination: "yes" to execute, "no" to spare. A dead player has one yes left for the whole game.',
    {yes: {type: 'string', desc: '"yes" or "no".'}}, vote),
  T('night_choice', true, 'Answer the choice your role must make (see what_is_asked): a player\'s name, two names when it asks for two, or "nobody" when that is offered.',
    {pick: {type: 'array', desc: 'The name or names you choose, as the question asks.'}}, nightChoice),
  T('pass', true, 'Do nothing this round: stay quiet now, or decline to nominate.', {}, pass),
];
export const TOOL_NAMES = PLAYER_TOOLS.map(t => t.name);
// What a call to a tool that does not exist is told.
export const ATTEMPT_INVITE = `Use one of your tools: ${TOOL_NAMES.join(', ')}.`;
// The header's counts, for the runner to show the same.
export {whatsNew};
