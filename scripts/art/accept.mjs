#!/usr/bin/env node
// Review step: keep or drop what waits in assets/incoming/portraits/.
//   npm run art:accept -- Odette [Bram ...]    move to assets/portraits/<Name>.png, an entry in assets/portraits/index.json, a line in docs/CREDITS.md
//   npm run art:accept -- all                  everything waiting
//   npm run art:accept -- --reject Odette      drop it from the inbox (redraw with art:portraits -- --only Odette --force --seed N)
//   npm run art:accept -- --list               what waits and what is accepted
// assets/portraits/index.json: {"version": 1, "portraits": {"Odette": {file, model, provider, licence, promptHash, seed, size, sha256, date}}}.
// Accepted images reach main through a normal PR; this script commits nothing.
import {existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {incomingDir, portraitsDir, root, readJson, writeJson, parseArgs, isPng, sha} from './lib.mjs';

const HEAD = '# Credits\n\nPortraits are generated for this fan project; no official art is used. Each line names the model and its licence.\n\n## Portraits\n\n';
const creditLine = (n, m) => `- ${n}: generated ${m.date.slice(0, 10)} with ${m.model} (${m.licence}) through Hugging Face Inference Providers, prompt ${m.promptHash}.`;

export function updateCredits(file, name, meta) {
  let t = existsSync(file) ? readFileSync(file, 'utf8') : HEAD;
  if (!/^## Portraits\s*$/m.test(t)) t = t.replace(/\s*$/, '\n\n') + '## Portraits\n\n';
  const lines = t.split('\n').filter(l => !l.startsWith(`- ${name}: generated `));
  const at = lines.findIndex(l => /^## Portraits\s*$/.test(l));
  let end = lines.length; for (let i = at + 1; i < lines.length; i++) if (/^## /.test(lines[i])) {end = i; break}
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, creditLine(name, meta));
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, lines.join('\n').replace(/\s*$/, '\n'));
}

export function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const o = parseArgs(argv), inc = incomingDir(env), dest = portraitsDir(env), idxFile = join(dest, 'index.json');
  const waiting = existsSync(inc) ? readdirSync(inc).filter(f => /^[A-Za-z][A-Za-z0-9_-]*\.png$/.test(f)).map(f => f.slice(0, -4)) : [];
  const idx = readJson(idxFile, {version: 1, portraits: {}});
  if (o.list) {out.log(`waiting: ${waiting.join(', ') || '(none)'}\naccepted: ${Object.keys(idx.portraits).join(', ') || '(none)'}`); return 0}
  const asked = o._.includes('all') ? waiting : o._;
  if (!asked.length) {out.error('name the portraits to take: npm run art:accept -- Odette (or all, --reject Name, --list)'); return 2}
  let bad = 0;
  for (const a of asked) {
    const n = waiting.find(w => w.toLowerCase() === a.toLowerCase());
    if (!n) {out.error(`${a}: nothing waiting in ${inc}`); bad++; continue}
    if (o.reject) {for (const e of ['.png', '.json']) try {unlinkSync(join(inc, n + e))} catch {} out.log(`${n}: rejected`); continue}
    const png = readFileSync(join(inc, n + '.png'));
    if (!isPng(png)) {out.error(`${n}: not a PNG`); bad++; continue}
    const meta = readJson(join(inc, n + '.json'), null);
    if (!meta || meta.sha256 !== sha(png)) {out.error(`${n}: no matching record (its .json is missing or is for another image); redraw it`); bad++; continue}
    if (meta.placeholder) {out.error(`${n}: made from a PLACEHOLDER brief; redraw it from the real brief first`); bad++; continue}
    mkdirSync(dest, {recursive: true}); copyFileSync(join(inc, n + '.png'), join(dest, n + '.png'));
    idx.portraits[n] = {file: n + '.png', model: meta.model, provider: meta.provider, licence: meta.licence, promptHash: meta.promptHash, seed: meta.seed, size: meta.size, sha256: meta.sha256, date: meta.date};
    writeJson(idxFile, idx); updateCredits(join(root(env), 'docs', 'CREDITS.md'), n, meta);
    for (const e of ['.png', '.json']) try {unlinkSync(join(inc, n + e))} catch {}
    out.log(`${n}: accepted -> assets/portraits/${n}.png`);
  }
  return bad ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
