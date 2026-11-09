// Our own tokens, hand-built SVG, no images: one file to restyle. Everything the page draws as a token comes from here:
//   roleToken(id)        a round token per role: a simple two-colour icon and the role's name on the lower arc; the rim tells the
//                        team (townsfolk, outsider, minion, demon)
//   seatMarker(name)     a seat at the table: the character's name around a disc, its initial in the middle; a shroud on the dead
//   reminderToken(t)     a small disc beside a seat in the grimoire (poisoned, drunk, protected, master, red herring, dead, ...)
//   ghostCoin(unspent)   the ghost vote, a small coin
//   handMarker(state)    a hand in a vote: 'up' raised, 'down' kept down, 'none' still to cast
// Colours live in styles/page.css as custom properties (--rim-townsfolk, --rim-outsider, --rim-minion, --rim-demon, --tk-face,
// --tk-ink, --tk-shroud, ...): the icons below draw with two classes only, `a` (the ink) and `b` (the accent: the rim's colour), and
// `s`/`sb` for strokes in the same two colours. Every icon sits in a 100 x 100 box, inside the face (centre 50,44, room down to y 62;
// the name runs along the arc below). Icons are ours: simple shapes, readable at 48 px; nothing from the official game's art.
import {esc} from './dom.js';

export const ROLE_ICONS = {
  // townsfolk
  washerwoman: '<path class="a" d="M28 40h44l-6 18H34z"/><circle class="b" cx="40" cy="32" r="5"/><circle class="b" cx="52" cy="27" r="4"/><circle class="b" cx="61" cy="33" r="3"/>',
  librarian: '<path class="a" d="M49 31c-7-5-15-6-22-4v28c7-2 15-1 22 4zM51 31c7-5 15-6 22-4v28c-7-2-15-1-22 4z"/><path class="sb" d="M50 31v28"/>',
  investigator: '<circle class="s" cx="45" cy="38" r="11"/><circle class="b" cx="45" cy="38" r="6"/><path class="s" d="M53 46l13 13" style="stroke-width:7"/>',
  chef: '<path class="a" d="M37 46c-9-1-10-14 0-15 1-8 12-10 15-4 5-6 15-3 13 5 9 1 9 14 0 14z"/><path class="b" d="M37 48h26v9H37z"/>',
  empath: '<path class="a" d="M50 60C29 47 27 30 38 27c5-1 9 2 12 7 3-5 7-8 12-7 11 3 9 20-12 33z"/><path class="b" d="M42 35c-4 1-5 6-3 9 1-4 3-6 6-7z"/>',
  'fortune-teller': '<circle class="a" cx="50" cy="38" r="14"/><circle class="b" cx="45" cy="33" r="4"/><path class="b" d="M37 60h26l-4-8H41z"/>',
  undertaker: '<path class="a" d="M47 21h6v24h-6z"/><path class="a" d="M42 20h16v5H42z"/><path class="b" d="M40 44h20l-2 12-8 5-8-5z"/>',
  monk: '<path class="a" d="M50 23c-9 0-13 8-13 15 0 5-4 15-7 21h40c-3-6-7-16-7-21 0-7-4-15-13-15z"/><ellipse class="b" cx="50" cy="38" rx="6" ry="8"/>',
  ravenkeeper: '<path class="a" d="M28 47c6-11 18-15 29-13l12-5-5 9c2 9-5 17-15 19l-7 7-2-7c-6 0-10-4-12-10z"/><circle class="b" cx="58" cy="38" r="3"/>',
  virgin: '<path class="a" d="M50 22c7 8 7 17 0 24-7-7-7-16 0-24z"/><path class="a" d="M50 46c-4-9-12-13-21-11 2 9 11 13 21 11zM50 46c4-9 12-13 21-11-2 9-11 13-21 11z"/><path class="b" d="M48 46h4v14h-4z"/>',
  slayer: '<path class="s" d="M31 59l31-31"/><path class="a" d="M68 22l-14 3 11 11z"/><path class="b" d="M30 52l-4 10 10-4zM36 58l-4 6 7-3z"/>',
  soldier: '<path class="a" d="M50 21l19 6v13c0 12-8 19-19 23-11-4-19-11-19-23V27z"/><path class="b" d="M47 29h6v26h-6zM38 38h24v6H38z"/>',
  mayor: '<path class="s" d="M33 24c4 15 10 20 17 20s13-5 17-20"/><circle class="b" cx="50" cy="51" r="9"/><circle class="a" cx="50" cy="51" r="4"/>',
  // outsiders
  butler: '<path class="a" d="M36 53c0-11 6-17 14-17s14 6 14 17z"/><path class="b" d="M30 53h40v5H30z"/><circle class="a" cx="50" cy="32" r="3"/>',
  drunk: '<path class="a" d="M35 31h23v28H35z"/><path class="s" d="M58 37h5c5 0 5 15 0 15h-5"/><path class="b" d="M33 25c3-5 9-3 11-1 3-4 10-3 11 1 4 0 5 6 0 7H33c-4-1-4-7 0-7z"/>',
  recluse: '<path class="a" d="M32 44l18-16 18 16v15H32z"/><path class="b" d="M46 47h8v12h-8z"/><path class="sb" d="M62 34v-8"/>',
  saint: '<ellipse class="sb" cx="50" cy="25" rx="12" ry="4"/><circle class="a" cx="50" cy="38" r="7"/><path class="a" d="M37 60c0-9 6-14 13-14s13 5 13 14z"/>',
  // minions
  poisoner: '<path class="a" d="M45 21h10v9l7 9v20H38V39l7-9z"/><path class="b" d="M50 41c-4 5-5 8-5 10a5 5 0 0 0 10 0c0-2-1-5-5-10z"/>',
  spy: '<path class="a" d="M26 42c9-10 17-15 24-15s15 5 24 15c-9 10-17 15-24 15s-15-5-24-15z"/><circle class="b" cx="50" cy="42" r="8"/><circle class="a" cx="50" cy="42" r="3"/>',
  'scarlet-woman': '<circle class="b" cx="50" cy="35" r="11"/><path class="a" d="M48 45h4v16h-4z"/><path class="a" d="M52 53c5-5 11-5 14-2-5 5-10 5-14 2zM48 50c-5-4-11-4-13-1 4 4 9 4 13 1z"/>',
  baron: '<path class="a" d="M38 24h24v24H38z"/><path class="b" d="M38 41h24v6H38z"/><path class="a" d="M29 48h42v7H29z"/>',
  // the demon
  imp: '<path class="a" d="M33 22l11 16-8 4zM67 22l-11 16 8 4z"/><circle class="a" cx="50" cy="47" r="14"/><path class="b" d="M42 44l6 3-6 2zM58 44l-6 3 6 2z"/>',
};

