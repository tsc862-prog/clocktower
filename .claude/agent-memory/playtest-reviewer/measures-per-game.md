---
name: measures-per-game
description: Measures per reviewed game (winner, cost, refusals, leaks, claims, demon found) and the issue numbers filed, games 1, 3 and 4
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

Game 4 (seed 31, 2026-11-09T14:26Z, summary #93): evil won night 4 two alive; $0.153, 125 turns (111 player), mean ctx 23k, first-turn ctx 7k (fresh sessions, #66 fixed); leaks 0; 55 lines (22 in rooms) / 13 passes; 20 refusals; rooms used (11 invites, #68 answered); demon not found (minion hanged); ST 9 of 14 turns empty (third game, #91); claims tool misses indirect claims (#92). Filed #87 (day-1 pile-on, high), #88 (Poisoner wastes poison), #89 (seats misread own log), #90 (Virgin execution narrated as a vote), #91, #92, #93; comments on #68 #70 #81 (all were already closed).

Tips: `/play/watch` JSON (needs Origin header) has the full event list incl. grimoire tokens; seats in events are 0-indexed, player ids 1-indexed; runner logs use local time (UTC-8) and show "new session" vs "resuming session". Writing issue bodies via heredoc in Bash failed on apostrophes: use the Write tool plus `gh --body-file`. Stale game-1 era lines share the same turns.jsonl: always filter by ts.

Game 5 (seed 37, id 37-20261109T173057Z, summary in the "Game 5 review" issue): unfinished (owner Stop 17:43:49Z, resume 17:49:30Z same session, New game 17:50Z; the 6 min gap is the owner's pause). $0.161, 96 player turns, leaks 0, 51 lines (15 rooms) / 10 passes, 21 refusals (12 had-your-turn, 7 night-1 heartbeat). ST 0 of 10 empty (#91 fix landed). Filed #122 (empty-room lines), #123 (answered question re-asked), #124 (execution tally wrong in narration), #125 (night-1 heartbeat), #126 (Mayor hanged on a tell fitting everyone). Label `playtest` did not exist; I created it. Seat order for neighbours = the alive list in the header, not the deal order given in the brief. Dead seats may speak, whisper and ghost-vote by design; "whisper-seen" notices are public by design (not a leak). Game logs for a game id are in game.jsonl (src=event) with `gameId`; turns.jsonl filter by ts.
