// Lazy tools (a cost lever): every player tool schema rides in every Claude call and is resent each call.
// each call. AGENT_LAZY_TOOLS=1 keeps the tools below in the prompt and defers the rest behind the CLI's ToolSearch: a deferred
// tool stays a tool (no tool is removed, the owner's rule); its name is listed, its schema comes when the player looks it up. Off by
// default, and off is the old request as it was. Player Claude runners only: the Storyteller, local and OpenAI-style minds never
// come here, and the forced scene answers (scripts/pacing.mjs) do not use the session's tools at all.
//
// How it works, read on SDK 0.3.316 / CLI 2.1.316 and proved by `npm run sessioncheck`:
//   tools: [] is what keeps ToolSearch out: with no ToolSearch the CLI sends every schema, whatever else is set.
//   tools: ['ToolSearch'] turns deferral on. MCP tools are deferred, except those the server lists with _meta anthropic/alwaysLoad.
//   ?lazy=1 on /mcp asks the relay for that _meta; without it tools/list is what it always was.
//   ENABLE_TOOL_SEARCH pinned 'true': the CLI otherwise keeps a conversation that ran without ToolSearch without it.
// The roll (scripts/session-roll.mjs) starts a fresh session when the switch changed, so no session carries both tool shapes.
//
// Plain Node, no SDK import.
export const SEARCH_TOOL = 'ToolSearch', ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

// The player tools that stay in the prompt. A new tool not listed here is deferred and still found (the tool map names it). The groups
// say why.
export const LAZY_GROUPS = {
  // the reads a seat needs every turn; the player-builder lists the rest when the tool table fills in (slice 3)
  used: ['look'],
};
export const ALWAYS_LOAD = Object.values(LAZY_GROUPS).flat();
const always = new Set(ALWAYS_LOAD);

export const lazyOn = (env = {}) => /^(1|true|yes|on)$/i.test(String(env.AGENT_LAZY_TOOLS ?? '').trim());
// The _meta of one tool for /mcp?lazy=1, undefined for a deferred one.
export const lazyMeta = name => always.has(name) ? {[ALWAYS_LOAD_META]: true} : undefined;
// What query is given for a player's tools. Off: the options as they always were.
export const toolOptions = (lazy, url) => lazy ? {url: url + '&lazy=1', tools: [SEARCH_TOOL], allowedTools: ['mcp__clocktower', SEARCH_TOOL]} : {url, tools: [], allowedTools: ['mcp__clocktower']};
export function withLazyEnv(childEnv, lazy) {if (lazy) childEnv.ENABLE_TOOL_SEARCH = 'true'; return childEnv}
// Noted on a session as it starts (only when on, so a session file with the switch off is as it was).
export function markLazy(sess, lazy) {if (lazy) sess.lazyTools = true; else delete sess.lazyTools}
export const lazyLine = total => `[tools] lazy loading on: ${ALWAYS_LOAD.length} in the prompt, ${total - ALWAYS_LOAD.length} found with ${SEARCH_TOOL}`;
// A turn's use of ToolSearch, from the tool names on the turn line.
export const searchCount = tools => (tools || []).filter(t => t && t.name === SEARCH_TOOL).length;
// The turn record's part: only with the switch on, so a line with it off is as it was.
export const lazyRec = (lazy, tools) => lazy ? {toolSearch: searchCount(tools)} : {};
