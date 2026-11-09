// The People view (#77): the characters are the main screen. A stage of seven portrait cards round the table in seat order
// (clockwise from the top, so the two whisper neighbours of a seat sit either side of it), the Storyteller's portrait apart on the
// left with its latest words beside it, and under the stage a strip of the last few lines.
//   a card       the portrait (assets/portraits/, the initial without one), the name, alive or shrouded, the ghost-vote coin, the true
//                role small in a corner (the watcher's; the "roles" switch on the game bar hides them), the room's name when away
//   the speaker  the newest line said (with the voice on: the line whose clip plays, then the last one played) lights its card and
//                sits beside the face as a caption until the next line; a whisper says to whom and that the table did not hear it;
//                a line said in a room carries its place. When a nomination, a vote or a phase comes after it, it steps back (dimmed)
//   a vote       the nominee and the nominator ringed and labelled, each voter's hand on their card as the ballot lands, the tally
//                and its bar in the middle of the table; the result flashed on the nominee once the vote closes; who is on the block
//   the night    the stage dims, the Storyteller's card wakes with what it does tonight (what only it and the watcher see), the seat it
//                has woken glows faintly; deaths shroud a card where it sits; at dawn the dawn and its narration show large in the middle
// Cards are keyed by seat and patched only when their HTML changes; the strip is keyed by event id. Nothing here acts for a seat.
import {esc, el, keyedRows} from './dom.js';
import {roleName, teamOf, voteView, seatNames, clockText} from './model.js';
import {handMarker, installDefs, cardShroud} from './tokens.js';
import {roleToken, ghostCoin, shroudArt} from './art.js';
import {portraitOf} from './portraits.js';
import {openRooms} from './square.js';
import {talkLine, roomNames} from './talk.js';

export const RECENT_N = 8; // lines in the strip under the stage
const STAGE_LINES = new Set(['say', 'whisper', 'narration', 'dawn']); // a line that takes the stage
const STEPS_BACK = new Set(['nomination', 'vote', 'execution', 'no-execution', 'phase', 'night', 'win']); // after these the caption dims
const RECENT = new Set(['say', 'whisper', 'narration', 'dawn', 'night', 'nomination', 'vote', 'execution', 'no-execution', 'slayer-shot', 'virgin', 'death', 'win']);
const ST_WORDS = new Set(['narration', 'dawn', 'night', 'win', 'execution', 'no-execution', 'virgin', 'slayer-shot']);
const LEAVES = new Set(['nomination', 'night', 'win']); // after these the caption leaves the stage altogether
const TALK_AFTER = new Set(['say', 'whisper', 'pass', 'nomination']);

// Where seat i of n sits on the ring, as a direction from the middle (cos, sin), clockwise from the top, and on which side of its card
// the caption goes (towards the middle).
export function seatPlace(i, n) {
  const a = (-90 + i * 360 / n) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return {c, s, x: 50 + 39 * c, y: 50 + 37 * s, side: c > 0.2 ? 'l' : 'r'};
}

// The stage's geometry (#79), in pixels of the table it is given, so it fits any window: the largest card that lets the ring stand
// inside the table with no card on another and room left in the middle; the middle is the free box inside the ring, and what is
// drawn there is held to it (its own size and its own scroll), never over a face. Measured from the table's box, height first.
//   label    the name and alive/dead under the face: the name's size follows the card
//   pad      what a card shows past its box: a speaker's face grows, the nominee's tag above, hands and tokens on the corners
export const cardLabel = cw => {const namePx = Math.round(Math.min(26, Math.max(16, cw * 0.13))); return {namePx, label: Math.round(namePx * 1.2 + 6 + 18)}};
const cardPad = cw => ({x: Math.round(cw * 0.08 + 20), y: Math.round(cw * 0.1 + 14)});
const hits = (a, b, gap = 0) => a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap;

// n points round an ellipse at equal distances along its edge, clockwise from the top: on a wide table the seats spread along the long
// sides instead of bunching at the ends.
function ellipseSteps(rx, ry, n) {
  const K = 720, len = [0];
  const pt = k => {const a = (-90 + k * 360 / K) * Math.PI / 180; return [rx * Math.cos(a), ry * Math.sin(a)]};
  for (let k = 1; k <= K; k++) {const [x0, y0] = pt(k - 1), [x1, y1] = pt(k); len.push(len[k - 1] + Math.hypot(x1 - x0, y1 - y0))}
  const out = [];
  for (let i = 0, k = 0; i < n; i++) {
    const want = len[K] * i / n;
    while (k < K && len[k + 1] <= want) k++;
    const a = (-90 + k * 360 / K) * Math.PI / 180;
    out.push({c: Math.cos(a), s: Math.sin(a)});
  }
  return out;
}

