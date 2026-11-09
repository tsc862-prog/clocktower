// The town square as a table seen from above: the seven seat markers round it in seat order (clockwise from the top), each with the
// character's name round its rim and a shroud when dead, the ghost vote as a coin, the nominee and the nominator marked while a vote
// is open, each hand raised or kept down as its ballot lands, and the running tally in the middle. Beside each marker, what only
// the Storyteller (and the watcher) sees: the true role as its token, and under it the tokens that matter, as short words.
// While the day's rooms are open (the watch body's places: {square, rooms: [{id, name, size, seats, free}], open}), a seat away from
// the Square carries a tag with its room's name, the rooms sit off the table's edge as small discs with their occupants inside, and
// one line under the table says who is where ("Odette and Bram in the Snug; the Vestry and the Taproom empty"). When the rooms
// close, all three go.
// The drawings are src/ui/tokens.js; the owner's own images, when his local folder has them, src/ui/art.js.
import {esc, el} from './dom.js';
import {roleName, teamOf, voteView, tokenWord, SQUARE_TOKENS, seatNames} from './model.js';
import {seatMarker, handMarker, installDefs, roomDisc} from './tokens.js';
import {roleToken, ghostCoin, shroudArt} from './art.js';
import {portraitOf} from './portraits.js';

// The rooms while they are open, else null: {rooms, roomOf: seat -> room}
export function openRooms(w) {
  const p = w && w.places;
  if (!p || p.open !== true || !Array.isArray(p.rooms)) return null;
  const rooms = p.rooms.filter(r => r && r.id != null).map(r => ({...r, seats: Array.isArray(r.seats) ? r.seats : []})), roomOf = {};
  for (const r of rooms) for (const i of r.seats) roomOf[i] = r;
  return {rooms, roomOf};
}
const andJoin = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a.at(-1);
// "Odette and Bram in the Snug; the Vestry and the Taproom empty"
export function roomsLine(rooms, names = []) {
  if (!rooms.some(r => r.seats.length)) return 'Everyone is at the Square; the rooms stand empty';
  const parts = rooms.filter(r => r.seats.length).map(r => `${andJoin(r.seats.map(i => names[i] ?? `seat ${i}`))} in ${r.name || r.id}`);
  const empty = rooms.filter(r => !r.seats.length).map(r => r.name || r.id);
  if (empty.length) parts.push(`${andJoin(empty)} empty`);
  const s = parts.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function createSquare(root) {
  installDefs();
  root.classList.add('table-view');
  const ring = root.querySelector('.ring') || root.appendChild(el('div', {class: 'ring'}));
  const centre = root.querySelector('.centre') || ring.appendChild(el('div', {class: 'centre'}));
  const strip = root.querySelector('.rooms-strip') || root.appendChild(el('div', {class: 'rooms-strip'}));
  const seats = new Map();
  let speaking = null; // the seat whose voice is playing (src/ui/voice.js), 'storyteller', or null
  function seatHtml(s, v, names, room) {
    const hand = v ? v.hands[s.seat] : undefined, voter = v && v.open && v.voters.includes(s.seat);
    const marks = [];
    if (v && v.nominee === s.seat) marks.push('<span class="mark nominee">nominated</span>');
    if (v && v.nominator === s.seat) marks.push('<span class="mark nominator">nominates</span>');
    const handTxt = !v ? '' : hand === true ? `<span class="hand up" title="voted yes">${handMarker('up')}<span class="hw">yes</span></span>`
      : hand === false ? `<span class="hand down" title="voted no">${handMarker('down')}<span class="hw">no</span></span>`
      : voter ? `<span class="hand none" title="not voted yet">${handMarker('none')}</span>` : '';
    const ghost = s.alive ? '' : `<span class="ghost ${s.ghostVote ? 'unspent' : 'spent'}" title="${s.ghostVote ? 'ghost vote unspent' : 'ghost vote spent'}">${ghostCoin(s.ghostVote)}</span>`;
    const toks = s.tokens.filter(t => SQUARE_TOKENS.has(t.token)).map(t => {
      const w = t.token === 'master' && t.by != null ? `master of ${names[t.by]}` : t.token === 'is-the-drunk' ? 'drunk' : tokenWord(t);
      return `<span class="tok${t.active === false ? ' off' : ''}">${esc(w)}</span>`;
    }).join(' ');
    const believed = s.believed !== s.role ? ` <span class="believed">(thinks ${esc(roleName(s.believed))})</span>` : '';
    const team = teamOf(s.role) || '';
    return `<div class="marks">${marks.join(' ')} ${handTxt}</div>` +
      `<div class="pieces">${seatMarker(s.name, {dead: !s.alive, shroud: shroudArt(), portrait: portraitOf(s.name)})}` +
      `<span class="role-piece" title="Only the Storyteller and you see this">${roleToken(s.role, {name: roleName(s.role), team, title: roleName(s.role) + ' (' + team + ')'})}</span>${ghost}` +
      (room ? `<span class="away-tag" title="Away from the Square, in ${esc(room.name || room.id)}">${esc(room.name || room.id)}</span>` : '') + '</div>' +
      `<div class="life">${s.alive ? 'alive' : 'dead'}</div>` +
      `<div class="st"><span class="sees" title="Only the Storyteller and you see this">ST sees</span> <span class="role team-${esc(team)}">${esc(roleName(s.role))}</span>${believed}${toks ? '<br>' + toks : ''}</div>`;
  }
  function render({watch: w}) {
    root.dataset.empty = w ? 'no' : 'yes';
    const list = (w && w.grimoire && w.grimoire.seats) || [], n = list.length, v = voteView(w), names = seatNames(w), open = openRooms(w);
    list.forEach((s, i) => {
      let r = seats.get(s.seat);
      if (!r) {
        const a = (-90 + i * 360 / n) * Math.PI / 180;
        r = {node: el('div', {class: 'seat', dataset: {seat: String(s.seat)}}), h: null};
        r.node.style.left = (50 + 40 * Math.cos(a)).toFixed(2) + '%';
        r.node.style.top = (50 + 40 * Math.sin(a)).toFixed(2) + '%';
        ring.append(r.node); seats.set(s.seat, r);
      }
      const room = open ? open.roomOf[s.seat] || null : null;
      const h = seatHtml(s, v, names, room);
      if (h !== r.h) {r.node.innerHTML = h; r.h = h}
      r.node.className = 'seat' + (s.alive ? '' : ' dead') + (v && v.nominee === s.seat ? ' is-nominee' : '') + (v && v.nominator === s.seat ? ' is-nominator' : '') + (speaking === s.seat ? ' speaking' : '') + (room ? ' away' : '');
    });
    for (const [k, r] of seats) if (!list.some(s => s.seat === k)) {r.node.remove(); seats.delete(k)}
    let c;
    if (!w) c = '<div class="quiet">No game yet</div>';
    else if (v && v.open) c = `<div class="vote open"><div class="what">${esc(names[v.nominator])} nominates ${esc(names[v.nominee])}</div>` +
      `<div class="tally"><b>${v.yes}</b> yes of <b>${v.need}</b> needed</div>` +
      `<div class="bar">${v.block && v.block.seat != null ? `${esc(names[v.block.seat])} is on the block with ${v.block.votes}: beat it to replace` : 'nobody on the block yet'}</div>` +
      `<div class="left">${v.cast} of ${v.voters.length} hands in${v.waiting.length ? `; waiting on ${esc(v.waiting.map(i => names[i]).join(', '))}` : ''}</div></div>`;
    else if (v) c = `<div class="vote closed"><div class="what">Last vote: ${esc(names[v.nominee])}, nominated by ${esc(names[v.nominator])}</div>` +
      `<div class="tally"><b>${v.yes}</b> of <b>${v.need}</b> needed</div><div class="bar">${v.block && v.block.seat != null ? `${esc(names[v.block.seat])} is on the block with ${v.block.votes}` : 'nobody is on the block'}</div></div>`;
    else c = `<div class="quiet">${esc(w.winner ? w.winner.text : w.phase === 'night' ? `Night ${w.night}` : w.phase === 'day' ? `Day ${w.day}` : '')}</div>`;
    if (centre._h !== c) {centre.innerHTML = c; centre._h = c}
    // the rooms off the table's edge, and who is where in one line
    const sh = !open ? '' : '<div class="rooms">' + open.rooms.map(r => {
      const who = r.seats.map(i => ({name: names[i] ?? `seat ${i}`, portrait: portraitOf(names[i])}));
      const count = r.size != null ? `${r.seats.length} of ${r.size}` : String(r.seats.length);
      return `<div class="room${r.seats.length ? '' : ' empty'}" data-room="${esc(r.id)}">${roomDisc(r, who)}` +
        `<div class="room-name">${esc(r.name || r.id)}</div><div class="room-count">${r.seats.length ? esc(count) : 'empty'}</div></div>`;
    }).join('') + `</div><p class="rooms-line">${esc(roomsLine(open.rooms, names))}</p>`;
    if (strip._h !== sh) {strip.innerHTML = sh; strip._h = sh}
    strip.hidden = !open;
  }
  // light the seat whose clip is playing (the centre for the Storyteller); patched in place, nothing else redrawn
  function setSpeaking(who) {
    speaking = who;
    for (const [k, r] of seats) r.node.classList.toggle('speaking', k === who);
    centre.classList.toggle('st-speaking', who === 'storyteller');
  }
  return {render, setSpeaking, get speaking() {return speaking}};
}
