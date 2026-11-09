---
name: evil-cover
description: What game 5 (seed 37) taught about evil seats giving away roles and how the Cover line and secret claims answer it (#104)
metadata:
  type: project
---

Game 5 hanged the Spy on day 1: she told her Imp "I am the Spy" in the Snug, he looked it up in claims and repeated it at the table, she stood by it, a good seat said "Spy is an evil role". Nothing a seat read said an evil role is a secret, and the claims ledger listed it like any claim.

The fix (2026-11-09, issue #104):
- Prompt paragraph after the bluff sentence: true role and team-mates' are secrets; cover from day 1 and keep to it; demon takes a bluff, minion a role not in play and tells the demon in a room; never nominate/vote a team-mate unless agreed. Still never names the Imp (channelcheck).
- `Cover:` header line, by day only (at night a Poisoner header with Poison line went 988 > 900). Demon: first bluff nobody claimed; Spy: townsfolk not in the grimoire told text, rotated by seat index; other minion: SAFE_GUESS (Soldier, Mayor, Monk first) rotated by seat, "a guess". Minions add "Tell <demon> in a room". After a good claim of its own (not whispered to a team-mate): "Your cover: X, said day N: keep to it." my_role has `cover`.
- Ledger: claimsOf marks `secret: 'own'` (my evil role, anywhere) or `'team'` (team-mate's evil role in a room or whisper); claimsText, clashesOf, the claims tool's oneClaim skip them. A claim first said in private and later at the table becomes a table claim (the table heard it).
- Chef note: pairs anywhere at the table, not his neighbours.

**Why:** Haiku does what the prompt says; "check claims before you repeat" turned the ledger into a script for repeating a secret.
**How to apply:** after the next paid game, check whether evil seats claim their Cover role on day 1, whether two evil seats clash on one cover (the guess has no knowledge of the demon's bluffs), and whether anyone still names a team-mate's role. Related: [[game4-fixes]].
