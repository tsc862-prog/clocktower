// The town square: the seven seats in a circle in seat order (clockwise from the top), alive or dead, the ghost vote, the nominee
// and the nominator while a vote is open, each hand as its ballot lands, and the running tally against the bar. Under each seat,
// what only the Storyteller (and the watcher) sees: the true role and the tokens that matter, as short words.
import {esc, el} from './dom.js';
import {roleName, teamOf, voteView, tokenWord, SQUARE_TOKENS, seatNames} from './model.js';

export function createSquare(root) {
  const ring = root.querySelector('.ring') || root.appendChild(el('div', {class: 'ring'}));
  const centre = root.querySelector('.centre') || ring.appendChild(el('div', {class: 'centre'}));
  const seats = new Map();
  function seatHtml(s, v, names) {
    const hand = v ? v.hands[s.seat] : undefined, voter = v && v.open && v.voters.includes(s.seat);
    const marks = [];
    if (v && v.nominee === s.seat) marks.push('<span class="mark nominee">nominated</span>');
    if (v && v.nominator === s.seat) marks.push('<span class="mark nominator">nominates</span>');
    const handTxt = !v ? '' : hand === true ? '<span class="hand up" title="voted yes">&#9650; yes</span>'
      : hand === false ? '<span class="hand down" title="voted no">&#9660; no</span>'
      : voter ? '<span class="hand none" title="not voted yet">&middot;</span>' : '';
    const ghost = s.alive ? '' : `<span class="ghost ${s.ghostVote ? 'unspent' : 'spent'}">${s.ghostVote ? 'ghost vote unspent' : 'ghost vote spent'}</span>`;
    const toks = s.tokens.filter(t => SQUARE_TOKENS.has(t.token)).map(t => {
      const w = t.token === 'master' && t.by != null ? `master of ${names[t.by]}` : t.token === 'is-the-drunk' ? 'drunk' : tokenWord(t);
      return `<span class="tok${t.active === false ? ' off' : ''}">${esc(w)}</span>`;
    }).join(' ');
    const believed = s.believed !== s.role ? ` <span class="believed">(thinks ${esc(roleName(s.believed))})</span>` : '';
    return `<div class="name">${esc(s.name)}</div><div class="life">${s.alive ? 'alive' : 'dead'} ${ghost}</div>` +
      `<div class="marks">${marks.join(' ')} ${handTxt}</div>` +
      `<div class="st"><span class="sees" title="Only the Storyteller and you see this">ST sees</span> <span class="role team-${esc(teamOf(s.role))}">${esc(roleName(s.role))}</span>${believed}${toks ? '<br>' + toks : ''}</div>`;
  }
  function render({watch: w}) {
    root.dataset.empty = w ? 'no' : 'yes';
    const list = (w && w.grimoire && w.grimoire.seats) || [], n = list.length, v = voteView(w), names = seatNames(w);
    list.forEach((s, i) => {
      let r = seats.get(s.seat);
      if (!r) {
        const a = (-90 + i * 360 / n) * Math.PI / 180;
        r = {node: el('div', {class: 'seat', dataset: {seat: String(s.seat)}}), h: null};
        r.node.style.left = (50 + 40 * Math.cos(a)).toFixed(2) + '%';
        r.node.style.top = (50 + 40 * Math.sin(a)).toFixed(2) + '%';
        ring.append(r.node); seats.set(s.seat, r);
      }
      const h = seatHtml(s, v, names);
      if (h !== r.h) {r.node.innerHTML = h; r.h = h}
      r.node.className = 'seat' + (s.alive ? '' : ' dead') + (v && v.nominee === s.seat ? ' is-nominee' : '') + (v && v.nominator === s.seat ? ' is-nominator' : '');
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
  }
  return {render};
}
