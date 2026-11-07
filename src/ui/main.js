// The page's entry: connects to the relay (the launcher, npm run up, tells Vite its address as VITE_RELAY_URL; without it the
// default port 8787) and drives src/ui/app.js on timers: the game every second and a half, the runners every two seconds, the
// relay's health every five, the WebSocket /play as it pushes (reconnecting by itself). ?fixture shows the recorded game instead
// (src/ui/fixtures/game.json), with nothing sent to the relay.
import {createApp} from './app.js';
import {relayClient} from './relay.js';

const env = (import.meta.env || {});
const RELAY = env.VITE_RELAY_URL || 'http://127.0.0.1:8787';
const SEED = env.VITE_GAME_SEED != null && env.VITE_GAME_SEED !== '' ? Number(env.VITE_GAME_SEED) : null;
const params = new URLSearchParams(location.search);

async function boot() {
  const client = relayClient({base: RELAY});
  if (params.has('fixture')) {
    const [g, r] = await Promise.all([import('./fixtures/game.json'), import('./fixtures/runners.json')]);
    window.clocktower = createApp({client, fixture: g.default || g, runnersFixture: r.default || r});
    return;
  }
  const app = createApp({client, seed: SEED});
  window.clocktower = app;
  const every = (ms, f) => {f(); setInterval(f, ms)};
  every(1500, app.pollWatch); every(2000, app.pollRunners); every(5000, app.pollHealth);
  const connect = () => {
    let ws;
    try {ws = new WebSocket(client.socketUrl())} catch {setTimeout(connect, 3000); return}
    ws.onmessage = m => {try {app.onSocket(JSON.parse(m.data))} catch {}};
    ws.onclose = () => setTimeout(connect, 3000);
  };
  connect();
}
boot();
