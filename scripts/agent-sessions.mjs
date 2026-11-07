// Agent runner sessions, one file per player: logs/agents/<playerId>.json holds the Agent
// SDK session id, the system prompt it was built with, turns and cost for that player only, so
// several runners (one per player) never touch each other's files and switching players never
// discards a conversation. Player ids restart with a new game, so a file whose player name differs
// from the player now behind that id belongs to an older game: it is moved to logs/agents/old/
// rather than overwritten.
// Plain Node, no SDK import.
import {existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROVIDERS} from '../src/data/providers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOGS = process.env.AGENT_LOGS ? resolve(process.env.AGENT_LOGS) : join(ROOT, 'logs'); // AGENT_LOGS: tests keep their sessions elsewhere
export const sessionDir = (logs = LOGS) => join(logs, 'agents');
export const sessionPath = (playerId, logs = LOGS) => join(sessionDir(logs), Math.floor(Number(playerId)) + '.json');
const readJson = f => {try {return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null} catch {return null}};
const safe = s => String(s || 'player').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
// Write through a temp file and rename, so a crash mid-write never leaves half a session.
// Windows refuses a rename over a file someone has open (the supervisor reading a player's mind, a virus scanner): try again for a
// moment, then let this save go. The session object lives on and the next save carries it; a save must never take a runner down.
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']), nap = new Int32Array(new SharedArrayBuffer(4));
function writeAtomic(f, obj) {
  mkdirSync(dirname(f), {recursive: true}); const tmp = f + '.' + process.pid + '.tmp'; writeFileSync(tmp, JSON.stringify(obj, null, 1));
  for (let i = 0; ; i++) {
    try {renameSync(tmp, f); return true}
    catch (e) {if (!LOCKED.has(e.code)) throw e; if (i >= 8) {try {rmSync(tmp, {force: true})} catch {} console.error(`[session] could not save ${f} (${e.code}): the next save carries it`); return false} Atomics.wait(nap, 0, 0, 25)}
  }
}
function archive(f, s, logs) {const to = join(sessionDir(logs), 'old', `${s.playerId}-${safe(s.playerName)}-${Date.now()}.json`); mkdirSync(dirname(to), {recursive: true}); renameSync(f, to); return to}

// The session for this player, or a fresh one. fresh: the new session object to start.
// Returns {sess, note}; note says when an older game's file was set aside.
export function loadSession(playerId, playerName, fresh, {logs = LOGS, startNew = false} = {}) {
  const f = sessionPath(playerId, logs), s = readJson(f);
  if (s && s.playerId === playerId && s.playerName === playerName && !startNew) return {sess: s, note: null};
  let note = null;
  if (s && (s.playerName !== playerName || startNew)) note = 'earlier session kept at ' + archive(f, s, logs);
  const sess = fresh(); if (s && s.playerName === playerName && s.runner) sess.runner = s.runner; // --new starts the conversation over, not the player's mind
  return {sess, note};
}
// A roll (scripts/session-roll.mjs): the file goes where --new puts it, and the runner saves on under the same path.
export function setAside(sess, logs = LOGS) {const f = sessionPath(sess.playerId, logs); return existsSync(f) ? archive(f, sess, logs) : null}
// Per-player runner settings, kept in the session file as sess.runner = {provider, model, effort}.
// Each player can have its own mind: 'anthropic' (Claude Agent SDK) and 'ollama' (a local model through
// scripts/local-agent.mjs) both run in a seat runner; the relay routes by player id alone and never assumes a model or an SDK, so
// other providers can read the same file later. Precedence: command-line overrides,
// then the player's saved settings, then the defaults (environment / built-in). Returns the settings
// and whether they changed what was saved.
export const DEFAULT_PROVIDER = 'anthropic';
export const RUNNER_PROVIDERS = PROVIDERS; // providers with an agent runner: the one list, player or Storyteller
export function runnerSettings(sess, overrides = {}, defaults = {}) {
  const saved = sess && sess.runner && typeof sess.runner === 'object' ? sess.runner : {};
  const pick = k => overrides[k] != null && overrides[k] !== '' ? String(overrides[k]) : saved[k] != null ? String(saved[k]) : defaults[k] != null ? String(defaults[k]) : null;
  const r = {provider: pick('provider') || DEFAULT_PROVIDER, model: pick('model'), effort: pick('effort')};
  // a provider switch drops the saved model and effort (they belong to the old provider)
  if (saved.provider && r.provider !== saved.provider) {r.model = overrides.model || defaults.model || null; r.effort = overrides.effort || defaults.effort || null}
  const changed = JSON.stringify(saved) !== JSON.stringify(r);
  return {runner: r, changed};
}

// Which player a runner takes, from /play/health's players ([{id,name,alive,link}]):
// --player NAME|ID names one (case-insensitive name, or id); without it the first living player
// with no live runner (link 'none'). Returns {player} or {error} with the list to choose from.
// Held by a live runner: the claim decides when health reports it (a runner that just let go still
// shows 'connected' for a few seconds after its last call, and may start again at once).
const busy = h => h.claimed != null ? !!h.claimed || h.link === 'waiting' : !!h.link && h.link !== 'none';
export function pickPlayer(players, want) {
  const list = (players || []).map(h => `${h.name} #${h.id}${h.alive ? '' : ' (dead)'}: ${h.link === 'none' ? 'free' : 'runner ' + h.link}`).join('; ') || 'none';
  if (want != null && String(want).trim()) {
    const w = String(want).trim().toLowerCase(), h = (players || []).find(x => String(x.id) === w || x.name.toLowerCase() === w);
    if (!h) return {error: `No seat "${want}". Seats: ${list}.`};
    if (busy(h)) return {error: `${h.name} #${h.id} already has a live agent runner (${h.link}). One runner per seat.`};
    return {player: h};
  }
  const h = (players || []).find(x => x.alive && !busy(x));
  return h ? {player: h} : {error: `No free seat (${list}). Name one with --player.`};
}
export function saveSession(sess, extra = {}, logs = LOGS) {writeAtomic(sessionPath(sess.playerId, logs), {...sess, ...extra, updated: new Date().toISOString()})}

// ---- the Storyteller seat: one session for the Storyteller agent, logs/agents/storyteller.json ----
// The file carries the game tag the game reports; a file from another game, or
// the old one on --new, is moved to logs/agents/old/ rather than overwritten, like a player's.
export const storytellerSessionPath = (logs = LOGS) => join(sessionDir(logs), 'storyteller.json');
export function loadStorytellerSession(game, fresh, {logs = LOGS, startNew = false} = {}) {
  const f = storytellerSessionPath(logs), s = readJson(f);
  if (s && s.game === game && !startNew) return {sess: s, note: null};
  let note = null;
  if (s) note = 'earlier Storyteller session kept at ' + setAsideStoryteller(s, logs);
  const sess = fresh(); if (s && s.game === game && s.runner) sess.runner = s.runner; // --new keeps the seat's mind
  return {sess, note};
}
export function setAsideStoryteller(sess, logs = LOGS) {const f = storytellerSessionPath(logs); if (!existsSync(f)) return null; const to = join(sessionDir(logs), 'old', `storyteller-${safe(sess.game)}-${Date.now()}.json`); mkdirSync(dirname(to), {recursive: true}); renameSync(f, to); return to}
export function saveStorytellerSession(sess, extra = {}, logs = LOGS) {writeAtomic(storytellerSessionPath(logs), {...sess, ...extra, updated: new Date().toISOString()})}
