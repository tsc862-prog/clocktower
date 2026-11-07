// Patch notes in the terminal: the notes of the PRs merged between two commits, in merge order.
//   npm run notes                      the last 10 merged notes
//   npm run notes -- --since <commit>  every note merged after that commit (newest last)
//   npm run notes -- --last N          the last N
//   npm run notes -- --lint            check every docs/patchnotes/*.md (front matter, 1-6 player-facing lines)
//   npm run notes -- --quote <PR>      the note of one PR as Markdown (CI's PR comment quotes it)
//   --repo DIR                         another checkout (default: this one)
// The launcher (scripts/up.mjs) uses notesSince/lastNotes and logs/last-seen.json (the commit the owner last saw).
// Order is merge order on main: `git log --first-parent` from old to HEAD, the PR number taken from the merge subject
// ("Merge pull request #N from ...", or a squash's "... (#N)"); a PR without a note prints its subject with "(no note)".
import {readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseNote, lintNote, noteLabel} from '../src/ui/patchnotes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const notesDir = repo => join(repo, 'docs', 'patchnotes');
export const seenFile = repo => join(repo, 'logs', 'last-seen.json');

const git = (repo, ...a) => {const r = spawnSync('git', ['-C', repo, ...a], {encoding: 'utf8', maxBuffer: 1 << 26}); return r.status === 0 ? r.stdout : null};
export const prOfSubject = s => {const m = String(s).match(/^Merge pull request #(\d+)\b/) || String(s).match(/\(#(\d+)\)\s*$/); return m ? Number(m[1]) : null};

export function readNote(repo, pr) {
  const dir = notesDir(repo); if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find(n => n === pr + '.md' || (pr === 0 && /^0000-.*\.md$/.test(n)));
  return f ? parseNote(readFileSync(join(dir, f), 'utf8'), f) : null;
}
export function allNotes(repo) {
  const dir = notesDir(repo); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => /\.md$/.test(n) && !n.startsWith('_')).map(n => ({file: n, note: parseNote(readFileSync(join(dir, n), 'utf8'), n)}));
}

// The merges on main between two commits, oldest first: [{sha, date, subject, pr, note}]
function merges(repo, range, n) {
  const out = git(repo, 'log', '--first-parent', ...(n ? ['-n', String(n)] : []), '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', range); if (out == null) return null;
  return out.split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).reverse().map(r => {
    const [sha, at = '', subject = '', body = ''] = r.split('\x1f'), pr = prOfSubject(subject);
    const title = /^Merge pull request/.test(subject) ? (body.split('\n').find(l => l.trim()) || '').trim() : subject.replace(/\s*\(#\d+\)\s*$/, '');
    return {sha, date: at.slice(0, 10), subject, title, pr, note: pr ? readNote(repo, pr) : null}}).filter(m => m.pr);
}
export const head = repo => (git(repo, 'rev-parse', 'HEAD') || '').trim() || null;
export function notesSince(repo, since) { // null when `since` is not an ancestor of HEAD (rewritten history, another repo)
  if (!since || git(repo, 'merge-base', '--is-ancestor', since, 'HEAD') == null) return null;
  return merges(repo, since + '..HEAD');
}
export function lastNotes(repo, n = 10) {const all = merges(repo, 'HEAD', 400) || []; return all.slice(-n)}

// One merge as terminal lines: "2026-11-07 #12 Title" then "  - line" per note line.
export function formatMerge(m) {
  const n = m.note;
  if (!n) return [`${m.date} #${m.pr} ${m.title || 'merged'} (no note)`];
  return [`${m.date} ${noteLabel(n)} ${n.title}`, ...n.lines.map(l => '  - ' + l)];
}

export function readSeen(repo) {try {return JSON.parse(readFileSync(seenFile(repo), 'utf8'))} catch {return null}}
export function writeSeen(repo, commit) {try {mkdirSync(dirname(seenFile(repo)), {recursive: true}); writeFileSync(seenFile(repo), JSON.stringify({commit, at: new Date().toISOString()}, null, 1) + '\n'); return true} catch {return false}}

// The launcher's step: the notes since the commit the owner last saw, then HEAD is recorded. Returns the lines to print.
export function unseenNotes(repo, {first = 10} = {}) {
  const now = head(repo); if (!now) return {lines: [], head: null};
  const seen = readSeen(repo), lines = [];
  if (seen && seen.commit === now) return {lines, head: now, count: 0};
  let list = seen && seen.commit ? notesSince(repo, seen.commit) : null;
  if (list == null) {list = lastNotes(repo, first); if (list.length) lines.push(seen ? `the last commit you saw is not on this branch; the last ${list.length} notes:` : `the last ${list.length} notes (first start with patch notes; n shows them again):`)}
  else if (list.length) lines.push(`${list.length} change(s) since you last looked:`);
  for (const m of list) lines.push(...formatMerge(m));
  writeSeen(repo, now);
  return {lines, head: now, count: list.length};
}

// Markdown for the PR comment: the note as the owner will read it.
export function quoteNote(repo, pr) {
  const n = readNote(repo, pr);
  if (!n) return `### Patch note\n\nNo patch note: add \`docs/patchnotes/${pr}.md\` (front matter, then 1-6 lines for the player) or label the PR \`no-notes\`.\n\n`;
  const errs = lintNote(n);
  return `### Patch note\n\n> **${n.title}** (${n.date}, ${n.area})\n>\n${n.lines.map(l => '> - ' + l).join('\n')}\n\n` + (errs.length ? errs.map(e => '- note problem: ' + e).join('\n') + '\n\n' : '');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => {const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d};
  const repo = resolve(opt('--repo', ROOT));
  if (argv.includes('--lint')) {
    let bad = 0;
    for (const {file, note} of allNotes(repo)) {const e = lintNote(note); if (e.length) {bad++; console.error(file + ':\n  ' + e.join('\n  '))}}
    console.log(bad ? `${bad} note(s) need work` : `all ${allNotes(repo).length} notes are fine`); process.exit(bad ? 1 : 0);
  }
  if (argv.includes('--quote')) {process.stdout.write(quoteNote(repo, Number(opt('--quote')))); process.exit(0)}
  const since = opt('--since');
  const list = since ? notesSince(repo, since) : lastNotes(repo, Number(opt('--last', 10)));
  if (list == null) {console.error(`${since} is not a commit before HEAD in ${repo}`); process.exit(1)}
  if (!list.length) console.log('no merged changes' + (since ? ' since ' + since : ''));
  for (const m of list) console.log(formatMerge(m).join('\n'));
}
