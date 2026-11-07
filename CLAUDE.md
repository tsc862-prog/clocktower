# Clocktower

A social deduction game in the shape of Blood on the Clocktower, played entirely by AI agents. A
Storyteller agent runs the game; every seat at the table is an agent; the owner watches and never plays.

## Hard rules

- **Our own roles, in public.** The repo is public, so the roles, their names, their flavour and every
  line of text are our own. The *mechanics* follow the game (teams, night order, what each ability does,
  the win conditions); the official character names, script names, art, logos and rules text never enter
  the repo, not in code, docs, tests, issues, PR text or commit messages. `docs/ROLES.md` is the canon:
  each role has our name, its team and the mechanic it carries, written in our words. A git-ignored
  `overlay.local.json` at the repo root may map our names to the official ones for the owner's private
  play only; every check passes with the file absent, and `npm run rightscheck` uses it, when present,
  as a blocklist over the tracked files (a tracked file that carries an official name fails). The
  `lore-keeper` names things and holds this line.
- **Watcher only.** The owner never holds a seat, never nominates, never votes, never whispers. The page
  shows everything (the grimoire included); it changes nothing.
- **Every seat is an agent.** Players and the Storyteller alike. A seat whose runner is gone pauses the
  game and asks the owner; reflexes (a scripted vote, a scripted night choice) are a fallback only after
  the owner resumes. The seeded sim (`npm run sim`) has no runners and uses scripted seats throughout.
- **Private stays private.** A seat's tools, prompts and session carry only what that character would
  know: its own role, what the Storyteller told it, what was said in its hearing, its own notes. A seat
  answers only the runner that claimed it. Whispers reach their two parties and nobody else. The
  channel check (`npm run channelcheck`, slice 3) plants a secret in one seat and fails if any other
  seat's tool result, prompt or event carries it. The watcher's page still sees everything.
- **The Storyteller is bound by the rules, free in its judgement.** The engine enforces the script
  (night order, who acts, what a poisoned ability returns); the Storyteller agent makes the calls the
  rules leave to it (who is drunk, which true or false information to give, how hard a game to run), and
  every call is logged with its reason.
- **Seeded games replay identically** with the same agent answers, so a bug can be reproduced. Game
  logic takes its randomness from the seeded RNG only, never `Math.random` or the clock.
- **Cost is the limit, not turns.** Budgets per seat and per game; no turn caps on paid runners.
- **Keys only in `.env`.** Git-ignored, read only by the relay and the runners, never printed, never sent
  to the browser. Nothing under `src/` reads a key or calls a model.
- **No page work and no paid game** until the seeded headless game plays to an end and the channel
  check exists and is green (slices 2 and 3 of issue #1). The empty page `npm run up` serves is the
  one exception.

## Agent team

Dedicated subagents live in `.claude/agents/`. Delegate to them by area:

| Agent | Owns | Model |
| --- | --- | --- |
| `rules-keeper` | The script as data, the engine, every edge case, the seeded sim | Opus |
| `storyteller-builder` | The Storyteller seat: tools, prompts, judgement calls, scripted fallbacks | Opus |
| `player-builder` | The player seats: tools, state header, talk model, memory, forced answers | Opus |
| `ui-designer` | The page | Opus |
| `infra` | Relay, runners, providers, CI, the launcher, behavior logs | Sonnet |
| `playtest-reviewer` | Reads game logs after play, files evidenced issues (no code) | Sonnet |
| `pm` | Issues, labels, priority, briefs (no code, no merges) | Haiku |
| `lore-keeper` | Names and flavour for anything of our own; `docs/ROLES.md`; the rights line | Sonnet |

Models are set in each agent's frontmatter. Escalate one task by overriding `model` on the Agent call (the
first runtime port ran `infra` on Opus); run at most three Opus agents at once. For a feature that spans
areas, plan it, hand each part to its owner, then have `lore-keeper` check every new name.

## Working in parallel (agents and people)

- **One task, one branch, one area.** Branch from `main` as `<area>/<short-name>` (areas: `rules`,
  `storyteller`, `players`, `ui`, `infra`, `lore`, `docs`). Edit only files your area owns (see Layout).
  An edit in another area's file is listed under "Out-of-area edits" in the PR.
