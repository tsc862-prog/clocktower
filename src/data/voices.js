// The voice of each seat for the local speech engine (Kokoro-FastAPI). Pure data, browser-safe.
// Chosen to match the manners in docs/ROLES.md; keep the two in step.
export const VOICES = {
  Odette: {voice: 'bf_emma', speed: 0.95},
  Bram: {voice: 'am_michael', speed: 1.1},
  Ines: {voice: 'af_bella', speed: 1.05},
  Corwin: {voice: 'bm_george', speed: 0.9},
  Thea: {voice: 'af_heart', speed: 1.0},
  Fitch: {voice: 'bm_lewis', speed: 1.0},
  Yusuf: {voice: 'am_fenrir', speed: 1.0},
  Storyteller: {voice: 'bm_daniel', speed: 0.95},
};

export const DEFAULT_VOICE = {voice: 'af_heart', speed: 1.0};

export function voiceFor(name) {
  return VOICES[name] || DEFAULT_VOICE;
}
