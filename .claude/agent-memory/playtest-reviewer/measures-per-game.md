---
name: measures-per-game
description: Measures per reviewed game (winner, cost, refusals, leaks, claims, demon found) and the issue numbers filed, games 1 and 3
metadata:
  type: project
---

Method that works: read `logs/play.jsonl` (field `player` = seat id, `role` = "storyteller" for ST; lines have `ts` UTC, local = UTC-8), `logs/behavior/clocktower/turns.jsonl` (filter by ts; `ctx`, `cost`, `flags`, `brief.text`), `logs/runners/*.log` (look for "resuming session"). Leak check: role names of other seats in headers and in private-tool results (my_role, my_whispers, look, where, who_voted, what_is_asked), whisper texts in non-party results, ST reason texts in player results.

| | Game 1 (seed 7, #40) | Game 3 (seed 23, #72) |
| --- | --- | --- |
| Winner | Evil night 4 | Good day 3 (Imp executed) |
| Cost | $0.12 | $0.383 (ctx carried over, #66) |
| Turns | 131 | 142 |
| Leaks | 0 | 0 |
| Refused calls | 10 "had your turn" | 18 (4 had-your-turn, 8 nomination races, 6 post-game) |
| Lines/passes | 55 / ~31 | 61 / 20 |
| Demon found by reasoning | no | yes twice |

Recurring failure kinds: sessions resumed across games (cross-game memory, #66); seats repeat an unchecked accusation (#67; game 1's #32 pile-on is the milder form); nomination races when all seats are woken at once (#69); read-only Storyteller turns (7/13 in g3, 10/15 in g1, #36 then #70); flat narrations (#70); stale notes (#71); rooms unused (#68). Game 2 was an aborted partial game inside the game-1 logs (23:01Z 2026-11-07) and the 16:39/16:41Z 2026-11-09 restarts: not reviewed.

Issues filed for game 3: #66 #67 #68 #69 #70 #71 summary #72; comments on #31 #32. Rule in agent file: a finding seen in 3 games is priority:high; I gave #66 and #67 high because they corrupt the outcome.
