// Voices: the page speaks each public line as it arrives, through the relay's local speech engine (scripts/providers/tts.mjs,
// Kokoro on the owner's machine; no text leaves it). Off on the first visit, remembered per browser; the first click on the
// toggle also unlocks the browser's audio. One clip at a time, in order:
//   a line said in the Square          in the speaker's voice
//   narration, dawn, nominations,      in the Storyteller's voice
//   vote results, executions, the win
//   night falls, a round, nominations, the day ends, who went to which room   in the Storyteller's voice (#82)
//   a name tag before a seat's line    in the Storyteller's voice, when the names tick is on (default): "Odette." / "Odette, in the Snug."
//   whispers                           in the whisperer's voice, only when the owner ticks them (off by default)
//   the night (#111)                   in the Storyteller's voice: who it wakes, what they choose, what it tells them, a death, a
//                                      bounced kill (nightSpoken); the page's own clip at once (the relay makes none for these)
//   a seat's thought before dawn       in the seat's voice, after the tag "Odette, thinking."; never dropped at night
// The speaking seat's marker is lit while its clip plays (the square's centre for the Storyteller). Skip ends the clip playing;
// Mute hushes it, drops what waits and holds new lines until unmuted. The queue holds a few lines at most: past that the oldest
// talk is dropped first (the Storyteller's lines last), so the voice never falls far behind the game at the readable pace.
// Who sounds like whom: GET /tts/status carries the seat voice map as seatVoices; src/data/voices.js (the lore-keeper's) when the
// relay does not; else the engine's default voice. With no engine the toggle says so once and stays off. The recorded game
// (?fixture) sends nothing to the relay, so it is not spoken.
// The page follows the ear (#103): while lines wait, src/ui/app.js draws the frame before the first of them; state.behind says so
// and the note adds "the page keeps pace". The line playing joins the picture only when its own clip begins (state.now.started, #109).
// Keeping time (#50): when the relay makes the clips itself (/tts/status clipsOnSay), a spoken event carries clip: {id, ms} in the
// watch body, or the socket sends {type: 'clip', id: <event id>, clip} a moment after the push; the page plays GET /tts?id=<clip.id>
// and asks POST /tts/say itself only when no clip has come within about a second (whispers never have one). The page tells the relay
// what it has heard: POST /play/heard {last, voice} on each clip's end or skip and every 20 s while the voice is on, and voice: false
// at once on Voice off or Mute; the relay lets a seat's next speaking turn wait a moment while the voices are behind.
import {seatNames, roleName} from './model.js';
import * as SPOKEN from '../data/spoken.js';

export const VOICE_KEY = 'clocktower.voice';
export const WHISPER_KEY = 'clocktower.voice.whispers';
export const NAMES_KEY = 'clocktower.voice.names'; // the name tag before a seat's line (#82): on unless the owner unticks it
export const QUEUE_CAP = 4; // lines waiting behind the one playing
export const HEARD_MS = 20000; // the heard report's heartbeat (the relay counts a report fresh for 90 s)
export const CLIP_WAIT_MS = 1000; // how long a line waits for the relay's clip before the page asks for its own
const defaultTick = (f, ms) => {const t = setInterval(f, ms); if (t && t.unref) t.unref(); return () => clearInterval(t)};
const STORYTELLER_LINES = new Set(SPOKEN.STORYTELLER_SPOKEN); // shared with the relay (src/data/spoken.js)
// What a seat says aloud in its own voice: 'say', and its night 'thought' (#111). The rules-keeper's list in src/data/spoken.js when it
// is there (its name is read behind a guard), else these two.
const SEAT_LINES = new Set([...(SPOKEN.SEAT_SPOKEN || SPOKEN.SEAT_SPOKEN_KINDS || SPOKEN.SEAT_LINES || []), 'say', 'thought']);
const TALK = new Set(['say', 'whisper']); // dropped first when the queue is full by day
const TAGGED = new Set(['say', 'whisper', 'thought']); // a name tag goes before these
const NIGHT = new Set(['thought', 'night']); // the night told and the seats' thoughts (#111): never dropped, never counted in the cap
const OWN = new Set(['whisper', 'night']); // the relay never makes a clip for these: the page asks its own at once

