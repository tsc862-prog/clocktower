// Portraits of our own for the seats and the Storyteller, generated and reviewed (npm run art:portraits, then art:accept) into
// assets/portraits/ with an index the page reads once per page load: assets/portraits/index.json, either
//   {"version": 1, "portraits": {"Odette": {"file": "Odette.png", ...}, "Storyteller": {...}}}    (the accept script's shape)
// or {"Odette": {"file": "assets/portraits/odette.png"}, ...}. A file name alone is under assets/portraits/. No index (or a broken
// one) and the page carries on with the initials. Vite's dev server (npm run up) serves assets/ from the project root as it is.
export const PORTRAIT_INDEX = '/assets/portraits/index.json';
const DIR = '/assets/portraits/';

let map = {}, loading = null;
export function portraitUrl(file) {
  const f = String(file || '').replace(/\\/g, '/');
  if (!f || /^[a-z]+:/i.test(f) || f.includes('..')) return null; // only files of our own folder
  if (f.startsWith('/')) return f;
  if (f.startsWith('assets/')) return '/' + f;
  return DIR + f;
}
// -> {name: url}
export function readIndex(idx) {
  const list = idx && typeof idx === 'object' ? (idx.portraits && typeof idx.portraits === 'object' ? idx.portraits : idx) : {};
  const out = {};
  for (const [name, e] of Object.entries(list)) {
    const url = portraitUrl(typeof e === 'string' ? e : e && e.file);
    if (url && name !== 'version') out[name] = url;
  }
  return out;
}
const pageFetch = (...a) => globalThis.fetch(...a);
export function loadPortraits({fetchImpl = pageFetch} = {}) {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await fetchImpl(PORTRAIT_INDEX, {cache: 'no-cache'});
      if (!r || !r.ok) return map;
      map = readIndex(await r.json()); // a missing file may come back as the dev server's HTML page: json() throws, no portraits
    } catch {}
    return map;
  })();
  return loading;
}
export function resetPortraits() {map = {}; loading = null} // for the smoke: a fresh page load
export const portraitOf = name => (name != null && map[name]) || null;
export const portraitCount = () => Object.keys(map).length;
