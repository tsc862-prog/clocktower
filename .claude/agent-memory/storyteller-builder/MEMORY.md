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

## Pending on the api (asked in the PR)
- closeVote(game, reason) and endDay(game, reason) record the reason as a ruling.
- grimoire tokens carry `by`; the header fills it from game.seats when missing.
- nightOrder(game) -> [{role, seat|null, acted}].
- the day clock at game.clock {round, roundsBeforeNominations, nominationsOpen}; the open ballot at game.ballot.
- storytellerHeader takes the api as a second argument until the api lands; then default it to `import * as api from '../game/api.js'`.