function ring(w, h, seats, cw) {
  const {namePx, label} = cardLabel(cw), ch = cw + label, pad = cardPad(cw), n = seats.length;
  const rx = Math.min(w * 0.39, w / 2 - cw / 2 - pad.x), ry = h / 2 - ch / 2 - pad.y;
  if (rx <= 0 || ry <= 0) return null;
  const pos = {}, boxes = [], at = ellipseSteps(rx, ry, n);
  seats.forEach((seat, i) => {
    const p = at[i], x = w / 2 + rx * p.c, y = h / 2 + ry * p.s;
    pos[seat] = {x: Math.round(x), y: Math.round(y), side: p.c > 0.2 ? 'l' : 'r'};
    boxes.push({seat, x, y, l: x - cw / 2, r: x + cw / 2, t: y - ch / 2, b: y + ch / 2, pad});
  });
  return {cw, ch, namePx, pos, boxes};
}

// The free box in the middle of a ring, centred left to right: of the boxes between the cards' edges, the largest with no card in it.
export function freeMiddle(w, h, boxes, gap = 14) {
  const tops = [0, ...boxes.map(b => b.b)].filter(t => t < h / 2), bottoms = [h, ...boxes.map(b => b.t)].filter(b => b > h / 2);
  let best = {x: Math.round(w / 2), y: Math.round(h / 2), w: 0, h: 0}, area = -1;
  for (const t0 of tops) for (const b0 of bottoms) {
    const top = t0 + gap, bottom = b0 - gap;
    if (bottom <= top) continue;
    const near = boxes.filter(b => b.t < bottom && b.b > top);
    if (near.some(b => b.l < w / 2 && b.r > w / 2)) continue;
    const half = Math.min(w / 2, ...near.map(b => b.x > w / 2 ? b.l - w / 2 : w / 2 - b.r)) - gap;
    if (half <= 0) continue;
    const a = half * 2 * (bottom - top);
    if (a > area) {area = a; best = {x: Math.round(w / 2 - half), y: Math.round(top), w: Math.round(half * 2), h: Math.round(bottom - top)}}
  }
  return best;
}

// -> {cw, ch, namePx, pos: {seat: {x, y, side}}, mid: {x, y, w, h}} for a table of w x h pixels and the seats in seat order.
export function stageLayout(w, h, seats) {
  if (!(w > 0 && h > 0) || !seats.length) return null;
  const hi = Math.floor(Math.min(320, h * 0.34, w * 0.16)), minMid = {w: Math.min(520, w * 0.28), h: Math.min(260, h * 0.24)};
  let best = null;
  for (let cw = hi; cw >= 48; cw -= 2) {
    const g = ring(w, h, seats, cw);
    if (!g) continue;
    const inside = g.boxes.every(b => b.l - b.pad.x >= -1 && b.r + b.pad.x <= w + 1 && b.t - b.pad.y >= -1 && b.b + b.pad.y <= h + 1);
    const apart = g.boxes.every((a, i) => g.boxes.every((b, j) => j <= i || !hits(a, b, 12)));
    if (!inside || !apart) continue;
    const mid = freeMiddle(w, h, g.boxes, Math.round(14 + g.cw * 0.1));
    best = best || {...g, mid};
    if (mid.w >= minMid.w && mid.h >= minMid.h) {best = {...g, mid}; break}
  }
  if (!best) {const g = ring(w, h, seats, 48) || {cw: 48, ch: 48 + cardLabel(48).label, namePx: 14, pos: {}, boxes: []}; best = {...g, mid: freeMiddle(w, h, g.boxes, Math.round(14 + g.cw * 0.1))}}
  const {boxes, ...out} = best;
  return out;
}

