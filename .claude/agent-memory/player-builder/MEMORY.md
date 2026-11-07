# player-builder memory

## The tool table (slice 3, src/data/player-tools.js)
- 14 tools. Reads (act false): look, my_role, read_talk(since?), my_whispers, my_notes, what_is_asked, who_voted, note(text). Acts (act true): speak(text), whisper(to, text), nominate(target), vote(yes: "yes"|"no" as a string), night_choice(pick: array of names), pass.
- `note` is act false on purpose: writing a note never spends the turn.
- Arg types the relay understands: string, integer, number, array (of strings), object. No boolean: vote takes "yes"/"no" and the handler also reads true/false/y/n.
- Every handler is `guarded`: no ctx.api/ctx.game (the relay's stub backend) -> look answers {ok, phase: 'no game yet', seats: []} (relaycheck depends on it), others say "No game yet". Any throw -> {ok: false, error: message + " Open to you now: ..."}.
- Handlers copy out whitelisted fields only (cleanEvent in src/seats/player.js: kinds say, whisper (own), whisper-seen, dawn, nomination, vote-result, execution, narration, phase, told (own)); never call grimoire/rulings/nightOrder.
- Names: seats resolved by exact name or a unique prefix, any case. Choose options labelled: index -> seat name, null -> "nobody", role id -> role name.

## The header (src/seats/player.js playerHeader(game, seat, api?))
```
You are Odette, the Fortune Teller (townsfolk, good), alive.
Day 1, round 2 of 3; nominations not open yet.        | Night 2. Nobody talks at night.
Alive (7): Odette, Bram, ... Dead: ...
New since your last look: 2 lines at the table, 1 whisper to you, 1 whisper seen, 1 dawn report. read_talk to see it.
**WAITING ON YOU: Vote on Thea's nomination of Fitch: yes to execute, or no.**   (only when something waits)
Useful now: vote, who_voted, read_talk.
```
- Under 700 chars in the usual case (~400). "Last look" = the last event id read_talk returned, per seat, in a WeakMap beside the game (lost on relay restart: the seat sees recent talk again).
- The api comes from useApi(api) or the third argument until src/game/api.js is on main; then import it directly.

## Talk model
- Nothing measured yet (slice 5).
