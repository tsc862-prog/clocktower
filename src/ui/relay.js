// The page's only way to the relay. Every route the page may touch is listed here; the page reads the game and starts or stops
// runners, and nothing else. It never posts to a seat's routes (/play/call, /play/storyteller, /play/narrate, /mcp): nothing on the
// page speaks, whispers, nominates or votes for a seat (npm run uismoke checks it). The voice engine's routes (VOICE) read aloud
// the lines the page already shows.
export const READS = {health: '/health', runners: '/play/runner', watch: '/play/watch'};
export const ACTIONS = {
  start: '/play/runner/start',       // {kind, player?, provider?, model?, budget?, by: 'owner'}
  stop: '/play/runner/stop',         // {kind, player?}
  stopAll: '/play/runner/stop-all',  // {why}
  resume: '/play/runner/resume',     // {scripted: true}: the scripted Storyteller answers for a gone Storyteller runner
  newGame: '/play/game/new',         // {seed, rounds}: asked of the backend; the button stays off until the relay serves it
};
export const SOCKET = '/play';
// The local voice engine (scripts/providers/tts.mjs): its state and seat voice map, a clip made from a line the page already shows,
// and the clip itself. It speaks for nobody at the table: it reads aloud what was said.
export const VOICE = {status: '/tts/status', say: '/tts/say', clip: '/tts'};

export function relayClient({base, fetchImpl = (...a) => fetch(...a), timeoutMs = 4000} = {}) {
  const url = p => base + p;
  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  async function get(path) {
    try {
      const r = await fetchImpl(url(path), {signal: signal()});
      if (r.status === 404) return {missing: true};
      return r.ok ? await r.json() : {error: `HTTP ${r.status}`};
    } catch (e) {return {down: true, error: String(e && e.message || e)}}
  }
  async function post(name, body) {
    const path = ACTIONS[name];
    if (!path) throw new Error(`the page has no action ${name}`);
    try {
      const r = await fetchImpl(url(path), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body || {}), signal: signal()});
      let j = null; try {j = await r.json()} catch {}
      return r.ok ? (j || {ok: true}) : {ok: false, status: r.status, error: (j && j.error) || `HTTP ${r.status}`};
    } catch (e) {return {ok: false, error: String(e && e.message || e)}}
  }
  return {
    health: () => get(READS.health),
    runners: () => get(READS.runners),
    watch: since => get(READS.watch + (since != null && since >= 0 ? `?since=${since}` : '')),
    start: body => post('start', {...body, by: 'owner'}),
    stop: body => post('stop', body),
    stopAll: why => post('stopAll', {why: why || 'the owner stopped every runner'}),
    resume: () => post('resume', {scripted: true}),
    newGame: body => post('newGame', body),
    socketUrl: () => base.replace(/^http/, 'ws') + SOCKET,
    ttsStatus: () => get(VOICE.status),
    ttsSay: async body => { // {text, voice?, speed?} -> {id, ms, cached} | {ok: false, error}; a clip can take a while to make
      try {
        const r = await fetchImpl(url(VOICE.say), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body || {}),
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined});
        let j = null; try {j = await r.json()} catch {}
        return r.ok && j ? j : {ok: false, status: r.status, error: (j && j.error) || `HTTP ${r.status}`};
      } catch (e) {return {ok: false, error: String(e && e.message || e)}}
    },
    ttsClipUrl: id => url(VOICE.clip + '?id=' + encodeURIComponent(id)),
  };
}
