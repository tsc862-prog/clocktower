// Art check: the portrait pipeline against a mock Hugging Face router, no network and no token (`npm run artcheck`). Proves:
//   1. --dry-run needs no token and calls nothing; with no token a run stops (exit 2) and calls nothing.
//   2. A run writes one square PNG per seat and the Storyteller into the inbox with a record (model, prompt hash, seed), sends the
//      token only as a bearer to the router, builds the prompt from the brief plus the style, and never prints the token.
//   3. A second run skips what is there; --only and --force redraw just those; an unknown name is refused.
//   4. Failures: 401 and 402 stop the run at once, a 429 without a quota word is retried, a JPEG answer is refused.
//   5. art:accept moves a reviewed image to assets/portraits/, writes index.json and a CREDITS.md line (replaced on a second accept),
//      refuses a placeholder-made image, and --reject drops one. The inbox is git-ignored.
import http from 'node:http';
import {deflateSync as zlibSync} from 'node:zlib';
import {mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {mkTmp} from './tmp.mjs';
import {main as portraits} from './art/portraits.mjs';
import {main as accept} from './art/accept.mjs';
import {REPO_ROOT} from './art/lib.mjs';

let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const TOKEN = 'hf_mocktoken_1234567890';

// A solid square PNG, built by hand (zlib, crc32).
const crcT = Array.from({length: 256}, (_, n) => {let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0});
const crc = b => {let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0};
const chunk = (t, d) => {const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c])};
function png(w, h, shade = 90) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, shade); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function mockRouter() {
  const st = {mode: 'ok', seen: [], auths: [], n: 0, failTimes: 0};
  const server = http.createServer((q, r) => {
    if (q.method === 'GET' && q.url.startsWith('/img/')) {r.writeHead(200, {'content-type': 'image/png'}); return r.end(png(st.size || 512, st.size || 512, 40 + (++st.n % 100)))}
    if (q.method !== 'POST' || q.url !== '/fal-ai/fal-ai/flux/schnell') {r.writeHead(404); return r.end('{}')}
    let b = ''; q.on('data', c => b += c); q.on('end', () => {
      const body = JSON.parse(b); st.seen.push(body); st.auths.push(q.headers.authorization || '');
      const send = (code, o) => {r.writeHead(code, {'content-type': 'application/json'}); r.end(JSON.stringify(o))};
      st.size = body.image_size.width;
      if (st.mode === 'auth') return send(401, {error: 'Invalid token'});
      if (st.mode === 'quota') return send(402, {error: 'You have exceeded your monthly included credits'});
      if (st.mode === 'rate' && st.failTimes-- > 0) return send(429, {error: 'slow down'});
      if (st.mode === 'jpeg') {r.writeHead(200, {'content-type': 'image/jpeg'}); return r.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))}
      send(200, {images: [{url: `http://127.0.0.1:${server.address().port}/img/${st.seen.length}.png`}]});
    });
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  return {st, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(res => server.close(res))};
}

const quiet = () => {const lines = []; return {lines, log: s => lines.push(String(s)), error: s => lines.push(String(s))}};

