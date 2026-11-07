// KEPT FOR NOW (borrowed, not wired into the relay yet): semantic search over a seat's notes. It comes back when the
// player-builder builds notes per seat (slice 3); until then the description below is the borrowed design.
// Semantic memory search, the relay's half. The game ranks notes by keywords and stays pure and
// deterministic (src/sim/notebook.js, tiers.js); this module ranks them by meaning with a small local embedding
// model (Ollama /api/embed, OLLAMA_EMBED_MODEL, default nomic-embed-text) and hands the game a map of
// {key: strength 0..1} that the tool folds into its own score (src/sim/semkey.js). The sim never calls a network.
//
//   rank({seat, pool, query}) -> {sem, hits, covered, total, cold, ms} | null (null: nothing to add; the tool answers as before)
//   seat: {kind:'player', id, name} | {kind:'storyteller'}; pool: [{k, text}] from the game (the tool's own `_pool` ask)
//
// Vectors live here, never in the save: logs/agents/<game>/<playerId>-<name>/vectors.json (the Storyteller's under storyteller/), keyed
// by the hash of the embedded text, rebuilt on demand when missing, stale (another model) or a note changed. The cache
// dies with the player like the mirror folder (purgeGame removes the folder; drop removes a fallen player's file).
// Budget: a search waits at most `budgetMs` (300) for vectors; a cold cache fills in the background and the search uses
// what is ready (the rest ranks by keywords); a failing Ollama pauses embedding for 30 s. A player's cache answers only
// that player's queries (seats stay apart).
import {mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
const SEM = {MAX: 2, POOL: 600, TEXT: 1200}; // the game's half kept these numbers (a meaning match adds at most MAX; at most POOL texts of TEXT characters)
import {MIRROR_ROOT, slug} from './memory-mirror.mjs';

export const EMBED_MODEL_DEFAULT = 'nomic-embed-text';
const envNum = (env, k, d, lo, hi) => {const raw = env && env[k]; if (raw == null || String(raw).trim() === '') return d; const v = Number(raw); return Number.isFinite(v) && v >= lo && v <= hi ? v : d};
export function embedConfig(env = process.env) {
  const off = /^(0|false|no|off)$/i.test(String(env.RELAY_EMBED || ''));
  const model = String(env.OLLAMA_EMBED_MODEL || '').trim() || EMBED_MODEL_DEFAULT;
  const lo = envNum(env, 'EMBED_MIN', 0.55, 0, 0.99), hi = envNum(env, 'EMBED_FULL', 0.8, 0.01, 1);
  return {enabled: !off, model, min: lo, full: Math.max(hi, lo + 0.05), budgetMs: envNum(env, 'EMBED_BUDGET_MS', 300, 20, 5000)};
}
// nomic-embed-text wants a task prefix on both sides; other models are used as they are.
const prefixes = model => /nomic/i.test(model) ? {q: 'search_query: ', d: 'search_document: '} : {q: '', d: ''};
const b64 = v => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const unb64 = s => {const b = Buffer.from(String(s), 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))};
const unit = arr => {let n = 0; for (const x of arr) n += x * x; n = Math.sqrt(n) || 1; const v = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) v[i] = arr[i] / n; return v};
const dot = (a, b) => {if (a.length !== b.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s};

// Is the embedding model pulled? (GET /api/tags through the adapter, cached 10 s there.) null when unknown/unreachable.
export const pulled = (models, model) => models.some(m => m === model || (!model.includes(':') && m.split(':')[0] === model));
export function semanticRecall({adapter, root = MIRROR_ROOT(), game = 'clocktower', config = embedConfig(), log = () => {}, now = () => Date.now()} = {}) {
  const cfg = {...embedConfig({}), ...config}, px = prefixes(cfg.model);
  let w = slug(game, 40), lastId = null, downUntil = 0, warned = false;
  const mem = new Map(), inflight = new Map(), queries = new Map(), swept = new Set(); // seat dir -> {vecs: Map(key -> Float32Array), dirty}
  const stats = {searches: 0, used: 0, cold: 0, embedded: 0, failures: 0, ms: 0};
  const dirOf = seat => seat && seat.kind === 'storyteller' ? join(root, w, 'storyteller') : seat && seat.kind === 'player' && Number.isInteger(seat.id) ? join(root, w, `${seat.id}-${slug(seat.name, 30)}`) : null;
  const reset = () => {mem.clear(); inflight.clear(); swept.clear()};
  function load(dir) {
    let c = mem.get(dir); if (c) return c;
    c = {vecs: new Map(), dirty: false};
    try {
      const j = JSON.parse(readFileSync(join(dir, 'vectors.json'), 'utf8'));
      if (j && j.v === 1 && j.model === cfg.model && j.vecs && typeof j.vecs === 'object') for (const [k, s] of Object.entries(j.vecs)) c.vecs.set(k, unb64(s));
    } catch {}
    mem.set(dir, c); return c;
  }
  function save(dir, c, keep) {
    try {
      if (keep) for (const k of [...c.vecs.keys()]) if (!keep.has(k)) {c.vecs.delete(k); c.dirty = true}
      if (!c.dirty) return;
      mkdirSync(dir, {recursive: true});
      const vecs = {}; let dim = 0; for (const [k, v] of c.vecs) {vecs[k] = b64(v); dim = v.length}
      const tmp = join(dir, 'vectors.json.tmp');
      writeFileSync(tmp, JSON.stringify({v: 1, model: cfg.model, dim, vecs})); renameSync(tmp, join(dir, 'vectors.json')); c.dirty = false;
    } catch (e) {log('[embed] could not save vectors: ' + e.message)}
  }
  const fail = e => {stats.failures++; downUntil = now() + 30000; if (!warned) {warned = true; log(`[embed] semantic search paused for 30 s: ${String(e && e.message || e).slice(0, 140)} (keywords still rank; pull the model with: ollama pull ${cfg.model})`)}};
  // Embed the query (if new) and every missing text, 32 at a time; fills the cache as it goes.
  async function fill(dir, c, qkey, qtext, missing) {
    const todo = missing.slice(); let first = true;
    while (first || todo.length) {
      const batch = todo.splice(0, 32), inputs = batch.map(m => px.d + m.text);
      if (first && qtext != null) inputs.unshift(px.q + qtext);
      const withQuery = first && qtext != null; first = false;
      if (!inputs.length) break;
      const r = await adapter.embed({model: cfg.model, input: inputs});
      const vs = r.vectors.map(unit);
      if (withQuery) {queries.set(qkey, vs.shift()); if (queries.size > 40) queries.delete(queries.keys().next().value)}
      batch.forEach((m, i) => {if (vs[i]) {c.vecs.set(m.k, vs[i]); c.dirty = true; stats.embedded++}});
      save(dir, c);
    }
  }
  return {
    config: cfg, stats,
    setGame(x, id = null) {const s = slug(x, 40); if (s && s !== w) {w = s; reset()} if (id && id !== lastId) {lastId = id; reset()}},
    dir: seat => dirOf(seat),
    // A fallen player's cache goes with it (hardcore); the Markdown mirror keeps its folder, not its vectors.
    drop(seat) {const dir = dirOf(seat); if (!dir || swept.has(dir)) return; swept.add(dir); mem.delete(dir); try {unlinkSync(join(dir, 'vectors.json'))} catch {}},
    async rank({seat, pool, query}) {
      const dir = dirOf(seat), q = String(query == null ? '' : query).trim().slice(0, 300);
      if (!cfg.enabled || !adapter || typeof adapter.embed !== 'function' || !dir || !q || !Array.isArray(pool) || !pool.length || now() < downUntil) return null;
      if (adapter.status) {const st = await adapter.status().catch(() => null); if (!st || !st.ok || !pulled(st.models, cfg.model)) return null} // not reachable or not pulled: keywords rank, nothing is requested
      const t0 = now(); stats.searches++;
      const items = pool.filter(p => p && typeof p.k === 'string' && typeof p.text === 'string').slice(0, SEM.POOL), c = load(dir);
      const qkey = cfg.model + '|' + q, missing = items.filter(p => !c.vecs.has(p.k));
      if (!queries.has(qkey) || missing.length) {
        let job = inflight.get(dir);
        if (!job || job.q !== qkey) {
          job = {q: qkey}; const mine = job;
          job.p = fill(dir, c, qkey, queries.has(qkey) ? null : q, missing).catch(fail).finally(() => {if (inflight.get(dir) === mine) inflight.delete(dir)});
          inflight.set(dir, job);
        }
        let timer; await Promise.race([job.p, new Promise(res => {timer = setTimeout(res, cfg.budgetMs)})]); clearTimeout(timer);
      }
      const qv = queries.get(qkey); if (!qv) {stats.cold++; return null}
      const sem = {}; let covered = 0, hits = 0;
      for (const p of items) {
        const v = c.vecs.get(p.k); if (!v) continue; covered++;
        const x = Math.max(0, Math.min(1, (dot(qv, v) - cfg.min) / (cfg.full - cfg.min)));
        if (x > 0) {sem[p.k] = Math.round(x * 1000) / 1000; hits++}
      }
      if (covered === items.length) save(dir, c, new Set(items.map(p => p.k))); // a full pass: forget vectors of notes that are gone
      const cold = covered < items.length; if (cold) stats.cold++;
      stats.used++; stats.ms += now() - t0;
      return {sem, hits, covered, total: items.length, cold, ms: now() - t0};
    },
  };
}

// What the relay prints on start: is the embedding model pulled?
export async function embedStatus(adapter, config = embedConfig()) {
  if (!config.enabled) return {ok: false, line: 'semantic memory search is off (RELAY_EMBED=0)'};
  const st = adapter && adapter.status ? await adapter.status() : null;
  if (!st || !st.ok) return {ok: false, line: `semantic memory search waits for Ollama (${st ? st.error : 'no adapter'}); keywords rank until then`};
  const have = pulled(st.models, config.model);
  return have ? {ok: true, line: `semantic memory search: ${config.model} (OLLAMA_EMBED_MODEL)`}
    : {ok: false, line: `semantic memory search needs an embedding model: ollama pull ${config.model} (keywords rank until then)`};
}
