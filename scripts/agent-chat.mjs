// Start-up checks for a runner on a Chat Completions provider: scripts/seat-runner.mjs calls openaiRunner once and gets the adapter (its chat is
// the tool-calling loop's model call, scripts/local-agent.mjs) or a message to show the owner.
// The key comes from the runner's environment/.env, as ANTHROPIC_API_KEY does for the Claude runner, and
// is passed to the adapter only: never printed, never in an argument.
import {openaiAdapter, hfAdapter, hfModelList, OPENAI_URL, HF_URL} from './providers/openai.mjs';
import {googleFromEnv, FREE_MODELS} from './providers/google.mjs';

// Providers whose runner is this loop over Chat Completions (OpenAI, the Hugging Face router, Gemini), and their names.
export const COMPAT_PROVIDERS = ['openai', 'huggingface', 'google'];
export const isCompat = p => COMPAT_PROVIDERS.includes(p);
export const compatLabel = p => ({openai: 'OpenAI', huggingface: 'Hugging Face', google: 'Gemini'})[p] || p;

// rs: the player's runner settings ({provider:'openai', model}); explicit: true when --model was given.
// Returns {adapter, model, note?} or {error}. Mutates rs.model (a saved Claude model is dropped).
export async function openaiRunner(rs, env, {explicit = false, fetchImpl = globalThis.fetch} = {}) {
  if (rs.provider === 'huggingface') return hfRunner(rs, env, {explicit, fetchImpl});
  if (rs.provider === 'google') return googleRunner(rs, env, {explicit, fetchImpl});
  if (!env.OPENAI_API_KEY) return {error: 'No OPENAI_API_KEY in the environment or .env. Create a key at platform.openai.com/api-keys; API billing is separate from ChatGPT Plus.'};
  if (!explicit && rs.model && /^claude-/.test(rs.model)) rs.model = null; // a Claude model left over from the default provider
  rs.model = rs.model || env.OPENAI_MODEL || null; rs.effort = null;
  const adapter = openaiAdapter({apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL || OPENAI_URL, defaultModel: rs.model, fetchImpl});
  const s = await adapter.status();
  if (!s.ok && /bad or missing key/.test(s.error || '')) return {error: 'OpenAI refused the key (bad or missing key). Check OPENAI_API_KEY in .env.'};
  const list = s.ok ? s.models : [];
  if (!rs.model) return {error: 'No OpenAI model chosen. Pass --model <id> (or set OPENAI_MODEL in .env).' + (list.length ? ' Available to this key: ' + list.slice(0, 12).join(', ') + (list.length > 12 ? ', ...' : '') : '')};
  if (s.ok && list.length && !list.includes(rs.model)) return {error: `Model ${rs.model} is not in this key's model list. Available: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', ...' : ''}.`};
  return {adapter, model: rs.model, note: s.ok ? null : 'could not list models (' + s.error + '); trying anyway'};
}

// The Hugging Face router: the same adapter and loop, HF_TOKEN from the environment/.env, the
// allowance only (recharge is off; the reply's estimated_cost is the turn's cost, unknown when absent). No status
// call here (it would spend one tiny call per curated model on every runner start); the warm-up call proves the
// token and the model, and a model_not_supported answer names the picker list. Same return as openaiRunner.
async function hfRunner(rs, env, {explicit, fetchImpl}) {
  if (!env.HF_TOKEN) return {error: 'No HF_TOKEN in the environment or .env. Create a token at huggingface.co/settings/tokens (inference permission); it shares the free allowance with the art pipeline.'};
  if (!explicit && rs.model && /^claude-/.test(rs.model)) rs.model = null;
  const list = hfModelList(env);
  rs.model = rs.model || env.HF_MODEL || null; rs.effort = null;
  if (!rs.model) return {error: 'No Hugging Face model chosen. Pass --model <id> (or set HF_MODEL in .env). Picker list: ' + list.join(', ')};
  const adapter = hfAdapter({apiKey: env.HF_TOKEN, baseUrl: env.HF_BASE_URL || HF_URL, defaultModel: rs.model, models: list, fetchImpl});
  return {adapter, model: rs.model, note: list.includes(rs.model) ? null : rs.model + ' is not in the picker list (HF_MODELS); trying anyway'};
}

// Gemini: the same adapter and loop through Google's OpenAI-compatible endpoint, GOOGLE_API_KEY from the
// environment/.env. The free tier is the budget (cost 0 per call, GOOGLE_TIER=paid prices it); the model list is one
// GET /models (free, no tokens). Same return as openaiRunner.
async function googleRunner(rs, env, {explicit, fetchImpl}) {
  if (!env.GOOGLE_API_KEY) return {error: 'No GOOGLE_API_KEY in the environment or .env. Create a key at https://aistudio.google.com/apikey (the free tier needs no billing).'};
  if (!explicit && rs.model && !/^gemini-/.test(rs.model)) rs.model = null; // a Claude or other provider's model left over
  rs.model = rs.model || env.GOOGLE_MODEL || null; rs.effort = null;
  const adapter = googleFromEnv(env, {defaultModel: rs.model, fetchImpl});
  const s = await adapter.status();
  if (!s.ok && /bad or missing GOOGLE_API_KEY/.test(s.error || '')) return {error: 'Google refused the key (bad or missing GOOGLE_API_KEY). Check GOOGLE_API_KEY in .env.'};
  const list = s.ok ? s.models : [], hint = list.length ? list : FREE_MODELS;
  if (!rs.model) return {error: 'No Gemini model chosen. Pass --model <id> (or set GOOGLE_MODEL in .env). ' + (list.length ? 'Available to this key: ' : 'Models with a free tier: ') + hint.slice(0, 12).join(', ') + (hint.length > 12 ? ', ...' : '')};
  if (s.ok && list.length && !list.includes(rs.model)) return {error: `Model ${rs.model} is not in this key's model list. Available: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', ...' : ''}.`};
  return {adapter, model: rs.model, note: (s.ok ? '' : 'could not list models (' + s.error + '); trying anyway. ') + 'Gemini ' + adapter.tier + ' tier' + (adapter.tier === 'free' ? ' (cost $0; the daily quota is the budget)' : '')};
}