// The night told aloud (#111), in the Storyteller's voice: a night event in plain prose for the watcher, or null. names: seat -> name;
// seats: the grimoire's seats when known (a Drunk woken as the role it believes is named as what it truly is).
// A verb per role whose choice has one; the rest pick.
export const NIGHT_VERBS = {poisoner: 'poisons', monk: 'guards', imp: 'chooses', 'fortune-teller': 'checks', ravenkeeper: 'chooses', butler: 'picks'};
const NAMED = new Set(['poisoner', 'monk']); // the verb already says who they are: "Yusuf poisons Bram."
export function nightSpoken(e, names = [], seats = null) {
  if (!e || e.phase !== 'night' && !['wake', 'acted', 'bounce', 'thought'].includes(e.type)) return null;
  const n = i => names[i] ?? `seat ${i}`;
  const list = v => (Array.isArray(v) ? v : [v]).filter(x => x != null).map(x => typeof x === 'number' ? n(x) : roleName(x));
  const and = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a.at(-1);
  switch (e.type) {
    case 'wake': {
      if (!Number.isInteger(e.seat)) return null;
      const truly = seats && seats.find(x => x.seat === e.seat), role = e.role ? roleName(e.role) : '';
      const drunk = truly && truly.role && e.role && truly.role !== e.role ? `, who is truly the ${roleName(truly.role)}` : '';
      return `The Storyteller wakes ${n(e.seat)}${role ? `, the ${role}` : ''}${drunk}.`;
    }
    case 'acted': {
      if (!Number.isInteger(e.seat)) return null;
      const verb = NIGHT_VERBS[e.role] || 'picks', who = and(list(e.target ?? e.targets)) || 'nobody';
      const tail = e.role === 'butler' ? ' as master' : '';
      return NAMED.has(e.role) ? `${n(e.seat)} ${verb} ${who}.` : `${n(e.seat)}${e.role ? `, the ${roleName(e.role)},` : ''} ${verb} ${who}${tail}.`;
    }
    case 'told': {
      if (!Number.isInteger(e.seat) || typeof e.text !== 'string' || !e.text.trim()) return null;
      return `The Storyteller tells ${n(e.seat)}: ${e.text.trim()}`;
    }
    case 'death': return Number.isInteger(e.seat) ? `${n(e.seat)} dies.` : null;
    case 'bounce': return Number.isInteger(e.from) && Number.isInteger(e.to) ? `The kill passes from ${n(e.from)} to ${n(e.to)}.` : null;
    case 'thought': return Number.isInteger(e.seat) && typeof e.text === 'string' && e.text.trim() ? `${n(e.seat)} thinks: ${e.text.trim()}` : null;
  }
  return null;
}

// What a log entry says aloud and who says it: {speaker: seat number | 'storyteller', text, kind}, or null for a silent one.
export function spokenLine(e, {whispers = false} = {}) {
  if (!e || typeof e.text !== 'string' || !e.text.trim()) return null;
  if (e.type === 'say' && Number.isInteger(e.seat)) return {speaker: e.seat, text: e.text, kind: 'say'};
  if (e.type !== 'say' && SEAT_LINES.has(e.type) && Number.isInteger(e.seat)) return {speaker: e.seat, text: e.text, kind: e.type}; // a night thought (#111)
  if (e.type === 'whisper') return whispers && Number.isInteger(e.from) ? {speaker: e.from, text: e.text, kind: 'whisper'} : null;
  if (e.type === 'death') return e.phase === 'day' ? {speaker: 'storyteller', text: e.text, kind: 'death'} : null; // a night death is the Storyteller's secret until dawn
  if (STORYTELLER_LINES.has(e.type)) return {speaker: 'storyteller', text: e.text, kind: e.type};
  return null;
}

