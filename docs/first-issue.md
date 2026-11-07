# Epic: the first game (our first script, 7 seats, text only, watcher only)

Owner decisions (2026-11-07): the owner is a watcher only; this is a new repo, not a mode of Eldmoor; the repo is public, so the roles and their names are our own from day one (the mechanics follow the game, the official names, art and text never enter the repo).

## Done when

One complete 7-player game of our first script (the mechanics of the beginner script, our own roles) runs from first night to the final vote with seven agent players and an agent Storyteller, readable on one page, seeded and replayable, with zero leaks in the channel check, and a behavior report that gives the win, the cost per seat and the leak count.

## Slices, in order

1. **Scaffold** (infra): copy the borrowed layers from Eldmoor as README lists them, rename hero to player and dm to storyteller, make `npm run up` start the relay and the page, CI green on an empty game. No game logic.
2. **Engine as data** (rules): `src/data/script.js` for the first script (roles, teams, night order, ability text as the engine reads it; ids are our own names from `docs/ROLES.md`), `src/game/` for phases, the grimoire, death, drunk and poison, registering (the outsider and the minion that may register as the other team), the demon's standby, the servant who votes with a master, the win conditions. A seeded headless game with scripted seats (`npm run sim`) plays to an end. Tests for every rule the script has an edge case for.
3. **Seat tools and the channel check**: the player tool table and the Storyteller tool table; the state header per seat; the check that plants a secret in one seat and reads every other seat's tool results, prompts and events.
4. **Runners play it**: a mock-mind game end to end on the copied runners; then one paid game.
5. **The day conversation, v1**: rounds in seat order with pass, whispers between rounds, nominations after N rounds, the clock in the header. Measured, then changed.
6. **The page**: town square, talk, grimoire, Storyteller log, agent panels; cinema-style full-window view later.
7. **Measures and review**: the behavior report's Clocktower tables, the playtest-reviewer agent reading them, cost report.

## Agent roster (draft `.claude/agents/`)

| Agent | Owns | Model |
| --- | --- | --- |
| `rules-keeper` | The script as data, the engine, every edge case, the seeded sim | Opus |
| `storyteller-builder` | The Storyteller seat: tools, prompts, judgement calls, scripted fallbacks | Opus |
| `player-builder` | The player seats: tools, state header, talk model, memory, forced answers | Opus |
| `ui-designer` | The page | Opus |
| `infra` | Relay, runners, providers, CI, the launcher, behavior logs | Sonnet |
| `playtest-reviewer` | Reads game logs after play, files evidenced issues | Sonnet |
| `pm` | Issues, labels, priority, briefs | Haiku |
| `lore-keeper` | Names and flavour for anything of our own; the rights line | Sonnet |

## Rights

Public repo, our own roles. Only the mechanics follow the game; no name, art, text or logo of the official game is copied in. A git-ignored overlay file may map our names to the official ones for the owner's private play, and every check passes without it.
