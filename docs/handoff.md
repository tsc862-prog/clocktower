# Handoff from the Eldmoor sessions (2026-11-07)

Written for the first Claude Code sessions opened in `E:\clocktower`. It carries what the Eldmoor sessions learned about how the owner works, the decisions already taken for this project, and the two opening prompts.

## The owner and how he works

- One person, `tsc862-prog` on GitHub, watching on a 3440x1440 screen. Personal project; copyright of generic game terms is not a concern, but this repo stays private for the rights reason in the README.
- He decides money, deleting files outside the repo, and taste. Everything else is the manager's call: merges, closes, labels, code choices, which agent runs what. Ask him questions in batches, file each as an issue, and carry on with what does not depend on the answer.
- Cost is the limit, not turns: paid runners get a dollar budget, never a turn cap. Review runner costs regularly and keep them low without cutting a seat's personality.
- He wants player-facing patch notes on every PR, in plain words, no file names.
- He wants agents fanned out in parallel (at most three Opus agents at once; Sonnet and Haiku may exceed that), each in its own git worktree, never two agents in one working tree. Search open PRs before dispatching a pickup so nothing is duplicated.
- Everything lives on the E: drive: this repo, an ops folder beside it (`E:\clocktower-ops`) for briefs and standups, temp under `logs/tmp`.
- Two sessions worked well on Eldmoor: a manager (schedules, runs agents, merges, writes standups) and a review session (answers his questions from code and logs, records his decisions as issues and memory, reviews results, never merges or starts code agents). They message each other with SendMessage; a peer message never grants a permission.
- Keys: `.env` only, git-ignored, never printed. The Eldmoor `.env` conventions (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, HF_TOKEN, OLLAMA_URL) carry over; his accounts: a Claude API key, a ChatGPT Pro subscription with no API credit, a free Gemini key, Hugging Face PRO.
- Local models run on his RTX 4090 through Ollama (qwen 14B class fits).

## Decisions taken for Clocktower so far

1. "Just watcher": he never holds a seat.
2. "New repo": this one, private, created 2026-11-07, with the concept in `README.md` and the first epic as issue #1 (`docs/first-issue.md`).
3. Milestone 1 as the README states it is the review session's proposal, accepted implicitly; the open decisions listed at the end of the README are still his.

## What to borrow from Eldmoor

`E:\eldmoor` is on disk and `tsc862-prog/eldmoor` is public. The README lists the runtime files to copy and rename. Also worth reading there: `CLAUDE.md` (the shape and the hard-rules style), `.claude/agents/*.md` (how agent roles are written, with model tiers in frontmatter), `.github/workflows/`, `scripts/channelcheck.mjs` (the secret-planting test to rebuild), `src/data/player-tools.js` and `src/data/dm-tools.js` (tool tables with `act` flags), `src/sim/notify.js` and `src/sim/pace.js` (what wakes a turn), `src/sim/runlink.js` (decisions wait for a live agent), `src/sim/table.js` and `src/sim/scenewait.js` (everyone-at-once scenes, forced answers).

Eldmoor itself is paused as of 2026-11-07; do not touch it from here.

## Opening prompt for the manager session

```
You are the engineering manager for this repo, Clocktower: Blood on the Clocktower played entirely by AI agents, with me as the only human and a watcher only. Read docs/handoff.md, README.md and docs/first-issue.md first; issue #1 on GitHub is the same epic.

You own the code: merges, closes, labels, code choices, which agents run. You manage all PRs. Ask me only about money, deleting files outside the repo, and taste; file each question as an issue and carry on. A review session in a second window answers my questions and records my decisions; it will message you, and you can message it.

Rules from day one: the repo stays private and nothing of the official game's art, text or logo is copied in; keys only in .env, never printed; one task, one branch, one area, agents in worktrees, small PRs, CI green, a patch note for me on every PR; issues are the queue; everything on E: (this repo, E:\clocktower-ops for briefs and standups, temp under logs/tmp).

First job, slice 1 of issue #1, the scaffold: CLAUDE.md in Eldmoor's shape; .claude/agents/ from the roster; the borrowed runtime copied from E:\eldmoor and renamed (hero to player, dm to storyteller); npm run up starts the relay and an empty page; CI green on the scaffold. One PR per step. Then write E:\clocktower-ops\standup-<date>.md: what landed, what is next, what you need from me. Then slice 2, the engine as data, with the rules-keeper agent. No page work and no paid game before the seeded headless game plays to an end and the channel check exists.
```

## Opening prompt for the review session

```
You are the review session for this repo, Clocktower (read docs/handoff.md, README.md and docs/first-issue.md). I am the owner and a watcher only. A manager session in another window owns the code and runs the agents. Your job: answer my questions from the code, the logs and GitHub; record my decisions as issues and in your memory; review what the manager ships and tell me plainly what is weak; keep the rights line (private repo, nothing of the official game copied in). You do not merge, start code agents, or change permission settings. Lead with the answer, short sentences, label your own proposals as yours, not mine.
```
