// Small DOM helpers for the watcher's page. Panels patch what changed and never rebuild a list the owner is reading: a row is
// keyed, its HTML is kept, and it is replaced only when that HTML differs. No framework, no build step.
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

// el('div', {class: 'x', dataset: {k: 'v'}, onclick: f}, child, 'text') -> element
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'dataset') for (const [d, x] of Object.entries(v)) e.dataset[d] = x;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  return e;
}

// Keyed rows in a container: rows(list, key, html) adds, patches and removes rows by key, in order, touching only the ones whose
// HTML changed. The container itself is never replaced, so its scroll position and any open <details> inside an unchanged row stay.
export function keyedRows(box, {tag = 'div', cls = 'row'} = {}) {
  const byKey = new Map();
  return function rows(items, key, html, extra = () => null) {
    const keep = new Set();
    let prev = null;
    for (const it of items) {
      const k = String(key(it)); keep.add(k);
      let r = byKey.get(k);
      const h = html(it), more = extra(it);
      if (!r) {r = {node: el(tag, {class: cls, dataset: {key: k}}), h: null}; byKey.set(k, r)}
      if (r.h !== h) {r.node.innerHTML = h; r.h = h}
      if (more) for (const [a, v] of Object.entries(more)) {if (v == null) r.node.removeAttribute(a); else if (r.node.getAttribute(a) !== String(v)) r.node.setAttribute(a, v)}
      const want = prev ? prev.nextSibling : box.firstChild;
      if (want !== r.node) box.insertBefore(r.node, want || null);
      prev = r.node;
    }
    for (const [k, r] of byKey) if (!keep.has(k)) {r.node.remove(); byKey.delete(k)}
    return byKey;
  };
}

// A log the owner reads for a long time: follows new lines while he is at the bottom; once he scrolls up it stops following and
// shows a "new below" button that resumes with one click. near(): within a few pixels of the bottom.
export function follower(box, button) {
  let follow = true, unseen = 0;
  const near = () => box.scrollTop + (box.clientHeight || 0) >= box.scrollHeight - 24;
  const show = () => {if (!button) return; button.hidden = follow; button.textContent = unseen ? `${unseen} new below: follow` : 'Follow the newest'};
  const toEnd = () => {box.scrollTop = box.scrollHeight};
  box.addEventListener('scroll', () => {
    follow = near(); if (follow) unseen = 0; show();
  });
  if (button) button.addEventListener('click', () => {follow = true; unseen = 0; toEnd(); show()});
  show();
  return {
    // call after appending n lines
    added(n) {
      if (!n) return;
      if (!follow) {unseen += n; show(); return}
      toEnd();
      // once more after layout: a list filled before the page's styles applied has no height yet
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {if (follow) toEnd()});
    },
    get following() {return follow},
  };
}