// Reminder tokens: small discs beside a seat in the grimoire (the engine's token ids; 'dead' is the page's own, for a dead seat).
export const REMINDER_ICONS = {
  poisoned: '<path class="a" d="M50 20c-11 15-15 23-15 29a15 15 0 0 0 30 0c0-6-4-14-15-29z"/>',
  'is-the-drunk': '<path class="a" d="M34 32h24v30H34z"/><path class="s" d="M58 38h6c5 0 5 16 0 16h-6"/>',
  protected: '<path class="a" d="M50 18l22 7v15c0 14-10 22-22 26-12-4-22-12-22-26V25z"/>',
  master: '<path class="a" d="M28 60l4-30 10 12 8-18 8 18 10-12 4 30z"/>',
  'red-herring': '<path class="a" d="M24 44c10-12 26-14 38-6l12-8v28l-12-8c-12 8-28 6-38-6z"/><circle class="b" cx="36" cy="42" r="3"/>',
  dead: '<path class="a" d="M30 18h40v46L50 52 30 64z"/>',
  executed: '<path class="s" d="M32 26l36 36M68 26L32 62" style="stroke-width:9"/>',
  'no-ability': '<circle class="s" cx="50" cy="44" r="18"/><path class="s" d="M37 31l26 26"/>',
  'registers-as': '<path class="a" d="M26 34c8-4 16-4 24 2 8-6 16-6 24-2 0 14-6 22-14 22-5 0-8-4-10-8-2 4-5 8-10 8-8 0-14-8-14-22z"/>',
  'is-the-demon': '<path class="a" d="M30 22l12 18-9 5zM70 22L58 40l9 5z"/><circle class="a" cx="50" cy="52" r="12"/>',
};

// Arcs the names run along, defined once per page (installDefs) and referenced by every token.
const DEFS = '<defs><path id="ct-arc-low" d="M18 50a32 32 0 0 0 64 0"/><path id="ct-arc-seat" d="M15 50a35 35 0 1 1 70 0a35 35 0 1 1 -70 0"/></defs>';
export function installDefs(doc = globalThis.document) {
  if (!doc || !doc.body || doc.getElementById('ct-defs')) return;
  const box = doc.createElement('div');
  box.setAttribute('id', 'ct-defs'); box.setAttribute('aria-hidden', 'true'); box.className = 'token-defs';
  box.innerHTML = `<svg width="0" height="0" focusable="false">${DEFS}</svg>`;
  doc.body.append(box);
}

