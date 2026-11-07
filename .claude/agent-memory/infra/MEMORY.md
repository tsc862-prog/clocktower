# infra agent memory

## Relay protocol (port 8787, 127.0.0.1 only)
- Seats: player ids 1-7 (seat index + 1), the Storyteller seat apart. A runner claims with POST /play/claim {player|role:'storyteller', runner, provider, model}, refreshes every 10 s (CLAIM_MS 45 s), releases on exit.
- Plain JSON: /play/call (player tools), /play/storyteller (Storyteller tools), /play/pace (player pace and header; {role:'storyteller'} is the Storyteller's own pace and header, added in slice 3), /play/ready, /play/behavior/turn, /play/narrate (watcher only).
- MCP: POST /mcp with X-Clocktower-Player / X-Clocktower-Role: storyteller and X-Clocktower-Runner (or ?player=&role=&runner=).
- Walls (npm run channelcheck proves them): a claimed seat answers only its runner (409); a runner holding a player gets 403 on every Storyteller route and vice versa.
- pace realMs: 0 is read as "default 10 s" (Number(0) || 10000); pass 1 for an immediate answer.

## Runners
- Player kind: Claude seats run scripts/agent-seat.mjs, other minds scripts/seat-runner.mjs (runners.mjs scriptOf). Storyteller kind: scripts/storyteller-runner.mjs (--scripted: the fallback, no budget). Both Claude runners live in scripts/claude-runner.mjs.
- Flags: --player N, --model (AGENT_MODEL / STORYTELLER_MODEL, default Haiku claude-haiku-5-5 from src/data/prompts.js), --effort (default medium), --budget (RUNNER_BUDGET, else the game share), --max-turns (optional, no default), --tool-turns (model calls inside one turn, default 12), --url, --new, --min-gap, --heartbeat, --max-fails.
- Game budget: GAME_BUDGET 5.00, STORYTELLER_SHARE 0.30 -> Storyteller $1.50, each player $0.50; pools clip and stop runners ("game budget reached").
- A gone Storyteller runner pauses the game (GET /play/runner paused); POST /play/runner/resume starts the scripted Storyteller.
- Checks: CLOCKTOWER_FAKE_SDK=scripts/fake-agent-sdk.mjs stands in for the Agent SDK; mock Ollama model mock-play:1b plays the game with the same mock mind (scripts/mock-mind.mjs).
- Pacing in checks: AGENT_MIN_GAP 0 plus a short AGENT_POLL_MS makes every runner play a heartbeat turn per poll (hundreds of turns, Ollama's 60 calls/min cap trips); keep the poll at its default and a gap of ~2 s.

## Costs per turn (measured)
- Not yet measured on the real API (no paid game run so far). Fake SDK prices: Haiku ~$0.0003 per 3-call turn, Opus ~$0.01.
- Behavior lines: the writer drops any key named header/headers/key/env (scrub), so a turn's header goes in rec.brief.text.
- Mock game check (npm run mockgamecheck): seed 5 ends "good" on day 1 in about 60 turns with the mock mind; the dear seat (Opus, $0.01) stops after one fake turn ($0.0134).
