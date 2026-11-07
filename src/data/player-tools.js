// The tools a player agent uses to play one seat. Pure data, shared by the relay's MCP server (scripts/relay-mcp.mjs), the local
// tool loop (scripts/local-agent.mjs) and the docs. Each tool:
//   {name, desc, act, args: {argName: {type: 'string'|'integer'|'number'|'array' (of strings), desc, optional?, enum?}}, handler?}
// act: true for a tool that spends the turn (speak, whisper, nominate, vote), false for a read.
// handler(args, ctx): the answer while no game is behind the relay; ctx = {seat: {id, name}}. Once the engine exists the game
// answers instead and the handlers go. A tool answers only with what that seat may know.
// STUB: one `look` until the player-builder fills this table in slice 3 of issue #1.
export const PLAYER_TOOLS = [
  {name: 'look', act: false, desc: 'Look at the table: the phase of the game and who sits where.', args: {},
    handler: () => ({ok: true, phase: 'no game yet', seats: []})},
];
export const TOOL_NAMES = PLAYER_TOOLS.map(t => t.name);
// What a call to a tool that does not exist is told.
export const ATTEMPT_INVITE = 'Use one of the tools listed for you.';