- **Parallel work uses worktrees.** `git worktree add E:/clocktower-<name> -b <area>/<name>` gives each
  agent its own checkout; never two agents in one working tree. `node_modules` in a worktree is a
  Windows junction to `E:/clocktower/node_modules` (`cmd /c mklink /J`): never `npm install` or `npm ci`
  in a worktree, never `rm -rf` a worktree or its `node_modules`, never run `git worktree remove`
  yourself (the manager removes the junction first with `cmd /c rmdir`, then the worktree). Never
  `git stash` (the stash is shared by every worktree). Agents use only absolute paths under their own
  worktree, set `TEMP` and `TMP` to `<worktree>/logs/tmp`, and before finishing confirm that
  `git -C E:/clocktower status` shows none of their files.
- **Small PRs, always green.** CI runs on every PR and on `main`; the one required check is **CI ok**.
  An open issue labelled `red-main` ("main is red") is a merge stop: nothing merges but the fix.
- **Merging.** While the repo is private on the free plan there is no branch protection: a PR labelled
  `automerge` is merged by `.github/workflows/automerge.yml` once CI ok passes on its head. Once the
  repo is public, main requires CI ok and up-to-date branches, and briefs end with
  `gh pr merge <n> --auto --merge` instead. The manager owns both.
- **Every PR carries its patch note.** `docs/patchnotes/<PR number>.md` (front matter `title`, `date`,
  `area`, `issues`, then 1-6 `- ` lines) written for the owner as a watcher: what he will see or can do
  now, in plain words, no file or function names, no hashes ("Nothing you will notice: ..." for CI and
  tests). `npm run rulescheck` fails a PR without it unless the PR has the label `no-notes`; the
  launcher and `npm run notes` show them.
- **Names go through lore.** Anything newly named (a role, a team, a script, a town) is added to
  `docs/ROLES.md` in the same PR and `lore-keeper` checks it before merge. Role ids in code are our
  names in kebab-case, never an official one.
- **Numbers and rules go through the rules-keeper.** A change to a role's mechanic, the night order or
  a win condition carries a test in `npm run sim` or a rules check, and the seeded sim summary in the PR.
- **Issues are the queue.** Work is tracked as GitHub issues labelled `area:<area>`; `agent-ready`
  means scoped enough to hand to the owning agent. Pick one, branch, PR, close it. Questions for the
  owner (money, deleting files outside the repo, taste) are issues too, labelled `question`.
- **Everything on E:.** This repo in `E:\clocktower`, worktrees beside it, briefs and standups in
  `E:\clocktower-ops`, temp under `logs/tmp`. Nothing of the project on C:.

## Commands

- `npm install` once, then `npm run up`: the one-window launcher (slice 1) starts the relay and the page
  and shows the patch notes since the owner last looked; `n` shows them again, `q` quits.
- `npm run relay`: the relay alone (`--play-only` without a key: the page and the seats work, model
  calls fail with a clear message). `GET /health` lists the providers it can reach.
- `npm run sim [-- --seed N]` (slice 2): a seeded headless game with scripted seats, start to finish,
  printing the grimoire per night, each day's nominations and votes, and the winner.
- `npm run channelcheck` (slice 3), `npm run rulescheck`, `npm run rightscheck`, `npm run notes`.
- Local models: install Ollama, `ollama pull qwen2.5:14b`; `OLLAMA_URL` and `OLLAMA_MODEL` in `.env`.
- `.env` keys, all optional: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `HF_TOKEN`,
  `OLLAMA_URL`. Copy `.env.example`.

## The game (milestone 1)

Seven seats, text only, one page, the first script (our own, with the mechanics of the beginner script:
thirteen town roles, four outsiders, four minions, one demon, as `docs/ROLES.md` names them). A complete
game, fun to read from the first night to the final vote. The slices of issue #1, in order: scaffold,
engine as data, seat tools and the channel check, runners play it, the day conversation, the page,
measures. Not in milestone 1: other scripts, travellers, voice, art, more than one table.

- **The engine (slice 2, `rules-keeper`).** `src/data/script.js` holds the script as data: roles with
  team, night order (first night and other nights), ability text as the engine reads it, setup changes
  (a role that adds or removes outsiders). `src/game/` holds phases (first night, day, nominations,
  execution, night), the grimoire, death, drunk and poison, registering (an outsider or minion that may
  register as the other team), the demon's standby, the servant who votes with a master, the win
  conditions. Every rule with an edge case has a test. Scripted seats pick with the seeded RNG so the
  sim ends.
