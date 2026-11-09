---
name: game5-day-fixes
description: What game 5's day talk taught (#122 empty rooms and had-your-turn, #123 questions asked twice and lines said twice, #126 reasons that fit anyone, ghosts' room stories) and how players/day-reads-better answered it
metadata:
  type: project
---

Game 5 (seed 37) day talk, answered on branch players/day-reads-better (2026-11-09):

- **Rooms and the turn (#122).** Seats spoke alone in a room (3 of 15 room lines), left, retried at the Square and were refused "had your turn" (12 of 96 turns). Now: header "You are alone in the Snug: nobody hears you here; leave to speak at the Square, or invite someone in."; Useful drops speak and puts leave first when alone; speak refuses alone before the api (turn kept); speak and pass refuse a spent turn with turnSpentOf ("You have had your turn: your round 2 turn was spent in the Snug (to Ines). The next round is yours again; ...": keeps the words "had your turn" so measures.mjs still counts it); a room line addressed to someone outside gets `warning` ("Corwin is not in the Snug; only Ines heard this.").
- **Asked twice, said twice (#123).** repeatOf: last 3 lines today, any place; word-pair (bigram) Dice >= 0.75, at least 6 words. A word-for-word repeat in the same place is left to the api (its REPEAT_MESSAGE; integration test counts it). Word SETS failed channelcheck: its fake lines differ only by round numbers. answeredOf: header "Asked of you: Thea, "..." You said day 1: "..." If that answers it, say so in one line." when a line naming me with "?" and an info word comes after my last word and I have an aloud claim.
- **Reasons that fit anyone (#126).** Prompt paragraph; `where` gains `visits` ("Day 2: the Snug, round 1: Odette and Bram; ...") and `together` ("Odette and Yusuf: once (day 2)"), replayed from public move events (replayPlaces in player.js; cleanEvent now keeps a phase's round).
- **Header cap.** A never-reading scripted evil seat on day 1 hit 990; the day-1 nudge now gives way to the Cover line (and to the Asked-of-you line). The evil-nudge test in playertoolcheck changed accordingly.

**Why:** Haiku seats act on where they think a line lands and on what they half remember; the fixes put the facts (who hears, where the turn went, what I already said, who was together) where the seat reads.
**How to apply:** after the next paid game, count lines said alone in a room (want 0), had-your-turn refusals (want < 6), near-repeat refusals (if many, the 0.75 threshold may be too eager), and whether the Asked-of-you line shortens a pile-on. Related: [[game4-fixes]], [[evil-cover]].