// The line on stage -> {e, speaker: seat | 'storyteller', stale, playing} or null (none once a nomination, the night or the end has
// come after the newest line). voiced: the id of the line the voice plays (or played
// last) when the voice is on.
export function stageLine(w, {voiced = null, playing = false} = {}) {
  const ev = (w && w.events) || [];
  let e = voiced != null ? ev.find(x => x.id === voiced) : null;
  if (!e) for (let i = ev.length - 1; i >= 0; i--) if (STAGE_LINES.has(ev[i].type) && ev[i].text) {e = ev[i]; break}
  if (!e) return null;
  const speaker = e.type === 'say' ? e.seat : e.type === 'whisper' ? e.from : 'storyteller';
  const now = playing && voiced === e.id;
  if (!now && ev.some(x => x.id > e.id && LEAVES.has(x.type))) return null;
  const stale = !now && ev.some(x => x.id > e.id && STEPS_BACK.has(x.type));
  return {e, speaker, stale, playing: playing && voiced === e.id};
}

// The dawn on stage: the day's dawn and its narration while nobody has spoken yet that day -> {dawn, narration: [text]} or null.
export function dawnView(w) {
  if (!w || w.phase !== 'day') return null;
  const ev = w.events || [], i = ev.findLastIndex(e => e.type === 'dawn');
  if (i < 0 || ev[i].day !== w.day) return null;
  const after = ev.slice(i + 1);
  if (after.some(e => TALK_AFTER.has(e.type))) return null;
  return {dawn: ev[i], narration: after.filter(e => e.type === 'narration' && e.text).map(e => e.text)};
}

// The last vote of the day while nothing has been said or nominated since: its result is flashed. -> the vote event or null
export function freshVote(w) {
  if (!w || w.phase !== 'day' || (w.pending && w.pending.kind === 'vote')) return null;
  const ev = w.events || [], i = ev.findLastIndex(e => e.type === 'vote' && e.day === w.day);
  if (i < 0) return null;
  return ev.slice(i + 1).some(e => ['say', 'whisper', 'nomination', 'phase', 'night'].includes(e.type)) ? null : ev[i];
}

// What the Storyteller does tonight, as only it (and the watcher) sees: the last few of tonight's wakings, choices, deaths and tellings.
export function nightLines(w, names) {
  if (!w || w.phase !== 'night') return {lines: [], woken: null};
  const n = i => names[i] ?? `seat ${i}`, list = v => (Array.isArray(v) ? v : [v]).filter(x => x != null).map(x => typeof x === 'number' ? n(x) : roleName(x)).join(' and ');
  const tonight = (w.events || []).filter(e => e.phase === 'night' && e.night === w.night);
  const lines = [];
  let woken = null;
  for (const e of tonight) {
    if (e.type === 'wake') {lines.push(`wakes ${n(e.seat)} (${roleName(e.role)})`); woken = e.seat}
    else if (e.type === 'acted') {lines.push(`${n(e.seat)} (${roleName(e.role)}) chooses ${list(e.target ?? e.targets) || 'nobody'}`); woken = e.seat}
    else if (e.type === 'told' && Number.isInteger(e.seat)) {lines.push(`tells ${n(e.seat)}: ${e.text}`); woken = e.seat}
    else if (e.type === 'death') lines.push(`${n(e.seat)} dies${e.by != null ? `, killed by ${n(e.by)}` : ''}`);
    else if (e.type === 'bounce') lines.push(`the kill passes from ${n(e.from)} to ${n(e.to)}`);
  }
  return {lines: lines.slice(-4), woken};
}

const face = (name, cls = '') => {
  const p = portraitOf(name);
  return `<div class="face${cls}"><span class="initial" aria-hidden="true">${esc(String(name || '?').slice(0, 1))}</span>` +
    (p ? `<img class="portrait" src="${esc(p)}" alt="${esc(name)}" draggable="false">` : '');
};

