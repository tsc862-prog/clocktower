---
name: night-thoughts
description: The think tool and the thoughts scene (#111): header line, useful tools, forced ask, what the checks expect, the api text that says "watcher"
metadata:
  type: project
---

The engine (#119) asks every living seat at once before dawn: pending {kind: 'thoughts', question, mine, tonight}. The player side (players/think, #111 part 3):

- askedOf returns {kind: 'thoughts', tool: 'think', tonight, text: question + " Tonight: " + tonight} while mine is null, null after. Header: `**WAITING ON YOU: The night is ending. In a sentence or two, what are you thinking? Tonight: You woke as the Poisoner. You chose Odette.**`; Useful: think, my_role, my_notes, read_talk.
- think(text): stripOwnName, api.think, then api.note `Night N, my thought: <kept text>` (empty text = no note, still ok). Refused by day / before the scene / twice.
- forcedAsk(game, seat, api) in player.js: {tool, ask, schema} for vote ({yes}) and thoughts ({text}); THOUGHT_ASK = "Your thought as the night ends, one sentence." No runner calls it yet: Clocktower has no forced structured scene answer for votes either (the Eldmoor scene path in local-agent is dead code); wiring it is infra's.
- Prompt never says anyone overhears (lore-keeper: a seat that knows it is heard performs). The api's legalNow text for thoughts says "only the watcher hears it" and reaches seats through ApiError refusals: rules-keeper's to reword.
- Poisoner's header at the scene: 403 chars real (seed 31 night 3), 665 on the fake with five claims; the poison line drops at the scene (it shows only with a night_choice).

**Why:** the owner wants to hear each seat's thought at night (game 5); the thought is the watcher's alone.
**How to apply:** a new private-by-design store (like notes) needs channelcheck's thinker exemption kept narrow: only its own my_notes.