// A voice map entry ('bm_daniel' or {voice, speed}) -> {voice, speed}
const voiceEntry = v => typeof v === 'string' ? {voice: v, speed: 1} : v && typeof v === 'object' && typeof v.voice === 'string' ? {voice: v.voice, speed: Number(v.speed) || 1} : null;
export function voiceFor(name, ...maps) {
  for (const m of maps) if (m && typeof m === 'object') {const e = voiceEntry(m[name]) || voiceEntry(m.default); if (e) return e}
  return {voice: null, speed: 1}; // the engine's default voice
}
// The lore-keeper's map, when the file is there (read behind a guard: the page plays without it).
export async function loadVoiceFile() {
  try {const p = '../data/voices.js'; const m = await import(/* @vite-ignore */ p); const v = m.SEAT_VOICES || m.VOICES || m.default; return v && typeof v === 'object' ? v : null}
  catch {return null}
}

// A moment of silence, played from the toggle's click so the browser lets the page play sound afterwards.
function silentWav() {
  const n = 64, b = new Uint8Array(44 + n), dv = new DataView(b.buffer), s = (o, t) => [...t].forEach((c, i) => {b[o + i] = c.charCodeAt(0)});
  s(0, 'RIFF'); dv.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); s(36, 'data'); dv.setUint32(40, n, true);
  b.fill(128, 44);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...b));
}
const store = () => {try {return globalThis.localStorage || null} catch {return null}};
const read = k => {try {const s = store(); return s ? s.getItem(k) : null} catch {return null}};
const write = (k, v) => {try {const s = store(); if (s) s.setItem(k, v)} catch {}};
const defaultAudio = () => typeof Audio === 'function' ? new Audio() : null;

