// Launcher check: `npm run up` (scripts/up.mjs) with real children on spare ports (never 8787 or 5173), no key and no network
// (`npm run upcheck`). In a small temp git repo standing in for the checkout `u` pulls, with one merged PR and its patch note:
//   1. the launcher starts the relay and Vite in one window, prints the patch notes since the owner last looked and records
//      HEAD in logs/last-seen.json;
//   2. the page answers 200 with the title and "No game yet", the relay's health answers (and lets the page's origin read it);
//   3. `n` prints the last notes again;
//   4. `q` stops both and frees both ports.
// Waits go through scripts/ci-clock.mjs (CI_FAST).
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {mkTmp, tmpEnv} from './tmp.mjs';
import {ms} from './ci-clock.mjs';
import {freePort, quietEnv} from './relaycheck.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const sleep = t => new Promise(r => setTimeout(r, t));
const until = async (f, t, step = 150) => {const t0 = Date.now(); for (;;) {const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > t) return null; await sleep(step)}};
const busy = port => new Promise(res => {const s = net.connect({port, host: '127.0.0.1'}); s.setTimeout(500); s.once('connect', () => {s.destroy(); res(true)}); s.once('timeout', () => {s.destroy(); res(false)}); s.once('error', () => res(false))});

// A repo with one merged pull request (#101) and its patch note, as `git log` shows a merge on GitHub.
function fakeRepo() {
  const dir = mkTmp('upcheck-repo-'), g = (...a) => {const r = spawnSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.invalid', '-c', 'commit.gpgsign=false', ...a], {encoding: 'utf8'}); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout};
  g('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'README.md'), 'test\n'); g('add', '.'); g('commit', '-q', '-m', 'start');
  g('checkout', '-q', '-b', 'infra/x'); mkdirSync(join(dir, 'docs', 'patchnotes'), {recursive: true});
  writeFileSync(join(dir, 'docs', 'patchnotes', '101.md'), '---\ntitle: The check note\ndate: 2026-11-07\narea: infra\nissues: [1]\n---\n- A line only the launcher check knows.\n');
  g('add', '.'); g('commit', '-q', '-m', 'note'); g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', 'infra/x', '-m', 'Merge pull request #101 from someone/infra/x');
  return dir;
}

async function main() {
  const repo = fakeRepo(), relayPort = await freePort(), vitePort = await freePort();
  const env = await quietEnv({UP_GRACE_MS: String(ms(12000, 4000))});
  const out = [];
  const child = spawn(process.execPath, ['scripts/up.mjs', '--relay-port', String(relayPort), '--vite-port', String(vitePort), '--no-open', '--repo', repo], {cwd: ROOT, env: {...env, ...tmpEnv(), NO_COLOR: '1'}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const take = d => {for (const l of String(d).split(/\r?\n/)) if (l.trim()) out.push(l)};
  child.stdout.on('data', take); child.stderr.on('data', take);
  const exited = new Promise(r => child.on('exit', code => r(code)));
  const send = w => child.stdin.write(w + '\n');
  try {
    console.log('start');
    const page = await until(async () => {const r = await fetch(`http://localhost:${vitePort}/`); return r.status === 200 ? await r.text() : null}, ms(60000, 20000));
    ok(!!page && /<title>Clocktower<\/title>/.test(page) && /No game yet/.test(page), `the page answers 200 on ${vitePort} with the title and "No game yet"`);
    const js = page ? await fetch(`http://localhost:${vitePort}/src/ui/main.js`).then(r => r.status).catch(() => 0) : 0;
    ok(js === 200, 'its script is served (no build step to play)');
    const h = await until(async () => {const r = await fetch(`http://127.0.0.1:${relayPort}/health`, {headers: {origin: `http://localhost:${vitePort}`}}); return r.status === 200 ? {j: await r.json(), cors: r.headers.get('access-control-allow-origin')} : null}, ms(30000, 10000));
    ok(!!h && h.j.ok && Object.keys(h.j.providers || {}).length >= 5, `the relay's health answers on ${relayPort} with its providers`);
    ok(!!h && h.cors === `http://localhost:${vitePort}`, "the relay lets this page's origin read its health (RELAY_ORIGIN follows the page's port)");
    ok(out.some(l => /^\[relay\]/.test(l)) && out.some(l => /^\[vite\]/.test(l)), 'both children print in the one window, tagged [relay] and [vite]');
    ok(out.some(l => /^\[notes\].*the last 1 notes/.test(l)) && out.some(l => /A line only the launcher check knows/.test(l)), 'it prints the patch notes since the owner last looked');
    let seen = null; try {seen = JSON.parse(readFileSync(join(repo, 'logs', 'last-seen.json'), 'utf8'))} catch {}
    const headNow = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim();
    ok(!!seen && seen.commit === headNow, 'and records what was seen in logs/last-seen.json');

    console.log('n');
    const before = out.length; send('n');
    const again = await until(async () => out.slice(before).some(l => /^\[notes\]\s+the last 1 patch notes/.test(l)) && out.slice(before).some(l => /A line only the launcher check knows/.test(l)), ms(8000, 3000));
    ok(!!again, '`n` shows the notes again');

    console.log('q');
    send('q');
    const code = await Promise.race([exited, sleep(ms(40000, 15000)).then(() => 'timeout')]);
    ok(code === 0, `\`q\` quits (exit ${code})`);
    const free = await until(async () => !(await busy(relayPort)) && !(await busy(vitePort)), ms(10000, 4000));
    ok(!!free, `both ports are free again (${relayPort}, ${vitePort})`);
    ok(out.some(l => /stopped\. Ports/.test(l)), 'it says it stopped');
  } finally {
    if (child.exitCode == null) {try {child.kill()} catch {}}
    if (fails) console.log(out.slice(-30).join('\n'));
  }
  console.log(fails ? `${fails} launcher check(s) failed` : 'launcher check: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