export function createStage(root, {voiceState = () => null, recorded = false} = {}) {
  installDefs();
  const stSide = root.querySelector('.stage-st') || root.appendChild(el('div', {class: 'stage-st'}));
  const table = root.querySelector('.table') || root.appendChild(el('div', {class: 'table'}));
  const centre = table.querySelector('.table-centre') || table.appendChild(el('div', {class: 'table-centre', 'aria-live': 'polite'}));
  const recentBox = root.querySelector('.recent') || root.appendChild(el('div', {class: 'recent'}));
  const recentRows = keyedRows(recentBox, {cls: 'line r-line'});
  const cards = new Map();
  // a portrait that fails to load leaves the initial (error events do not bubble: caught on the way down)
  root.addEventListener('error', e => {const t = e.target; if (t && t.tagName === 'IMG' && t.classList.contains('portrait')) t.hidden = true}, true);
  let lastVoiced = null, last = null, geo = null, geoKey = '';

  // the stage's geometry from the table's own box (#79): card size, each card's place, the free middle; written as CSS variables the
  // wide layout reads (the phone's grid ignores them). Redone only when the table's size or the seats change.
  function place(seats) {
    const box = table.getBoundingClientRect ? table.getBoundingClientRect() : null;
    const w = Math.round(box ? box.width : 0), h = Math.round(box ? box.height : 0), key = w + 'x' + h + ':' + seats.join(',');
    if (key === geoKey) return;
    geoKey = key; geo = stageLayout(w, h, seats);
    if (!geo) return;
    // the middle's box on the table itself: the table's oval (drawn by the table) and the middle's text both read it
    table.setAttribute('style', `--ring-cw:${geo.cw}px;--ring-name:${geo.namePx}px;--table-h:${h}px;--mid-x:${geo.mid.x}px;--mid-y:${geo.mid.y}px;--mid-w:${geo.mid.w}px;--mid-h:${geo.mid.h}px`);
    for (const seat of seats) {
      const r = cards.get(seat), p = geo.pos[seat];
      if (!r || !p) continue;
      const at = `--x:${p.x}px;--y:${p.y}px`;
      if (r.at !== at) {r.node.setAttribute('style', at); r.at = at}
      if (r.side !== p.side) {r.side = p.side; r.node.className = r.node.className.replace(/cap-[lr]/, 'cap-' + p.side)}
    }
  }
  if (globalThis.ResizeObserver) new ResizeObserver(() => {if (last) draw()}).observe(table);
  else if (globalThis.addEventListener) globalThis.addEventListener('resize', () => {if (last) draw()});
  // the People view never scrolls the window: a drag-select or a find could push it sideways and cut the Storyteller and the strip off
  if (globalThis.addEventListener && globalThis.scrollTo) globalThis.addEventListener('scroll', () => {
    if (document.body.dataset.view === 'people' && !matchMedia('(max-width: 600px)').matches && (globalThis.scrollX || globalThis.scrollY)) globalThis.scrollTo(0, 0);
  });

  function voiceNow() {
    const vs = voiceState();
    const on = !!(vs && vs.on && !vs.muted && !recorded);
    return {on, playing: on && !!vs.now, voiced: on ? (vs.now ? vs.now.id : lastVoiced) : null};
  }

  function captionHtml(line, names, rooms) {
    const e = line.e, n = i => esc(names[i] ?? `seat ${i}`);
    const kind = e.type === 'whisper' ? 'whisper' : e.room != null ? 'say in-room' : 'say';
    const head = e.type === 'whisper' ? `<div class="cap-head">to ${n(e.to)} <span class="unheard">the table did not hear this</span></div>`
      : e.room != null ? `<div class="cap-head place">in ${esc(rooms[e.room] || e.room)}</div>` : '';
    return `<div class="caption ${kind}${line.stale ? ' stale' : ''}" data-event="${e.id}">${head}<div class="cap-text">${esc(e.text)}</div></div>`;
  }

  function cardHtml(s, c) {
    const {v, names, room, line, rooms, block, vote, roles, woken} = c;
    const hand = v ? v.hands[s.seat] : undefined, voter = v && v.open && v.voters.includes(s.seat);
    const team = teamOf(s.role) || '';
    const tags = [];
    if (v && v.nominee === s.seat) tags.push('<span class="tag nominee">nominated</span>');
    if (v && v.nominator === s.seat) tags.push('<span class="tag nominator">nominates</span>');
    const handH = !v || (!v.open && !vote) ? '' : hand === true ? `<span class="hand-mark up" title="voted yes">${handMarker('up')}<span class="hw">yes</span></span>`
      : hand === false ? `<span class="hand-mark down" title="voted no">${handMarker('down')}<span class="hw">no</span></span>`
      : voter ? `<span class="hand-mark none" title="not voted yet">${handMarker('none')}</span>` : '';
    const result = vote && vote.target === s.seat
      ? `<span class="result ${vote.block && vote.block.seat === s.seat ? 'passes' : 'fails'}">${vote.tally} of ${vote.need ?? vote.needed}: ${vote.block && vote.block.seat === s.seat ? 'on the block' : 'not enough'}</span>` : '';
    const onBlock = !result && block && block.seat === s.seat ? `<span class="result block">on the block · ${block.votes}</span>` : '';
    const believed = s.believed && s.believed !== s.role ? `, thinks ${roleName(s.believed)}` : '';
    return face(s.name) +
      (s.alive ? '' : `<span class="shroud">${shroudArt() ? `<img class="shroud-art" src="${esc(shroudArt())}" alt="" draggable="false">` : cardShroud()}</span>`) +
      (roles ? `<span class="role-corner" title="${esc(roleName(s.role) + ' (' + team + believed + '); only the Storyteller and you see this')}">${roleToken(s.role, {name: roleName(s.role), team})}</span>` : '') +
      (s.alive ? '' : `<span class="ghost-corner" title="${s.ghostVote ? 'ghost vote unspent' : 'ghost vote spent'}">${ghostCoin(s.ghostVote)}</span>`) +
      handH + (tags.length ? `<span class="tags">${tags.join('')}</span>` : '') +
      (room ? `<span class="away-tag" title="Away from the Square, in ${esc(room.name || room.id)}">${esc(room.name || room.id)}</span>` : '') +
      result + onBlock + '</div>' +
      `<div class="name sc-${s.seat % 7}">${esc(s.name)}</div><div class="life">${s.alive ? 'alive' : 'dead'}${woken ? ' · <span class="awake">awake</span>' : ''}</div>` +
      (line && line.speaker === s.seat ? captionHtml(line, names, rooms) : '');
  }

  function centreHtml(w, v, names, vote, dawn) {
    if (!w) return '<div class="quiet">No game yet</div>';
    const n = i => esc(names[i] ?? `seat ${i}`);
    if (w.winner) {const good = w.winner.team === 'good'; return `<div class="winner-big ${good ? 'good' : 'evil'}">${good ? 'Good' : 'Evil'} wins</div><div class="sub">${esc(w.winner.text)}</div>`}
    if (w.phase === 'night') return `<div class="night-big">Night ${esc(w.night)}</div><div class="sub">The town sleeps. The Storyteller wakes them one by one.</div>`;
    if (v && v.open) {
      const pips = v.voters.map((i, k) => `<span class="pip${k < v.yes ? ' yes' : ''}${k === v.need - 1 ? ' need' : ''}"></span>`).join('');
      return `<div class="vote-what">${n(v.nominator)} nominates <b>${n(v.nominee)}</b></div>` +
        `<div class="tally-big"><b>${v.yes}</b><span> yes of ${v.need} needed</span></div>` +
        `<div class="meter" role="img" aria-label="${v.yes} of ${v.need} needed">${pips}</div>` +
        `<div class="sub">${v.cast} of ${v.voters.length} hands in${v.waiting.length ? `; waiting on ${esc(v.waiting.map(i => names[i]).join(', '))}` : ''}</div>` +
        `<div class="sub">${v.block && v.block.seat != null ? `${n(v.block.seat)} is on the block with ${v.block.votes}: beat it to replace` : 'nobody on the block yet'}</div>`;
    }
    if (vote) {
      const passes = vote.block && vote.block.seat === vote.target;
      return `<div class="vote-what">${n(vote.by)} nominated <b>${n(vote.target)}</b></div>` +
        `<div class="tally-big ${passes ? 'passes' : 'fails'}"><b>${vote.tally}</b><span> of ${vote.need ?? vote.needed} needed</span></div>` +
        `<div class="sub">${passes ? `${n(vote.target)} is on the block` : vote.block && vote.block.seat != null ? `not enough; ${n(vote.block.seat)} stays on the block` : 'not enough; nobody is on the block'}</div>`;
    }
    if (dawn) return `<div class="dawn-big">${esc(dawn.dawn.text)}</div>${dawn.narration.map(t => `<div class="dawn-words">${esc(t)}</div>`).join('')}`;
    const b = v && !v.open && v.block && v.block.seat != null ? `<div class="sub">${n(v.block.seat)} is on the block with ${v.block.votes}</div>` : '';
    return `<div class="day-line">${esc(clockText(w))}</div>${b}`;
  }

  function draw() {
    if (!last) return;
    const w = last.watch;
    root.dataset.empty = w ? 'no' : 'yes';
    root.dataset.phase = w ? String(w.phase || '') : '';
    const list = (w && w.grimoire && w.grimoire.seats) || [], names = seatNames(w), rooms = roomNames(w), open = openRooms(w);
    const v = voteView(w), vote = freshVote(w), dawn = dawnView(w), vn = voiceNow();
    const line = w ? stageLine(w, vn) : null;
    const night = nightLines(w, names);
    const roles = (globalThis.document && document.body && document.body.dataset.roles) !== 'off';
    const block = w && w.phase === 'day' && v && v.block && v.block.seat != null ? v.block : null;
    list.forEach((s, i) => {
      let r = cards.get(s.seat);
      if (!r) {
        r = {node: el('div', {class: 'card', dataset: {seat: String(s.seat)}}), h: null, side: seatPlace(i, list.length).side, at: ''};
        table.append(r.node); cards.set(s.seat, r);
      }
      const room = open ? open.roomOf[s.seat] || null : null;
      const h = cardHtml(s, {v, names, room, line, rooms, block, vote, roles, woken: night.woken === s.seat});
      if (h !== r.h) {r.node.innerHTML = h; r.h = h}
      const speaking = !!line && line.speaker === s.seat;
      const cls = 'card sc-' + (s.seat % 7) + ' cap-' + r.side + (s.alive ? '' : ' dead') + (speaking ? ' speaking' : '') + (speaking && line.stale ? ' stale' : '') +
        (speaking && line.playing ? ' voicing' : '') + (v && v.nominee === s.seat ? ' is-nominee' : '') + (v && v.nominator === s.seat ? ' is-nominator' : '') +
        (v && v.open && v.voters.includes(s.seat) ? ' is-voter' : '') + (room ? ' away' : '') + (night.woken === s.seat ? ' woken' : '') + (vote && vote.target === s.seat ? ' flash' : '');
      if (r.node.className !== cls) r.node.className = cls;
    });
    for (const [k, r] of cards) if (!list.some(s => s.seat === k)) {r.node.remove(); cards.delete(k)}
    place(list.map(s => s.seat));
    const c = centreHtml(w, v, names, vote, dawn);
    if (centre._h !== c) {centre.innerHTML = c; centre._h = c}
    // the Storyteller, apart, with its latest words
    const ev = (w && w.events) || [];
    const said = line && line.speaker === 'storyteller' ? line.e : ev.findLast(e => ST_WORDS.has(e.type) && e.text);
    const stSpeaking = !!line && line.speaker === 'storyteller';
    const sh = face('Storyteller') + '</div><div class="name">Storyteller</div>' +
      `<div class="st-words">${said ? `<div class="st-line${stSpeaking && !line.stale ? '' : ' older'}">${esc(said.text)}</div>` : '<div class="st-line older">The Storyteller has not spoken yet.</div>'}` +
      (night.lines.length ? `<div class="st-night"><span class="seen-by">tonight, as the Storyteller sees it</span>${night.lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : '') + '</div>';
    if (stSide._h !== sh) {stSide.innerHTML = sh; stSide._h = sh}
    const stCls = 'stage-st' + (stSpeaking ? ' speaking' : '') + (stSpeaking && line.playing ? ' voicing' : '') + (w && w.phase === 'night' ? ' awake' : '');
    if (stSide.className !== stCls) stSide.className = stCls;
    // the strip: the last lines before the one on stage, newest first
    const items = [];
    for (let i = ev.length - 1; i >= 0 && items.length < RECENT_N; i--) {
      const e = ev[i];
      if (!RECENT.has(e.type) || (line && e.id === line.e.id) || !e.text) continue;
      const l = talkLine(e, names, rooms);
      if (l) items.push({e, l});
    }
    recentRows(items, x => x.e.id, x => x.l.html, x => ({'data-kind': x.l.cls}));
    recentBox.dataset.count = String(items.length);
  }
  function render(s) {
    const key = s && s.watch ? s.watch.seed + ':' + (s.epoch || 0) : null;
    if (last && last.key !== key) lastVoiced = null; // another game: its event ids start again
    last = {...s, key}; draw();
  }
  // the voice (src/ui/voice.js) began or ended a clip: the line it plays takes the stage
  function setSpeaking(who) {
    const vs = voiceState();
    if (who != null && vs && vs.now) lastVoiced = vs.now.id;
    draw();
  }
  return {render, setSpeaking, refresh: draw, cards, get line() {return last && last.watch ? stageLine(last.watch, voiceNow()) : null}};
}
