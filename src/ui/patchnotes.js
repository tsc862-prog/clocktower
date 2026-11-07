// Patch notes : one player-facing note per merged PR, docs/patchnotes/<PR>.md. Pure helpers, no DOM, shared by
// the page's What's new block (later), the launcher (scripts/up.mjs, scripts/patchnotes.mjs) and the
// repo rule that every PR carries its note (scripts/rulescheck.mjs).
//
// A note:
//   ---
//   title: Players whisper between rounds
//   date: 2026-11-03
//   area: players
//   issues: [1]
//   ---
//   - A player can whisper to one other player between rounds of talk; the table only sees that they leaned in.
//   - ...
// 1-6 lines, each a "- " bullet, written for the player: what you will see or can do now, in plain words. No file or
// function names, no commit hashes, no code. "Nothing you will notice: ..." is fine for CI, tests and baselines.

export const NOTE_MAX_LINES = 6, NOTE_LINE_MAX = 280;
export const NOTE_AREAS = ['rules', 'storyteller', 'players', 'ui', 'infra', 'lore', 'docs'];

// '0000-before' -> 0, '12' -> 12; anything else -> null
export const noteNumber = id => {const m = String(id).replace(/^.*[\\/]/, '').replace(/\.md$/, '').match(/^(\d+)(?:-[a-z0-9-]+)?$/); return m ? Number(m[1]) : null};
export const noteId = path => String(path).replace(/^.*[\\/]/, '').replace(/\.md$/, '');

export function parseNote(text, id = '') {
  const src = String(text || '').replace(/\r\n?/g, '\n'), note = {id: noteId(id), pr: noteNumber(id), title: '', date: '', area: '', issues: [], lines: [], extra: []};
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  note.front = !!m;
  const head = m ? m[1] : '', body = m ? m[2] : src;
  for (const l of head.split('\n')) {
    const kv = l.match(/^\s*([a-z]+)\s*:\s*(.*?)\s*$/i); if (!kv) continue;
    const k = kv[1].toLowerCase(), v = kv[2].replace(/^["']|["']$/g, '');
    if (k === 'issues') note.issues = (v.match(/\d+/g) || []).map(Number);
    else if (k === 'title' || k === 'date' || k === 'area') note[k] = v;
  }
  for (const l of body.split('\n')) {
    if (!l.trim()) continue;
    const b = l.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (b) note.lines.push(b[1]); else note.extra.push(l.trim());
  }
  return note;
}

// What makes a line not player-facing: code, file names, function names, commit hashes.
const FILE_RX = /\b[\w./-]+\.(?:m?js|json|md|cmd|ya?ml|css|html?|png|txt|jsonl)\b/i;
const HASH_RX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const CALL_RX = /\b[A-Za-z_$][\w$.]*\(\s*\)/;
const CAMEL_RX = /\b[a-z]+[A-Z][A-Za-z]*\b/;
export function lintNote(note) {
  const err = [];
  if (note.pr == null) err.push('the file name must be the PR number (docs/patchnotes/<PR>.md)');
  if (!note.front) err.push('no front matter (--- title, date, area, issues ---)');
  if (!note.title) err.push('front matter needs a title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(note.date)) err.push('front matter needs a date as YYYY-MM-DD');
  if (!note.area) err.push('front matter needs an area (' + NOTE_AREAS.join(', ') + ')');
  else if (!NOTE_AREAS.includes(note.area)) err.push('area "' + note.area + '" is not one of ' + NOTE_AREAS.join(', '));
  if (note.extra.length) err.push('every line after the front matter is a "- " bullet (found: ' + note.extra[0].slice(0, 60) + ')');
  if (!note.lines.length) err.push('no note lines: write 1-' + NOTE_MAX_LINES + ' "- " lines for the player');
  if (note.lines.length > NOTE_MAX_LINES) err.push(note.lines.length + ' lines; at most ' + NOTE_MAX_LINES);
  for (const l of [note.title, ...note.lines]) {
    const why = l.length > NOTE_LINE_MAX ? 'longer than ' + NOTE_LINE_MAX + ' characters'
      : /`/.test(l) ? 'code in backticks' : FILE_RX.test(l) ? 'a file name (' + l.match(FILE_RX)[0] + ')'
      : HASH_RX.test(l) ? 'a commit hash (' + l.match(HASH_RX)[0] + ')' : CALL_RX.test(l) ? 'a function call (' + l.match(CALL_RX)[0] + ')'
      : CAMEL_RX.test(l) ? 'a code name (' + l.match(CAMEL_RX)[0] + ')' : '';
    if (why) err.push('not player-facing: ' + why + ' in "' + l.slice(0, 70) + (l.length > 70 ? '…' : '') + '"');
  }
  return err;
}

// Oldest first: by date, then PR number (the "before" note, number 0, leads its day).
export const sortNotes = list => list.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.pr ?? 0) - (b.pr ?? 0));

// Notes from a {path: text} map (a Vite ?raw glob, or files read in Node). Files whose name starts with "_" are skipped.
export function notesFrom(map) {
  return sortNotes(Object.entries(map || {}).filter(([p]) => !/(^|[\\/])_/.test(p) && /\.md$/.test(p)).map(([p, t]) => parseNote(t, p)).filter(n => n.pr != null && n.lines.length));
}

// The label a note shows: "#12" or "Before patch notes".
export const noteLabel = n => n.pr ? '#' + n.pr : 'Before patch notes';
