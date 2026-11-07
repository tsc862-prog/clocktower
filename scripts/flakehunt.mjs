// Nightly flake hunt: run the flake-prone checks N times and report pass counts as Markdown.
//   node scripts/flakehunt.mjs [--runs 5] [--checks a,b,c | --all] [--out flake-report.md] [--link URL]
// The default list is the timer-bound and process-spawning checks (FLAKY below; edit it when a check starts or stops
// flaking); --all runs every npm script that runs a scripts/*check.mjs. Each run is a fresh `npm run <check>` child with
// CI_FAST as the environment has it. A check that fails in 2 or more of N runs (2 of 5) is labelled `flaky` in the table; one
// failing 1 run is "unsteady". Exit 0 always: the report is the product (the workflow files the issue).
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const FLAKY = ['upcheck', 'relaycheck', 'channelcheck', 'mockgamecheck'];
const RUNS = Math.max(1, Number(opt('runs', 5)));
const pkg = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const all = Object.keys(pkg).filter(k => /scripts\/\w+check\.mjs/.test(pkg[k]));
const names = (argv.includes('--all') ? all : opt('checks', FLAKY.join(',')).split(',').map(s => s.trim()).filter(Boolean)).filter(n => pkg[n]);
const rows = [];
for (const name of names) {
  let fails = 0, last = '', ms = 0;
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now(), r = spawnSync('npm', ['run', name], {encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20, timeout: 20 * 60000});
    ms += Date.now() - t0;
    const ok = r.status === 0;
    if (!ok) { fails++; const out = ((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/).map(l => l.trim()); last = (out.reverse().find(l => /FAIL|Error|error|not ok|expected/.test(l)) || out.find(l => l) || (r.error ? String(r.error.message) : 'no output')).slice(0, 200); }
    console.log(`${name} run ${i}/${RUNS}: ${ok ? 'pass' : 'FAIL'}`);
  }
  rows.push({name, fails, last, sec: Math.round(ms / RUNS / 1000)});
}
const flaky = r => r.fails * 5 >= 2 * RUNS && r.fails >= 2, label = r => r.fails === 0 ? '' : r.fails === RUNS ? 'broken' : flaky(r) ? 'flaky' : 'unsteady';
const esc = s => String(s).replace(/\|/g, '/').replace(/`/g, "'");
const L = [`## Nightly flake report`, '', `${names.length} checks, ${RUNS} runs each, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, CI_FAST=${process.env.CI_FAST || 'unset'}. ${opt('link', '') ? `[Run](${opt('link', '')})` : ''}`, '',
  '| check | fails/runs | label | avg s | last failing line |', '| --- | --- | --- | --- | --- |',
  ...rows.sort((a, b) => b.fails - a.fails || a.name.localeCompare(b.name)).map(r => `| ${r.name} | ${r.fails}/${RUNS} | ${label(r)} | ${r.sec} | ${r.fails ? '`' + esc(r.last) + '`' : ''} |`), '',
  `Labels: flaky = failed in 2 of 5 runs or worse (rate), unsteady = failed once, broken = failed every run. The pm uses this table to file or close flake issues; this issue is rewritten each night and never duplicated.`, ''];
writeFileSync(opt('out', 'flake-report.md'), L.join('\n'));
console.log(L.join('\n'));
const bad = rows.filter(r => r.fails);
writeFileSync(opt('out', 'flake-report.md').replace(/\.md$/, '.json'), JSON.stringify({runs: RUNS, rows}, null, 1));
console.log(bad.length ? `${bad.length} checks failed at least once` : 'no flakes seen');
