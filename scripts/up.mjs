// One-window launcher: `npm run up`. Starts the relay (runners on, the last run's runners resumed) and the page's Vite dev server
// as child processes of this one terminal, prefixes and colours their output, prints the patch notes merged since the owner last
// looked (logs/last-seen.json, scripts/patchnotes.mjs), opens the page once, and takes single-key commands:
//
//   u  update   git pull --ff-only (refused on a dirty tree or a non-fast-forward); npm install only when package-lock.json changed;
//               then the relay restarts (Vite follows src changes by itself, and is restarted when vite.config.js, package.json or
//               the lockfile changed)
//   r  restart  the relay (and its runners, which come back by themselves) without pulling
//   s  status   relay health and providers, seats, runners, Ollama models loaded
//   n  notes    the last 10 patch notes
//   h  help
//   q  quit     (or Ctrl+C, or closing the window) runners stop cleanly first, then the relay, then Vite
//
// Terminals without raw mode (a pipe, some IDE consoles) take the word plus Enter: update, restart, status, notes, help, quit.
// Options: --relay-port N (8787, or RELAY_PORT), --vite-port N (5173), --no-open, --repo DIR (the git checkout `u` pulls; default:
// this one). Children are started with node and an argument array, never a shell. `npm run relay` and `npm run dev` in two
// terminals still work.
import {spawn} from 'node:child_process';
import {watch, existsSync, readFileSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {unseenNotes, lastNotes, formatMerge} from './patchnotes.mjs';
import {tmpEnv, tmpRoot, cleanOld} from './tmp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const argv = process.argv.slice(2);
const opt = (name, dflt) => {const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt};
const RELAY_PORT = Number(opt('--relay-port', process.env.RELAY_PORT || 8787)), VITE_PORT = Number(opt('--vite-port', 5173));
const REPO = opt('--repo', ROOT), NO_OPEN = argv.includes('--no-open');
const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY || argv.includes('--no-color');
const GRACE_MS = Number(process.env.UP_GRACE_MS) || 12000; // how long the relay gets to stop its runners before the tree is killed
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- output ----
const COLORS = {up: '1;33', relay: '36', vite: '35', git: '32', npm: '32', notes: '1;32'};
const tagOf = name => (NO_COLOR ? `[${name}]` : `\x1b[${COLORS[name] || '37'}m[${name}]\x1b[0m`).padEnd(NO_COLOR ? 8 : 20);
const say = (name, text) => {for (const l of String(text).split(/\r?\n/)) if (l.trim()) process.stdout.write(tagOf(name) + ' ' + l + '\n')};
const up = t => say('up', t);

// ---- processes ----
const live = new Set(); // every child we started, for shutdown
function killTree(pid) { // the whole tree, so no runner, esbuild or shell stays behind holding a port
  return new Promise(res => {
    if (!pid) return res();
    if (WIN) {const k = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {windowsHide: true, stdio: 'ignore'}); k.on('exit', () => res()); k.on('error', () => res())}
    else {try {process.kill(-pid, 'SIGKILL')} catch {try {process.kill(pid, 'SIGKILL')} catch {}} res()}
  });
}
function launch(name, args, {env = {}, cwd = ROOT, onLine, cmd = process.execPath} = {}) {
  const child = spawn(cmd, args, {cwd, env: {...process.env, ...tmpEnv(), ...env}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !WIN});
  const p = {name, child, pid: child.pid, exited: false, started: Date.now(), expected: false};
  p.done = new Promise(res => {child.on('exit', (code, sig) => {p.exited = true; p.code = code; p.sig = sig; live.delete(p); res()}); child.on('error', e => {say('up', `${name}: could not start: ${e.message}`); p.exited = true; live.delete(p); res()})});
  if (child.stdin) child.stdin.on('error', () => {});
  for (const [stream] of [[child.stdout], [child.stderr]]) {
    let partial = '';
    stream.on('data', d => {partial += String(d); const parts = partial.split(/\r?\n/); partial = parts.pop(); for (const l of parts) {say(name, l); if (onLine) onLine(l)}});
    stream.on('end', () => {if (partial) {say(name, partial); if (onLine) onLine(partial); partial = ''}});
  }
  live.add(p);
  return p;
}
async function stopProc(p, {soft, graceMs = GRACE_MS} = {}) { // soft: ask on stdin ("stop") and wait; then kill the tree
  if (!p || p.exited) return;
  p.expected = true;
  if (soft) {try {p.child.stdin.write('stop\n')} catch {} await Promise.race([p.done, sleep(graceMs)])}
  if (!p.exited) {await killTree(p.pid); await Promise.race([p.done, sleep(2000)])}
}

