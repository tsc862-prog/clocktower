// The owner's own token images, from a local folder that is never committed (public/tokens-local/, git-ignored; its README says
// what to drop there). The repo draws every token itself (src/ui/tokens.js); when a PNG or WebP named by the id exists there it
// takes that token's place everywhere it shows (the square, the grimoire). One probe per id per page load, remembered: until a
// probe answers, and for good when it fails, the drawn token stays, so nothing flickers.
//   probeArt({load})     looks for /tokens-local/<id>.png, then <id>.webp (the first that loads wins), for every role, the shroud,
//                        the ghost vote and each reminder, once per page load; resolves
//                        with the number of role images found. load(url) -> Promise<boolean> (the browser's Image by default)
//   roleToken, reminderToken, ghostCoin   the drawn token, or the image when one was found
//   shroudArt()          the shroud image's address, or null (the seat marker draws its own shroud then)
//   artCount()           role images found, of ROLE_IDS.length
import {SCRIPT} from '../data/script.js';
import {roleToken as drawnRole, reminderToken as drawnReminder, ghostCoin as drawnGhost, REMINDER_ICONS} from './tokens.js';
import {esc} from './dom.js';

export const ART_DIR = '/tokens-local/';
export const ROLE_IDS = SCRIPT.roles.map(r => r.id);
export const EXTRA_IDS = ['shroud', 'ghost-vote', ...Object.keys(REMINDER_ICONS)];
export const ART_KINDS = ['png', 'webp'];
const fileUrl = (id, kind) => ART_DIR + encodeURIComponent(id) + '.' + kind;

const found = new Map(); // id -> the address of the image that loaded | false (none); missing: not answered yet
export const artUrl = id => found.get(id) || null;
let probing = null;

// The browser's way: an Image either decodes or fails (a missing file may come back as the dev server's HTML page: it fails too).
export const imageLoad = url => new Promise(res => {
  if (typeof Image !== 'function') return res(false);
  const i = new Image();
  i.onload = () => res(i.naturalWidth > 0);
  i.onerror = () => res(false);
  i.src = url;
});

export function probeArt({load = imageLoad, ids = [...ROLE_IDS, ...EXTRA_IDS]} = {}) {
  if (probing) return probing;
  const one = async id => {
    for (const k of ART_KINDS) {
      const url = fileUrl(id, k);
      let ok = false; try {ok = (await load(url)) === true} catch {}
      if (ok) {found.set(id, url); return}
    }
    found.set(id, false);
  };
  probing = Promise.all(ids.map(one)).then(() => artCount());
  return probing;
}
export function resetArt() {found.clear(); probing = null} // for the smoke: a fresh page load
export const hasArt = id => typeof found.get(id) === 'string';
export const artCount = () => ROLE_IDS.filter(hasArt).length;
export const artNote = () => {const n = artCount(); return n ? `local art: ${n} of ${ROLE_IDS.length} tokens` : ''};

export function roleToken(id, opts = {}) {
  if (!hasArt(id)) return drawnRole(id, opts);
  const {name = id, team = '', title = '', cls = ''} = opts;
  return `<img class="token role-token art team-${esc(team)}${cls ? ' ' + cls : ''}" src="${esc(artUrl(id))}" data-role="${esc(id)}" alt="${esc(name)}"${title ? ` title="${esc(title)}"` : ''} draggable="false">`;
}
export function reminderToken(token, opts = {}) {
  if (!hasArt(token)) return drawnReminder(token, opts);
  const {title = '', off = false, label = ''} = opts;
  return `<img class="token reminder-token art rem-${esc(token)}${off ? ' off' : ''}" src="${esc(artUrl(token))}" alt="${esc(label || token)}"${title ? ` title="${esc(title)}"` : ''} draggable="false">`;
}
export function ghostCoin(unspent) {
  if (!hasArt('ghost-vote')) return drawnGhost(unspent);
  return `<img class="token ghost-coin art ${unspent ? 'unspent' : 'spent'}" src="${esc(artUrl('ghost-vote'))}" alt="${unspent ? 'ghost vote unspent' : 'ghost vote spent'}" draggable="false">`;
}
export const shroudArt = () => artUrl('shroud');