- **Seats (slice 3).** `src/data/player-tools.js` and `src/data/storyteller-tools.js` are tool tables
  with `act` flags (an acting tool spends the turn; a reading tool does not). Each seat gets a state
  header per turn: what you know, who is alive, what was said since your last turn, the day's clock,
  the useful next tools. The Storyteller's tools read the grimoire, give night information, pick the
  drunk and the demon's bluffs, rule on edge cases and narrate; every judgement call carries a reason.
  Decisions wait for a live agent; everyone-at-once scenes (a vote) force an answer from each seat.
- **The day (slice 5).** Rounds of speaking in seat order with a chance to pass, whispers between
  rounds, nominations after a set number of rounds, a clock in the header. Measured, then changed.

## Borrowed runtime

Copied from Eldmoor (`tsc862-prog/eldmoor`) and renamed, hero to player and dm to storyteller, in slice 1:
`scripts/providers/` (Claude, Ollama, OpenAI, Hugging Face, Gemini, the limiter, the voice engine, off),
`scripts/relay.mjs` and `relay-mcp.mjs` (seats, claims, MCP and plain JSON tools on `/play/*`, the runner
header `X-Clocktower-Runner`), `runners.mjs` (start and stop from the page, budgets, budget stops, Claude
slots, events log), `pacing.mjs` (turns driven by the game: urgent, soft and heartbeat wakes),
`local-agent.mjs` and `agent-chat.mjs` (the tool loop for local and OpenAI minds, forced structured
answers), `warmup.mjs` and `session-roll.mjs` (the start gate, the Haiku cost cliff past 100k prompt
tokens), the behavior log, report, mind compare and cost report, `up.mjs`, `tmp.mjs`, `pr-comment.mjs`,
`patchnotes.mjs`, `flakehunt.mjs`, and the CI, red-main and nightly workflows. Rebuilt from their design,
not their code: the tool tables, decisions that wait for a live agent, everyone-at-once scenes, the
channel check, notes and memories per seat, the no-repeating rule for speech, the behavior report's
tables and the playtest-reviewer loop. Eldmoor is paused; nothing here touches `E:\eldmoor`.

## Behavior logs (for review)

Append-only JSONL under `logs/behavior/<game>/` (git-ignored), written by the runners and the relay,
never read by any seat: one line per agent turn (seat, model, wake reason, header before and after,
tools called, speech, seconds, tokens, cost, flags), one per Storyteller judgement call with its reason,
one per game event. `npm run behavior-report` turns them into the milestone's measures: who won and how,
cost per seat and model, leaks (must be 0), claims that contradict a seat's earlier words, whether the
demon was found by reasoning or luck. The `playtest-reviewer` reads them and files evidenced issues.

## CI observation

A CI failure on main opens one issue "main is red" (label `red-main`) through
`.github/workflows/red-main.yml`, closed when main is green again. An open red-main issue stops every
merge but the fix. A nightly run at real timing exercises the real pacing; flakes go to the pm as triage
input.

## Layout

- `src/data/`: the script and roles (`script.js`), tool tables (`player-tools.js`,
  `storyteller-tools.js`), prompts (`prompts.js`). Owned by `rules-keeper` (script), `player-builder`
  and `storyteller-builder` (tools and prompts).
- `src/game/`: the engine: phases, grimoire, night, day, votes, win. `rules-keeper`.
- `src/seats/`: what a seat sees and can do: the state header, notes, memory, forced answers.
  `player-builder` and `storyteller-builder`.
- `src/ui/`: the page. `ui-designer`.
- `scripts/`: relay, runners, providers, launcher, checks (`*check.mjs`), reports. `infra`.
- `docs/`: `ROLES.md` (lore), `patchnotes/`, `handoff.md`, `first-issue.md`.
- `.github/workflows/`: CI, red-main, automerge, nightly. `infra`.
- `logs/`: git-ignored: behavior logs, runner logs, `tmp/`.

## Known state

Slice 1 (scaffold) is in progress; see issue #1 and `E:\clocktower-ops\standup-<date>.md` for what landed
and what is next.