// ---- ports ----
const listening = (port, host) => new Promise(res => {const s = net.connect({port, host}); s.setTimeout(800); s.once('connect', () => {s.destroy(); res(true)}); s.once('timeout', () => {s.destroy(); res(false)}); s.once('error', () => res(false))});
const portBusy = async port => (await listening(port, '127.0.0.1')) || (await listening(port, '::1'));
async function waitPortFree(port, ms = 8000) {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (!(await portBusy(port))) return true; await sleep(200)} return false}

// ---- state ----
let relay = null, vite = null, busy = '', quitting = false, codeChanged = false, quietUntil = 0, opened = false;
const RELAY_ARGS = ['scripts/relay.mjs', '--runners', '--resume-runners', '--launcher'];
const relayEnv = () => ({RELAY_PORT: String(RELAY_PORT), RELAY_ORIGIN: `http://localhost:${VITE_PORT}`, CLOCKTOWER_LAUNCHER: '1'});

function startRelay() {
  codeChanged = false; quietUntil = Date.now() + 1500;
  relay = launch('relay', RELAY_ARGS, {env: relayEnv()});
  up(`relay started (pid ${relay.pid}) on http://127.0.0.1:${RELAY_PORT}`);
  const mine = relay;
  mine.done.then(() => {if (!mine.expected && !quitting) up(`relay exited on its own (code ${mine.code ?? mine.sig}). Press r to start it again.`)});
}
function startVite() {
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {up('vite is not installed (node_modules/vite). Run npm install once.'); return null}
  vite = launch('vite', [viteBin, '--port', String(VITE_PORT), '--strictPort'], {env: {VITE_RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`}, onLine: l => {if (!opened && /Local:|ready in/i.test(l)) openGame()}});
  up(`vite started (pid ${vite.pid}) on http://localhost:${VITE_PORT}`);
  const mine = vite;
  mine.done.then(() => {if (!mine.expected && !quitting) up(`vite exited on its own (code ${mine.code ?? mine.sig}). Press u or r after fixing it, or q and start again.`)});
  return vite;
}
async function restartRelay() {
  if (relay) await stopProc(relay, {soft: true});
  if (!(await waitPortFree(RELAY_PORT))) up(`warning: port ${RELAY_PORT} is still held after the relay stopped`);
  startRelay();
}
async function restartVite() {
  if (vite) await stopProc(vite);
  await waitPortFree(VITE_PORT);
  startVite();
}

function openGame() {
  if (opened || NO_OPEN) return; opened = true;
  const url = `http://localhost:${VITE_PORT}`;
  const [cmd, args] = WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {const c = spawn(cmd, args, {stdio: 'ignore', detached: true, windowsHide: true}); c.on('error', () => up(`open ${url} in your browser`)); c.unref(); up(`opened ${url}`)} catch {up(`open ${url} in your browser`)}
}

// ---- git and npm ----
function run(cmd, args, {cwd = REPO, timeout = 120000, tag} = {}) {
  return new Promise(res => {
    let out = '', err = '', done = false;
    let c; try {c = spawn(cmd, args, {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})} catch (e) {return res({code: -1, out, err: e.message})}
    const fin = r => {if (!done) {done = true; clearTimeout(t); res(r)}};
    const t = setTimeout(() => {err += '\ntimed out'; killTree(c.pid); fin({code: -1, out, err})}, timeout);
    c.stdout.on('data', d => {out += d; if (tag) say(tag, String(d))}); c.stderr.on('data', d => {err += d; if (tag) say(tag, String(d))});
    c.on('error', e => fin({code: -1, out, err: err + e.message})); c.on('close', code => fin({code, out, err}));
  });
}
const git = (...a) => run('git', ['-C', REPO, ...a], {timeout: 90000});
function npmCli() { // npm-cli.js, so install runs as node + argument array (no .cmd, no shell)
  const c = [process.env.UP_NPM_CLI, /npm-cli\.js$/.test(process.env.npm_execpath || '') ? process.env.npm_execpath : '',
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  return c.find(f => f && existsSync(f)) || null;
}

async function update() {
  const st = await git('status', '--porcelain', '--untracked-files=no');
  if (st.code !== 0) return up(`update refused: git status failed: ${(st.err || st.out).trim().split('\n')[0]}`);
  // .claude/ holds the agents' memory notes, which change all the time: they never block an update. git itself refuses the
  // pull if an incoming commit touches a file that has local changes (handled below); nothing is ever stashed.
  const dirty = st.out.split('\n').filter(l => l.trim() && !/^.. "?\.claude\//.test(l));
  if (dirty.length) return up(`update refused: the working tree has local changes (${dirty.length} file(s), e.g. ${dirty[0].trim()}). Commit or discard them, then press u again.`);
  const before = (await git('rev-parse', 'HEAD')).out.trim();
  quietUntil = Date.now() + 8000; // the pull rewrites scripts/: not a "code changed" notice
  const pull = await git('pull', '--ff-only');
  say('git', (pull.out + pull.err).trim());
  if (pull.code !== 0) {
    const mine = (pull.err.match(/overwritten by merge:\n([\s\S]*?)(?:\nPlease|\nAborting|$)/) || [])[1];
    const files = mine ? mine.split('\n').map(f => f.trim()).filter(Boolean) : [];
    if (files.length) return up(`update refused: the incoming commits change files you have edited locally. Commit or discard your local changes to ${files.join(', ')}, then press u again. Nothing was changed.`);
  }
  if (pull.code !== 0) return up('update refused: git pull --ff-only did not fast-forward (diverged history, no upstream or no network). Nothing was changed.');
  const after = (await git('rev-parse', 'HEAD')).out.trim();
  if (before === after) return up('already up to date. (Press r to restart the relay anyway.)');
  const files = (await git('diff', '--name-only', before, after)).out.split('\n').map(s => s.trim()).filter(Boolean);
  up(`updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}: ${files.length} file(s) changed`);
  try {const n = cleanOld(); up(`temp files live in ${tmpRoot()}` + (n ? ` (${n} older than a day removed)` : ''))} catch {}
  showUnseen();
  const lock = files.includes('package-lock.json'), viteChanged = lock || files.includes('package.json') || files.includes('vite.config.js');
  if (lock) { // dependencies changed: nothing may hold node_modules while npm works
    const cli = npmCli();
    if (!cli) {up('package-lock.json changed but npm was not found next to node: run npm install in this folder, then press r.'); return}
    up('package-lock.json changed: stopping the relay and Vite, running npm install');
    if (relay) await stopProc(relay, {soft: true}); if (vite) await stopProc(vite);
    const r = await run(process.execPath, [cli, 'install'], {cwd: REPO, timeout: 600000, tag: 'npm'});
    if (r.code !== 0) up('npm install failed (see above). The relay and Vite are stopped: fix it and press r (relay) or restart this launcher.');
    await waitPortFree(RELAY_PORT); await waitPortFree(VITE_PORT);
    startRelay(); startVite();
    return;
  }
  await restartRelay();
  if (viteChanged) {up('vite.config.js or package.json changed: restarting Vite'); await restartVite()}
  up('update applied. The page reconnects to the relay by itself (Vite reloads it when src/ changed).');
}

// ---- patch notes ----
function showUnseen() {
  try {const r = unseenNotes(REPO); if (!r.head) return; if (!r.lines.length) return say('notes', 'no new patch notes since you last looked (press n for the last 10)'); for (const l of r.lines) say('notes', l)}
  catch (e) {up('patch notes: ' + e.message)}
}
function showLast(n = 10) {
  try {const list = lastNotes(REPO, n); if (!list.length) return say('notes', 'no patch notes yet'); say('notes', `the last ${list.length} patch notes:`); for (const m of list) for (const l of formatMerge(m)) say('notes', l)}
  catch (e) {up('patch notes: ' + e.message)}
}

async function getJson(path, ms = 3000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try {const r = await fetch(`http://127.0.0.1:${RELAY_PORT}${path}`, {signal: ac.signal}); return await r.json()} catch {return null} finally {clearTimeout(t)}
}
function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {for (const f of ['.env.local', '.env']) {const p = join(ROOT, f); if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && m[1] === name && !line.trim().startsWith('#')) return m[2].replace(/^["']|["']$/g, '')}}} catch {}
  return '';
}
async function status() {
  const age = p => p && !p.exited ? Math.round((Date.now() - p.started) / 1000) + ' s' : 'down';
  up(`relay pid ${relay && !relay.exited ? relay.pid : '-'} (up ${age(relay)}), vite pid ${vite && !vite.exited ? vite.pid : '-'} (up ${age(vite)})`);
  const h = await getJson('/health');
  if (!h) up(`relay: not answering on ${RELAY_PORT}`);
  else {const q = h.queues && h.queues.anthropic; up(`relay: ok${q ? `, Claude queue depth ${q.depth ?? 0} in flight ${q.inFlight ?? q.inflight ?? 0}` : ''}; providers: ${Object.entries(h.providers || {}).map(([k, v]) => k + (v.ok ? ' ok' : ' off')).join(', ') || 'none'}`)}
  const ph = await getJson('/play/health');
  if (ph) up(`seats: ${(ph.players || []).map(p => p.name + (p.claimed ? ' (' + (p.runner ? p.runner.provider : 'runner') + ')' : '')).join(', ')}; Storyteller ${ph.storyteller && ph.storyteller.claimed ? 'held' : 'free'}; ${ph.phase || ''}`);
  const rr = await getJson('/play/runner');
  if (rr && rr.enabled) {
    if (!rr.runners.length) up('runners: none running');
    for (const r of rr.runners) up(`runner ${r.key} ${r.name}: ${r.state}, ${[r.provider, r.model].filter(Boolean).join(' ') || 'default mind'}, ${r.turns} turns, $${(r.cost || 0).toFixed(2)}${r.error ? ', ' + r.error : ''}`);
  } else if (rr) up('runners: off');
  try { // Ollama: the models it holds in memory right now
    const url = (envValue('OLLAMA_URL') || 'http://localhost:11434').replace(/\/+$/, ''), ac = new AbortController(), t = setTimeout(() => ac.abort(), 2500);
    const j = await (await fetch(url + '/api/ps', {signal: ac.signal})).json(); clearTimeout(t);
    up(`ollama (${url}): ${(j.models || []).length ? j.models.map(m => m.name + (m.size_vram ? ` ${(m.size_vram / 1e9).toFixed(1)} GB` : '')).join(', ') + ' loaded' : 'reachable, no model loaded'}`);
  } catch {up('ollama: not reachable')}
  const hd = await git('log', '-1', '--format=%h %s'); if (hd.code === 0) up(`repo: ${hd.out.trim().slice(0, 90)}`);
  try {const {todayLine} = await import('./cost-report.mjs'); up(todayLine())} catch {up('cost today: no logs read')}
  if (codeChanged) up('relay code changed since it started: press u (or r) to apply');
}

const HELP = ['u  update: git pull --ff-only, npm install if the lockfile changed, restart the relay (and Vite if its config changed)',
  'r  restart the relay and its runners (no pull)', 's  status: relay, providers, seats, runners, Ollama', 'n  the last 10 patch notes (npm run notes -- --since <commit> for more)', 'h  this help', 'q  quit (Ctrl+C or closing the window too): runners stop cleanly first'];

// ---- commands ----
async function command(word) {
  const w = String(word).trim().toLowerCase();
  const map = {u: 'u', update: 'u', r: 'r', restart: 'r', q: 'q', quit: 'q', exit: 'q', s: 's', status: 's', n: 'n', notes: 'n', h: 'h', help: 'h', '?': 'h'};
  const k = map[w]; if (!k) {if (w) up(`unknown command "${w}". Press h for help.`); return}
  if (k === 'h') return HELP.forEach(l => up(l));
  if (k === 'n') return showLast(10);
  if (k === 'q') return shutdown('quit');
  if (busy) return up(`busy (${busy}); wait for it to finish`);
  busy = {u: 'updating', r: 'restarting', s: 'status'}[k];
  try {if (k === 'u') await update(); else if (k === 'r') {up('restarting the relay: runners stop cleanly and come back once the page reconnects'); await restartRelay()} else await status()}
  catch (e) {up(`${busy} failed: ${e.message}`)}
  finally {busy = ''}
}

async function shutdown(why, code = 0) {
  if (quitting) return; quitting = true;
  up(`stopping (${why}): runners, then the relay, then Vite`);
  up('runners will resume next start (delete logs/runners/active.json to start clean)');
  const fast = /hangup|close/.test(why); // a closing window gives only a few seconds
  try {if (relay) await stopProc(relay, {soft: true, graceMs: fast ? 3000 : GRACE_MS}); if (vite) await stopProc(vite)} catch {}
  for (const p of [...live]) await killTree(p.pid);
  up('stopped. Ports ' + RELAY_PORT + ' and ' + VITE_PORT + ' are free.');
  if (process.stdin.isTTY && process.stdin.setRawMode) try {process.stdin.setRawMode(false)} catch {}
  process.exit(code);
}

// ---- code-change notice ----
function watchCode() {
  const note = (_, f) => {
    if (process.env.UP_DEBUG_WATCH) up('watch event ' + _ + ' ' + f + ' quiet=' + Math.max(0, quietUntil - Date.now()) + 'ms changed=' + codeChanged);
    if (!f || !/\.mjs$/.test(String(f)) || /(check|smoke|^up)\.mjs$|(^|[\\/])up\.mjs$/.test(String(f)) || Date.now() < quietUntil || codeChanged) return;
    codeChanged = true; up(`relay code changed (${basename(String(f))}): press u (or r) to apply`);
  };
  for (const d of [join(ROOT, 'scripts'), join(ROOT, 'scripts', 'providers')]) {
    try {const w = watch(d, {persistent: false}, note); w.on('error', () => {})} catch {}
  }
}

// ---- main ----
async function main() {
  if (!existsSync(join(ROOT, 'scripts', 'relay.mjs'))) {console.error('up: run this from the Clocktower folder'); process.exit(1)}
  const busyPorts = [];
  if (await portBusy(RELAY_PORT)) busyPorts.push(`${RELAY_PORT} (relay)`);
  if (await portBusy(VITE_PORT)) busyPorts.push(`${VITE_PORT} (game)`);
  if (busyPorts.length) {
    up(`port ${busyPorts.join(' and ')} already in use: something else (another Clocktower?) is running. Close its windows (or press q in the launcher that started it) and start again.`);
    process.exit(1);
  }
  if (process.stdout.isTTY) process.stdout.write('\x1b]0;Clocktower\x07');
  up('Clocktower launcher. Keys: u update, r restart relay, s status, n patch notes, h help, q quit.');
  showUnseen();
  startRelay(); startVite();
  if (!NO_OPEN) setTimeout(openGame, 20000).unref(); // if Vite's ready line is missed
  watchCode();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
  process.on('SIGHUP', () => shutdown('hangup'));
  process.on('uncaughtException', e => {up('launcher error: ' + (e && e.stack || e)); shutdown('error', 1)});
  const raw = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  if (raw) {
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => {for (const ch of String(d)) {if (ch === '\x03' || ch === '\x04') return command('q'); if (/\S/.test(ch)) command(ch)}});
  } else {
    process.stdin.setEncoding('utf8'); let buf = '';
    process.stdin.on('data', d => {buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); for (const l of lines) command(l)});
    process.stdin.on('end', () => shutdown('stdin closed'));
  }
  process.stdin.on('error', () => {});
  process.stdin.resume();
}
main();
