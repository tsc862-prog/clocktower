// The portrait pipeline's shared parts (ported in spirit from Eldmoor's scripts/art/, cut down to one job: a square painted
// portrait per seat, text to image, through Hugging Face Inference Providers). Node only; nothing under src/ imports it.
//   HF_TOKEN       read from the environment or from .env / .env.local at the repo root (only that line); sent only to the router,
//                  never printed, never to the browser.
//   HF_ROUTER_URL  default https://router.huggingface.co (a mock in the check)
//   ART_ROOT       where assets/ and docs/ live (default the repo; the check points it at a temp folder)
//   ART_MODEL      default black-forest-labs/FLUX.1-schnell (Apache-2.0); ART_PROVIDER fal-ai (default) or hf-inference;
//                  ART_PROVIDER_ID the provider's own id (default fal-ai/flux/schnell for fal-ai)
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const root = (env = process.env) => env.ART_ROOT || REPO_ROOT;
export const incomingDir = (env = process.env) => join(root(env), 'assets', 'incoming', 'portraits');
export const portraitsDir = (env = process.env) => join(root(env), 'assets', 'portraits');
export const SIZES = [512, 768];
export const sha = b => createHash('sha256').update(b).digest('hex');
export const promptHash = (prompt, negative = '') => sha(Buffer.from(prompt + '\u0000' + negative)).slice(0, 16);

export class ArtError extends Error {constructor(kind, msg, status) {super(msg); this.kind = kind; this.status = status}}

export function hfToken(env = process.env) {
  if (env.HF_TOKEN) return env.HF_TOKEN;
  for (const f of ['.env.local', '.env']) {
    const p = join(root(env), f); if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {const m = line.match(/^\s*HF_TOKEN\s*=\s*(.*?)\s*$/); if (m && m[1]) return m[1].replace(/^["']|["']$/g, '')}
  }
  return '';
}

export function modelOf(env = process.env) {
  const provider = env.ART_PROVIDER || 'fal-ai';
  const repo = env.ART_MODEL || 'black-forest-labs/FLUX.1-schnell';
  return {repo, provider, providerId: env.ART_PROVIDER_ID || (provider === 'fal-ai' ? 'fal-ai/flux/schnell' : repo), licence: env.ART_LICENCE || 'Apache-2.0'};
}

// The seats' briefs: src/data/portraits.js (the lore-keeper's) when it exists, else a placeholder per seat, marked.
export const PLACEHOLDER_NAMES = ['Odette', 'Bram', 'Ines', 'Corwin', 'Thea', 'Fitch', 'Yusuf', 'Storyteller'];
export async function briefs(env = process.env) {
  try {
    const m = await import(pathToFileURL(join(root(env), 'src', 'data', 'portraits.js')).href);
    if (m.PORTRAITS && typeof m.PORTRAITS === 'object') return {style: String(m.PORTRAIT_STYLE || ''), portraits: m.PORTRAITS, placeholder: false};
  } catch {}
  return {style: 'painted portrait, muted palette, soft lamplight, plain dark background, head and shoulders', placeholder: true,
    portraits: Object.fromEntries(PLACEHOLDER_NAMES.map(n => [n, {prompt: `PLACEHOLDER brief (src/data/portraits.js is missing): a character called ${n}, a person of a small town at a long table`}]))};
}

// The request for one image. fal-ai takes its own body; hf-inference the text-to-image task spec.
export function buildRequest({model, prompt, negative, size, seed, env = process.env}) {
  const router = (env.HF_ROUTER_URL || 'https://router.huggingface.co').replace(/\/$/, '');
  const flux = /flux/i.test(model.repo); // FLUX takes no negative prompt
  if (model.provider === 'hf-inference') return {url: `${router}/hf-inference/models/${model.repo}`, body: {inputs: prompt, parameters: {width: size, height: size, seed, ...(negative && !flux ? {negative_prompt: negative} : {})}}};
  return {url: `${router}/${model.provider}/${model.providerId}`, body: {prompt, image_size: {width: size, height: size}, seed, num_images: 1, output_format: 'png', ...(negative && !flux ? {negative_prompt: negative} : {})}};
}

export const isPng = b => !!b && b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
export const pngSize = b => ({w: b.readUInt32BE(16), h: b.readUInt32BE(20)});

async function imageBytes(r) {
  const ct = r.headers.get('content-type') || '';
  if (ct.startsWith('image/')) return Buffer.from(await r.arrayBuffer());
  let j; try {j = await r.json()} catch {throw new ArtError('image', 'the answer is neither an image nor JSON')}
  const it = (j.images && j.images[0]) || (j.data && j.data[0]) || j;
  const url = typeof it === 'string' ? it : it.url, b64 = it.b64_json || it.image || it.base64;
  if (url && url.startsWith('data:')) return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  if (url) {const g = await fetch(url); if (!g.ok) throw new ArtError('transient', `image download failed: HTTP ${g.status}`, g.status); return Buffer.from(await g.arrayBuffer())}
  if (b64) return Buffer.from(b64, 'base64');
  throw new ArtError('image', 'no image in the answer');
}

const QUOTA = /quota|credit|limit|exceeded|billing|payment/i;
// One call: the PNG bytes, or an ArtError whose kind says what to do (auth, quota: stop the run; transient: retry; image, model: this one failed).
export async function fetchImage({req, token, timeoutMs = 180000}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try {r = await fetch(req.url, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'image/png, application/json'}, body: JSON.stringify(req.body), signal: ac.signal})}
  catch (e) {throw new ArtError('transient', e.name === 'AbortError' ? 'timed out' : 'network: ' + e.message)}
  finally {clearTimeout(t)}
  if (!r.ok) {
    const txt = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    if (r.status === 401) throw new ArtError('auth', 'HTTP 401: bad or missing HF_TOKEN', 401);
    if (r.status === 402) throw new ArtError('quota', 'HTTP 402: the credits are spent ' + txt, 402);
    if (r.status === 403) throw new ArtError(QUOTA.test(txt) ? 'quota' : 'auth', 'HTTP 403: ' + (QUOTA.test(txt) ? 'allowance refused ' : 'the token lacks the "Inference Providers" permission ') + txt, 403);
    if (r.status === 429) throw new ArtError(QUOTA.test(txt) ? 'quota' : 'transient', 'HTTP 429 ' + txt, 429);
    if (r.status >= 500) throw new ArtError('transient', `HTTP ${r.status} ${txt}`, r.status);
    throw new ArtError('model', `HTTP ${r.status} ${txt}`, r.status);
  }
  const bytes = await imageBytes(r);
  if (!isPng(bytes)) throw new ArtError('image', 'the provider answered an image that is not a PNG (set ART_PROVIDER / ART_MODEL to one that answers PNG)');
  return bytes;
}

export function writeJson(file, obj) {mkdirSync(dirname(file), {recursive: true}); const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n'); renameSync(tmp, file)}
export function readJson(file, dflt) {try {return JSON.parse(readFileSync(file, 'utf8'))} catch {return dflt}}
export function parseArgs(argv, valued = []) {const o = {_: []}; for (let i = 0; i < argv.length; i++) {const a = argv[i]; if (a.startsWith('--')) {const k = a.slice(2); if (valued.includes(k)) {o[k] = argv[++i]} else o[k] = true} else o._.push(a)} return o}
