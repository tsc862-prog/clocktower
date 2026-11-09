// The engine's public face. Runs unchanged in Node and in the browser: no model, no network, no node: imports.
export {newGame, createState, deal} from './state.js';
export {answer, replay, validate, start, THOUGHT_MAX, THOUGHTS_QUESTION} from './engine.js';
export {PENDING_KINDS, optionKey, sameAnswer} from './mechanics.js';
export {grimoire, roleName, aliveCount} from './grimoire.js';
export {createScripted, suspicion, cannedThoughts} from './scripted.js';
export {createScriptedTalk, playScripted} from './talk.js';
export {createRng} from './rng.js';
export {HOOKS, TELLINGS, PASSIVE} from './abilities.js';

import {answer} from './engine.js';

// Play a game to its end. `answerer(state)` answers each decision; `override(pending, state)` may answer first
// (return undefined to defer). Stops at maxDays with an error, or when `until(state)` turns true.
export function playOut(state, answerer, {override, until, maxDays = 30, onDecision} = {}) {
  while (state.pending && !(until && until(state))) {
    if (state.day > maxDays) throw new Error(`no winner after ${maxDays} days`);
    const p = state.pending;
    let v = override ? override(p, state) : undefined;
    if (v === undefined) v = answerer(state);
    if (onDecision) onDecision(p, v, state);
    state = answer(state, v);
  }
  return state;
}