async function main() {
  const M = await mockRouter();
  try {
    const rootDir = mkTmp('artcheck-');
    const env = {ART_ROOT: rootDir, HF_ROUTER_URL: M.url, ART_RETRY_MS: '10', PATH: process.env.PATH};
    const inbox = join(rootDir, 'assets', 'incoming', 'portraits');

    console.log('no token, dry run');
    let o = quiet();
    ok(await portraits(['--dry-run'], env, o) === 0 && M.st.seen.length === 0 && o.lines.some(l => /first request: POST .*fal-ai\/fal-ai\/flux\/schnell/.test(l)), '--dry-run prints the first request and calls nothing');
    o = quiet();
    ok(await portraits([], env, o) === 2 && M.st.seen.length === 0 && o.lines.some(l => /no HF_TOKEN/.test(l)), 'with no token the run stops (exit 2), no call');

    console.log('a run (placeholder briefs: no src/data/portraits.js in the temp root)');
    const E = {...env, HF_TOKEN: TOKEN};
    o = quiet();
    ok(await portraits(['--size', '512'], E, o) === 0, 'exit 0');
    const files = existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith('.png')).sort() : [];
    ok(files.length === 8 && files.includes('Storyteller.png') && files.includes('Odette.png'), `eight portraits in the inbox: ${files.join(', ')}`);
    const rec = JSON.parse(readFileSync(join(inbox, 'Odette.json'), 'utf8'));
    ok(rec.model === 'black-forest-labs/FLUX.1-schnell' && rec.licence === 'Apache-2.0' && /^[0-9a-f]{16}$/.test(rec.promptHash) && rec.size === 512 && rec.placeholder === true, 'the record names the model, licence, prompt hash, size, and says placeholder');
    ok(M.st.auths.every(a => a === 'Bearer ' + TOKEN), 'the token went only as a bearer to the router');
    ok(!o.lines.join('\n').includes(TOKEN), 'the token was not printed');
    ok(M.st.seen.every(b => b.image_size.width === 512 && b.image_size.height === 512 && /painted portrait/.test(b.prompt) && /PLACEHOLDER/.test(b.prompt)), 'each request is square 512 with the brief plus the style');
    ok(o.lines.some(l => /PLACEHOLDER/.test(l)), 'the run says it used placeholders');

    console.log('real briefs, skip, only, force');
    mkdirSync(join(rootDir, 'src', 'data'), {recursive: true}); writeFileSync(join(rootDir, 'package.json'), '{"type": "module"}');
    writeFileSync(join(rootDir, 'src', 'data', 'portraits.js'), "export const PORTRAIT_STYLE = 'inked style';\nexport const PORTRAITS = {Odette: {prompt: 'a clerk', negative: 'text'}, Bram: {prompt: 'a smith'}};\n");
    let n = M.st.seen.length; o = quiet();
    ok(await portraits([], E, o) === 0 && M.st.seen.length === n, 'a second run makes nothing (all there)');
    ok(await portraits(['--only', 'Odette', '--force', '--size', '768'], E, quiet()) === 0 && M.st.seen.length === n + 1 && M.st.seen.at(-1).prompt === 'a clerk, inked style' && M.st.seen.at(-1).image_size.width === 768, '--only Odette --force redraws just her at 768 with her brief plus the style');
    ok(await portraits(['--only', 'Nobody'], E, quiet()) === 2, 'an unknown name is refused');
    ok(await portraits(['--size', '100'], E, quiet()) === 2, 'a size other than 512 or 768 is refused');

    console.log('failures');
    const F = {...E, ART_ROOT: mkTmp('artcheck-f-')}; mkdirSync(join(F.ART_ROOT, 'src', 'data'), {recursive: true}); writeFileSync(join(F.ART_ROOT, 'package.json'), '{"type": "module"}');
    writeFileSync(join(F.ART_ROOT, 'src', 'data', 'portraits.js'), "export const PORTRAIT_STYLE = 's';\nexport const PORTRAITS = {A: {prompt: 'a'}, B: {prompt: 'b'}, C: {prompt: 'c'}};\n");
    M.st.mode = 'auth'; n = M.st.seen.length; o = quiet();
    ok(await portraits([], F, o) === 1 && M.st.seen.length === n + 1 && o.lines.some(l => /stopping: auth/.test(l)), 'a 401 stops the run after one call');
    M.st.mode = 'quota'; n = M.st.seen.length; o = quiet();
    ok(await portraits([], F, o) === 1 && M.st.seen.length === n + 1 && o.lines.some(l => /stopping: quota/.test(l)), 'a 402 (credits spent) stops the run after one call');
    M.st.mode = 'jpeg'; o = quiet();
    ok(await portraits(['--only', 'A'], F, o) === 1 && !existsSync(join(F.ART_ROOT, 'assets', 'incoming', 'portraits', 'A.png')), 'a JPEG answer is refused, nothing written');
    M.st.mode = 'rate'; M.st.failTimes = 2; n = M.st.seen.length;
    ok(await portraits(['--only', 'A'], F, quiet()) === 0 && M.st.seen.length === n + 3, 'a plain 429 is retried (two refusals, then the image)');
    M.st.mode = 'ok';

    console.log('accept');
    const R = {ART_ROOT: rootDir}, port = join(rootDir, 'assets', 'portraits');
    o = quiet();
    ok(accept(['Odette'], R, o) === 0 && existsSync(join(port, 'Odette.png')) && !existsSync(join(inbox, 'Odette.png')), 'Odette moves from the inbox to assets/portraits/');
    const idx = JSON.parse(readFileSync(join(port, 'index.json'), 'utf8'));
    ok(idx.version === 1 && idx.portraits.Odette && idx.portraits.Odette.file === 'Odette.png' && idx.portraits.Odette.model === 'black-forest-labs/FLUX.1-schnell' && /^[0-9a-f]{16}$/.test(idx.portraits.Odette.promptHash) && idx.portraits.Odette.date, 'index.json has the entry: file, model, prompt hash, date');
    let cr = readFileSync(join(rootDir, 'docs', 'CREDITS.md'), 'utf8');
    ok(/- Odette: generated .* with black-forest-labs\/FLUX\.1-schnell \(Apache-2\.0\)/.test(cr), 'docs/CREDITS.md has a line with the model and licence');
    ok(accept(['Bram'], R, quiet()) === 2, 'Bram was made from a placeholder brief (the first run): refused');
    await portraits(['--only', 'Bram', '--force'], E, quiet());
    ok(accept(['bram'], R, quiet()) === 0 && Object.keys(JSON.parse(readFileSync(join(port, 'index.json'), 'utf8')).portraits).join() === 'Odette,Bram', 'after a redraw from the real brief Bram is accepted (names are case-insensitive)');
    await portraits(['--only', 'Odette', '--force'], E, quiet()); accept(['Odette'], R, quiet());
    cr = readFileSync(join(rootDir, 'docs', 'CREDITS.md'), 'utf8');
    ok((cr.match(/- Odette: generated/g) || []).length === 1 && (cr.match(/- Bram: generated/g) || []).length === 1, 'a second accept replaces the credits line, it does not repeat it');
    await portraits(['--only', 'Odette', '--force'], E, quiet());
    ok(accept(['--reject', 'Odette'], R, quiet()) === 0 && !existsSync(join(inbox, 'Odette.png')) && existsSync(join(port, 'Odette.png')), '--reject drops the inbox image and leaves the accepted one');
    ok(accept(['--list'], R, o = quiet()) === 0 && /accepted: Odette, Bram/.test(o.lines.join('\n')), '--list shows what is accepted');

    console.log('the inbox is git-ignored');
    const g = spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', 'assets/incoming/portraits/Odette.png']);
    ok(g.status === 0, 'assets/incoming/ is in .gitignore');
  } finally {await M.close()}
  console.log(fails ? `\nartcheck: ${fails} failed` : '\nartcheck: all ok');
  process.exit(fails ? 1 : 0);
}
main().catch(e => {console.error(e); process.exit(1)});
