// Create or update one PR comment identified by a hidden marker, so several CI jobs can each keep their own
// comment on a pull request without `gh pr comment --edit-last` overwriting another job's.
//   node scripts/pr-comment.mjs <pr> <marker> <body-file>
// Needs gh and GH_TOKEN with pull-requests: write. Exits 0 even when it cannot comment (a fork's read-only token).
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
const [pr, marker, file] = process.argv.slice(2);
if (!pr || !marker || !file) { console.error('usage: pr-comment.mjs <pr> <marker> <body-file>'); process.exit(2); }
const tag = `<!-- ${marker} -->`, body = tag + '\n' + readFileSync(file, 'utf8');
const gh = (...a) => execFileSync('gh', a, {encoding: 'utf8'}).trim();
try {
  const repo = process.env.GITHUB_REPOSITORY || gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
  const list = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`)).flat();
  const mine = list.filter(c => c.body && c.body.startsWith(tag)).pop();
  writeFileSync('.pr-comment-body.json', JSON.stringify({body}));
  if (mine) gh('api', '-X', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '--input', '.pr-comment-body.json');
  else gh('api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '.pr-comment-body.json');
  console.log(mine ? 'updated comment ' + mine.id : 'commented on #' + pr);
} catch (e) { console.error('could not comment: ' + String(e.message).split('\n')[0]); }