export function createVoice({client, audio = defaultAudio(), onSpeaker = () => {}, onChange = () => {}, cap = QUEUE_CAP, recorded = false, voiceFile = loadVoiceFile,
  tick = defaultTick, heardEvery = HEARD_MS, clipWait = CLIP_WAIT_MS}) {
  const st = {on: false, whispers: read(WHISPER_KEY) === 'on', names: read(NAMES_KEY) !== 'off', places: null, muted: false, blocked: false, engine: null, note: '', queue: [], now: null,
    key: null, seen: -1, dropped: 0, fails: 0, saidNoEngine: false, checking: false, heard: -1, reporting: false, sentOn: false, behind: false};
  let finish = null, fileMap = null, fileLoaded = null;
  // the relay's clips by event id, and the lines waiting for theirs
  const clips = new Map(), waiting = new Map();
  function clip(eventId, c) {
    if (!Number.isInteger(eventId) || !c || typeof c.id !== 'string' || !c.id) return;
    clips.set(eventId, {id: c.id, ms: c.ms});
    const w = waiting.get(eventId); if (w) w();
    if (clips.size > 64) for (const k of clips.keys()) {if (clips.size <= 32) break; clips.delete(k)} // the oldest first
  }
  // The heard mark: the newest event finished or skipped; with nothing playing or waiting, everything seen so far.
  const live = () => st.on && !st.muted && !recorded;
  const mark = () => !st.now && !st.queue.length ? Math.max(st.heard, st.seen) : st.heard;
  async function report(voice = live()) {
    if (recorded || !client.heard) return;
    const last = mark();
    if (last < 0 || (!voice && !st.sentOn)) return; // no game yet; or nothing to take back
    if (voice) st.sentOn = true; else st.sentOn = false;
    const r = await client.heard({last, voice});
    const ok = voice && live() && !!r && r.ok !== false;
    if (ok !== st.reporting) {st.reporting = ok; changed()}
  }
  const heardDone = item => {st.heard = Math.max(st.heard, item.id)};
  const stopTick = recorded ? () => {} : tick(() => {if (live()) report()}, heardEvery);
  const changed = () => onChange(st);
  const say = m => {st.note = m; changed()};
  const nameOf = (speaker, names) => speaker === 'storyteller' ? 'Storyteller' : names[speaker] ?? `seat ${speaker}`;

  async function check() {
    if (!fileLoaded) fileLoaded = Promise.resolve(voiceFile ? voiceFile() : null).then(m => {fileMap = m}, () => {});
    const [s] = await Promise.all([client.ttsStatus(), fileLoaded]);
    st.engine = s && typeof s === 'object' ? s : null;
    return !!(st.engine && st.engine.ok === true);
  }
  function unlock() {
    if (!audio) return;
    try {audio.onended = null; audio.onerror = null; audio.src = silentWav(); const p = audio.play(); if (p && p.catch) p.catch(() => {})} catch {}
  }
  async function turnOn({click = false} = {}) {
    if (recorded) {say('The recorded game is read, not spoken: voices play in the live game.'); return false}
    if (click) {unlock(); st.blocked = false}
    if (st.checking) return false;
    st.checking = true;
    let ok = false;
    try {ok = await check()} finally {st.checking = false}
    if (!ok) {
      st.on = false; write(VOICE_KEY, 'off');
      const e = st.engine || {}, why = e.down ? 'the relay is not answering' : e.missing ? 'this relay has no voice route' : e.error || '';
      st.hint = e.hint || '';
      if (!st.saidNoEngine) {st.saidNoEngine = true; st.note = 'No voice engine is answering: the page stays silent.' + (why ? ` (${why})` : '')}
      changed(); return false;
    }
    st.on = true; st.muted = false; st.fails = 0; st.note = ''; write(VOICE_KEY, 'on'); changed(); pump(); report();
    return true;
  }
  function clear() {
    st.queue = [];
    if (st.now) {st.now = null; try {audio && audio.pause()} catch {} const f = finish; finish = null; if (f) f()}
    onSpeaker(null);
  }
  function turnOff() {st.on = false; write(VOICE_KEY, 'off'); clear(); st.reporting = false; changed(); report(false)}
  async function toggle() {
    if (st.on && st.blocked) {unlock(); st.blocked = false; st.note = ''; changed(); pump(); return true}
    if (st.on) {turnOff(); return false}
    return turnOn({click: true});
  }
  function skip() {
    if (!st.now) return;
    heardDone(st.now); st.now = null; try {audio && audio.pause()} catch {}
    const f = finish; finish = null; onSpeaker(null); if (f) f();
    changed(); pump(); report();
  }
  function mute() {
    st.muted = !st.muted;
    if (st.muted) {clear(); st.reporting = false}
    changed(); report();
  }
  function setWhispers(on) {st.whispers = !!on; write(WHISPER_KEY, on ? 'on' : 'off'); changed()}
  function setNames(on) {st.names = !!on; write(NAMES_KEY, on ? 'on' : 'off'); changed()}
  // The name tag (#82): the Storyteller says who speaks before a seat's line: "Odette." at the Square, "Odette, in the Snug." in a room,
  // "Odette, to Bram." for a whisper. Cached per text on the page (seven tags cover a Square game); the relay's /tts/say caches the audio too.
  const tags = new Map();
  function tagText(l, e, names) {
    const who = nameOf(l.speaker, names);
    if (l.kind === 'whisper') return Number.isInteger(e.to) ? `${who}, to ${nameOf(e.to, names)}.` : `${who}.`;
    if (l.kind === 'thought') return `${who}, thinking.`;
    if (e.room == null) return `${who}.`;
    const r = st.places && Array.isArray(st.places.rooms) ? st.places.rooms.find(x => x.id === e.room) : null;
    return `${who}, in ${r && r.name ? r.name : 'a room'}.`;
  }
  function tagClip(text) {
    if (!tags.has(text)) {
      const v = voiceFor('Storyteller', st.engine && st.engine.seatVoices, fileMap);
      tags.set(text, Promise.resolve().then(() => client.ttsSay({text, ...(v.voice ? {voice: v.voice} : {}), speed: v.speed})).then(r => {if (!r || !r.id) tags.delete(text); return r}, () => {tags.delete(text); return null}));
    }
    return tags.get(text);
  }

  // New log entries from the frame the page holds. The first game seen sets the mark (nothing already said is spoken); a new game
  // after it is spoken from its start, the queue's cap keeping only its newest lines.
  function feed(w, epoch = 0) {
    if (!w || !Array.isArray(w.events)) return;
    const key = w.seed + ':' + epoch, last = w.events.reduce((m, e) => Math.max(m, e.id), -1);
    if (st.key !== key) {const first = st.key == null; st.key = key; st.seen = first ? last : -1; st.heard = -1; if (!first) {clear(); clips.clear()}}
    const fresh = w.events.filter(e => e.id > st.seen);
    if (!st.now && !st.queue.length) st.heard = Math.max(st.heard, st.seen); // idle: everything before these was heard
    st.seen = Math.max(st.seen, last);
    for (let i = w.events.length - 1; i >= 0 && w.events[i].id > st.heard; i--) if (w.events[i].clip) clip(w.events[i].id, w.events[i].clip);
    if (!st.on || st.muted || !fresh.length) return;
    const names = seatNames(w); if (w.places) st.places = w.places;
    const seats = w.grimoire && w.grimoire.seats;
    for (const e of fresh) {
      let l = spokenLine(e, {whispers: st.whispers});
      if (!l) {const t = nightSpoken(e, names, seats); if (t && e.type !== 'thought') l = {speaker: 'storyteller', text: t, kind: 'night'}} // the night told (#111)
      if (l) st.queue.push({...l, id: e.id, name: nameOf(l.speaker, names), ...(st.names && TAGGED.has(l.kind) ? {tag: tagText(l, e, names)} : {})});
    }
    // the cap holds the day's lines; the night's (its telling and the thoughts) are all read, the picture waiting with the ear (#103)
    const capped = () => st.queue.reduce((k, x) => k + (NIGHT.has(x.kind) ? 0 : 1), 0);
    while (capped() > cap) {let i = st.queue.findIndex(x => TALK.has(x.kind)); if (i < 0) i = st.queue.findIndex(x => !NIGHT.has(x.kind)); st.queue.splice(i, 1); st.dropped++}
    changed(); pump();
  }

  // The clip for a line: the relay's when it has made one (asked for at once, or waited for up to clipWait when the relay makes
  // clips), else one the page asks for itself. item.via says which: 'clip' or 'say'.
  function synth(item) {
    if (item.clip) return item.clip;
    const own = () => {const v = voiceFor(item.name, st.engine && st.engine.seatVoices, fileMap); item.voice = v.voice; item.via = 'say'; return client.ttsSay({text: item.text, ...(v.voice ? {voice: v.voice} : {}), speed: v.speed})};
    const relays = () => {const c = clips.get(item.id); if (c) {item.via = 'clip'; return {id: c.id, ms: c.ms}} return null};
    const waits = !OWN.has(item.kind) && !!(st.engine && st.engine.clipsOnSay) && clipWait > 0;
    if (relays() || !waits) {item.clip = Promise.resolve(relays() || own()); return item.clip}
    item.clip = new Promise(res => {
      let done = false, t = null;
      const end = () => {if (done) return; done = true; clearTimeout(t); waiting.delete(item.id); res(relays() || own())};
      waiting.set(item.id, end); t = setTimeout(end, clipWait);
    });
    return item.clip;
  }
  // onStart: called once the browser has begun the clip (play()'s promise resolves), not when it is asked for
  function play(src, onStart = null) {
    return new Promise(res => {
      finish = res;
      if (!audio) {if (onStart) onStart(); res(); return}
      audio.onended = () => res(); audio.onerror = () => res();
      try {
        audio.src = src;
        const p = audio.play();
        if (onStart) {if (p && p.then) p.then(() => {if (finish === res) onStart()}, () => {}); else onStart()}
        if (p && p.catch) p.catch(err => {
          if (err && err.name === 'NotAllowedError') {st.blocked = true; st.queue = []; say('The browser held the sound back: click Voice once to let the page speak.')}
          res();
        });
      } catch {res()}
    });
  }
  async function pump() {
    if (st.now || !st.on || st.muted || st.blocked) return;
    const item = st.queue.shift();
    if (!item) {onSpeaker(null); changed(); return}
    st.now = item; changed();
    const clip = synth(item);
    if (st.queue[0]) {synth(st.queue[0]); if (st.queue[0].tag) tagClip(st.queue[0].tag)} // the engine makes the next clip while this one plays
    const tag = item.tag ? tagClip(item.tag) : null; // the name tag counts as part of the line: the heard mark moves when the line has played
    let r = null; try {r = await clip} catch {}
    if (st.now !== item) return; // skipped, muted or turned off meanwhile
    if (!r || !r.id) {
      heardDone(item); st.now = null;
      if (++st.fails >= 2) {turnOff(); say('The voice engine stopped answering: voices are off.' + (r && r.error ? ` (${r.error})` : ''))}
      else {changed(); pump()}
      return;
    }
    st.fails = 0;
    if (tag) {
      let t = null; try {t = await tag} catch {}
      if (st.now !== item) return;
      if (t && t.id) {onSpeaker('storyteller'); changed(); await play(client.ttsClipUrl(t.id)); if (st.now !== item) return}
    }
    // the line counts as shown (src/ui/app.js pickShown) and its speaker lights only once its own clip has begun (#109): not while
    // the clip is fetched, nor while its name tag plays
    await play(client.ttsClipUrl(r.id), () => {if (st.now !== item) return; item.started = true; onSpeaker(item.speaker); changed()});
    if (st.now !== item) return;
    heardDone(item); st.now = null; onSpeaker(null); changed(); pump(); report();
  }

  // On load: remembered on means try again (the browser may still hold the sound back until a click on the toggle).
  const ready = read(VOICE_KEY) === 'on' && !recorded ? turnOn() : Promise.resolve(false);
  return {state: st, toggle, turnOn, turnOff, skip, mute, setWhispers, setNames, feed, ready, clip, report, mark, stop: stopTick};
}

