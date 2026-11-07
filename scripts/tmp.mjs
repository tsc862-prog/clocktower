// The project's temp (owner rule 2026-11-05: nothing on C:). One place for where temp files go and how they are cleaned up.
//   tmpRoot CLOCKTOWER_TMP if set, else <repo>/logs/tmp (gitignored), created on demand.
//   mkTmp(prefix) a fresh directory under tmpRoot, removed when this process exits (also on process.exit).
//   cleanOld(ms) delete entries of tmpRoot older than ms (default one day); the launcher calls it at start.
//   tmpEnv {TEMP, TMP, TMPDIR} for child processes.
// A killed process cannot clean up after itself; cleanOld sweeps what it left.
import {mkdirSync, mkdtempSync, existsSync, writeFileSync, readdirSync, rmSync, statSync, lstatSync, unlinkSync, rmdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const tmpRoot = () => {const d = resolve(process.env.CLOCKTOWER_TMP || join(REPO, 'logs', 'tmp')); mkdirSync(d, {recursive: true}); const pj = join(d, 'package.json'); // plain .js files in here are CommonJS, as in the system temp (the repo's package.json says module)
  if (!existsSync(pj)) try {writeFileSync(pj, '{"type":"commonjs","private":true}\n')} catch {}
  return d};
export const tmpEnv = () => {const d = tmpRoot(); return {TEMP: d, TMP: d, TMPDIR: d}};

// Remove a directory without ever following a link out of it (a node_modules junction is unlinked, not emptied).
export function rmTree(dir) {
  try {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink() || (process.platform === 'win32' && n === 'node_modules')) {try {unlinkSync(p)} catch {try {rmdirSync(p)} catch {}}}
      } catch {}
    }
  } catch {}
  try {rmSync(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})} catch {}
}

const made = new Set(); let hooked = false;
export function mkTmp(prefix = 'clocktower-') {
  const dir = mkdtempSync(join(tmpRoot(), prefix));
  made.add(dir);
  if (!hooked) {hooked = true; process.on('exit', () => {for (const d of made) rmTree(d)})}
  return dir;
}
export const keepTmp = dir => made.delete(dir);

export function cleanOld(ms = 86400000) {
  const root = tmpRoot(), now = Date.now(); let n = 0;
  for (const name of readdirSync(root)) {
    if (name === 'package.json') continue;
    const p = join(root, name);
    try {if (now - statSync(p).mtimeMs > ms) {rmTree(p); try {unlinkSync(p)} catch {} n++}} catch {}
  }
  return n;
}
