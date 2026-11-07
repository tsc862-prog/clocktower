// The Storyteller's log: every judgement call with its question, the answer and the reason, newest last. A ruling the scripted
// fallback made (nobody answered in time) is marked. Appended, never rebuilt; follows the newest like the talk.
import {esc, follower} from './dom.js';
import {roleName, seatNames} from './model.js';

const SCRIPTED = /^scripted default/i;
export const isScripted = r => SCRIPTED.test(String(r.reason || ''));

function valueText(v, names) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => valueText(x, names)).join(', ');
  if (typeof v === 'number') return names[v] != null ? `${names[v]}` : String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return roleName(v);
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${valueText(x, names)}`).join('; ');
  return String(v);
}
const when = r => r.phase === 'night' ? `night ${r.night}` : r.phase === 'day' ? `day ${r.day}` : r.phase;

export function createRulings(root) {
  const box = root.querySelector('.lines'), f = follower(box, root.querySelector('.follow'));
  const shown = new Set(); let epoch = null;
  function render({watch: w, epoch: ep = 0}) {
    if (!w) return;
    const key = w.seed + ':' + ep; if (epoch !== key) {box.replaceChildren(); shown.clear(); epoch = key}
    const names = seatNames(w);
    let added = 0;
    for (const r of w.rulings || []) {
      if (shown.has(r.id)) continue; shown.add(r.id);
      const row = document.createElement('div'), s = isScripted(r);
      row.className = 'ruling' + (s ? ' scripted' : ''); row.dataset.key = String(r.id);
      row.innerHTML = `<div class="head"><span class="when">${esc(when(r))}</span> <span class="kind">${esc(r.kind)}</span>${s ? ' <span class="flag" title="Nobody answered in time; the scripted default decided">scripted default</span>' : ''}</div>` +
        `<div class="q">${esc(r.question || '')}</div>` + (r.value != null ? `<div class="a">Answer: <b>${esc(valueText(r.value, names))}</b></div>` : '') +
        `<div class="why">${esc(r.reason || '')}</div>`;
      box.append(row); added++;
    }
    f.added(added);
  }
  return {render};
}
