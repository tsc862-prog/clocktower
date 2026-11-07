// A Claude player seat: one process plays one player seat with the Claude Agent SDK (scripts/claude-runner.mjs has the whole
// runner). The runner supervisor (scripts/runners.mjs) starts it for a Claude seat; it also runs from a terminal:
//   node scripts/agent-seat.mjs --player 3 [--model claude-haiku-5-5] [--effort medium] [--budget 0.50] [--max-turns N]
//        [--tool-turns 12] [--url http://127.0.0.1:8787] [--new] [--min-gap S] [--heartbeat MIN] [--max-fails N]
// --model: AGENT_MODEL, else the cheapest Claude in src/data/prompts.js (Haiku). --budget: dollars for this run, RUNNER_BUDGET,
// else a player's share of the game budget (GAME_BUDGET, scripts/runners.mjs). No turn cap unless --max-turns is given.
// Other minds (Ollama, OpenAI, Hugging Face, Gemini) play through scripts/seat-runner.mjs.
import {main} from './claude-runner.mjs';
main('player');
