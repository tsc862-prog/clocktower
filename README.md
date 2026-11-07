# Clocktower

Blood on the Clocktower, played entirely by AI agents. A Storyteller agent runs the game; every seat at the table is an agent; a human watches and never plays.

Working title. The repo is private: the game, its characters and its scripts belong to The Pandemonium Institute, and nothing with the official characters is published. A public release would need its own roles with the same mechanics.

## Hard rules

- **Watcher only.** The owner never holds a seat, never nominates, never votes, never whispers. The page shows everything (the grimoire included); it changes nothing.
- **Every seat is an agent.** Players and the Storyteller alike. A seat whose runner is gone pauses the game and asks the owner; reflexes (a scripted vote, a scripted night choice) are a fallback only after the owner resumes.
- **Private stays private.** A seat's tools, prompts and session carry only what that character would know: its own role, what the Storyteller told it, what was said in its hearing, its own notes. A check plants a secret in one seat and fails if any other seat's tool result, prompt or event carries it. Whispers reach their two parties and nobody else.
- **The Storyteller is bound by the rules, free in its judgement.** The engine enforces the script (night order, who acts, what a poisoned ability returns); the Storyteller agent makes the calls the rules leave to it (the Drunk, which information to give the Washerwoman, how hard a game to run) and every call is logged with its reason.
- **Seeded games replay identically** with the same agent answers, so a bug can be reproduced.
- **Cost is the limit, not turns.** Budgets per seat and per game; no turn caps.

## The first game (milestone 1)

Trouble Brewing, 7 seats, text only, one page. A complete game that is fun to read from the first night to the final vote.

What it needs:

1. **The engine**: the Trouble Brewing script as data (roles, teams, night order, abilities), phases (first night, day, nominations, execution, night), the grimoire, death, the win conditions, drunk and poison, the Scarlet Woman, the Butler, the Recluse and Spy registering.
2. **The Storyteller seat**: tools to read the grimoire, give night information, pick the Drunk and the demon bluffs, rule on edge cases, narrate the day, and a scripted fallback for every wait.
3. **The player seats**: tools to speak in the square, whisper to one player, take notes, nominate, vote, use a night ability when asked; a state header per turn (what you know, who is alive, what was said since your last turn, the day's clock).
4. **The day conversation**: the one thing this game has that the earlier project did not. Open talk among seven voices, side whispers, and a day that ends. First version: rounds of speaking in seat order with a chance to pass, whispers between rounds, nominations after a set number of rounds. Measure how it reads; change it after.
5. **The page**: a town square (seats in a circle, alive and dead, votes shown as they are cast), the day's talk, the grimoire panel for the watcher, the Storyteller's log, and the agent panel per seat (runner, cost, last turn).
6. **Measures**: good-team win rate over 10 games, cost per game by seat and model, leaks (must be 0), how often a seat's claim contradicts its own earlier words, how often the Demon is found by reasoning rather than luck.

Not in milestone 1: other scripts, travellers, fabled, voice, art, more than one table.

## What is borrowed

From the Eldmoor repo (`tsc862-prog/eldmoor`), by copying into this one and renaming (hero to player, dm to storyteller, `/play/*` routes):

- `scripts/providers/` (Claude, Ollama, OpenAI, Hugging Face, Gemini, the limiter, the voice engine)
- `scripts/relay-mcp.mjs` (seats, claims, a seat answers only its own runner, MCP and plain JSON tools)
- `scripts/runners.mjs` (start and stop from the page, budgets, budget stops, Claude slots, events log)
- `scripts/pacing.mjs` (turns driven by the game: urgent, soft and heartbeat wakes)
- `scripts/local-agent.mjs`, `scripts/agent-chat.mjs` (the tool loop for local and OpenAI minds, forced structured answers)
- `scripts/warmup.mjs`, `scripts/session-roll.mjs` (the start gate, the Haiku cost cliff)
- `scripts/behavior-log.mjs`, `behavior-turn.mjs`, `behavior-report.mjs`, `mind-compare.mjs`, `cost-report.mjs`
- `scripts/up.mjs`, `tmp.mjs`, `pr-comment.mjs`, `patchnotes.mjs`, `flakehunt.mjs`
- `.github/workflows/` (CI, red main, nightly run, flakes), the `CLAUDE.md` shape, `.claude/agents/` rewritten

Rebuilt from their design, not their code: tool tables with `act` flags, decisions that wait for a live agent, everyone-at-once scenes with forced answers, the channel check, notes and memories per seat, the no-repeating rule for speech, the behavior report and the playtest-reviewer loop.

## Open decisions for the owner

- Models and budget for the first games (my proposal: Storyteller and the evil team on Claude Sonnet, townsfolk on Claude Haiku or a local 14B; $3 to $5 a game to start).
- Day length and the talk model, after the first readable game.
- Whether the page speaks (the voice engine is borrowed and off).
