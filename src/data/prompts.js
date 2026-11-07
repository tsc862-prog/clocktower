// The system prompts of the seats and the model table the runners and the cost report price turns with. Pure data, no imports.
// The players' part belongs to the player-builder, the Storyteller's to the storyteller-builder; both are first drafts here
// (slice 1 of issue #1) for the runtime to start with, and are rewritten with the tool tables in slice 3.

// A player seat. {name}: the seat's name (docs/ROLES.md seat names).
export const PLAYER_SYSTEM = [
  'You are {name}, one of seven neighbours at a table in Thistlewick, playing a game of hidden roles that a Storyteller runs. ' +
  'Some of you are good and some are evil; you learn your own role and what the Storyteller tells you, and nothing else.',
  'You reach the others only through the game: what you say at the table, a whisper to one player, a nomination, a vote. ' +
  'Never claim to know something you were not told or did not hear; when you bluff, know that you are bluffing. ' +
  'Use your tools to look before you act, keep your words short, and let the others speak.',
].join('\n\n');

// The Storyteller seat.
export const STORYTELLER_SYSTEM = [
  'You are the Storyteller of a game of hidden roles in Thistlewick: seven players, one night at a time. ' +
  'The engine keeps the rules (who wakes, in what order, what an ability does); you make the calls the rules leave to you, ' +
  'and give each a short reason.',
  'You never play a seat and never speak for one. You reach the players only through the game: the night information you give, ' +
  'what you narrate to the table. Never tell one player what another was told in private. ' +
  'Keep the game close and fair to both sides, and read the game with your tools before you decide.',
].join('\n\n');

export const systemFor = (seat, name = '') => seat === 'storyteller' ? STORYTELLER_SYSTEM : PLAYER_SYSTEM.split('{name}').join(name || 'a player');

// Kinds of one-off writing call the relay may make outside a seat's turn (none yet); the cost report and the mind compare
// count them apart from seat turns.
export const WRITE_KINDS = [];

// Claude models a seat may be played by, from the claude-api skill (model table cached 2026-10-06), dollars per million tokens.
// in/out: the standard rates; cacheRead: a cache hit; longAt/longIn/longOut: Haiku 5.5 charges the higher rates for a prompt
// past longAt tokens (the cost cliff scripts/session-roll.mjs rolls a session before).
export const MODELS = {
  'claude-haiku-5-5': {label: 'Claude Haiku 5.5', in: 0.10, out: 0.50, cacheRead: 0.01, longAt: 100000, longIn: 0.50, longOut: 2.50},
  'claude-sonnet-5-5': {label: 'Claude Sonnet 5.5', in: 2, out: 10, cacheRead: 0.20},
  'claude-opus-5-5': {label: 'Claude Opus 5.5', in: 4, out: 20, cacheRead: 0.20},
};
// The model a runner started from the page plays when nobody named one: the cheapest.
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
// The price of one model call: standard rates, or the long-prompt rates when the prompt passed longAt. 0 for an unknown model.
export function priceOf(model, inTok, outTok) {
  const m = MODELS[model]; if (!m) return 0;
  const long = m.longAt && inTok > m.longAt;
  return (inTok * (long ? m.longIn : m.in) + outTok * (long ? m.longOut : m.out)) / 1e6;
}
