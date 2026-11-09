---
name: game4-fixes
description: What game 4 (seed 31) taught the player seats and how PR #97 answered it - day-1 dodge pile-on, Poisoner targets, log misreads, indirect claims, header room
metadata:
  type: project
---

PR #97 (2026-11-09) answered #87, #88, #89, #92 from the game 4 review (#93).

- **Day-1 pile-on is the recurring failure** (games 1, 3, 4): Haiku treats an unanswered question as evidence. The fix is knowledge, not tone: the prompt names which roles learned something by day 1 (Washerwoman, Librarian, Investigator, Chef, Empath, Fortune Teller) and which did not; a good seat with nothing yet gets "First day: the Monk first acts on night 2, so you have nothing to tell yet; say so if asked..."; the claims line on day 1 ends "No night answer to give yet: Monk and Mayor (silence there is no dodge)." Not yet measured in a played game.
- **Role knowledge lives in player.js**: LEARNS (first / nightly / later / never), nothingYet(role), readsOf(role) (one sentence on what a count can and cannot show, my_role `reads`), my_role `day1` for good roles only.
- **Poisoner line** at night 2+ with the choose pending: "Poison: worth it on ...; wasted on X (Virgin, fired day 1), Y (Librarian, first night only); no working claim: ... Never on the player your demon kills tonight." From claims heard + public virgin/slayer-shot events; team-mates from told minion-info are excluded.
- **Log wording**: cleanEvent rewrites nomination and virgin texts ("X (nominator) nominated Y (nominee)"); the engine's projection text is untouched (rules-keeper's). Header "Record: day 1, ..." (virgin, slayer shot that killed, execution; last 3).
- **Claims by ability**: ABILITY_SAYS (first-person regex per role) only when the line claims no role by name; marked unnamed / "said not named"; "my X ability|trap|number..." is a named claim. Claims line now by role: "Claims (one player per role): Mayor: Corwin (day 1); Monk: Ines (said not named)." Day omitted for today's claims; clash "(twice: at most one is)".
- **channelcheck gotcha**: it plants A's role name and scans every seat's text INCLUDING the system prompt; on its seed A is the Imp. Never name the Imp in the player prompt (say "the demon"); any role named in the static prompt blinds that probe.
- **Header room**: Moves line by day only and only today's moves; news line with >5 kinds ends "N more". Scripted seats never read, so peak headers in `playScripted` games without read_talk run ~870-965 (main was ~1000-1090 before); with reads, seed 31 peaks at 749. The cap test samples realistic states.

**Why:** game 4 lost the Monk on day 1, wasted 3 of 3 poisons and reversed the Virgin's nominator; "the only Mayor left" with no second Mayor.
**How to apply:** after the next paid game, check whether day-1 nominations still cite a "dodge" and whether the Poisoner line changed picks; if the pile-on persists, consider a header line for the asker ("you asked Ines a question her role cannot answer yet"). Related: [[talk-model]].
