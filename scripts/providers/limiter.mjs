// Per-provider concurrency limiter for the relay. Some API organisations cap concurrent requests
// across all models (the owner's Anthropic org answers 429 "Number of concurrent requests... exceeded"
// when the table's five persona/backstory writes and a burst of townPlan/say calls go at once).
//
//   const lim = makeLimiter({max: 2});
//   await lim.run(=> adapter.call(...), {urgent: true, signal}) // a decision kind
//   await lim.run(=> adapter.call(...), {urgent: false, signal}) // a writing kind
//
// - At most `max` calls in flight; the rest wait in a FIFO queue in which urgent (decision) calls go
//   ahead of every non-urgent (writing) call.
// - A queued call whose signal aborts (its deadline passed: the relay's per-kind timer), or that would
//   start with less than minLeft ms before its deadline, leaves the queue and rejects with an
//   AbortError, so a stale decision is dropped, never sent late. The sim
//   already plays scripted when the relay answers with an error.
// - rateLimited(ms) counts a 429 and holds the queue so nothing new starts until it ends; calls in flight finish.
// - stats: {max, inflight, queued, queuedUrgent, rateLimited, dropped, paused (ms left), served}.
// rpm (optional): at most rpm starts a minute, spaced evenly (a free tier's per-minute quota); 0 = no spacing.
export function makeLimiter({max = 2, rpm = 0, now = () => Date.now()} = {}) {
  max = Math.max(1, Math.floor(Number(max) || 1));
  const gap = Number(rpm) > 0 ? 60000 / Number(rpm) : 0; let nextAt = 0;
  const q = []; // {fn, urgent, res, rej, signal, onAbort}
  let inflight = 0, pausedUntil = 0, timer = null;
  const st = {rateLimited: 0, dropped: 0, served: 0};
  const abortErr = () => Object.assign(new Error('dropped from the queue: deadline passed'), {name: 'AbortError', queued: true});

  function pump() {
    if (timer) return;
    const wait = pausedUntil - now();
    if (wait > 0) {timer = setTimeout(() => {timer = null; pump()}, wait); if (timer.unref) timer.unref(); return}
    while (inflight < max && q.length) {
      if (gap && now() < nextAt) {timer = setTimeout(() => {timer = null; pump()}, nextAt - now()); if (timer.unref) timer.unref(); return}
      const j = q.shift(); if (j.signal) j.signal.removeEventListener('abort', j.onAbort);
      if (j.deadline != null && j.deadline - now() < j.minLeft) {st.dropped++; j.rej(abortErr()); continue} // too late to be worth sending
      inflight++; st.served++; if (gap) nextAt = now() + gap;
      Promise.resolve().then(j.fn).then(j.res, j.rej).finally(() => {inflight--; pump()});
    }
  }
  // deadline (ms timestamp) and minLeft: a call that would start with less than minLeft ms left is dropped.
  function run(fn, {urgent = false, signal = null, deadline = null, minLeft = 0} = {}) {
    if (signal && signal.aborted) {st.dropped++; return Promise.reject(abortErr())}
    return new Promise((res, rej) => {
      const j = {fn, urgent, res, rej, signal, deadline, minLeft, onAbort: null};
      if (signal) {j.onAbort = () => {const i = q.indexOf(j); if (i >= 0) {q.splice(i, 1); st.dropped++; rej(abortErr())}}; signal.addEventListener('abort', j.onAbort, {once: true})}
      if (urgent) {const i = q.findIndex(x => !x.urgent); if (i < 0) q.push(j); else q.splice(i, 0, j)} else q.push(j);
      pump();
    });
  }
  // Hold new starts for ms (a 429 asked us to slow down); counts the 429.
  function rateLimited(ms) {st.rateLimited++; const until = now() + Math.max(0, ms); if (until > pausedUntil) pausedUntil = until; if (timer) {clearTimeout(timer); timer = null} pump()}
  const stats = () => ({max, ...(gap ? {rpm: Number(rpm)} : {}), inflight, queued: q.length, queuedUrgent: q.filter(j => j.urgent).length, ...st, paused: Math.max(0, pausedUntil - now())});
  return {run, rateLimited, stats, get max() {return max}};
}

// Is this error a 429 from the provider? Returns {retryAfterMs} or null. Reads the Anthropic SDK's
// APIError (status, headers as a Headers object or a plain object) and plain fakes alike.
export function rateLimitOf(e) {
  if (!e || e.kind === 'quota') return null; // a used-up quota or allowance is never retried
  if ((e.status !== 429 && !/rate_limit_error|\b429\b/.test(String(e.message || '')))) return null;
  const h = e.headers, raw = h ? (typeof h.get === 'function' ? h.get('retry-after') : h['retry-after']) : null;
  const sec = Number(raw);
  return {retryAfterMs: Number.isFinite(sec) && sec >= 0 ? Math.min(60000, sec * 1000) : null};
}
