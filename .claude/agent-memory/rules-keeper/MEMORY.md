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
- Slayer: a standing day action, callable any time the day's table ask waits (see Game 1 fixes); never offered at dawn.
- Red herring: any good seat, may be the Fortune Teller.

## The api and backend (slice 3)
- Every log entry: `id` (= n, = index) and `audience` ('all' | [seats] | 'storyteller'), set in grimoire.js `log` (PUBLIC_TYPES; a day death is public, a night death is announced by dawn). api.events projects each entry through a per-type whitelist (`project`), never the raw entry; engine 'night' -> 'phase', 'vote' -> 'vote-result'.
- Api state lives in the game: `clock` {day, round, roundsBeforeNominations, nominationsOpen, spoke, passedNominating}, `ballot` {id, nominee, votes}, `notes` {seat: [...]}, `actions` (every mutating api call). `restore(plainCopy)` = newGame(config) + replay actions. `sync()` resets the clock on a new day; idempotent and logs nothing, so reads may call it.
- Clock: one say-or-pass per seat per round before nominations; round ends when every living seat has had one; nominations open after `rounds` (default 3, config.rounds) or by openNominations; after that talk is free, a pass means "pass on nominating", and the day ends itself when every living seat nominated or passed (logs phase day-ends, answers the engine null).
- No per-hand public events: a Butler's voided yes would show. The vote pending carries `ballots` (hands so far) because the player-builder asked; vote-result's `yes` is the counted hands only.
- closeVote/endDay take a reason, logged as a ruling with decision null. grimoire() adds `by` to tokens (engine grimoire unchanged, so dawn entries and the sim stay the same). nightOrder() is a flat [{role, seat|null, acted, status, wakes}].
- forSeat(seat): a player's api refuses other seats and every Storyteller function; the Storyteller may view/pendingFor any seat but never notes, events of a seat, or acts.
- backend.js: no Date.now (gamecheck forbids clocks in src/game): the scripted Storyteller is a setTimeout(grace) reset by each new decision and each Storyteller call. Seen-tracking for the soft wake: brief, wake, and ctx.api.events mark seen.
- An api game driven by createScripted makes exactly the sim's engine answers (apicheck holds this for seeds 1-5, 7).
- Seed 3 deals Odette the Spy: her told carries the whole grimoire, so leak checks on her allow roles named in her told.

## Game 1 fixes (#30, #29, #37)
- Day clock: `clockStarted(game)` = phase day, step 'nominations', no winner. say/pass refuse before it (night, a dawn being resolved, dusk) and a refused act records nothing (act() pushes to game.actions only after impl returns).
- The engine goes from dawn straight to step 'nominations'; no dawn day-actions loop any more. A standing day action is a hook `dayAction: {available, options, question, *act}`; the day's table ask carries `pending.dayActions` [{by, ability, options, question}], answered `{by, ability, target}` (validate checks it), resolved at once, then the table ask comes again (new pending id).
- api: `dayActionFor`, `dayAction(seat, target|null)` (null keeps it, a no-op); refused during a vote or a Storyteller ruling, dead, spent, no ability. pendingFor shows it as `{kind: 'choose', standing: true, options: [null, ...]}` only once the seat has taken its say-or-pass this round (or nominations are open and it has no nomination left), so it never hides the seat's turn (the mock mind answered "nobody" forever otherwise). mustAct ignores standing; answer() routes a standing choose to dayAction.
- `canAct(game, seat)`: mustAct, or (clock running) a standing action, its round turn, or a nomination/pass on nominating. `nextTurnText` returns a phrase starting "until ..." (the player header wraps it "nothing to do until ...").
- backend pace: soft only if unseen AND (winner, Storyteller, a seat never shown the game, or canAct); the heartbeat's why adds "nothing to do until ...".
- Scripted Slayer: weighs the shot once a day (memo in createScripted) after the day's first vote, or before the scripted table ends the day. Seed 2's transcript moved; 1 and 3 did not. Seed 10 shoots (apicheck covers it).

## Rooms and neighbour whispers (#28, PR #57)
- Rooms are data in `src/data/rooms.js` ROOMS [{id, name, size}] (placeholders nook 2, parlour 3, backroom 4; lore renames). State `game.places[seat]` = room id or null (the Square); sync resets it on a new day.
- Owner's open questions answered by the manager's defaults: 3 rooms (2/3/4); a line anywhere is the turn. Moves (go/invite/leave) are free, never a turn.
- Room line audience = occupants at the moment (late joiner hears nothing earlier). A Square line stays 'all' (seats in rooms hear the Square too). Storyteller events exclude room lines like whispers; watchView adds both, plus `places`.
- invite: only a seat at the Square (never pulls someone out of another room); room omitted = inviter's room; both move, one public `move`.
- Whisper: at the Square only, to livingNeighbours (dead skipped), target must be at the Square too (a neighbour in a room is refused, not replaced by the next one). Dead seats may whisper and use rooms.
- Rooms close (one `move` with closed: true) in openNoms and endDay.
- The sim plays through the api (`src/game/talk.js` playScripted); talk has its own RNG (seed ^ 0x7a1c7a1c) so no decision moves; apicheck still compares apiGame (no rooms) to the sim's answers. Adding talk randomness never moves winners; changing scripted.js does.
- channelcheck's B is A's neighbour now (the old B could be anyone).
