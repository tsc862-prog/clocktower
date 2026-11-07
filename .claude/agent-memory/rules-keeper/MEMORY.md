# rules-keeper memory

## Shapes (slice 2, PR #13)
- Script: `src/data/script.js` SCRIPT {roles, firstNight, otherNights, setup 5..15, tellings, bluffs}. Role data rules: `setup`, `disguise` (Drunk), `misregisters` (Spy, Recluse), `heir` (Scarlet Woman). Everything else a role does is a hook in `src/game/abilities.js` keyed by id.
- Engine is a generator (`engine.js`); `state.pending` is the decision, `answer(state, v)` validates against `options` and resumes. Live generator kept in a WeakMap; a JSON copy is rebuilt by `replay()` from config + answers.
- Modules: grimoire.js (queries, tokens, log), mechanics.js (ask, perceive, inform, kill/die, demonDied, demonKill, execute, checkWin), abilities.js (HOOKS, TELLINGS), engine.js (phases), state.js (deal, newGame), scripted.js (createScripted), index.js (playOut).
- Scripted answers use their own RNG (seed ^ 0x5eed5eed) so the engine's RNG draws only for the deal; replays stay exact.

## Night resolution
- Seats act as `believed` (the Drunk wakes as its townsfolk); wakers for a step are snapshotted before acting (so a fresh star-passed Imp never acts twice).
- Poison: token by the Poisoner, replaced at its next action, removed at once when the Poisoner dies (kill() strips tokens `by` the dead seat unless `keep`).
- Monk protection: token with `shields: 'demon'`, `until: 'dawn'`, `active` false when the Monk was drunk/poisoned at the time.
- demonKill: dead target nothing; shield; Soldier hook; then Mayor redirect (once, bounced kill can still be shielded).
- Win check after the Imp's action, at dawn, after executions and Slayer shots, and at dusk (Mayor hook first).

## Edge decisions and why
- Scarlet Woman counts alive BEFORE the demon's death (official ruling): 5 alive and the Imp executed -> she takes over.
- Star pass with 4 alive still passes to a minion (the Imp's own ability, not the SW's). With several minions the Storyteller picks (`star-pass`); a working SW at 5+ always takes it.
- Registration prompts (`register`) only when the answer could change the result; dead Spy/Recluse still register (Undertaker case); poisoned ones never do.
- Virgin: used on first nomination even if poisoned; registering via the nominator (Spy may register as townsfolk). The Drunk is an outsider to the Virgin.
- Butler: a yes counts only if the master's yes is in the same vote; a voided yes does not spend a ghost vote; poisoned Butler votes freely; dead Butler votes freely.
- Ghost vote spent only by a counted yes. Bar = ceil(alive/2); a tie clears the block but keeps the bar.
- Slayer offered once at the start of each day (open: mid-day shots come with slice 5).
- Red herring: any good seat, may be the Fortune Teller.
