# player-builder memory

## The tool table (slice 3, src/data/player-tools.js)
- 19 tools. Reads (act false): look, my_role, read_talk(since?), my_whispers, my_notes, what_is_asked, who_voted, note(text), where. Moves (act false, free): go(room), invite(player, room?), leave. Acts (act true): speak(text), whisper(to, text), nominate(target), vote(yes: "yes"|"no" as a string), night_choice(pick: array of names), slay(target | "hold"), pass.
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

## Talk model: what game 1 taught (seed 7, Haiku on every seat; review #40)
- Haiku copies what it reads: once lines showed "Name: text" it signed every line (#33), and six seats repeated one pile-on phrase (#32). Fixes: speak/whisper strip a leading own "Name:", "Name (ghost):", "**Name:**" (stripOwnName in player-tools.js); the prompt and the header say not to sign; a manner per seat (SEAT_MANNERS in prompts.js, keyed by seat name, mirrored in docs/ROLES.md) plus "speak in your own voice, do not echo the table".
- Left alone, day 1 is dead air: the table agrees "no nominations on an empty dawn" and passes (#31). The prompt now says the first day matters most, soft claim or ask by name, nominate anyway; the header nudges on day 1 (seat can act, nothing asked) and when nominations are open with none made.
- Nobody counted at 4 alive (#38): stakesLine(v) by day at 3-4 alive ("Stakes: 4 alive; the demon kills one a night; evil wins at 2. A wrong execution today: 3 left, 2 after tonight, evil wins. Wrong executions to spare: none.").
- Seats woken after their round turn burned turns on refused pass/speak (#29). waitingOf(game, api, v, me, asked): the api's canAct/nextTurnText when present (rules-keeper's parallel PR), else clock.toSpeak; the header then says "You have had your turn this round; nothing to do until round N / until nominations open; reading is fine." and Useful lists reads only (refusals and what_is_asked too). Pacing (not waking) is infra's half.
- Header lines now: who, clock, alive, [stakes], news, [WAITING ON YOU], [wait text], [nudge], Useful (+ "Speak without your name in front." when speak is listed), [dead line]. Still under 700.
- Template-literal/replace gotcha when scripting edits with node: `$&` and `$'` in a String.replace replacement and `\s` in a template literal get eaten; use split/join or the Edit tool.

## The real api (PR #16) as it met the tools
- ctx.api is api.forSeat(index): bound, so a handler can only name its own seat; Storyteller functions throw.
- Event ids start at 0 (lastSeen defaults to -1; read_talk since<=0 means everything). Projections include phase (what: night|round|nominations|day-ends), pass, vote-closed, no-execution, slayer-shot, virgin, death, win; all seat fields are indexes.
- ApiError messages already end with legalNow(): handlers pass them through unchanged (only their own refusals get "Open to you now").
- The vote pending stays after voting (mine set) and has no `seats`; who_voted approximates voters as the living plus who voted.
- A seat that passed on nominating has no nomination pending but may still nominate: nominate calls the api anyway when nominations are open.
- view.clock.toSpeak (living only): the header says whether my turn this round is still mine.
- Integration case in playertoolcheck: seed 7, rounds 1, to day 3 through the tools (say, repeat refused, whisper, passes, 2 nominations, 14 votes, 5 night choices).

## The Slayer's standing shot (#37, after rules PR #45)
- The api: dayActionFor(game, seat) non-null while the shot may fire (day, talk begun, the table's nomination pending: not during a vote); dayAction(game, seat, idx|null) fires or keeps ({kept:true}); pendingFor shows it as choose {standing:true} only after the seat's round turn.
- shotOf(game, api, v, me) in player.js is the one source. askedOf returns null for a standing pending (never WAITING ON YOU). Header line "Your shot is unspent: slay <name> any time today, or hold it." after the wait text; usefulTools(..., shot) = the list without the shot + 'slay'. waitingOf judges the wait as if no shot (the api's canAct is true with one) and says "nothing else to do".
- what_is_asked: asked "standing" (tool slay, options + "hold") when nothing else waits, else a standing field. night_choice with one name and no real choose falls back to slay ("nobody" holds).
- slay's answer is public only: the event texts plus "X dies." or "X is still alive" (same text whether or not a Storyteller ruling on the target is still pending, so a Recluse is not hinted).
- A one-name night_choice by day now fires a shot: channelcheck's hostile probes use two names. whatsNew counts slayer-shot as "shots", not deaths (virgin and the shot used to double-count with their death/execution).
- Escaping gotcha again: \' inside a node heredoc template literal lost its backslash; edit quote-bearing JS strings with the Edit tool.


## Rooms (#28, PR #61 on the api of #57; names from lore #59)
- Room ids stay nook/parlour/backroom; names are the lore-keeper's (the Snug, the Vestry, the Taproom). Tests on a real game read names from api.where(...).rooms, never hard-code them (#59 landed mid-PR and broke them).
- Header lines added after the news line: `Moves: <newest two texts>` (others' moves since the last look; "N earlier (read_talk)"), the place line (`You are at the Square; whisper only to your neighbours A and B. Away: X and Y in the Vestry.` / `You are in the Vestry with Thea: only you 2 hear...` / `You are alone in the Snug...`), and `Rooms, closing when nominations open: Snug 2 free, ...` while open. Useful gains invite (Square) or leave (room, whisper dropped).
- Header cap in playertoolcheck raised 700 -> 900 for those lines (day 1 real ~640; fake 3-alive with stakes ~890). Next line added needs a cut elsewhere.
- speak returns `heard`; whisper pre-checks view.place.neighbours and refuses with both names + "invite them to a room"; cleanEvent drops entries whose audience array omits the seat; read_talk: move {seats,to,from,by,text}, room line `in`.
- channelcheck probes go/invite only with nonexistent rooms (a probe must move nobody); leave is exempt beside pass.
- Not yet measured in a played game: whether seats over-use rooms or speak alone in one.
