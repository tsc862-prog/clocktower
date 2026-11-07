// The tools the Storyteller agent uses to run the game. Pure data, shared by the relay's MCP server (scripts/relay-mcp.mjs,
// selected with X-Clocktower-Role: storyteller or /mcp?role=storyteller) and the local tool loop. Separate from the player tools:
// the Storyteller never plays a seat, and no player reaches these. Same shape as src/data/player-tools.js.
// STUB: one `look` until the storyteller-builder fills this table in slice 3 of issue #1.
export const STORYTELLER_TOOLS = [
  {name: 'look', act: false, desc: 'Look at the game: the phase and the seats.', args: {},
    handler: () => ({ok: true, phase: 'no game yet', seats: []})},
];