// The game bar's controls: the toggle, skip, mute, whispers and one line of note.
export function voiceBar(voice, els) {
  const {toggle, skip, mute, whispers, names, note, box, time} = els;
  if (toggle) toggle.addEventListener('click', () => voice.toggle());
  if (skip) skip.addEventListener('click', () => voice.skip());
  if (mute) mute.addEventListener('click', () => voice.mute());
  if (whispers) {whispers.checked = voice.state.whispers; whispers.addEventListener('change', () => voice.setWhispers(whispers.checked))}
  if (names) {names.checked = voice.state.names; names.addEventListener('change', () => voice.setNames(names.checked))}
  return function render(st = voice.state) {
    if (toggle) {
      const t = st.on ? (st.blocked ? 'Voice: click to hear' : 'Voice: on') : 'Voice: off';
      if (toggle.textContent !== t) toggle.textContent = t;
      toggle.setAttribute('aria-pressed', st.on ? 'true' : 'false');
      toggle.title = st.on ? 'Click to stop the voices' : 'Click to hear each line spoken (the local voice engine)';
    }
    if (box) box.dataset.state = !st.on ? 'off' : st.muted ? 'muted' : st.now ? 'speaking' : 'on';
    if (skip) {skip.hidden = !st.on; skip.disabled = !st.now}
    if (mute) {mute.hidden = !st.on; const m = st.muted ? 'Unmute' : 'Mute'; if (mute.textContent !== m) mute.textContent = m}
    if (whispers && whispers.parentNode) whispers.parentNode.hidden = !st.on;
    if (names && names.parentNode) names.parentNode.hidden = !st.on;
    if (time) time.hidden = !(st.on && !st.muted && st.reporting && st.engine && st.engine.clipsOnSay);
    if (note) {
      const n = st.note || (st.on && st.now ? `${st.now.name}${st.queue.length ? `, ${st.queue.length} waiting` : ''}${st.behind && st.queue.length ? '; the page keeps pace' : ''}` : '');
      if (note.textContent !== n) note.textContent = n;
      note.title = st.hint || st.note || (st.behind ? 'The page keeps pace with the voices: it shows what has been said, and catches up with the game as the waiting lines are read.' : '');
      if (box) box.dataset.behind = st.behind ? 'yes' : 'no';
    }
  };
}
