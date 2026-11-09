// The day's talk: every line said in the Square with its speaker, phase breaks (night falls, dawn, rounds, nominations open, the
// day ends), nominations, votes with their hands, executions, the Storyteller's narration in its own style. Whispers sit inline as
// "A leaned in to B" with their text beneath, marked as something the table did not hear. What each seat was told by night and a
// runner's own asides are the watcher's too, each marked so (both can be hidden). New lines are appended, never rebuilt; the
// list follows the newest line until the owner scrolls up, and one click follows it again.
import {esc} from './dom.js';
import {follower} from './dom.js';
import {roleName, seatNames} from './model.js';

const BREAKS = new Set(['phase', 'dawn']);
export function talkLine(e, names) {
  const n = i => esc(names[i] ?? `seat ${i}`);
  const who = i => `<b class="who sc-${Number.isInteger(i) ? i % 7 : 'x'}">${n(i)}</b>`; // each seat's own colour (styles/page.css --seat-c0..6)
  switch (e.type) {
    case 'say': return {cls: 'say', html: `${who(e.seat)} <span class="text">${esc(e.text)}</span>`};
    case 'pass': return {cls: 'pass', html: `<span class="dim">${esc(e.text)}</span>`};
    case 'whisper': return {cls: 'whisper', html: `<div class="lean">${who(e.from)} leaned in to ${who(e.to)} <span class="unheard" title="Only the two of them heard this">the table did not hear this</span></div><div class="text">${esc(e.text)}</div>`};
    case 'whisper-seen': return null; // the table's view of a whisper; the whisper itself carries it
    case 'narration': return {cls: 'narration', html: `<span class="st-name">Storyteller</span> <span class="text">${esc(e.text)}</span>`};
    case 'phase': return {cls: 'break ' + (e.what || ''), html: esc(e.text)};
    case 'night': return {cls: 'break night', html: esc(e.text || `Night ${e.night} falls.`)};
    case 'dawn': return {cls: 'break dawn', html: esc(e.text)};
    case 'nomination': return {cls: 'nomination', html: esc(e.text)};
    case 'vote': return {cls: 'vote-result', html: `${esc(e.text)}`};
    case 'vote-closed': case 'execution': case 'no-execution': case 'slayer-shot': case 'virgin':
      return {cls: 'event ' + e.type, html: esc(e.text)};
    case 'death': return e.phase === 'day' ? {cls: 'event death', html: esc(e.text)} : {cls: 'private death', html: `<span class="seen-by">ST sees</span> ${n(e.seat)} (${esc(roleName(e.role))}) dies in the night${e.by != null ? `, killed by ${n(e.by)}` : ''}.`};
    case 'win': return {cls: 'win', html: esc(e.text)};
    case 'told': return {cls: 'private told', html: `<span class="seen-by">told ${n(e.seat)}</span> ${esc(e.text)}`};
    case 'aside': return {cls: 'private aside', html: `<span class="seen-by">${esc(e.who)}'s aside, for you only</span> ${esc(e.text)}`};
  }
  return null;
}

export function createTalk(root) {
  const box = root.querySelector('.lines'), btn = root.querySelector('.follow');
  const f = follower(box, btn);
  const shown = new Set();
  let epoch = null;
  const opts = {told: root.querySelector('input[name="told"]'), asides: root.querySelector('input[name="asides"]')};
  const sync = () => {root.dataset.hideTold = opts.told && !opts.told.checked ? 'yes' : 'no'; root.dataset.hideAsides = opts.asides && !opts.asides.checked ? 'yes' : 'no'};
  for (const o of Object.values(opts)) if (o) o.addEventListener('change', sync);
  sync();
  function render({watch: w, asides = [], epoch: ep = 0}) {
    if (!w) return;
    const key = w.seed + ':' + ep; if (epoch !== key) {box.replaceChildren(); shown.clear(); epoch = key}
    const names = seatNames(w);
    // asides come from the socket with no game id: they sit after the last event that was in when they arrived
    const items = [...w.events.map(e => ({k: 'e' + e.id, at: e.id, e})), ...asides.map(a => ({k: 'a' + a.n, at: a.after + 0.5, e: {type: 'aside', ...a}}))]
      .filter(x => !shown.has(x.k)).sort((a, b) => a.at - b.at);
    let added = 0;
    for (const x of items) {
      shown.add(x.k);
      const l = talkLine(x.e, names);
      if (!l) continue;
      const row = document.createElement('div');
      row.className = 'line ' + l.cls; row.dataset.key = x.k; row.innerHTML = l.html;
      if (x.e.day != null) row.dataset.day = String(x.e.day);
      box.append(row); added++;
    }
    f.added(added);
  }
  return {render, follower: f, box};
}