const fit = name => name.length > 13 ? 7.5 : name.length > 10 ? 9 : 10.5; // font size on the arc, by the name's length

// roleToken('imp', {name: 'Imp', team: 'demon'}) -> <svg class="token role-token team-demon">
export function roleToken(id, {name = id, team = '', title = '', cls = ''} = {}) {
  const icon = ROLE_ICONS[id] || `<text class="initial" x="50" y="52" text-anchor="middle">${esc(String(name).slice(0, 1))}</text>`;
  return `<svg class="token role-token team-${esc(team)}${cls ? ' ' + cls : ''}" viewBox="0 0 100 100" data-role="${esc(id)}" role="img" aria-label="${esc(name)}">` +
    (title ? `<title>${esc(title)}</title>` : '') +
    `<circle class="tk-rim" cx="50" cy="50" r="48"/><circle class="tk-face" cx="50" cy="50" r="41"/><g class="icon">${icon}</g>` +
    `<text class="tk-name" style="font-size:${fit(name)}px"><textPath href="#ct-arc-low" startOffset="50%" text-anchor="middle">${esc(name)}</textPath></text></svg>`;
}

// seatMarker('Odette', {dead}) -> the seat's disc at the table, the name around its rim, a shroud over it when dead
export function seatMarker(name, {dead = false} = {}) {
  return `<svg class="token seat-marker${dead ? ' is-dead' : ''}" viewBox="0 0 100 100" role="img" aria-label="${esc(name)}${dead ? ', dead' : ''}">` +
    `<circle class="sm-rim" cx="50" cy="50" r="48"/><circle class="sm-face" cx="50" cy="50" r="27"/>` +
    `<text class="sm-initial" x="50" y="60" text-anchor="middle">${esc(String(name).slice(0, 1))}</text>` +
    `<text class="name sm-name"><textPath href="#ct-arc-seat" startOffset="25%" text-anchor="middle">${esc(name)}</textPath></text>` +
    (dead ? '<path class="shroud" d="M38 25h24v40L50 56 38 65z"/>' : '') + '</svg>';
}

// reminderToken('poisoned', {title: 'poisoned · by Odette', off}) -> a small disc
export function reminderToken(token, {title = '', off = false, label = ''} = {}) {
  const icon = REMINDER_ICONS[token] || `<text class="initial" x="50" y="56" text-anchor="middle">${esc(String(token).slice(0, 1).toUpperCase())}</text>`;
  return `<svg class="token reminder-token rem-${esc(token)}${off ? ' off' : ''}" viewBox="0 0 100 100" role="img" aria-label="${esc(label || token)}">` +
    (title ? `<title>${esc(title)}</title>` : '') + `<circle class="rm-face" cx="50" cy="50" r="46"/><g class="icon">${icon}</g></svg>`;
}

export const ghostCoin = unspent => `<svg class="token ghost-coin ${unspent ? 'unspent' : 'spent'}" viewBox="0 0 100 100" role="img" aria-label="${unspent ? 'ghost vote unspent' : 'ghost vote spent'}">` +
  '<circle class="gc-rim" cx="50" cy="50" r="46"/><path class="gc-ghost" d="M30 76V46a20 20 0 0 1 40 0v30l-7-6-6 6-7-6-7 6-6-6z"/><circle class="gc-eye" cx="43" cy="46" r="4"/><circle class="gc-eye" cx="57" cy="46" r="4"/></svg>';

export function handMarker(state) {
  if (state === 'none') return '<svg class="token hand-marker none" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30"/></svg>';
  return `<svg class="token hand-marker ${state === 'up' ? 'up' : 'down'}" viewBox="0 0 100 100" aria-hidden="true"><g${state === 'up' ? '' : ' transform="rotate(180 50 50)"'}>` +
    '<rect x="34" y="46" width="34" height="38" rx="11"/><rect x="34" y="22" width="8" height="32" rx="4"/><rect x="43" y="14" width="8" height="38" rx="4"/>' +
    '<rect x="52" y="16" width="8" height="36" rx="4"/><rect x="61" y="24" width="7" height="30" rx="3.5"/><rect x="20" y="46" width="8" height="24" rx="4" transform="rotate(-35 24 58)"/>' +
    '</g></svg>';
}
