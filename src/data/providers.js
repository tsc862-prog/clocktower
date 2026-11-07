// The one list of model providers: a mind any seat can be played by, a player or the Storyteller. The relay, the runner
// supervisor, the runners and (later) the page read this list, so they cannot disagree on who may sit where. Add a provider here
// once its adapter and runner path exist. Pure data, no imports: both the browser and the Node scripts read it.
export const PROVIDERS = ['anthropic', 'ollama', 'openai', 'huggingface', 'google'];
export const PROVIDER_LABEL = {anthropic: 'Claude', ollama: 'Local (Ollama)', openai: 'OpenAI', huggingface: 'Hugging Face', google: 'Gemini'};
