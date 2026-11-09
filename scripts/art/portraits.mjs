#!/usr/bin/env node
// Portrait generator: one square painted portrait per seat and the Storyteller, into assets/incoming/portraits/ (git-ignored, for review).
//   npm run art:portraits                       every portrait not yet in the inbox
//   npm run art:portraits -- --only Odette,Bram just these (names as in src/data/portraits.js)
//   --force            redraw even if the inbox has one      --size 512|768 (default 512)      --seed N (default: stable per name)
//   --dry-run          print the plan and the first request (no token needed), call nothing
// Reads PORTRAITS and PORTRAIT_STYLE from src/data/portraits.js ({Odette: {prompt, negative?}, ...}; a marked placeholder per seat
// when that file is missing). The final prompt is the brief plus the style. Needs HF_TOKEN (Hugging Face PRO, in .env); a run stops on
// a refused token or spent credits. A reviewed image is taken with `npm run art:accept -- Odette`. Nothing under assets/incoming is ever committed.
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {briefs, buildRequest, modelOf, hfToken, fetchImage, pngSize, sha, promptHash, incomingDir, writeJson, parseArgs, SIZES, ArtError} from './lib.mjs';

const seedOf = name => parseInt(sha(Buffer.from(name)).slice(0, 8), 16) % 2147483647; // stable per name, so a redraw is a choice (--seed)
const sleep = t => new Promise(r => setTimeout(r, t));

export async function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const o = parseArgs(argv, ['only', 'size', 'seed']);
  const size = Number(o.size || 512);
  if (!SIZES.includes(size)) {out.error(`--size must be ${SIZES.join(' or ')}`); return 2}
  const {style, portraits, placeholder} = await briefs(env), model = modelOf(env), dir = incomingDir(env);
  let names = Object.keys(portraits);
  if (o.only) {
    const want = String(o.only).split(',').map(s => s.trim()).filter(Boolean), low = Object.fromEntries(names.map(n => [n.toLowerCase(), n]));
    const bad = want.filter(w => !low[w.toLowerCase()]); if (bad.length) {out.error(`unknown: ${bad.join(', ')} (known: ${names.join(', ')})`); return 2}
    names = want.map(w => low[w.toLowerCase()]);
  }
  if (placeholder) out.log('[portraits] src/data/portraits.js is missing: using a marked PLACEHOLDER brief per seat');
  const todo = names.filter(n => o.force || !existsSync(join(dir, n + '.png')));
  out.log(`[portraits] ${todo.length} to make of ${names.length} (${size}x${size}, ${model.repo} via ${model.provider}) -> ${dir}`);
  const mk = n => {const b = portraits[n], prompt = [b.prompt, style].filter(Boolean).join(', '), seed = o.seed != null ? Number(o.seed) : seedOf(n); return {n, prompt, negative: b.negative || '', seed, req: buildRequest({model, prompt, negative: b.negative, size, seed, env})}};
  if (o['dry-run']) {if (todo[0]) {const j = mk(todo[0]); out.log(`[portraits] first request: POST ${j.req.url}\n${JSON.stringify(j.req.body)}`)} return 0}
  const token = hfToken(env);
  if (!token) {out.error('[portraits] no HF_TOKEN: put HF_TOKEN=hf_... in .env (a PRO token with the "Inference Providers" permission)'); return 2}
  mkdirSync(dir, {recursive: true});
  let made = 0, failed = 0;
  for (const n of todo) {
    const j = mk(n), t0 = Date.now();
    try {
      let bytes;
      for (let a = 0; ; a++) {try {bytes = await fetchImage({req: j.req, token, timeoutMs: Number(env.ART_TIMEOUT_MS) || 180000}); break} catch (e) {if (e.kind === 'transient' && a < 2) {await sleep(Number(env.ART_RETRY_MS ?? 4000) * (a + 1)); continue} throw e}}
      const {w, h} = pngSize(bytes);
      if (w !== h) throw new ArtError('image', `not square (${w}x${h})`);
      writeFileSync(join(dir, n + '.png'), bytes);
      writeJson(join(dir, n + '.json'), {name: n, model: model.repo, provider: model.provider, licence: model.licence, promptHash: promptHash(j.prompt, j.negative), seed: j.seed, size: w, sha256: sha(bytes), placeholder, date: new Date().toISOString()});
      made++; out.log(`[portraits] ${n} -> ${n}.png ${w}x${h} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++; out.error(`[portraits] ${n} failed: ${e.message}`);
      if (e.kind === 'auth' || e.kind === 'quota') {out.error('[portraits] stopping: ' + e.kind); break}
    }
  }
  out.log(`[portraits] made ${made}, failed ${failed}. Review them, then: npm run art:accept -- <Name>`);
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(c => process.exit(c), e => {console.error(e.message); process.exit(1)});
