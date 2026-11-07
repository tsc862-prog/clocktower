// Repo rules, run in CI and by hand (`npm run rulescheck [-- --pr N]`). Exit 1 on any failure.
//  1. Patch notes: every docs/patchnotes/*.md has front matter and 1-6 player-facing lines; on a pull request the tree holds
//     docs/patchnotes/<PR>.md unless the PR carries the label no-notes. The PR number comes from --pr N or PR_NUMBER (CI);
//     the label is read live with gh (GH_TOKEN) and falls back to PR_LABELS.
//  2. Workflow files: every .github/workflows/*.yml parses as the simple YAML we write (a step name with a comma or a colon
//     is quoted; braces balance), so a broken workflow fails here with file and line instead of leaving a PR with no checks.
//  3. CI coverage: every `*check` script in package.json is run by a step in ci.yml (a check nobody runs is a check nobody trusts).
//  4. Layering: nothing under src/ imports from scripts/ or node:*; nothing under src/ or scripts/ carries a key literal.
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), opt = (k, d) => {const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d};
let fails = 0;
const ok = (cond, msg) => {console.log(`  ${cond ? 'ok ' : 'FAIL'} ${msg}`); if (!cond) fails++};
const walk = (dir, out = []) => {for (const n of readdirSync(dir, {withFileTypes: true})) {const p = join(dir, n.name); if (n.isDirectory()) walk(p, out); else out.push(p)} return out};

// 1. patch notes
console.log('patch notes: one player-facing note per PR (docs/patchnotes/<PR>.md)');
{
  const {parseNote, lintNote} = await import(pathToFileURL(join(ROOT, 'src/ui/patchnotes.js')).href);
  const dir = join(ROOT, 'docs', 'patchnotes'), files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')) : [];
  let bad = 0;
  for (const f of files) {const e = lintNote(parseNote(readFileSync(join(dir, f), 'utf8'), f)); if (e.length) {bad++; console.log(`       ${f}: ${e.join('; ')}`)}}
  ok(bad === 0, `${files.length} note(s) well formed`);
  const pr = Number(opt('--pr', process.env.PR_NUMBER || '')) || 0;
  if (!pr) console.log("  -    not a pull-request run (no --pr N or PR_NUMBER): the PR's own note is checked in CI");
  else if (files.includes(pr + '.md')) ok(true, `PR #${pr} carries its note (docs/patchnotes/${pr}.md)`);
  else {
    const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'labels', '--jq', '.labels[].name'], {encoding: 'utf8'});
    const labels = (r.status === 0 ? r.stdout.split('\n') : (process.env.PR_LABELS || '').split(',')).map(s => s.trim());
    ok(labels.includes('no-notes'), labels.includes('no-notes') ? `PR #${pr} has no note and the label no-notes` :
      `PR #${pr} has no patch note: add docs/patchnotes/${pr}.md (title, date, area, issues in front matter, then 1-6 "- " lines on what the watcher will see; "Nothing you will notice: ..." for CI and tests), or label the PR no-notes and re-run`);
  }
}

// 2. workflow files
console.log('workflow files: the YAML we write parses');
{
  const dir = join(ROOT, '.github', 'workflows'), files = existsSync(dir) ? readdirSync(dir).filter(f => /\.ya?ml$/.test(f)) : [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n'); let bad = null;
    lines.forEach((l, i) => {
      if (bad || l.trim().startsWith('#')) return;
      const inline = l.match(/^\s*-\s*\{(.*)$/); // an inline step: - {name: ..., run: ...}
      if (inline) {
        if (!/\}\s*$/.test(l)) bad = `${i + 1}: inline step not closed with }`;
        else {const nm = inline[1].match(/name:\s*([^,}]*)/); const v = nm ? nm[1].trim() : ''; if (v && !/^["']/.test(v) && /[:#]/.test(v)) bad = `${i + 1}: inline step name with a colon or #: quote it`;
          const raw = inline[1].match(/name:\s*(.*?),\s*run:/); if (raw && !/^["']/.test(raw[1].trim()) && raw[1].includes(',')) bad = `${i + 1}: inline step name with a comma: quote it (${raw[1].trim()})`}
      } else {
        const m = l.match(/^\s*-?\s*name:\s*(.*)$/);
        if (m) {const v = m[1].trim(); if (v && !/^["']/.test(v) && /:\s|\s#/.test(v) && !/^\$\{\{/.test(v)) bad = `${i + 1}: unquoted name with ": " or " #": ${v}`}
      }
      const open = (l.match(/\$\{\{/g) || []).length, close = (l.match(/\}\}/g) || []).length; if (open !== close) bad = `${i + 1}: unbalanced \${{ }}`;
    });
    ok(!bad, `${f}${bad ? ' ' + bad : ''}`);
  }
}

// 3. CI coverage
console.log('CI coverage: every *check script runs in ci.yml');
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {};
  const ci = existsSync(join(ROOT, '.github/workflows/ci.yml')) ? readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8') : '';
  for (const name of Object.keys(pkg).filter(n => /check$/.test(n))) ok(new RegExp(`npm run ${name}\\b`).test(ci), `${name} is run by CI`);
}

// 4. layering and keys
console.log('layering: src/ never imports scripts/ or node:*; no key literal anywhere');
{
  const src = existsSync(join(ROOT, 'src')) ? walk(join(ROOT, 'src')).filter(f => /\.(js|mjs)$/.test(f)) : [];
  let bad = [];
  for (const f of src) {const t = readFileSync(f, 'utf8'); if (/from\s+['"](\.\.\/)+scripts\//.test(t) || /from\s+['"]node:/.test(t)) bad.push(f.slice(ROOT.length + 1))}
  ok(bad.length === 0, `src/ stays browser-safe${bad.length ? ': ' + bad.join(', ') : ''}`);
  const all = ['src', 'scripts', 'docs', '.github'].filter(d => existsSync(join(ROOT, d))).flatMap(d => walk(join(ROOT, d)));
  const keys = all.filter(f => /sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,}/.test(readFileSync(f, 'utf8'))).map(f => f.slice(ROOT.length + 1));
  ok(keys.length === 0, `no key literal in the tree${keys.length ? ': ' + keys.join(', ') : ''}`);
}

console.log(fails ? `${fails} rule(s) broken` : 'all rules hold');
process.exit(fails ? 1 : 0);
