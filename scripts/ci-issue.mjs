// Open or update the one issue a CI watcher keeps: find an open issue by exact title, comment on it or
// create it; or close it with a comment. Used by the nightly workflows and the red-main alarm; needs `gh` and GH_TOKEN
// with issues: write. The body comes from a file so run summaries can be long.
//   node scripts/ci-issue.mjs open  --title T --body-file F [--label L] [--comment-file F]
//   node scripts/ci-issue.mjs close --title T --comment TEXT
// `open`: no open issue with that title -> create it with the body (and the label, made if missing); one exists -> its
// body is replaced and the comment (default: the body) added. Never creates a second open issue with the same title.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [cmd, ...rest] = process.argv.slice(2);
const opt = n => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : null; };
const title = opt('title'); if (!cmd || !title) { console.error('usage: ci-issue.mjs open|close --title T ...'); process.exit(2); }
const gh = (...a) => execFileSync('gh', a, {encoding: 'utf8'}).trim();
const find = () => { const l = JSON.parse(gh('issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '30')); return l.find(i => i.title === title) || null; };
const hit = find();
if (cmd === 'open') {
  const bodyFile = opt('body-file'), body = readFileSync(bodyFile, 'utf8'), label = opt('label');
  if (label) { try { gh('label', 'create', label, '--color', 'B60205', '--description', 'raised by a CI watcher (issue 574)'); } catch { /* exists */ } }
  if (hit) {
    gh('issue', 'edit', String(hit.number), '--body-file', bodyFile);
    gh('issue', 'comment', String(hit.number), '--body-file', opt('comment-file') || bodyFile);
    console.log('updated #' + hit.number);
  } else {
    const url = gh('issue', 'create', '--title', title, '--body', body, ...(label ? ['--label', label] : []));
    console.log('opened ' + url);
  }
} else if (cmd === 'close') {
  if (!hit) { console.log('no open issue to close'); process.exit(0); }
  gh('issue', 'close', String(hit.number), '--comment', opt('comment') || 'Green again.');
  console.log('closed #' + hit.number);
} else { console.error('unknown command ' + cmd); process.exit(2); }
