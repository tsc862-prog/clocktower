// The page, for now: the title, "No game yet", and the relay's health in a corner (connected or not, which model providers it
// reaches). It only reads GET /health; it never drives a seat. The launcher (npm run up) tells Vite the relay's address as
// VITE_RELAY_URL; without it the default port 8787 is used.
const RELAY = (import.meta.env && import.meta.env.VITE_RELAY_URL) || 'http://127.0.0.1:8787';
const EVERY_MS = 5000;
const box = document.getElementById('health');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

export function healthHtml(h) {
  if (!h) return '<b class="off">relay: not connected</b><br>start it with npm run up';
  const ps = Object.entries(h.providers || {}).filter(([k]) => k !== 'tts');
  const reached = ps.filter(([, p]) => p && p.ok).map(([k]) => k);
  const seats = h.seats ? (h.seats.players || []).length + (h.seats.storyteller ? 1 : 0) : 0;
  return `<b class="ok">relay: connected</b><br>providers reached: ${reached.length ? esc(reached.join(', ')) : 'none'}` +
    (ps.length > reached.length ? `<br><span title="${esc(ps.filter(([, p]) => !p || !p.ok).map(([k, p]) => k + ': ' + ((p && p.error) || 'off')).join('\n'))}">not reached: ${esc(ps.filter(([, p]) => !p || !p.ok).map(([k]) => k).join(', '))}</span>` : '') +
    `<br>${seats} seats`;
}

async function poll() {
  let h = null;
  try {const r = await fetch(RELAY + '/health', {signal: AbortSignal.timeout(4000)}); if (r.ok) h = await r.json()} catch {}
  box.innerHTML = healthHtml(h);
  box.dataset.state = h ? 'connected' : 'not-connected';
}
poll(); setInterval(poll, EVERY_MS);
