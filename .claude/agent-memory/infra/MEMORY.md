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

## Pace knob (issue #26)
- Start body `minGap` (5-600 s) and `heartbeat` (10-1440 game min) -> req -> `--min-gap` / `--heartbeat` (runnerArgs), kept in active.json. View: `paceNow: {minGap, heartbeat}` (the old `pace` string stays: the page parses it in runnerGap).
- Live: POST /play/runner/limits {key, minGap?, heartbeat?} sets r.paceLive; relay-mcp withPace() adds `pace: {...}` to the pace answer (player and Storyteller routes) via play.onPace(fn); makePacer sends minGap and heartbeat each poll and adopts the answer's overrides.

## Narrator voice (issue #50, PR #53)
- startRelay -> makeVoice(env, log): RELAY_TTS unset probes TTS_URL (default 127.0.0.1:8880, Kokoro-FastAPI on the owner's PC) once at start: log "[relay] voice engine found (N voices)" (the launcher forwards relay lines) or "voice engine not found" + HINT and the voice goes off (status enabled:false, /tts/say 503). =0 forced off (status still answers), =1 forced on (engine used when it starts later). /tts/status adds seatVoices from src/data/voices.js (VOICES export), imported behind a try.
- /health providers now includes `tts`; relaycheck filters it, and quietEnv points TTS_URL at a closed port so checks never meet the real engine. `npm run ttscheck` (runtime job).

## Portrait pipeline (issue #27, PR #55)
- scripts/art/{lib,portraits,accept}.mjs; `npm run art:portraits [-- --only Odette,Bram --size 512|768 --force --seed N --dry-run]`, `npm run art:accept -- Odette|all|--reject N|--list`; `npm run artcheck` (mock router, CI runtime job).
- Reads PORTRAITS/PORTRAIT_STYLE from src/data/portraits.js (placeholder briefs, marked, if missing; accept refuses placeholder-made images). Default model black-forest-labs/FLUX.1-schnell (Apache-2.0) via router fal-ai/fal-ai/flux/schnell, body {prompt,image_size,seed,output_format:png}; env ART_MODEL, ART_PROVIDER (fal-ai|hf-inference), ART_PROVIDER_ID, ART_LICENCE, HF_ROUTER_URL, ART_ROOT. UNVERIFIED against the live router (no token here): first real run is the test. Eldmoor's route (fal-ai through the router with HF_TOKEN) was proven there.
- Output: assets/incoming/portraits/<Name>.png + .json (git-ignored); accept -> assets/portraits/<Name>.png, index.json {version:1, portraits:{Name:{file,model,provider,licence,promptHash,seed,size,sha256,date}}}, a line per name in docs/CREDITS.md.
- Heredocs with apostrophes in Git Bash tool commands broke twice: write files with the Write tool.
