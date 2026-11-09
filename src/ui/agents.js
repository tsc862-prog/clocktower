// Agents: one row for the Storyteller and one per seat: provider and model, state (claimed, warming, ready, playing, stopped, gone),
// cost so far against its budget, the session's size, turns, the last turn (collapsible: its header and tool calls when the runner
// reports them, else its last output lines). Start and stop per runner, start all, stop all, and the owner's resume when a gone
// Storyteller has paused the game. The game budget's two pools sit on top. Model, provider and budget per runner, blank for the
// supervisor's default. Rows are built once and patched, so an open "last turn" and a field being typed in stay as they are.
import {esc, el} from './dom.js';
import {seatState, money, ago} from './model.js';
import {SEAT_NAMES} from '../data/script.js';
import {portraitOf} from './portraits.js';

export function createAgents(root, {act}) {
  const list = root.querySelector('.agent-rows'), pools = root.querySelector('.pools'), note = root.querySelector('.agents-note');
  const resume = root.querySelector('button[data-act="resume"]'), startAll = root.querySelector('button[data-act="start-all"]'), stopAll = root.querySelector('button[data-act="stop-all"]');
  const rows = new Map();
  // a portrait that fails to load hides itself (error events do not bubble: caught on the way down)
  list.addEventListener('error', e => {const t = e.target; if (t && t.tagName === 'IMG' && t.classList.contains('mini-portrait')) t.hidden = true}, true);
  let last = {runners: null};
  resume.addEventListener('click', () => act('resume'));
  const doStartAll = () => act('startAll', {seats: [...rows.values()].filter(r => r.startable).map(r => r.body())});
  startAll.addEventListener('click', doStartAll);
  stopAll.addEventListener('click', () => act('stopAll'));

  function row(key, label, kind, player) {
    const prov = el('select', {name: 'provider', title: 'Provider (blank: the supervisor default)'}, el('option', {value: ''}, 'default'));
    const model = el('input', {name: 'model', placeholder: 'model (default)', size: '18', title: 'Model name; blank for the default'});
    const budget = el('input', {name: 'budget', placeholder: 'budget $', size: '7', inputmode: 'decimal', title: 'Budget in dollars for this runner; blank for its share of the game budget'});
    const start = el('button', {class: 'start', dataset: {act: 'start'}}, 'Start'), stop = el('button', {class: 'stop', dataset: {act: 'stop'}}, 'Stop');
    const head = el('div', {class: 'agent-head'}), turn = el('div', {class: 'turn-body'});
    const det = el('details', {class: 'last-turn'}, el('summary', {}, 'Last turn'), turn);
    const node = el('div', {class: 'agent', dataset: {key, kind}}, head, el('div', {class: 'agent-ctl'}, prov, model, budget, start, stop), det);
    const r = {key, kind, player, node, head, turn, prov, model, budget, start, stop, label, h: '', t: '', startable: false,
      body() {
        const b = {kind}; if (player != null) b.player = player;
        if (prov.value) b.provider = prov.value; if (model.value.trim()) b.model = model.value.trim();
        const d = Number(budget.value); if (budget.value.trim() && Number.isFinite(d)) b.budget = d;
        return b;
      }};
    start.addEventListener('click', () => act('start', r.body()));
    stop.addEventListener('click', () => act('stop', player != null ? {kind, player} : {kind}));
    rows.set(key, r); list.append(node);
    return r;
  }

  function render({watch: w, runners: rv, links}) {
    last = {runners: rv};
    const enabled = !!(rv && rv.enabled);
    const seats = w && w.grimoire ? w.grimoire.seats.map(s => ({id: s.seat + 1, name: s.name, alive: s.alive}))
      : links && links.links ? Object.keys(links.links).map(id => ({id: Number(id), name: SEAT_NAMES[id - 1] || `Seat ${id}`, alive: true}))
      : SEAT_NAMES.map((n, i) => ({id: i + 1, name: n, alive: true}));
    const want = [{key: 'storyteller', label: 'Storyteller', kind: 'storyteller', player: null, alive: true}, ...seats.map(s => ({key: 'player:' + s.id, label: s.name, kind: 'player', player: s.id, alive: s.alive}))];
    const byKey = Object.fromEntries(((rv && rv.runners) || []).map(r => [r.key, r]));
    const provs = (rv && rv.providers) || [];
    for (const x of want) {
      const r = rows.get(x.key) || row(x.key, x.label, x.kind, x.player);
      if (r.prov.options.length !== provs.length + 1 && document.activeElement !== r.prov) {const keep = r.prov.value; r.prov.replaceChildren(el('option', {value: ''}, 'default'), ...provs.map(p => el('option', {value: p}, p))); r.prov.value = keep}
      const run = byKey[x.key] || null;
      const link = x.kind === 'storyteller' ? links && links.storyteller && links.storyteller.link : links && links.links && links.links[x.player];
      const ready = x.kind === 'storyteller' ? links && links.storyteller && links.storyteller.ready : links && links.ready && links.ready[x.player];
      const mind = x.kind === 'storyteller' ? links && links.storyteller && links.storyteller.runner : links && links.runners && links.runners[x.player];
      const st = seatState(run, link, ready), live = run && !['stopped', 'crashed'].includes(run.state);
      const provider = (run && run.provider) || (mind && mind.provider) || '', model = (run && run.model) || (mind && mind.model) || '';
      const defBudget = rv && rv.game && rv.game.defaults ? rv.game.defaults[x.kind] : null;
      if (r.budget.placeholder !== (defBudget != null ? `${money(defBudget)} default` : 'budget $')) r.budget.placeholder = defBudget != null ? `${money(defBudget)} default` : 'budget $';
      const face = portraitOf(x.label);
      const h = (face ? `<img class="mini-portrait${x.alive ? '' : ' dead'}" src="${esc(face)}" alt="" draggable="false">` : '') + `<span class="who">${esc(x.label)}${x.alive ? '' : ' <small>(dead)</small>'}</span>` +
        `<span class="state s-${st}">${st}</span>` +
        `<span class="mind">${provider || model ? esc([provider, model].filter(Boolean).join(' / ')) : '<span class="dim">no runner</span>'}</span>` +
        `<span class="cost" title="cost so far of its budget">${run ? `${money(run.cost)} of ${money(run.capBudget ?? run.budget)}` : ''}${run && run.budgetSpent ? ' <b>budget spent</b>' : ''}</span>` +
        `<span class="ctx" title="the session's size">${run && run.ctx != null ? `${run.ctx}k ctx${run.rolls ? `, ${run.rolls} rolled` : ''}` : ''}</span>` +
        `<span class="turns">${run ? `${run.turns} turns${run.lastTurnAgo != null ? ', last ' + ago(run.lastTurnAgo) : ''}` : ''}</span>` +
        (run && (run.error || run.endWhy) && !live ? `<span class="why">${esc(run.error || run.endWhy)}</span>` : '');
      if (h !== r.h) {r.head.innerHTML = h; r.h = h}
      r.node.dataset.state = st;
      const lt = run && run.lastTurn;
      const t = lt ? `<div class="turn-meta">${esc(lt.wake || '')}${lt.at ? ' · ' + esc(lt.at) : ''}${lt.cost != null ? ' · ' + money(lt.cost) : ''}</div>` +
          (lt.header ? `<pre class="header">${esc(lt.header)}</pre>` : '') +
          (lt.tools && lt.tools.length ? `<ol class="tools">${lt.tools.map(c => `<li><b>${esc(c.tool)}</b> ${esc(c.args ? JSON.stringify(c.args) : '')}${c.ok === false ? ' <span class="err">refused' + (c.error ? ': ' + esc(c.error) : '') + '</span>' : ''}</li>`).join('')}</ol>` : '')
        : run && run.lines && run.lines.length ? `<pre class="lines">${esc(run.lines.join('\n'))}</pre>` : '<span class="dim">no turn yet</span>';
      if (t !== r.t) {r.turn.innerHTML = t; r.t = t}
      r.start.disabled = !enabled || !!live || !x.alive;
      r.stop.disabled = !enabled || !live;
      r.startable = enabled && !live && x.alive;
    }
    const g = rv && rv.game;
    const p = g ? `<span><b>Game budget</b> ${money(g.budget)}</span> <span>players ${money(g.players.spent)} of ${money(g.players.budget)}</span> <span>Storyteller ${money(g.storyteller.spent)} of ${money(g.storyteller.budget)}</span>` +
      (rv.session && rv.session.budget != null ? ` <span>session ${money(rv.session.spent)} of ${money(rv.session.budget)}</span>` : '') : '';
    if (pools._h !== p) {pools.innerHTML = p; pools._h = p}
    const n = !rv ? 'The runner supervisor is not answering.' : rv.down ? 'The relay is not answering.' : !enabled ? (rv.how || 'Runners are off.') : rv.paused ? `The game is paused: ${rv.paused.why}. Resume lets the scripted Storyteller answer from here on.` : '';
    if (note.textContent !== n) note.textContent = n;
    resume.hidden = !(rv && rv.paused);
    startAll.disabled = !enabled || ![...rows.values()].some(r => r.startable);
    stopAll.disabled = !enabled || !((rv && rv.runners) || []).some(r => !['stopped', 'crashed'].includes(r.state));
  }
  // the game bar's Start all (src/ui/app.js) does what this panel's does
  return {render, rows, startAll: doStartAll, canStartAll: () => !startAll.disabled, get last() {return last}};
}
