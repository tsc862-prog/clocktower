# storyteller-builder memory

## Shapes (slice 3, PR "Slice 3: the Storyteller's tools, header and prompt")
- Tool table `src/data/storyteller-tools.js`: reads look, grimoire, night_order, what_is_asked, talk, rulings, day_state; acts decide, fallback, narrate, open_nominations, close_vote, end_day. Handlers take (args, {game, seat, api, log}); a wrapper answers `look` with "no game yet" and refuses the rest when ctx.game is missing (the relay's stub backend, relaycheck calls `look`).
- `decide` reads `value` as words: a seat name, a role (name or id), yes/no, a number, "none", "#N" option refs, comma lists for `count` picks, "Name, Name, Role" for a pinger statement; or `option` (integer). Raw JSON in value is accepted for local loops. It always hands the api the pending's own option object.
- Reasons: required on decide, fallback, close_vote, end_day; at least 4 words and 15 characters. Passed to api.answer / closeVote / endDay and logged with ctx.log('storyteller-call', ...).
- `fallback` uses createScripted(game.config.seed) cached per live game (WeakMap) and prefixes the ruling "Scripted default: ".
- `narrate` refuses, while the game runs, any role name in play (true or believed); at the end it may name roles. Max 600 chars.
- `talk` and the header never carry whisper text: a raw `whisper` event becomes a whisper-seen mark (dropped if the api already sends marks).
- Header `storytellerHeader(game, api)`: phase/clock line, one grimoire line per seat, **Waiting on you: <kind words> for <seat>.** + question, Truth (3 shown, "and N more"), Legal (listed when short, "the truth only" when working info, else a count), "Since your last turn: N said, N whispers seen, N other events" (marks seen per live game in a WeakMap), "Now: <2-3 tools>". Cap 1200; longest over 60 seeded games ~730.
- The mock providers know a Storyteller turn by "Storyteller of" in the system prompt: keep it.

## Judgement guidance in the prompt
- Engine keeps the rules and offers only legal answers; true information when the ability works; when it malfunctions choose what makes the best game (often plausible and misleading, sometimes true); keep the game close by free choices only; one-sentence reason per call; reach players only via decisions and narration; never name a role while the game runs; voice: a town clerk reading the minutes of a bad week.

## The real api (PR #16) and how the tools meet it
- ctx.api is forSeat('storyteller'): may read view/pendingFor/events for 'storyteller', never acts for a player or reads notes.
- grimoire(game) returns {phase, night, day, seats, bluffs, pending, winner}; tokens carry `by`. grimoireRows accepts an array too (the check's fake).
- nightOrder entries: {role, seat|null, acted, status done|now|to come, wakes, name, seatName, night, telling}; by day it is the coming night.
- events(game, 'storyteller') returns every log entry with an audience except whispers: tableEvents keeps audience 'all' only.
- game.clock {day, round, roundsBeforeNominations, nominationsOpen, spoke, passedNominating}; game.ballot {id, nominee, votes}.
- closeVote/endDay(game, reason) log rulings with decision: null; endDay refuses while a vote is open or another decision waits.
- storytellerHeader(game, api = forSeat('storyteller')).
- The backend's --scripted mode answers a Storyteller decision unanswered for 2 s with the scripted default.

## Game 1 fixes (#34, #35, #36)
- `narrate` runs `narrationError(game, text)` (src/seats/storyteller.js): by day a sentence saying nominations are open/closed against `game.clock.nominationsOpen`, "X died in the night" against `game.diedTonight`, "executed" against `game.executed`/`game.today.executed` is refused with "Not true: <truth>". Sentences with not/yet/until/will/if or a Day N are skipped. The result carries `clock`.
- `decide` and `fallback` run `reasonFactsError` (storyteller-tools.js): "only option" with more than one offered; "poisoned/drunk" when info works; "works/sober" when malfunctioning (info and register kinds only).
- `offeredWords(p)` is the count line ("20 options offered, pick one"): in `what_is_asked.pending.offered` and the header's Legal line.
- Header: "Clock fact for narration: nominations are CLOSED (...)" by day; "DAWN NOT YET NARRATED: ..." from `dawnOwed` (a `dawn` event of this day with no `narration` event after it in the log), which puts narrate first in "Now:" (toolsNow third arg). Fake api in the check has `_push` for log events.
- Prompt: narrate every dawn with one line of Thistlewick colour, executions and the end; true reasons; spend turns acting.
