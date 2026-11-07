// The grimoire as the Storyteller sees it: every seat with its true role, the role it believes it is when that differs, alive or
// dead, its tokens with who placed them; the demon's bluffs; the decision the game waits on and who it waits on; tonight's waking
// order. Rows are keyed by seat and patched in place.
import {esc, keyedRows} from './dom.js';
import {roleName, teamOf, tokenText, seatNames, waitsOn} from './model.js';

export function createGrimoire(root) {
  const table = root.querySelector('.seats'), rows = keyedRows(table, {cls: 'grim-row'});
  const foot = root.querySelector('.grim-foot');
  function render({watch: w}) {
    if (!w) {rows([], () => 0, () => ''); foot.innerHTML = ''; return}
    const g = w.grimoire, names = seatNames(w);
    rows(g.seats, s => s.seat, s => `<span class="n">${s.seat + 1}</span><span class="name">${esc(s.name)}</span>` +
      `<span class="role team-${esc(teamOf(s.role))}">${esc(roleName(s.role))}<small> ${esc(teamOf(s.role) || '')}</small></span>` +
      `<span class="believed">${s.believed !== s.role ? 'believes ' + esc(roleName(s.believed)) : ''}</span>` +
      `<span class="life">${s.alive ? 'alive' : 'dead' + (s.ghostVote ? ', ghost vote left' : ', ghost vote spent')}</span>` +
      `<span class="tokens">${s.tokens.length ? s.tokens.map(t => `<span class="tok${t.active === false ? ' off' : ''}">${esc(tokenText(t, names))}</span>`).join(' ') : '<span class="dim">no tokens</span>'}</span>`,
      s => ({'data-alive': s.alive ? 'yes' : 'no'}));
    const order = (w.nightOrder || []).filter(o => !o.telling).map(o => `<span class="wake ${esc(o.status.replace(' ', '-'))}${o.wakes === false ? ' skip' : ''}">${esc(o.name || roleName(o.role))}${o.seatName ? ' (' + esc(o.seatName) + ')' : ''}</span>`).join(' &rsaquo; ');
    const h = `<div><b>Demon's bluffs:</b> ${g.bluffs && g.bluffs.length ? g.bluffs.map(b => esc(roleName(b))).join(', ') : '<span class="dim">not shown yet</span>'}</div>` +
      `<div class="pending"><b>Waiting on:</b> ${esc(waitsOn(w))}</div>` +
      (order ? `<div class="order"><b>Night ${(w.nightOrder[0] || {}).night ?? ''} wakes:</b> ${order}</div>` : '');
    if (foot._h !== h) {foot.innerHTML = h; foot._h = h}
  }
  return {render};
}
