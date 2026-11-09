// The watcher page's smoke (npm run uismoke): index.html's body in a stubbed DOM (scripts/stubdom.mjs), the page's app
// (src/ui/app.js) against a fake relay that answers from the recorded game (src/ui/fixtures/game.json, npm run uifixture) and the
// recorded supervisor (src/ui/fixtures/runners.json). Checks:
//   - without the watcher route the page says so and offers the recorded game; "No game yet" shows
//   - every panel renders from the recording; the circle has seven seats in seat order
//   - a vote shows the nominee and the nominator, each hand as cast (yes raised, no lowered, not yet blank) and the tally
//   - whispers render as "A leaned in to B" with the text beneath, marked as unheard by the table; the Storyteller's narration and
//     scripted rulings are marked
//   - the talk keeps its scroll position and its rows when new lines arrive while scrolled up, and one click follows again
//   - the agents panel renders a row per seat and the Storyteller with their states; the resume button only when paused
//   - start, stop, stop all, start all and resume post to the supervisor's routes with the right bodies; an open "last turn" stays open
//   - the live push: a pushed event lands in the talk once (deduped by id), each pushed ballot raises or lowers its hand, the page
//     reads ?since=last when the socket opens (pushes that land meanwhile wait for it) and polls only while the socket is down
//   - the pace knob starts on "readable" and every start (one seat, start all) carries its minGap and heartbeat
//   - nothing on the page posts to a seat's routes (/play/call, /play/storyteller, /play/narrate, /mcp), at run time or in the code
//   - the recorded game as the page's ?fixture mode sends nothing; a fresh recording from today's engine renders too
//   - the owner's own token images: a PNG, then a WebP, looked for once per id per page load; the drawn token wherever none loads;
//     the shroud image over the dead; the game bar counts them; nothing in public/tokens-local is tracked but its README
//   - portraits (a fixture assets/portraits/index.json): in each seat's disc, the initial without one, the shroud over the dead,
//     beside each agent row and in the Storyteller's log; no index, or a broken one, and the page carries on
//   - voices (a fake engine and a fake audio element): off on a first visit and nothing posted; one click on, remembered; lines read
//     in order one at a time in their speaker's voice, the speaker lit; whispers only when asked; the queue capped; skip, mute;
//     no engine: says so once and stays off; the recorded game is not spoken
//   - keeping time (#50): the relay's clip played when the event or the socket brings one, the page's own clip after a second without;
//     whispers on the page's own path; POST /play/heard {last, voice} on each clip end, each skip and the 20 s tick, voice false at once
//     on mute and off, nothing posted while the voice is off; the "keeping time" mark while the page reports
//   - following the voices (#103): with lines waiting, a move, a vote's result and the talk wait until they are read; hands land at
//     once; the line playing shows only once its own clip has begun, not while it is made or its name tag plays (#109); Mute and Voice off show the live game; the recorded game is unaffected; the pick of the shown frame on a hand-made ring
//   - the night aloud (#111): the night's prose (nightSpoken) for each kind; told at once in the Storyteller's voice on the page's own
//     clip; a thought after its tag in its seat's voice, its card lit with an italic caption; nothing dropped at night; Voice off
//     speaks nothing and still lists the night; the recorded night (?fixture=night) with its hand-made thoughts
//   - rooms (#28): a line said in a room carries its place, a move is a one-line mark; in the square, a seat away carries its room's
//     name, the rooms show as discs off the table with their occupants, one line says who is where; all of it goes when the rooms close
//   - the People view (#77): the default, the Table view one click away and remembered; seven cards in seat order with the role in a
//     corner; a pushed line lights its speaker with the line beside the face, the line before goes down into the strip; whispers and
//     room lines marked; the vote on the faces and the tally against its bar; the result flashed; night dims and wakes the Storyteller;
//     dawn large; the dead shrouded in place; drawers open without unmounting the stage; the roles switch; the phone layout; no control
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {install} from './stubdom.mjs';
import {record, FIXTURE_SEED} from './uifixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const GAME = JSON.parse(readFileSync(join(ROOT, 'src/ui/fixtures/game.json'), 'utf8'));
const RUN = JSON.parse(readFileSync(join(ROOT, 'src/ui/fixtures/runners.json'), 'utf8'));
const {createApp} = await import('../src/ui/app.js');
const {relayClient, ACTIONS, READS} = await import('../src/ui/relay.js');
const {PACES} = await import('../src/ui/model.js');
const tick = () => new Promise(r => setTimeout(r, 0));

let fails = 0;
const ok = (c, m) => {console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++};
const copy = v => JSON.parse(JSON.stringify(v));
const FORBIDDEN = /\/play\/call|\/play\/storyteller|\/play\/narrate|\/mcp\b/;
const BASE = 'http://127.0.0.1:8787';

// A fake relay: GET answers from the recordings, POST records the body. watch: the frame /play/watch serves (null: 404).
function fakeRelay() {
  const r = {calls: [], posts: [], watch: null, runners: copy(RUN.runners)};
  r.fetch = async (url, opt = {}) => {
    const path = String(url).replace(BASE, '').split('?')[0];
    r.calls.push({path, method: opt.method || 'GET'});
    const res = (status, body) => ({ok: status < 400, status, json: async () => copy(body)});
    if ((opt.method || 'GET') === 'POST') {r.posts.push({path, body: JSON.parse(opt.body || '{}')}); return res(200, {ok: true})}
    if (path === READS.health) return res(200, {ok: true});
    if (path === READS.runners) return res(200, r.runners);
    if (path === READS.watch) {
      if (!r.watch) return res(404, {error: 'not found'});
      const since = Number(new URL(url).searchParams.get('since') ?? -1);
      return res(200, {...r.watch, events: r.watch.events.filter(e => e.id > since)});
    }
    return res(404, {error: 'not found'});
  };
  return r;
}
const $ = id => document.getElementById(id);
const texts = nodes => nodes.map(n => n.textContent);

// ---- live, the route missing ----
console.log('live page, no watcher route yet');
install(HTML);
let relay = fakeRelay();
let app = createApp({client: relayClient({base: BASE, fetchImpl: relay.fetch}), seed: 13});
await app.pollHealth(); await app.pollWatch(); await app.pollRunners();
ok(!$('empty').hidden && /No game yet/.test($('empty').textContent), '"No game yet" shows before a game arrives');
ok(/does not send the game/.test($('source').textContent) && !!$('source').querySelector('a[href="?fixture"]'), 'the page says the relay does not send the game yet and links the recorded game');
ok($('relay-state').dataset.state === 'connected', 'the relay state reads connected');
ok($('seed').value === '13', 'the seed field shows the launcher seed');
ok($('new-game').disabled && /asked of the backend/.test($('new-game').title), 'New game is off, with a tooltip, until the relay can start a game');

// ---- the talk frame ----
console.log('day 1, talking');
relay.watch = GAME.frames.talk;
await app.pollWatch();
const w = GAME.frames.talk, names = w.grimoire.seats.map(s => s.name);
ok($('empty').hidden, '"No game yet" hides once the game arrives');
ok(/day \d+, round \d of 2/.test($('phase').textContent), `the game bar shows the phase and clock (${$('phase').textContent})`);
const seats = document.querySelectorAll('#square .seat');
ok(seats.length === 7, 'the circle has seven seats');
ok(JSON.stringify(seats.map(s => s.querySelector('.name').textContent)) === JSON.stringify(names), 'the seats sit in seat order, clockwise from the top');
ok(seats.every(s => /ST sees/.test(s.textContent) && s.querySelector('.role')), 'each seat shows its true role, marked as what the Storyteller sees');
const drunk = w.grimoire.seats.find(s => s.role === 'drunk'), thinks = drunk && drunk.believed.replace(/-/g, ' ');
ok(!!drunk && /drunk/.test(seats[drunk.seat].textContent) && new RegExp('thinks ' + thinks, 'i').test(seats[drunk.seat].textContent), 'the Drunk shows as drunk, with the role it thinks it is');
const talk = $('talk').querySelector('.lines');
const says = talk.querySelectorAll('.line.say'), sayEv = w.events.filter(e => e.type === 'say');
ok(says.length === sayEv.length && says.length > 0, `every line said shows in the talk (${says.length})`);
ok(says[0].querySelector('.who').textContent === names[sayEv[0].seat] && says[0].textContent.includes(sayEv[0].text), 'a line shows its speaker and its words');
ok(says.every((l, i) => l.querySelector('.who').classList.contains('sc-' + sayEv[i].seat)) && new Set(sayEv.map(e => e.seat)).size > 1, 'each speaker has the colour of their seat, the same in every line');
{const css = readFileSync(join(ROOT, 'styles/page.css'), 'utf8');
  ok([0, 1, 2, 3, 4, 5, 6].every(i => css.includes(`.who.sc-${i}`)) && /@media \(max-width: 600px\)[\s\S]*overflow-x: clip/.test(css), 'the page has a colour for each of the seven seats and a phone layout that never scrolls sideways');}
const wh = talk.querySelectorAll('.line.whisper'), whEv = w.events.filter(e => e.type === 'whisper');
ok(wh.length === whEv.length && wh.length > 0, `whispers show inline (${wh.length})`);
ok(wh.length > 0 && wh[0].querySelector('.lean').textContent.includes(`${names[whEv[0].from]} leaned in to ${names[whEv[0].to]}`) && wh[0].querySelector('.text').textContent === whEv[0].text && /did not hear/.test(wh[0].textContent),
  'a whisper reads "A leaned in to B", its text beneath, marked as unheard by the table');
ok(talk.querySelectorAll('.line.break').length >= 2 && talk.querySelectorAll('.line.narration').length >= 1, 'phase breaks and the Storyteller\'s narration show');
ok(talk.querySelectorAll('.line.told').length > 0, 'what each seat was told shows, marked private');
ok(talk.scrollTop === talk.scrollHeight && $('talk').querySelector('.follow').hidden, 'the talk follows the newest line');
const grows = document.querySelectorAll('#grimoire .grim-row');
ok(grows.length === 7 && new RegExp('believes ' + thinks, 'i').test(grows[drunk.seat].textContent) && /drunk/.test(grows[drunk.seat].textContent), 'the grimoire lists every seat, the believed role when it differs and the tokens');
ok(/Demon's bluffs/.test($('grimoire').textContent) && w.grimoire.bluffs.every(b => new RegExp(b.replace(/-/g, ' '), 'i').test($('grimoire').querySelector('.grim-foot').textContent)), 'the grimoire shows the demon\'s bluffs');
ok(/Waiting on/.test($('grimoire').textContent), 'the grimoire shows what the game waits on');
const rul = $('rulings').querySelectorAll('.ruling');
ok(rul.length === w.rulings.length && rul.length > 0, `every ruling shows in the Storyteller's log (${rul.length})`);
ok(rul.filter(r => r.classList.contains('scripted')).length === w.rulings.filter(r => /^scripted default/.test(r.reason)).length && rul.some(r => r.classList.contains('scripted')), 'scripted-default rulings are marked');
ok(rul[0].querySelector('.why').textContent === w.rulings[0].reason, 'a ruling shows its reason');

// ---- our own tokens ----
console.log('tokens');
{
  const {SCRIPT} = await import('../src/data/script.js');
  const T = await import('../src/ui/tokens.js');
  const missing = SCRIPT.roles.filter(r => !T.ROLE_ICONS[r.id]).map(r => r.id);
  ok(missing.length === 0, `every role in the script has a token icon${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''} (${SCRIPT.roles.length})`);
  const box = document.createElement('div');
  box.innerHTML = SCRIPT.roles.map(r => T.roleToken(r.id, {name: r.name, team: r.team})).join('');
  const toks = box.querySelectorAll('svg.role-token');
  ok(toks.length === SCRIPT.roles.length && toks.every((t, i) => t.dataset.role === SCRIPT.roles[i].id && t.textContent.includes(SCRIPT.roles[i].name) && t.classList.contains('team-' + SCRIPT.roles[i].team)),
    'each role token carries its name and its team\'s rim');
  ok(['poisoned', 'is-the-drunk', 'protected', 'master', 'red-herring', 'dead'].every(k => T.REMINDER_ICONS[k]), 'reminder discs exist for poisoned, drunk, protected, master, red herring and dead');
  const src = readFileSync(join(ROOT, 'src/ui/tokens.js'), 'utf8');
  ok(!/\.png|\.jpe?g|\.webp|https?:\/\//i.test(src), 'the tokens are drawn by hand: no image file and no outside link');
  const markers = document.querySelectorAll('#square .seat .seat-marker');
  ok(markers.length === 7 && JSON.stringify(markers.map(m => m.querySelector('.name').textContent)) === JSON.stringify(names), 'the square renders seven seat markers round the table, in seat order');
  ok(document.querySelectorAll('#square .seat .role-token').every((t, i) => t.dataset.role === w.grimoire.seats[i].role), 'each seat shows its true role as a token');
  const rem = document.querySelectorAll('#grimoire .grim-row .reminder-token');
  const want = w.grimoire.seats.reduce((n, s) => n + s.tokens.length + (s.alive ? 0 : 1), 0);
  ok(rem.length === want && want > 0, `reminders render in the grimoire as discs (${rem.length})`);
  ok(document.querySelectorAll('#grimoire .grim-row .role-token').length === 7, 'every grimoire row shows its role token');
}

// ---- the vote frame ----
console.log('day 1, a vote');
relay.watch = GAME.frames.vote;
const talkFirst = talk.firstChild;
await app.pollWatch();
const v = GAME.frames.vote, votes = v.ballot.votes, p = v.pending;
const sq = () => document.querySelectorAll('#square .seat');
ok(sq()[p.nominee].querySelector('.mark.nominee') && sq()[p.nominator].querySelector('.mark.nominator'), `the nominee (${names[p.nominee]}) and the nominator (${names[p.nominator]}) are marked`);
const yes = Object.values(votes).filter(Boolean).length, no = Object.values(votes).filter(x => !x).length, waiting = p.seats.length - Object.keys(votes).length;
ok(document.querySelectorAll('#square .hand.up').length === yes && document.querySelectorAll('#square .hand.down').length === no && document.querySelectorAll('#square .hand.none').length === waiting,
  `hands as cast: ${yes} raised, ${no} lowered, ${waiting} not yet`);
for (const [i, x] of Object.entries(votes)) ok(!!sq()[i].querySelector(x ? '.hand.up' : '.hand.down'), `${names[i]}'s hand is ${x ? 'raised' : 'lowered'}`);
const need = Math.ceil(v.grimoire.seats.filter(s => s.alive).length / 2);
ok(new RegExp(`${yes}\\s*yes of\\s*${need}\\s*needed`).test($('square').querySelector('.centre').textContent.replace(/\s+/g, ' ')), `the tally reads ${yes} yes of ${need} needed`);
ok(talk.firstChild === talkFirst, 'the talk kept its rows (appended, not rebuilt)');

// ---- scrolled up while the game goes on ----
console.log('the owner scrolls up; the game goes on');
talk.scrollTop = 0; talk.dispatch('scroll');
const btn = $('talk').querySelector('.follow');
ok(!btn.hidden, 'scrolled up: the follow button shows');
const before = talk.children.length, reading = talk.children[0];
relay.watch = GAME.frames.end;
await app.pollWatch();
ok(talk.children.length > before && talk.scrollTop === 0 && talk.children[0] === reading, `new lines arrived (${talk.children.length - before}) and the talk stayed where the owner was reading`);
ok(/new below/.test(btn.textContent), `the button counts what is new (${btn.textContent})`);
btn.click();
ok(talk.scrollTop === talk.scrollHeight && btn.hidden, 'one click follows the newest again');
ok(talk.querySelectorAll('.line.win').length === 1 && !$('winner').hidden, 'the end: the winner shows in the talk and the game bar');
ok(talk.querySelectorAll('.line.nomination').length === GAME.frames.end.events.filter(e => e.type === 'nomination').length, 'every nomination shows');

// ---- asides from the socket ----
app.onSocket({type: 'narrate', player: 2, text: 'Bram drums his fingers.'});
ok(talk.lastChild.classList.contains('aside') && /Bram's aside, for you only/.test(talk.lastChild.textContent), 'a runner\'s narration shows as an aside, marked as the watcher\'s only');

// ---- the live push ----
console.log('the live push');
{
  install(HTML);
  const pr = fakeRelay();
  const papp = createApp({client: relayClient({base: BASE, fetchImpl: pr.fetch}), refreshMs: null});
  const V = GAME.frames.vote, T = GAME.frames.talk, watchReads = () => pr.calls.filter(c => c.path === READS.watch).length;
  // the relay holds the talk frame; the socket opens; a push lands while the page is still reading it
  pr.watch = T;
  const opening = papp.onSocketOpen();
  const early = V.events.filter(e => e.id > T.last).slice(0, 3);
  papp.onSocket({type: 'watch', seed: V.seed, last: early.at(-1).id, events: early, clock: T.clock, pending: T.pending, ballot: null, phase: T.phase, day: T.day, night: T.night, winner: null});
  await opening; await tick();
  const tl = () => document.querySelector('#talk .lines');
  const ids = () => tl().children.map(c => c.dataset.key).filter(k => k[0] === 'e').map(k => +k.slice(1));
  ok(watchReads() === 1, 'the socket opens: the page reads the game once');
  ok(early.every(e => ids().includes(e.id)) && JSON.stringify(ids()) === JSON.stringify([...ids()].sort((a, b) => a - b)), 'a push that landed during the read is merged after it, in event order');
  await papp.tickWatch();
  ok(watchReads() === 1, 'while the socket is open the timer does not poll');
  // the vote: its events, then the ballots one by one
  const upto = V.events.filter(e => e.id > early.at(-1).id);
  const base = {type: 'watch', seed: V.seed, clock: V.clock, pending: V.pending, phase: V.phase, day: V.day, night: V.night, winner: null};
  papp.onSocket({...base, last: V.last, events: upto, ballot: {id: V.ballot.id, nominee: V.ballot.nominee, votes: {}}});
  await tick();
  const hands = () => ({up: document.querySelectorAll('#square .hand.up').length, down: document.querySelectorAll('#square .hand.down').length, none: document.querySelectorAll('#square .hand.none').length});
  ok(hands().none === V.pending.seats.length && hands().up === 0, `the vote opens with every hand still to cast (${JSON.stringify(hands())})`);
  ok(!!document.querySelectorAll('#square .seat')[V.pending.nominee].querySelector('.mark.nominee'), 'the pushed vote marks the nominee');
  const votes = {}; let n = 0;
  for (const [seat, yes] of Object.entries(V.ballot.votes)) {
    votes[seat] = yes; n++;
    papp.onSocket({...base, last: V.last, events: [], ballot: {id: V.ballot.id, nominee: V.ballot.nominee, votes: {...votes}}});
    await tick();
    const h = hands(), want = Object.values(votes);
    ok(h.up === want.filter(Boolean).length && h.down === want.filter(x => !x).length && h.none === V.pending.seats.length - n,
      `ballot ${n} lands: ${h.up} raised, ${h.down} lowered, ${h.none} to cast`);
  }
  const before = tl().children.length;
  papp.onSocket({...base, last: V.last, events: upto.slice(-3), ballot: {id: V.ballot.id, nominee: V.ballot.nominee, votes}});
  await tick();
  ok(tl().children.length === before, 'a pushed event the page already has is not shown twice');
  // the socket drops: the timer polls; it reopens: one read ?since=last
  papp.onSocketClose(); pr.watch = V;
  await papp.tickWatch();
  ok(watchReads() === 2, 'the socket is down: the timer polls');
  pr.calls.length = 0;
  await papp.onSocketOpen();
  const reread = pr.calls.filter(c => c.path === READS.watch);
  ok(reread.length === 1 && tl().children.length === before, 'the socket reopens: one read of the game, and nothing doubles');
  // a push with new events: drawn at once, the grimoire side read a moment later
  install(HTML);
  const app2 = createApp({client: relayClient({base: BASE, fetchImpl: pr.fetch}), refreshMs: 60000});
  pr.watch = T; await app2.onSocketOpen(); pr.calls.length = 0;
  app2.onSocket({...base, last: early.at(-1).id, events: early, ballot: null});
  await tick();
  ok(pr.calls.length === 0 && early.every(e => document.querySelector(`#talk .line[data-key="e${e.id}"]`) || !['say', 'pass', 'nomination'].includes(e.type)), 'a push renders at once, without a read');
  await app2.flushRefresh();
  ok(pr.calls.length === 1 && pr.calls[0].path === READS.watch, 'after a push with new events the page reads the grimoire side once');
}
install(HTML);
relay = fakeRelay();
app = createApp({client: relayClient({base: BASE, fetchImpl: relay.fetch}), seed: 13});
relay.watch = GAME.frames.end; await app.pollWatch();

// ---- agents ----
console.log('agents');
app.onSocket(copy(RUN.links));
await app.pollRunners();
const rows = () => document.querySelectorAll('#agents .agent');
const row = k => rows().find(r => r.dataset.key === k);
ok(rows().length === 8 && rows()[0].dataset.key === 'storyteller', 'a row for the Storyteller and one per seat');
const st = k => row(k).dataset.state;
ok(st('storyteller') === 'playing' && st('player:1') === 'playing' && st('player:4') === 'claimed' && st('player:6') === 'gone' && st('player:5') === 'none',
  `states: ${rows().map(r => r.dataset.key + '=' + r.dataset.state).join(' ')}`);
ok(/\$0\.06 of \$0\.50/.test(row('player:1').textContent) && /33k ctx/.test(row('player:1').textContent) && /claude-haiku-4-5/.test(row('player:1').textContent), 'a row shows provider and model, cost of budget and the session size');
ok(/Game budget/.test($('agents').querySelector('.pools').textContent) && /players \$0\.27 of \$3\.50/.test($('agents').querySelector('.pools').textContent), 'the game budget\'s two pools show');
const det = row('player:1').querySelector('details');
ok(/nominate/.test(det.textContent) && /You are Odette/.test(det.textContent), 'the last turn shows its header and tool calls');
det.open = true; await app.pollRunners();
ok(row('player:1').querySelector('details') === det && det.open, 'an open last turn stays open through updates');
const resume = $('agents').querySelector('button[data-act="resume"]');
ok(resume.hidden, 'no resume button while the game runs');
relay.runners.paused = {why: "the Storyteller's runner ended (crashed)", at: '2026-11-07T14:20:00Z'};
await app.pollRunners();
ok(!resume.hidden && /paused/.test($('agents').querySelector('.agents-note').textContent), 'paused: the resume button shows, with why');
relay.posts.length = 0;
resume.click(); await new Promise(r => setTimeout(r, 0));
ok(relay.posts.length === 1 && relay.posts[0].path === ACTIONS.resume && relay.posts[0].body.scripted === true, 'resume posts {scripted: true} to the supervisor');

// the start controls, against the vote frame (everyone alive)
relay.watch = null; app.state.watch = GAME.frames.vote; app.state.epoch++; app.render();
relay.posts.length = 0;
const thea = row('player:5');
thea.querySelector('select[name="provider"]').value = 'ollama';
thea.querySelector('input[name="model"]').value = 'qwen2.5:14b';
thea.querySelector('button.start').click(); await new Promise(r => setTimeout(r, 0));
ok(relay.posts[0] && relay.posts[0].path === ACTIONS.start && JSON.stringify(relay.posts[0].body) === JSON.stringify({kind: 'player', player: 5, provider: 'ollama', model: 'qwen2.5:14b', minGap: PACES.readable.minGap, heartbeat: PACES.readable.heartbeat, by: 'owner'}),
  `start posts the seat, provider and model (${JSON.stringify(relay.posts[0] && relay.posts[0].body)})`);
relay.posts.length = 0;
row('player:7').querySelector('input[name="budget"]').value = '0.25';
row('player:7').querySelector('button.start').click(); await new Promise(r => setTimeout(r, 0));
ok(relay.posts[0] && JSON.stringify(relay.posts[0].body) === JSON.stringify({kind: 'player', player: 7, budget: 0.25, minGap: PACES.readable.minGap, heartbeat: PACES.readable.heartbeat, by: 'owner'}), `a budget typed in goes with the start (${JSON.stringify(relay.posts[0] && relay.posts[0].body)})`);
relay.posts.length = 0;
row('player:1').querySelector('button.stop').click(); row('storyteller').querySelector('button.stop').click(); await new Promise(r => setTimeout(r, 0));
ok(relay.posts.length === 2 && relay.posts.every(x => x.path === ACTIONS.stop) && JSON.stringify(relay.posts.map(x => x.body)) === JSON.stringify([{kind: 'player', player: 1}, {kind: 'storyteller'}]), 'stop posts the runner to stop');
ok(row('player:1').querySelector('button.start').disabled && row('player:5').querySelector('button.stop').disabled, 'a running runner cannot be started twice; a seat with none cannot be stopped');
relay.posts.length = 0;
$('agents').querySelector('button[data-act="stop-all"]').click(); await new Promise(r => setTimeout(r, 0));
ok(relay.posts.length === 1 && relay.posts[0].path === ACTIONS.stopAll, 'stop all posts to stop-all');
relay.posts.length = 0;
relay.runners.runners = relay.runners.runners.filter(r => r.key !== 'storyteller'); await app.pollRunners(); relay.watch = null; app.state.watch = GAME.frames.vote; app.render();
$('agents').querySelector('button[data-act="start-all"]').click(); await new Promise(r => setTimeout(r, 20));
const started = relay.posts.filter(x => x.path === ACTIONS.start).map(x => x.body);
ok(started.length >= 2 && started[0].kind === 'storyteller' && started.every(b => b.by === 'owner') && !started.some(b => b.player === 1 || b.player === 2),
  `start all starts the Storyteller first and only seats with no runner (${started.map(b => b.kind === 'storyteller' ? 'ST' : b.player).join(', ')})`);

// ---- the pace knob ----
console.log('the pace knob');
ok($('pace').value === 'readable' && $('pace').options.length === 3, `the knob offers fast, readable and slow and starts on readable (${$('pace').value})`);
ok(started.every(b => b.minGap === PACES.readable.minGap && b.heartbeat === PACES.readable.heartbeat), 'start all sends the readable pace with every start');
$('pace').value = 'slow'; $('pace').dispatch('change');
relay.posts.length = 0;
row('player:5').querySelector('button.start').click(); await tick();
ok(relay.posts[0] && relay.posts[0].body.minGap === PACES.slow.minGap && relay.posts[0].body.heartbeat === PACES.slow.heartbeat, `slow: a start sends minGap ${PACES.slow.minGap} s and heartbeat ${PACES.slow.heartbeat} game min`);
$('pace').value = 'fast'; $('pace').dispatch('change');
relay.posts.length = 0;
row('player:5').querySelector('button.start').click(); await tick();
ok(relay.posts[0] && relay.posts[0].body.minGap === 20 && relay.posts[0].body.heartbeat === 120, "fast: the runners' own default, 20 s and 120 game minutes");
relay.runners.runners = relay.runners.runners.map(x => ({...x, pace: 'waiting: a turn on an event, else every 120 game min, at least 20 s apart'}));
$('pace').value = 'readable'; $('pace').dispatch('change'); await app.pollRunners();
ok(/old pace until restarted/.test($('pace-note').textContent), `runners started at another pace are named (${$('pace-note').textContent})`);
$('pace').value = 'fast'; $('pace').dispatch('change');
ok($('pace-note').textContent === '', 'no note once the knob matches what runs');
$('pace').value = 'readable'; $('pace').dispatch('change');

// ---- nothing speaks for a seat ----
console.log('watcher only');
for (const b of document.querySelectorAll('button')) b.click();
await new Promise(r => setTimeout(r, 20));
const allowed = new Set([...Object.values(READS), ...Object.values(ACTIONS), ...Object.values((await import('../src/ui/relay.js')).VOICE)]);
ok(relay.calls.every(c => allowed.has(c.path)), 'every request the page made is to a listed route');
ok(!relay.calls.some(c => FORBIDDEN.test(c.path)), 'no request went to a seat\'s routes');
ok(![...Object.values(READS), ...Object.values(ACTIONS)].some(x => FORBIDDEN.test(x)), 'the page\'s route list has none of a seat\'s routes');
const code = readdirSync(join(ROOT, 'src/ui')).filter(f => f.endsWith('.js')).map(f => [f, readFileSync(join(ROOT, 'src/ui', f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')]);
const bad = code.filter(([, t]) => /['"`]\/(mcp|play\/(call|storyteller|narrate))\b/.test(t)).map(([f]) => f);
ok(bad.length === 0, `no code under src/ui names a seat's route${bad.length ? ': ' + bad.join(', ') : ''}`);
ok(!/\b(nominate|vote|whisper|speak)\b/i.test(document.querySelectorAll('button').map(b => b.textContent).join(' ')), 'no button nominates, votes, whispers or speaks');

// ---- the recorded game, as ?fixture shows it ----
console.log('the recorded game (?fixture)');
install(HTML);
relay = fakeRelay();
app = createApp({client: relayClient({base: BASE, fetchImpl: relay.fetch}), fixture: GAME, runnersFixture: RUN});
ok(document.querySelectorAll('#square .seat').length === 7 && document.querySelectorAll('#talk .line').length > 50 && document.querySelectorAll('#agents .agent').length === 8, 'every panel renders from the recording');
ok($('frames').options.length === 6 && !$('frames').hidden, 'a picker offers the recorded moments: talk, a vote, a night, a dawn, the rooms, the end');
$('frames').value = 'talk'; $('frames').dispatch('change');
ok(document.querySelectorAll('#talk .line.win').length === 0 && /round \d of 2/.test($('phase').textContent), 'picking an earlier moment shows that moment');
for (const b of document.querySelectorAll('button')) b.click();
await new Promise(r => setTimeout(r, 20));
ok(relay.calls.length === 0, 'the recorded game sends nothing to the relay');

// ---- today's engine still renders ----
console.log("a fresh recording from today's engine");
install(HTML);
const fresh = record(FIXTURE_SEED);
app = createApp({client: relayClient({base: BASE, fetchImpl: fakeRelay().fetch}), fixture: fresh, runnersFixture: RUN});
ok(document.querySelectorAll('#square .seat').length === 7 && document.querySelectorAll('#talk .line.say').length === fresh.frames.end.events.filter(e => e.type === 'say').length, 'a game recorded now renders the same way');
const stale = JSON.stringify(fresh.frames.end.events.map(e => e.type)) !== JSON.stringify(GAME.frames.end.events.map(e => e.type));
if (stale) console.log('  note the recorded game differs from today\'s engine: npm run uifixture writes a new one');

// ---- the owner's own token images (a git-ignored local folder) ----
console.log("the owner's own token images");
{
  const A = await import('../src/ui/art.js');
  const {execFileSync} = await import('node:child_process');
  const fresh = (artLoad) => {A.resetArt(); install(HTML); return createApp({client: relayClient({base: BASE, fetchImpl: fakeRelay().fetch}), fixture: GAME, runnersFixture: RUN, artLoad})};
  // none in the folder: every token stays drawn, no note
  let asked = [];
  let aapp = fresh(async u => {asked.push(u); return false});
  await aapp.art;
  const all = [...A.ROLE_IDS, ...A.EXTRA_IDS];
  ok(asked.length === all.length * 2 && all.every(id => asked.indexOf('/tokens-local/' + id + '.png') >= 0 && asked.indexOf('/tokens-local/' + id + '.png') < asked.indexOf('/tokens-local/' + id + '.webp')),
    `the page looks for a PNG, then a WebP, for each role, the shroud, the ghost vote and the reminders (${asked.length})`);
  ok(document.querySelectorAll('img.token').length === 0 && document.querySelectorAll('#square svg.role-token').length === 7 && $('art-note').hidden, 'no images: every token is the drawn one and the game bar says nothing');
  // a loader that fails outright is the same as no image
  aapp = fresh(async () => {throw new Error('blocked')});
  await aapp.art;
  ok(document.querySelectorAll('img.token').length === 0 && document.querySelectorAll('#grimoire svg.role-token').length === 7, 'an image that fails to load leaves the drawn token');
  // the first seat's role as a WebP and the shroud as a PNG
  const E = GAME.frames.end, role0 = E.grimoire.seats[0].role, dead = E.grimoire.seats.filter(s => !s.alive);
  asked = [];
  aapp = fresh(async u => {asked.push(u); return u === '/tokens-local/' + role0 + '.webp' || u === '/tokens-local/shroud.png'});
  ok(document.querySelectorAll('img.token').length === 0, 'before the look answers, the drawn tokens show');
  await aapp.art;
  ok(!asked.includes('/tokens-local/shroud.webp'), 'a PNG found is not looked for again as WebP');
  const same = E.grimoire.seats.filter(s => s.role === role0).length;
  const sqImg = document.querySelectorAll('#square img.role-token'), grImg = document.querySelectorAll('#grimoire img.role-token');
  ok(sqImg.length === same && grImg.length === same && [...sqImg, ...grImg].every(i => i.getAttribute('src') === '/tokens-local/' + role0 + '.webp' && i.dataset.role === role0),
    `the ${role0} WebP replaces its token in the square and the grimoire (${sqImg.length} + ${grImg.length})`);
  ok(document.querySelectorAll('#square svg.role-token').length === 7 - same && document.querySelectorAll('#grimoire svg.role-token').length === 7 - same, 'every other role keeps its drawn token');
  ok(dead.length > 0 && document.querySelectorAll('#square .seat-marker image.shroud-art').length === dead.length && document.querySelectorAll('#square .seat-marker path.shroud').length === 0, `the shroud image lies over each dead seat (${dead.length})`);
  ok(!$('art-note').hidden && $('art-note').textContent === 'local art: 1 of 22 tokens', `the game bar counts the images found (${$('art-note').textContent})`);
  // looked for once per page load
  const n = asked.length;
  install(HTML);
  aapp = createApp({client: relayClient({base: BASE, fetchImpl: fakeRelay().fetch}), fixture: GAME, runnersFixture: RUN, artLoad: async u => {asked.push(u); return true}});
  await aapp.art;
  ok(asked.length === n && document.querySelectorAll('#square img.role-token').length === same, 'the page looks once per load and remembers each answer');
  A.resetArt();
  const tracked = execFileSync('git', ['ls-files', 'public/tokens-local'], {cwd: ROOT, encoding: 'utf8'}).split('\n').filter(Boolean);
  ok(tracked.every(f => f === 'public/tokens-local/README.md'), `nothing in the local art folder is tracked but its README (${tracked.join(', ') || 'none yet'})`);
  const ignored = f => {try {return execFileSync('git', ['check-ignore', f], {cwd: ROOT, encoding: 'utf8'}).trim() === f} catch {return false}};
  ok(ignored('public/tokens-local/imp.png') && ignored('public/tokens-local/imp.webp') && !ignored('public/tokens-local/README.md'), 'an image dropped in the folder is git-ignored; its README is not');
}

// ---- portraits on the seat markers ----
console.log('portraits');
{
  const PI = await import('../src/ui/portraits.js');
  const IDX = JSON.parse(readFileSync(join(ROOT, 'src/ui/fixtures/portraits.json'), 'utf8'));
  const E = GAME.frames.end;
  const page = (pageFetch) => {PI.resetPortraits(); install(HTML); return createApp({client: relayClient({base: BASE, fetchImpl: fakeRelay().fetch}), fixture: GAME, runnersFixture: RUN, pageFetch})};
  const html = {ok: true, status: 200, json: async () => {throw new SyntaxError('Unexpected token <')}};
  for (const [why, f] of [['no index (404)', async () => ({ok: false, status: 404, json: async () => ({})})], ['the dev server\'s HTML for a missing index', async () => html], ['a fetch that fails', async () => {throw new Error('down')}]]) {
    const a = page(f); await a.portraits;
    ok(document.querySelectorAll('#square image.sm-portrait').length === 0 && document.querySelectorAll('#square .sm-initial').length === 7 && document.querySelectorAll('#agents img.mini-portrait').length === 0 && $('rulings').querySelector('.st-portrait').hidden,
      `${why}: the initials, no portraits, and the page carries on`);
  }
  let asked = [];
  const a = page(async u => {asked.push(u); return {ok: true, status: 200, json: async () => copy(IDX)}});
  await a.portraits;
  ok(asked.length === 1 && asked[0] === PI.PORTRAIT_INDEX, 'the page reads assets/portraits/index.json once');
  const seatsEl = document.querySelectorAll('#square .seat');
  const has = E.grimoire.seats.map(s => !!IDX.portraits[s.name]);
  ok(seatsEl.every((el, i) => {const im = el.querySelector('image.sm-portrait'); return has[i] ? im && im.getAttribute('href') === '/assets/portraits/' + E.grimoire.seats[i].name + '.png' : !im}),
    `each seat with a portrait shows it in its disc (${has.filter(Boolean).length} of 7)`);
  const bare = E.grimoire.seats.findIndex(s => !IDX.portraits[s.name]);
  ok(bare >= 0 && !seatsEl[bare].querySelector('image.sm-portrait') && seatsEl[bare].querySelector('.sm-initial').textContent === E.grimoire.seats[bare].name[0], 'a seat with no entry keeps its initial');
  const deadP = E.grimoire.seats.map((s, i) => [s, seatsEl[i]]).filter(([s]) => !s.alive && IDX.portraits[s.name]);
  ok(deadP.length > 0 && deadP.every(([, el]) => {const svg = el.querySelector('.seat-marker'), kids = svg.children.map(c => c.tagName.toLowerCase()); return svg.classList.contains('is-dead') && kids.indexOf('path') > kids.indexOf('image')}),
    `a dead seat keeps the shroud over its portrait (${deadP.length})`);
  const minis = document.querySelectorAll('#agents .agent img.mini-portrait');
  ok(minis.length === Object.keys(IDX.portraits).length && document.querySelector('#agents .agent[data-key="storyteller"] img.mini-portrait').getAttribute('src') === '/assets/portraits/Storyteller.png', `the agents panel shows a small portrait per row that has one (${minis.length})`);
  const stp = $('rulings').querySelector('.st-portrait');
  ok(!stp.hidden && stp.getAttribute('src') === '/assets/portraits/Storyteller.png', "the Storyteller's log shows the Storyteller's portrait");
  minis[0].dispatch('error');
  ok(minis[0].hidden, 'a portrait that fails to load hides itself');
  ok(JSON.stringify(PI.readIndex({Odette: {file: 'assets/portraits/odette.png'}, Bram: {file: '../secret.png'}, Ines: {file: 'https://example.com/x.png'}})) === JSON.stringify({Odette: '/assets/portraits/odette.png'}),
    'the other index shape reads too; a file outside the portraits or off the machine is ignored');
  PI.resetPortraits();
}

// ---- voices ----
console.log('voices');
{
  const VO = await import('../src/ui/voice.js');
  const {VOICE} = await import('../src/ui/relay.js');
  const T = GAME.frames.talk, V = GAME.frames.vote, E = GAME.frames.end;
  const SEATV = {Odette: {voice: 'v_odette', speed: 0.95}, Bram: 'v_bram', Ines: {voice: 'v_ines'}, Corwin: {voice: 'v_corwin'}, Thea: {voice: 'v_thea'}, Fitch: {voice: 'v_fitch'}, Yusuf: {voice: 'v_yusuf'}, Storyteller: {voice: 'v_st', speed: 0.95}};
  const clipId = n => n.toString(16).padStart(24, '0');
  // a relay with a voice engine: /tts/status answers {ok, seatVoices}; /tts/say makes a clip id per line
  const voiceRelay = ({engine = true, clipsOnSay = false} = {}) => {
    const r = fakeRelay(), base = r.fetch; r.says = []; r.status = 0;
    r.fetch = async (url, opt = {}) => {
      const path = String(url).replace(BASE, '').split('?')[0];
      if (path === VOICE.status) {
        r.calls.push({path, method: 'GET'}); r.status++;
        return {ok: true, status: 200, json: async () => engine ? {enabled: true, ok: true, engine: 'kokoro', voices: ['v_odette'], seatVoices: SEATV, ...(clipsOnSay ? {clipsOnSay: true, heard: null} : {})} : {enabled: true, ok: false, voices: [], error: 'not answering'}};
      }
      if (path === VOICE.say) {
        r.calls.push({path, method: 'POST'}); r.says.push(JSON.parse(opt.body));
        const n = r.says.length; // the clip's id is fixed when it is asked for
        return engine ? {ok: true, status: 200, json: async () => ({id: clipId(n), ms: 5})} : {ok: false, status: 503, json: async () => ({error: 'narrator voice is off'})};
      }
      return base(url, opt);
    };
    return r;
  };
  const fakeAudio = () => ({src: '', plays: [], paused: true, onended: null, onerror: null,
    play() {this.paused = false; this.plays.push(this.src); return Promise.resolve()}, pause() {this.paused = true}, end() {const f = this.onended; if (f) f()}});
  const settle = async (n = 8) => {for (let i = 0; i < n; i++) await tick()};
  const livePage = (r, audio) => {install(HTML); localStorage.setItem(VO.NAMES_KEY, 'off'); return createApp({client: relayClient({base: BASE, fetchImpl: r.fetch}), refreshMs: null, audio, voiceFile: async () => null})};
  const push = (a, frame, from) => a.onSocket({type: 'watch', seed: frame.seed, last: frame.last, events: frame.events.filter(e => e.id > from), clock: frame.clock, pending: frame.pending, ballot: frame.ballot || null, phase: frame.phase, day: frame.day, night: frame.night, winner: frame.winner || null});
  const lit = () => document.querySelectorAll('#square .seat.speaking').map(s => +s.dataset.seat);
  const centreLit = () => document.querySelector('#square .centre').classList.contains('st-speaking');

  // off on the first visit: nothing is posted while lines arrive
  const vr = voiceRelay(), au = fakeAudio();
  const va = livePage(vr, au);
  vr.watch = T; await va.onSocketOpen(); await settle();
  ok($('voice-toggle').textContent === 'Voice: off' && $('voice-toggle').getAttribute('aria-pressed') === 'false' && $('voice-skip').hidden && $('voice-mute').hidden, 'the Voice toggle starts off on a first visit; skip and mute show only when on');
  push(va, V, T.last); await settle();
  ok(vr.says.length === 0 && vr.status === 0 && au.plays.length === 0, 'voices off: nothing is posted and nothing plays as lines arrive');

  // the first click: unlocks the sound, asks the engine, remembers
  $('voice-toggle').click(); await settle();
  ok(va.voice.state.on && $('voice-toggle').textContent === 'Voice: on' && localStorage.getItem(VO.VOICE_KEY) === 'on', 'one click turns the voices on and the browser remembers');
  ok(!!au.plays[0] && au.plays[0].startsWith('data:audio/wav'), 'the click plays a moment of silence, so the browser lets the page speak');
  ok(vr.says.length === 0, 'what was already said is not read out');

  // the next lines arrive: spoken in order, one at a time, each in its voice
  const names = E.grimoire.seats.map(s => s.name);
  const after = E.events.filter(e => e.id > V.last), firstSay = after.find(e => e.type === 'say');
  const day2 = [...after.filter(e => VO.spokenLine(e)).slice(0, 2), firstSay]; // two of the Storyteller's lines, then a seat's
  push(va, {...E, events: day2, last: day2.at(-1).id}, V.last); await settle();
  const want = day2.map(e => VO.spokenLine(e)).filter(Boolean);
  ok(want.length >= 3 && vr.says.length >= 1 && vr.says.length <= 2 && vr.says[0].text === want[0].text, `one clip at a time, the next made while it plays (${vr.says.length} asked for, ${want.length} lines)`);
  const voiceOf = l => {const m = SEATV[l.speaker === 'storyteller' ? 'Storyteller' : names[l.speaker]]; return typeof m === 'string' ? m : m.voice};
  ok(vr.says[0].voice === voiceOf(want[0]), `the line is asked in its speaker's voice (${vr.says[0].voice})`);
  ok(au.plays.at(-1) === BASE + VOICE.clip + '?id=' + clipId(1), `the clip plays from the relay (${au.plays.at(-1)})`);
  const who0 = want[0].speaker;
  ok(who0 === 'storyteller' ? centreLit() && lit().length === 0 : JSON.stringify(lit()) === JSON.stringify([who0]), `the speaker is lit while its clip plays (${who0 === 'storyteller' ? 'the Storyteller, in the centre' : names[who0]})`);
  {const st = document.querySelector('#stage .stage-st'), c = who0 === 'storyteller' ? null : document.querySelector('#stage .card[data-seat="' + who0 + '"]');
    ok(who0 === 'storyteller' ? st.classList.contains('voicing') && st.querySelector('.st-line').textContent === want[0].text : c.classList.contains('voicing') && c.querySelector('.cap-text').textContent === want[0].text, 'the People view puts the line being spoken on stage, its speaker lit')}
  const heard = [vr.says[0].text], litBy = [who0 === 'storyteller' ? centreLit() : lit()[0] === who0];
  for (let i = 1; i < want.length; i++) {
    au.end(); await settle();
    heard.push(vr.says[i] && vr.says[i].text);
    litBy.push(want[i].speaker === 'storyteller' ? centreLit() && lit().length === 0 : JSON.stringify(lit()) === JSON.stringify([want[i].speaker]));
  }
  {const l = want.at(-1), c = document.querySelector('#stage .card.voicing'); ok(Number.isInteger(l.speaker) && c && +c.dataset.seat === l.speaker && c.querySelector('.cap-text').textContent === l.text, 'as each clip plays its line takes the stage (the caption follows the voice)')}
  ok(JSON.stringify(heard) === JSON.stringify(want.map(l => l.text)), `the lines are read in the order they came (${want.map(l => l.kind).join(', ')})`);
  ok(litBy.every(Boolean), 'each line lights its own speaker, and only that one');
  ok(want.every((l, i) => vr.says[i].voice === voiceOf(l)), "a seat's line is in that seat's voice, the Storyteller's lines in the Storyteller's");
  au.end(); await settle();
  ok(lit().length === 0 && !centreLit() && !va.voice.state.now, 'when the last clip ends nothing is lit');

  // the queue never falls far behind: a burst keeps only the newest few
  const rest = E.events.filter(e => e.id > day2.at(-1).id);
  ok(rest.some(e => e.type === 'whisper'), 'the recorded game has whispers after this point');
  const before = vr.says.length;
  push(va, E, day2.at(-1).id); await settle();
  {const dayQ = va.voice.state.queue.filter(x => x.kind !== 'night' && x.kind !== 'thought'); ok(dayQ.length <= VO.QUEUE_CAP && va.voice.state.dropped > 0, `a burst of ${rest.length} entries leaves at most ${VO.QUEUE_CAP} of the day's lines waiting (${va.voice.state.dropped} dropped; the night's ${va.voice.state.queue.length - dayQ.length} told lines are kept)`)}
  ok(vr.says.slice(before).every(b => !rest.some(e => e.type === 'whisper' && e.text === b.text)), 'whispers are not read unless asked');
  // skip and mute
  const playing = va.voice.state.now;
  $('voice-skip').click(); await settle();
  ok(!!playing && va.voice.state.now && va.voice.state.now !== playing && vr.says.length > before + 1, 'Skip ends the clip playing and the next one starts');
  $('voice-mute').click(); await settle();
  ok(va.voice.state.muted && !va.voice.state.now && va.voice.state.queue.length === 0 && lit().length === 0 && !centreLit() && $('voice-mute').textContent === 'Unmute', 'Mute hushes the clip, drops what waits, and nothing is lit');
  const muted = vr.says.length;
  $('voice-mute').click(); await settle();
  ok(vr.says.length === muted && !va.voice.state.muted, 'unmuted: nothing held while muted is read out afterwards');

  // whispers, when asked
  $('voice-whispers').checked = true; $('voice-whispers').dispatch('change');
  ok(localStorage.getItem(VO.WHISPER_KEY) === 'on', 'the whispers choice is remembered');
  const wh = {type: 'whisper', from: 2, to: 4, text: 'Back me.'};
  ok(VO.spokenLine(wh, {whispers: true}).speaker === 2 && VO.spokenLine(wh) === null, "a whisper is read in the whisperer's voice only when whispers are ticked");
  ok(VO.spokenLine({type: 'told', seat: 1, text: 'You learn 0.'}) === null && VO.spokenLine({type: 'death', phase: 'night', seat: 1, text: 'Ines dies.'}) === null && VO.spokenLine({type: 'pass', text: 'Bram passes.'}) === null,
    'what a seat is told by night, a night death before dawn and a pass are never read');

  // off again: nothing posted
  $('voice-toggle').click(); await settle();
  const offAt = vr.says.length;
  ok(!va.voice.state.on && localStorage.getItem(VO.VOICE_KEY) === 'off' && $('voice-skip').hidden, 'a second click turns the voices off, remembered');
  push(va, E, -1); await settle();
  ok(vr.says.length === offAt, 'turned off: nothing more is posted');

  // remembered on: the next page load asks the engine
  const vr2 = voiceRelay();
  install(HTML); localStorage.setItem(VO.VOICE_KEY, 'on');
  const va2 = createApp({client: relayClient({base: BASE, fetchImpl: vr2.fetch}), refreshMs: null, audio: fakeAudio(), voiceFile: async () => null});
  await va2.voice.ready;
  ok(va2.voice.state.on && vr2.status === 1, 'remembered on: the next visit starts with the voices on');

  // no engine: the toggle says so once and stays off; nothing is posted
  localStorage.removeItem(VO.VOICE_KEY);
  const nr = voiceRelay({engine: false});
  const na = livePage(nr, fakeAudio());
  nr.watch = T; await na.onSocketOpen();
  $('voice-toggle').click(); await settle();
  const said = $('voice-note').textContent;
  ok(!na.voice.state.on && $('voice-toggle').textContent === 'Voice: off' && /No voice engine/.test(said), `no engine: the toggle stays off and says why (${said})`);
  $('voice-toggle').click(); await settle();
  ok($('voice-note').textContent === said && !na.voice.state.on, 'clicked again: the same one line, still off');
  push(na, V, T.last); await settle();
  ok(nr.says.length === 0, 'no engine: nothing is posted');

  // the voice map from the lore-keeper's file when the relay has none; the default otherwise
  ok(VO.voiceFor('Bram', null, {Bram: {voice: 'x', speed: 1.1}}).voice === 'x' && VO.voiceFor('Nobody', null, null).voice === null && VO.voiceFor('Odette', SEATV).speed === 0.95,
    "voices come from the relay's map, else the file, else the engine's default");

  // the recorded game is not spoken
  const rr = voiceRelay();
  install(HTML);
  createApp({client: relayClient({base: BASE, fetchImpl: rr.fetch}), fixture: GAME, runnersFixture: RUN, audio: fakeAudio(), voiceFile: async () => null});
  $('voice-toggle').click(); await settle();
  ok(rr.calls.length === 0 && /recorded game/.test($('voice-note').textContent), 'the recorded game sends nothing to the voice engine and says so');
  ok(!/\b(nominate|vote|whisper|speak)\b/i.test(document.querySelectorAll('button').map(b => b.textContent).join(' ')), 'no voice control speaks, votes or whispers for a seat');
  localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY);

  // ---- keeping time (#50): the relay's clips and the heard report ----
  console.log('voices keeping time');
  {
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.setItem(VO.NAMES_KEY, 'off');
    const kr = voiceRelay({clipsOnSay: true}), ka = fakeAudio();
    let tickFn = null;
    install(HTML); localStorage.setItem(VO.NAMES_KEY, 'off');
    const kp = createApp({client: relayClient({base: BASE, fetchImpl: kr.fetch}), refreshMs: null, audio: ka, voiceFile: async () => null,
      voiceTick: (fn, ms) => {tickFn = fn; kr.tickMs = ms; return () => {}}, clipWait: 600}); // long beside a timer tick (about 16 ms on Windows)
    const heards = () => kr.posts.filter(p => p.path === VOICE.heard).map(p => p.body);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = T.last, line = (k, extra = {}) => ({id: L + k, type: 'say', day: T.day, night: T.night, seat: k % 7, text: 'Line ' + k + ' at the Square.', ...extra});
    const sendLine = async ev => {kp.onSocket({type: 'watch', seed: T.seed, last: ev.id, events: [ev], clock: T.clock, pending: T.pending, ballot: null, phase: T.phase, day: T.day, night: T.night, winner: null}); await settle()};
    kr.watch = T; await kp.onSocketOpen(); await settle();
    ok(typeof tickFn === 'function' && kr.tickMs === VO.HEARD_MS && VO.HEARD_MS === 20000, 'the heard report has a 20 s tick');
    await sendLine(line(1)); tickFn(); await settle();
    ok(heards().length === 0 && kr.says.length === 0, 'voice off: no heard report on lines or on the tick');
    ok($('voice-time').hidden, 'voice off: no "keeping time" mark');

    $('voice-toggle').click(); await settle();
    ok(heards().length === 1 && heards()[0].voice === true && heards()[0].last === L + 1, `voice on: the page reports at once, everything seen so far heard (${JSON.stringify(heards()[0])})`);
    ok(!$('voice-time').hidden && /keeping time/.test($('voice-time').textContent), 'the "keeping time" mark shows while the relay makes the clips and the page reports');

    // a clip in the event itself (the watch body): played from the relay, nothing asked of /tts/say
    const c2 = 'a'.repeat(24);
    await sendLine(line(2, {clip: {id: c2, ms: 300}}));
    ok(ka.plays.at(-1) === BASE + VOICE.clip + '?id=' + c2 && kr.says.length === 0 && kp.voice.state.now && kp.voice.state.now.via === 'clip', "an event's clip plays from GET /tts?id=, no clip asked for");
    ka.end(); await settle();
    ok(heards().length === 2 && heards()[1].last === L + 2 && heards()[1].voice === true, `a clip's end reports it heard (${JSON.stringify(heards()[1])})`);

    // the clip arrives on the socket after the push
    const c3 = 'b'.repeat(24);
    await sendLine(line(3)); await sleep(5);
    ok(ka.plays.at(-1) !== BASE + VOICE.clip + '?id=' + c3 && kr.says.length === 0, 'a line without its clip waits a moment for the relay');
    kp.onSocket({type: 'clip', id: L + 3, clip: {id: c3, ms: 250}}); await settle();
    ok(ka.plays.at(-1) === BASE + VOICE.clip + '?id=' + c3 && kr.says.length === 0, "the socket's clip message is played when it comes");
    // skipped: reported heard too
    $('voice-skip').click(); await settle();
    ok(heards().at(-1).last === L + 3 && heards().at(-1).voice === true, `a skip reports the line heard (${JSON.stringify(heards().at(-1))})`);

    // no clip within the wait: the page asks for its own
    const before = kr.says.length;
    await sendLine(line(4)); await sleep(700); await settle();
    ok(kr.says.length === before + 1 && kr.says.at(-1).text === line(4).text && kp.voice.state.now && kp.voice.state.now.via === 'say', 'no clip within the wait: the page asks POST /tts/say itself');
    ka.end(); await settle();
    ok(heards().at(-1).last === L + 4, 'the fallback clip ends: reported heard');

    // whispers: the page's own clip at once
    $('voice-whispers').checked = true; $('voice-whispers').dispatch('change');
    const sb = kr.says.length;
    await sendLine({id: L + 5, type: 'whisper', day: T.day, night: T.night, from: 2, to: 4, text: 'Between us two.'});
    ok(kr.says.length === sb + 1 && kr.says.at(-1).text === 'Between us two.', 'a ticked whisper is asked of /tts/say at once (the relay makes none)');
    ka.end(); await settle();

    // the tick
    const hb = heards().length; tickFn(); await settle();
    ok(heards().length === hb + 1 && heards().at(-1).voice === true && heards().at(-1).last === L + 5, 'the 20 s tick reports while the voice is on');

    // mute and off: voice false at once, nothing on the tick
    $('voice-mute').click(); await settle();
    ok(heards().at(-1).voice === false && heards().length === hb + 2, 'Mute reports voice: false at once');
    ok($('voice-time').hidden, 'muted: the "keeping time" mark goes');
    tickFn(); await settle();
    ok(heards().length === hb + 2, 'muted: the tick posts nothing');
    $('voice-mute').click(); await settle();
    ok(heards().at(-1).voice === true && !$('voice-time').hidden, 'unmuted: voice true again, the mark back');
    $('voice-toggle').click(); await settle();
    const offN = heards().length;
    ok(heards().at(-1).voice === false && !kp.voice.state.on, 'Voice off reports voice: false at once');
    tickFn(); await sendLine(line(6)); await settle();
    ok(heards().length === offN, 'voice off: nothing more is reported');
    ok(kr.posts.every(p => !FORBIDDEN.test(p.path)), 'the heard report goes to its own route, never a seat\'s');

    // the held frame's events may carry clips the push never does: a replay is still a replay
    const {mergePush} = await import('../src/ui/model.js');
    const held = {...T, events: T.events.map((e, i) => i === T.events.length - 1 ? {...e, clip: {id: c2, ms: 1}} : e)};
    ok(!mergePush(held, {type: 'watch', seed: T.seed, last: T.last, events: T.events}).full, 'a replayed push is still a replay when the held event carries its clip');
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);
  }

  // ---- listening mode (#82): phases and moves are spoken; the names tick says who speaks first ----
  console.log('voices: listening mode');
  {
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);
    const lr = voiceRelay(), la = fakeAudio();
    install(HTML);
    const lp = createApp({client: relayClient({base: BASE, fetchImpl: lr.fetch}), refreshMs: null, audio: la, voiceFile: async () => null});
    lr.watch = T; await lp.onSocketOpen(); await settle();
    ok($('voice-names').checked && lp.voice.state.names, 'the names tick is on by default');
    ok(VO.spokenLine({id: 1, type: 'phase', what: 'night', text: 'Night 2 falls.'}).speaker === 'storyteller' && VO.spokenLine({id: 2, type: 'move', text: 'Odette went to the Snug.'}).speaker === 'storyteller', "a phase and a move are said in the Storyteller's voice");
    $('voice-toggle').click(); await settle();
    const L0 = T.last, ev = (i, o) => ({id: L0 + i, day: T.day, night: T.night, ...o});
    const sendOne = async e => {lp.onSocket({type: 'watch', seed: T.seed, last: e.id, events: [e], clock: T.clock, pending: T.pending, ballot: T.ballot, phase: T.phase, day: T.day, night: T.night, winner: T.winner, places: T.places}); await settle()};
    await sendOne(ev(1, {type: 'phase', what: 'round', text: 'Round 2 of 3 begins.'}));
    ok(lr.says.some(x => x.text === 'Round 2 of 3 begins.'), 'a phase line is asked of the voice');
    la.end(); await settle();
    await sendOne(ev(2, {type: 'move', seats: [0], room: 0, text: 'Odette went to the Snug.'}));
    ok(lr.says.some(x => x.text === 'Odette went to the Snug.'), 'a move line is asked of the voice');
    la.end(); await settle();
    const n0 = lr.says.length, nm = E.grimoire.seats[0].name;
    await sendOne(ev(3, {type: 'say', seat: 0, text: 'Good evening.'}));
    ok(lr.says.slice(n0).some(x => x.text === nm + '.' && x.voice === 'v_st'), 'a name tag is asked of the voice in the Storyteller voice');
    ok(lp.voice.state.now && lp.voice.state.now.id === L0 + 3 && lp.voice.mark() < L0 + 3, 'the tag is playing: the line is not yet heard');
    la.end(); await settle();
    ok(lr.says.some(x => x.text === 'Good evening.') && lp.voice.mark() < L0 + 3, 'then the line itself, the heard mark still not moved');
    la.end(); await settle();
    ok(lp.voice.mark() >= L0 + 3, 'the heard mark moves once the line itself has played');
    const n1 = lr.says.length;
    await sendOne(ev(4, {type: 'say', seat: 0, text: 'Another thing.'}));
    la.end(); await settle(); la.end(); await settle();
    ok(lr.says.slice(n1).every(x => x.text !== nm + '.'), 'the same name tag is cached: not asked again');
    $('voice-names').checked = false; $('voice-names').dispatch('change');
    ok(localStorage.getItem(VO.NAMES_KEY) === 'off' && !lp.voice.state.names, 'the names choice is remembered');
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);
  }

  // ---- the page follows the voices (#103): what is drawn is what has been said ----
  console.log('voices: the page follows the voices');
  {
    const {pickShown, FRAME_RING} = await import('../src/ui/app.js');
    // the pick on a hand-made ring: frames seq 1..4 carrying events up to 10, 12, 15, 20
    const ring = [{seq: 1, max: 10}, {seq: 2, max: 12}, {seq: 3, max: 15}, {seq: 4, max: 20}];
    ok(pickShown(ring, {boundary: null}) === null, 'the pick: nothing waiting, the live frame');
    ok(JSON.stringify(pickShown(ring, {boundary: 15, now: 11})) === '{"seq":2,"trim":null}', 'the pick: the newest frame below the first waiting line');
    ok(JSON.stringify(pickShown(ring, {boundary: 14, now: 13})) === '{"seq":3,"trim":14}', 'the pick: the line playing came with the waiting one, so its frame is cut at the waiting line');
    ok(JSON.stringify(pickShown(ring, {boundary: 13, now: 11, shown: {seq: 3, trim: null}})) === '{"seq":3,"trim":null}', 'the pick never steps back from what is shown');
    ok(JSON.stringify(pickShown(ring, {boundary: 16, now: 13, shown: {seq: 2, trim: null}})) === '{"seq":3,"trim":null}', 'the pick moves forward as the lines are heard');
    ok(FRAME_RING >= 32, `the page keeps the last ${FRAME_RING} frames`);

    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY);
    const fr = voiceRelay(), fa = fakeAudio();
    const fp = livePage(fr, fa); // names tick off: one clip per line
    fr.watch = T; await fp.onSocketOpen(); await settle();
    $('voice-toggle').click(); await settle();
    const L = T.last, n = T.grimoire.seats.map(s => s.name), ev = (i, o) => ({id: L + i, day: T.day, night: T.night, ...o});
    const send = async (events, extra = {}) => {fp.onSocket({type: 'watch', seed: T.seed, last: events.length ? events.at(-1).id : fp.state.watch.last, events, clock: T.clock, pending: T.pending, ballot: T.ballot, phase: T.phase, day: T.day, night: T.night, winner: T.winner, places: fp.state.watch.places, ...extra}); await settle()};
    const talkHas = id => !!document.querySelector(`#talk .line[data-key="e${id}"]`);
    const stage = () => document.querySelector('#stage');
    const away = {square: [2, 3, 4, 5, 6], rooms: [{id: 'nook', name: 'the Snug', size: 2, seats: [0, 1], free: 0}, ...T.places.rooms.slice(1)], open: true};
    await send([ev(1, {type: 'say', seat: 2, text: 'First, at the Square.'})]);
    ok(fp.voice.state.now && fp.voice.state.now.id === L + 1 && talkHas(L + 1), 'a line that plays at once is on the page at once');
    await send([ev(2, {type: 'say', seat: 3, text: 'Second, still waiting.'})]);
    await send([ev(3, {type: 'move', seats: [0, 1], room: 'nook', text: `${n[0]} and ${n[1]} went to the Snug.`})], {places: away});
    ok(fp.state.watch.places.rooms[0].seats.length === 2 && fp.voice.state.queue.length === 2, 'the live frame has the move; two lines wait for the voice');
    ok(stage().dataset.rooms === '' && !document.querySelector('#stage .card.away'), 'the move not yet said: the stage keeps everyone at the Square');
    ok(!talkHas(L + 2) && !talkHas(L + 3) && !document.querySelector('#square .seat.away'), 'the talk and the square wait for the voice too');
    ok(/keeps pace/.test($('voice-note').textContent) && /keeps pace/.test($('voice-note').title), `the voice bar says the page keeps pace (${$('voice-note').textContent})`);
    fa.end(); await settle();
    ok(fp.voice.state.now.id === L + 2 && talkHas(L + 2) && !talkHas(L + 3) && stage().dataset.rooms === '', 'the second line plays: it shows, the move still waits');
    fa.end(); await settle();
    ok(fp.voice.state.now.id === L + 3 && stage().dataset.rooms === 'out' && talkHas(L + 3), 'the move is read: the stage breaks out into the rooms as it is said');
    ok(!/keeps pace/.test($('voice-note').textContent), 'nothing waits: the page is live again and the hint goes');
    fa.end(); await settle();

    // mute: the live frame at once
    await send([ev(4, {type: 'say', seat: 4, text: 'Third.'})]);
    await send([ev(5, {type: 'say', seat: 5, text: 'Fourth, waiting.'})]);
    ok(!talkHas(L + 5), 'a waiting line is not shown');
    $('voice-mute').click(); await settle();
    ok(talkHas(L + 5), 'Mute: the page shows the live game at once');
    $('voice-mute').click(); await settle();
    // voice off: always live
    $('voice-toggle').click(); await settle();
    await send([ev(6, {type: 'say', seat: 6, text: 'Fifth.'})]);
    await send([ev(7, {type: 'say', seat: 2, text: 'Sixth.'})]);
    ok(!fp.voice.state.on && talkHas(L + 6) && talkHas(L + 7), 'Voice off: every line shows as it arrives');
    fp.voice.stop();

    // a vote: hands land at once, the result waits for its reading
    localStorage.removeItem(VO.VOICE_KEY);
    const gr = voiceRelay(), ga = fakeAudio();
    const gp = livePage(gr, ga);
    const V0 = {...V, ballot: {...V.ballot, votes: {}}};
    gr.watch = V0; await gp.onSocketOpen(); await settle();
    $('voice-toggle').click(); await settle();
    const M = V.last, vsend = async (events, extra = {}) => {gp.onSocket({type: 'watch', seed: V.seed, last: events.length ? events.at(-1).id : gp.state.watch.last, events, clock: V.clock, pending: V.pending, ballot: gp.state.watch.ballot, phase: V.phase, day: V.day, night: V.night, winner: null, ...extra}); await settle()};
    const handsUp = () => document.querySelectorAll('#stage .hand-mark.up').length;
    await vsend([{id: M + 1, day: V.day, night: V.night, phase: 'day', type: 'narration', text: 'The hands begin to rise.'}]);
    ok(gp.voice.state.now && gp.voice.state.now.id === M + 1, 'a line plays');
    await vsend([], {ballot: {...V.ballot, votes: {1: true}}});
    ok(handsUp() === 1, 'a hand landing with nothing waiting shows at once');
    const result = E.events.find(e => e.type === 'vote');
    await vsend([{...result, id: M + 2}], {ballot: null, pending: null});
    ok(gp.voice.state.queue.length === 1 && gp.voice.state.queue[0].id === M + 2, 'the result waits behind the line playing');
    ok(!document.querySelector('#stage .card.flash') && !document.querySelector('#stage .result:not(.block)') && handsUp() === 1, 'the result not yet read: no tally flash, the hands as they were');
    ga.end(); await settle();
    ok(gp.voice.state.now && gp.voice.state.now.id === M + 2 && !!document.querySelector('#stage .card.flash'), 'the result is read: it flashes as it is heard');
    gp.voice.stop();
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);

    // the picture waits for the clip's own sound (#109): not while the clip is made and fetched, nor while its name tag plays
    localStorage.removeItem(VO.VOICE_KEY);
    const holdAudio = () => {const a = fakeAudio(); a.held = [];
      a.play = function () {this.paused = false; this.plays.push(this.src); return new Promise(r => this.held.push(r))};
      a.start = function () {const h = this.held; this.held = []; for (const r of h) r()}; return a};
    const hr = voiceRelay(), ha = holdAudio();
    const hp = livePage(hr, ha);
    hr.watch = T; await hp.onSocketOpen(); await settle();
    $('voice-toggle').click(); await settle(); ha.start(); await settle();
    const hsend = async (events, extra = {}) => {hp.onSocket({type: 'watch', seed: T.seed, last: events.at(-1).id, events, clock: T.clock, pending: T.pending, ballot: T.ballot, phase: T.phase, day: T.day, night: T.night, winner: T.winner, places: hp.state.watch.places, ...extra}); await settle()};
    await hsend([ev(1, {type: 'move', seats: [0, 1], room: 'nook', text: `${n[0]} and ${n[1]} went to the Snug.`})], {places: away});
    ok(hp.voice.state.now && hp.voice.state.now.id === L + 1 && hp.voice.state.queue.length === 0 && !hp.voice.state.now.started, 'a move behind nothing: its clip is asked for and not yet begun');
    ok(stage().dataset.rooms === '' && !document.querySelector('#stage .card.away') && !talkHas(L + 1), "the clip not yet begun: everyone stays at the Square, the talk waits");
    ha.start(); await settle();
    ok(hp.voice.state.now.started && stage().dataset.rooms === 'out' && talkHas(L + 1), "the move's own clip begins: the stage breaks out as it is heard");
    ha.end(); await settle();
    // a vote's result behind nothing
    const flashed = () => !!document.querySelector('#stage .card.flash');
    await hsend([{...result, id: L + 2, day: T.day}], {ballot: null, pending: null, places: hp.state.watch.places});
    ok(hp.voice.state.now && hp.voice.state.now.id === L + 2 && !hp.voice.state.now.started && !flashed() && !talkHas(L + 2), "a vote's result behind nothing: no flash while its clip is made");
    ha.start(); await settle();
    ok(flashed() && talkHas(L + 2), 'the result flashes as its own clip begins');
    ha.end(); await settle();
    // the name tag first: the seat's caption comes with the line's own clip, not the tag's
    $('voice-names').checked = true; $('voice-names').dispatch('change');
    await hsend([ev(3, {type: 'say', seat: 4, text: 'Hear me out.'})], {places: hp.state.watch.places});
    const cap = () => {const c = document.querySelector('#stage .card[data-seat="4"]'); return c && c.querySelector('.cap-text') ? c.querySelector('.cap-text').textContent : ''};
    ha.start(); await settle(); // the tag begins
    ok(hp.voice.state.now.id === L + 3 && !hp.voice.state.now.started && hr.says.some(x => x.text === n[4] + '.') && cap() !== 'Hear me out.' && !talkHas(L + 3), 'while the name tag plays the line is not yet shown');
    ha.end(); await settle(); // the tag ends, the line's clip is asked to play
    ok(!hp.voice.state.now.started && cap() !== 'Hear me out.', 'the line asked to play but not begun: still not shown');
    ha.start(); await settle();
    ok(hp.voice.state.now.started && cap() === 'Hear me out.' && document.querySelector('#stage .card[data-seat="4"]').classList.contains('voicing') && talkHas(L + 3), "the line's own clip begins: its caption and its speaker light");
    ha.end(); await settle();
    hp.voice.stop();
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);

    // the recorded game is drawn as recorded
    install(HTML);
    const rp = createApp({client: relayClient({base: BASE, fetchImpl: voiceRelay().fetch}), fixture: GAME, runnersFixture: RUN, frame: 'rooms', audio: fakeAudio(), voiceFile: async () => null});
    await settle();
    ok(document.querySelector('#stage').dataset.rooms === 'out' && rp.state.source === 'recorded', 'the recorded game (rooms) is unaffected: the rooms are out');
  }

  // ---- the night aloud (#111): the night told in the Storyteller's voice, each seat's thought in its own ----
  console.log('voices: the night aloud');
  {
    const {NIGHT_N} = await import('../src/ui/stage.js');
    const {roleName} = await import('../src/ui/model.js');
    const vname = name => {const m = SEATV[name]; return typeof m === 'string' ? m : m.voice};
    const NF = GAME.frames.night, nn = NF.grimoire.seats.map(s => s.name), NS = NF.grimoire.seats;
    const at = o => ({phase: 'night', night: 2, day: 1, ...o});
    const P = (e, seats = NS) => VO.nightSpoken(at(e), nn, seats);
    const drunkSeat = NS.find(s => s.role === 'drunk');
    ok(P({type: 'wake', seat: 6, role: 'soldier'}) === `The Storyteller wakes ${nn[6]}, the Soldier.`, `wake: "${P({type: 'wake', seat: 6, role: 'soldier'})}"`);
    ok(P({type: 'wake', seat: drunkSeat.seat, role: drunkSeat.believed}) === `The Storyteller wakes ${nn[drunkSeat.seat]}, the ${roleName(drunkSeat.believed)}, who is truly the Drunk.`,
      `wake, the Drunk: "${P({type: 'wake', seat: drunkSeat.seat, role: drunkSeat.believed})}"`);
    ok(P({type: 'acted', seat: 0, role: 'poisoner', target: 1}) === `${nn[0]} poisons ${nn[1]}.` && P({type: 'acted', seat: 4, role: 'monk', target: 3}) === `${nn[4]} guards ${nn[3]}.`,
      `acted, a verb that names the role: "${P({type: 'acted', seat: 0, role: 'poisoner', target: 1})}" / "${P({type: 'acted', seat: 4, role: 'monk', target: 3})}"`);
    ok(P({type: 'acted', seat: 1, role: 'imp', target: 4}) === `${nn[1]}, the Imp, chooses ${nn[4]}.`, `acted, the demon: "${P({type: 'acted', seat: 1, role: 'imp', target: 4})}"`);
    ok(P({type: 'acted', seat: 5, role: 'butler', target: 1}) === `${nn[5]}, the Butler, picks ${nn[1]} as master.`, `acted, the Butler: "${P({type: 'acted', seat: 5, role: 'butler', target: 1})}"`);
    ok(P({type: 'acted', seat: 3, role: 'fortune-teller', targets: [0, 6]}) === `${nn[3]}, the Fortune Teller, checks ${nn[0]} and ${nn[6]}.` && P({type: 'acted', seat: 3, role: 'empath', target: null}) === `${nn[3]}, the Empath, picks nobody.`,
      `acted, two targets and a role with no verb: "${P({type: 'acted', seat: 3, role: 'fortune-teller', targets: [0, 6]})}" / "${P({type: 'acted', seat: 3, role: 'empath', target: null})}"`);
    ok(P({type: 'told', seat: 3, text: 'No: neither Odette nor Yusuf is the demon.'}) === `The Storyteller tells ${nn[3]}: No: neither Odette nor Yusuf is the demon.`, 'told: the Storyteller tells the seat, in its own words');
    ok(P({type: 'death', seat: 2, text: 'Ines dies.'}) === `${nn[2]} dies.` && P({type: 'bounce', from: 4, to: 3}) === `The kill passes from ${nn[4]} to ${nn[3]}.`, 'a death at night and a bounced kill');
    ok(P({type: 'thought', seat: 0, text: 'Quiet tonight.'}) === `${nn[0]} thinks: Quiet tonight.`, 'a thought, in the night list: "Name thinks: ..."');
    ok(VO.nightSpoken({type: 'death', phase: 'day', seat: 2}, nn) === null && VO.nightSpoken({type: 'told', phase: 'setup', seat: 0, text: 'You are the Baron.'}, nn) === null && VO.nightSpoken({type: 'ruling', phase: 'night'}, nn) === null && VO.nightSpoken({type: 'night', phase: 'night', text: 'Night 2 falls.'}, nn) === null,
      "a day death, a role told at setup, a ruling and nightfall are not the night's prose");
    const th = VO.spokenLine({id: 9, type: 'thought', seat: 4, text: 'Hm.'});
    ok(th && th.speaker === 4 && th.kind === 'thought', 'a thought is a seat-spoken line: in its own voice');

    // the live page: voice on, names on, the relay makes clips for the seats' lines (not for the night's prose)
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);
    const nr = voiceRelay({clipsOnSay: true}), na = fakeAudio();
    install(HTML);
    const np = createApp({client: relayClient({base: BASE, fetchImpl: nr.fetch}), refreshMs: null, audio: na, voiceFile: async () => null, clipWait: 600});
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const N0 = {...NF, events: NF.events.filter(e => e.id <= 54), last: 54};
    nr.watch = N0; await np.onSocketOpen(); await settle();
    $('voice-toggle').click(); await settle();
    const nsend = async events => {np.onSocket({type: 'watch', seed: NF.seed, last: events.at(-1).id, events, clock: null, pending: null, ballot: null, phase: 'night', day: NF.day, night: NF.night, winner: null}); await settle()};
    const told = NF.events.filter(e => e.id > 54 && e.id <= 60), prose = told.map(e => VO.nightSpoken(e, nn, NS)).filter(Boolean);
    const s0 = nr.says.length;
    await nsend(told);
    ok(nr.says.length > s0 && nr.says[s0].text === prose[0] && nr.says[s0].voice === 'v_st', `the night is told at once, in the Storyteller's voice, no clip waited for ("${nr.says[s0] && nr.says[s0].text}")`);
    ok(np.voice.state.now && np.voice.state.now.via === 'say' && np.voice.state.now.kind === 'night', "the night's prose is the page's own clip");
    const heardProse = [nr.says[s0].text];
    for (let i = 1; i < prose.length; i++) {na.end(); await settle(); heardProse.push(np.voice.state.now && np.voice.state.now.text)}
    ok(JSON.stringify(heardProse) === JSON.stringify(prose), `the night told in order: ${prose.map(t => '"' + t + '"').join(' / ')}`);
    ok(prose.some(t => t === `${nn[2]} dies.`), 'a death at night is spoken as it happens');
    {const st = document.querySelector('#stage .stage-st'); ok(st.classList.contains('speaking') && st.querySelector('.st-line').textContent === prose.at(-1), "the Storyteller's card speaks the night's line")}
    na.end(); await settle();

    // a thought: the tag "Name, thinking.", then the thought in the seat's voice, from the relay's clip
    const T1 = {id: 61, phase: 'night', night: NF.night, day: NF.day, type: 'thought', seat: 4, text: 'I keep counting the empty chairs.', audience: 'watcher'};
    const s1 = nr.says.length;
    await nsend([T1]);
    ok(nr.says.slice(s1).some(x => x.text === `${nn[4]}, thinking.` && x.voice === 'v_st'), `the name tag: "${nn[4]}, thinking." in the Storyteller's voice`);
    np.onSocket({type: 'clip', id: 61, clip: {id: 'c'.repeat(24), ms: 300}}); await settle();
    na.end(); await settle(); // the tag ends
    ok(na.plays.at(-1) === BASE + VOICE.clip + '?id=' + 'c'.repeat(24) && np.voice.state.now.via === 'clip', "then the thought itself, from the relay's clip");
    {const c = document.querySelector('#stage .card[data-seat="4"]'), cap = c.querySelector('.caption.thought .cap-text');
      ok(c.classList.contains('speaking') && c.classList.contains('thinking') && c.classList.contains('voicing') && cap && cap.textContent === T1.text, 'the thinking card lights with its thought as a caption in the thinking style');
      ok(!document.querySelector('#stage .stage-st').classList.contains('speaking'), "the Storyteller's card is not the speaker while a seat thinks")}
    na.end(); await settle();
    // without the relay's clip: the page's own, in the seat's voice
    const T2 = {...T1, id: 62, seat: 6, text: 'Tomorrow I say less.'};
    const s2 = nr.says.length;
    await nsend([T2]); na.end(); await sleep(700); await settle();
    ok(nr.says.slice(s2).some(x => x.text === T2.text && x.voice === vname(nn[6])),
      `no clip within the wait: the thought is asked of /tts/say in ${nn[6]}'s voice`);
    na.end(); await settle();
    {const l = document.querySelectorAll('#stage .st-night .nl').map(x => x.textContent);
      ok(l.length <= NIGHT_N && l.includes(`${nn[6]} thinks: ${T2.text}`) && l.some(t => t.startsWith('The Storyteller ')), `the night's list in the same prose (${l.length} lines)`)}
    ok(!!document.querySelector('#talk .line.thought') && /thinks, for you only/.test(document.querySelector('#talk .line.thought').textContent), 'the talk lists the thoughts with the night, marked as the watcher\'s alone');

    // seven thoughts and the night's prose in one push: none dropped
    const d0 = np.voice.state.dropped;
    const burst = [...[0, 1, 3, 4, 6].map((s, i) => ({id: 63 + i, phase: 'night', night: NF.night, day: NF.day, type: 'thought', seat: s, text: `Thought ${i + 1}.`, audience: 'watcher'})),
      {id: 68, phase: 'night', night: NF.night, day: NF.day, type: 'wake', seat: 3, role: 'fortune-teller'}, {id: 69, phase: 'night', night: NF.night, day: NF.day, type: 'told', seat: 3, text: 'Yes.'},
      {id: 70, phase: 'night', night: NF.night, day: NF.day, type: 'thought', seat: 2, text: 'Thought six.'}, {id: 71, phase: 'night', night: NF.night, day: NF.day, type: 'thought', seat: 5, text: 'Thought seven.'}];
    await nsend(burst);
    const q = np.voice.state, inLine = [q.now, ...q.queue].filter(Boolean).map(x => x.id);
    ok(q.dropped === d0 && burst.every(e => inLine.includes(e.id)), `nothing is dropped at night: ${burst.length} lines wait to be read (cap ${VO.QUEUE_CAP} is the day's)`);
    np.voice.stop();
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY); localStorage.removeItem(VO.NAMES_KEY);

    // voice off: nothing spoken; the night view still lists the prose and the newest thought lights its card
    const or = voiceRelay(), oa = fakeAudio();
    const op = livePage(or, oa);
    or.watch = N0; await op.onSocketOpen(); await settle();
    op.onSocket({type: 'watch', seed: NF.seed, last: 63, events: NF.events.filter(e => e.id > 54), clock: null, pending: null, ballot: null, phase: 'night', day: NF.day, night: NF.night, winner: null}); await settle();
    {const l = document.querySelectorAll('#stage .st-night .nl').map(x => x.textContent), lastT = NF.events.at(-1);
      ok(or.says.length === 0 && oa.plays.length === 0, 'Voice off: nothing is spoken at night');
      ok(l.some(t => t.startsWith('The Storyteller tells ')) && l.includes(`${nn[lastT.seat]} thinks: ${lastT.text}`), `Voice off: the night view lists the night in prose (${l.join(' | ')})`);
      ok(document.querySelector(`#stage .card[data-seat="${lastT.seat}"]`).classList.contains('thinking'), 'Voice off: the newest thought lights its card')}
    op.voice.stop();

    // the recorded night (?fixture=night)
    install(HTML);
    createApp({client: relayClient({base: BASE, fetchImpl: voiceRelay().fetch}), fixture: GAME, runnersFixture: RUN, frame: 'night', audio: fakeAudio(), voiceFile: async () => null});
    await settle();
    {const thoughts = NF.events.filter(e => e.type === 'thought'), lastT = thoughts.at(-1), c = document.querySelector(`#stage .card[data-seat="${lastT.seat}"]`);
      const l = document.querySelectorAll('#stage .st-night .nl').map(x => x.textContent);
      ok(thoughts.length >= 2 && document.querySelector('#stage').dataset.phase === 'night', `the recorded game has a night with ${thoughts.length} thoughts`);
      ok(c.classList.contains('thinking') && c.querySelector('.caption.thought .cap-text').textContent === lastT.text, 'the recorded night: a card thinking, its thought as its caption');
      ok(l.filter(t => / thinks: /.test(t)).length === thoughts.length && l.some(t => /^The Storyteller (wakes|tells) /.test(t)), "the recorded night's list in the voice's prose")
      ok(document.querySelectorAll('#talk .line.thought').length === thoughts.length, 'the talk lists the recorded thoughts')}
  }
}

// ---- rooms in the talk (#28) ----
console.log('rooms in the talk');
{
  install(HTML);
  const rr = fakeRelay();
  const ra = createApp({client: relayClient({base: BASE, fetchImpl: rr.fetch}), refreshMs: null, audio: null, voiceFile: async () => null});
  const T = GAME.frames.talk, n = T.grimoire.seats.map(s => s.name), L = T.last;
  const extra = [
    {id: L + 1, type: 'move', day: T.day, night: T.night, seats: [0, 1], room: 'nook', from: null, by: 0, text: `${n[0]} and ${n[1]} went to the snug.`},
    {id: L + 2, type: 'say', day: T.day, night: T.night, seat: 0, room: 'nook', text: 'Only for your ears.'},
    {id: L + 3, type: 'say', day: T.day, night: T.night, seat: 2, text: 'Said at the Square.'},
  ];
  rr.watch = {...T, last: L + 3, events: [...T.events, ...extra], places: {square: [2, 3, 4, 5, 6], rooms: [{id: 'nook', name: 'the snug', size: 2, seats: [0, 1], free: 0}], open: true}};
  await ra.pollWatch();
  const line = k => document.querySelector(`#talk .line[data-key="e${k}"]`);
  ok(line(L + 1) && line(L + 1).classList.contains('move') && line(L + 1).textContent === extra[0].text, 'a move shows as a one-line mark');
  ok(line(L + 2) && line(L + 2).classList.contains('in-room') && /^in the snug:/.test(line(L + 2).querySelector('.place').textContent) && line(L + 2).querySelector('.who').textContent === n[0] && line(L + 2).textContent.includes('Only for your ears.'),
    `a line said in a room carries its place, named from the watch body (${line(L + 2) && line(L + 2).textContent})`);
  ok(line(L + 3) && !line(L + 3).classList.contains('in-room') && !line(L + 3).querySelector('.place'), 'a line at the Square has no place mark');
  // the square while the rooms are open: a tag on each seat away, the rooms off the table's edge, one line of who is where
  const sq = () => document.querySelector('#square');
  const away = () => document.querySelectorAll('#square .seat.away').map(s => +s.dataset.seat);
  const tags = () => document.querySelectorAll('#square .away-tag').map(t => t.textContent);
  ok(JSON.stringify(away()) === '[0,1]' && JSON.stringify(tags()) === '["the snug","the snug"]', `the two seats in a room carry its name as a tag (${tags().join(', ')})`);
  ok(!document.querySelectorAll('#square .seat').filter(s => ![0, 1].includes(+s.dataset.seat)).some(s => s.querySelector('.away-tag')), 'a seat at the Square has no tag');
  const strip = sq().querySelector('.rooms-strip');
  ok(strip && !strip.hidden && strip.querySelectorAll('.room').length === 1 && strip.querySelector('.room[data-room="nook"] .room-name').textContent === 'the snug', 'the room shows as a labelled disc off the table');
  ok(strip.querySelectorAll('.room[data-room="nook"] .rd-person').length === 2 && strip.querySelector('.room[data-room="nook"] .room-count').textContent === '2 of 2', 'its disc holds its two occupants and says how full it is');
  {
    const P = {square: [3, 4, 5, 6], rooms: [{id: 'nook', name: 'the Snug', size: 2, seats: [0, 1], free: 0}, {id: 'parlour', name: 'the Vestry', size: 3, seats: [], free: 3}, {id: 'backroom', name: 'the Taproom', size: 4, seats: [2], free: 3}], open: true};
    rr.watch = {...rr.watch, places: P}; await ra.pollWatch();
    const want = `${n[0]} and ${n[1]} in the Snug; ${n[2]} in the Taproom; the Vestry empty`;
    ok(strip.querySelector('.rooms-line').textContent === want, `one line under the table says who is where (${strip.querySelector('.rooms-line').textContent})`);
    ok(strip.querySelectorAll('.room').length === 3 && strip.querySelector('.room[data-room="parlour"]').classList.contains('empty') && strip.querySelector('.room[data-room="parlour"] .room-count').textContent === 'empty', 'all three rooms show; an empty one says so');
    ok(JSON.stringify(away()) === '[0,1,2]' && tags()[2] === 'the Taproom', 'a third seat in another room carries that room\'s name');
    const {roomsLine} = await import('../src/ui/square.js');
    ok(roomsLine(P.rooms.map(r => ({...r, seats: []})), n) === 'Everyone is at the Square; the rooms stand empty', 'with every room empty the line says everyone is at the Square');
    const T2 = await import('../src/ui/tokens.js');
    const disc = T2.roomDisc(P.rooms[0], [{name: n[0], portrait: '/assets/portraits/x.png'}, {name: n[1]}]);
    ok(/<image class="rd-portrait"[^>]*clip-path="url\(#ct-room-2-0\)"/.test(disc) && /rd-initial[^>]*>B</.test(disc.replace(n[1][0], 'B')) && !/#[0-9a-f]{3,6}\b/i.test(disc.replace(/url\(#ct-room-\d-\d\)/g, '')),
      'a room disc draws a portrait where there is one, the initial otherwise, and no colour of its own (the colours are page variables)');
    const dbox = {}; T2.installDefs({body: {append: b => {dbox.b = b}}, getElementById: () => null, createElement: () => ({setAttribute() {}})});
    ok(['ct-room-1-0', 'ct-room-2-1', 'ct-room-3-2', 'ct-room-4-3'].every(id => dbox.b.innerHTML.includes('id="' + id + '"')), 'the clip shapes for up to four occupants are on the page');
    const css = readFileSync(join(ROOT, 'styles/page.css'), 'utf8');
    ok(['--room-rim', '--room-face', '--room-tag'].every(v => css.includes(v + ':')), 'the rooms\' colours are page variables');
    // the rooms close: the tags, the discs and the line go
    rr.watch = {...rr.watch, places: {...P, open: false, rooms: P.rooms.map(r => ({...r, seats: [], free: r.size}))}}; await ra.pollWatch();
    ok(away().length === 0 && tags().length === 0 && strip.hidden && !strip.querySelector('.room'), 'when the rooms close, the tags, the discs and the line go');
    rr.watch = {...rr.watch, places: P}; await ra.pollWatch();
    rr.watch = {...rr.watch, places: undefined}; await ra.pollWatch();
    ok(away().length === 0 && strip.hidden, 'a watch body without places shows no rooms');
  }
  const {talkLine} = await import('../src/ui/talk.js');
  const {ROOMS} = await import('../src/data/rooms.js');
  ok(talkLine({type: 'say', seat: 0, room: ROOMS[0].id, text: 'x'}, n).html.includes(`in ${ROOMS[0].name}:`), `without places in the body, the room is named from the rooms as data (${ROOMS[0].name})`);
}

// ---- the People view (#77) ----
console.log('the People view');
const {frameAt} = await import('../src/ui/model.js');
{
  install(HTML);
  const pr = fakeRelay();
  const papp = createApp({client: relayClient({base: BASE, fetchImpl: pr.fetch}), refreshMs: null});
  const body = document.body, stage = $('stage');
  ok(body.dataset.view === 'people' && localStorage.getItem('clocktower.view') === null, 'the People view is the default; nothing is stored until the owner picks');
  pr.watch = GAME.frames.talk; await papp.onSocketOpen();
  const T = GAME.frames.talk, tn = T.grimoire.seats.map(s => s.name);
  const cards = () => stage.querySelectorAll('.card');
  const card = i => stage.querySelector(`.card[data-seat="${i}"]`);
  ok(cards().length === 7 && JSON.stringify(cards().map(c => c.querySelector('.name').textContent)) === JSON.stringify(tn), 'seven cards on the stage, in seat order');
  // the stage fits its window (#79): the cards are placed from the table's measured box, and at every table size from a small laptop
  // to 3440x1440 no card leaves the table, no two cards touch, and the middle (dawn, tally, winner) is a box clear of every face
  {const {stageLayout} = await import('../src/ui/stage.js');
    ok(cards().every(c => /--x:\d+px;--y:\d+px/.test(c.getAttribute('style') || '')) && /--ring-cw:\d+px/.test(stage.querySelector('.table').getAttribute('style') || '') &&
      /--mid-w:\d+px/.test(stage.querySelector('.table').getAttribute('style') || ''), 'the cards and the middle are placed from the measured table');
    const sizes = [[958, 470], [1060, 520], [1300, 600], [1590, 690], [1500, 820], [2000, 700], [2850, 1150]], bad = [];
    const hit = (p, q) => p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;
    for (const [w, h] of sizes) {
      const L = stageLayout(w, h, [0, 1, 2, 3, 4, 5, 6]);
      const box = p => ({l: p.x - L.cw / 2, r: p.x + L.cw / 2, t: p.y - L.ch / 2, b: p.y + L.ch / 2});
      const bs = Object.values(L.pos).map(box), m = {l: L.mid.x, r: L.mid.x + L.mid.w, t: L.mid.y, b: L.mid.y + L.mid.h};
      if (bs.some(b => b.l < 0 || b.t < 0 || b.r > w || b.b > h)) bad.push(`${w}x${h}: a card leaves the table`);
      if (bs.some((p, i) => bs.some((q, j) => j > i && hit(p, q)))) bad.push(`${w}x${h}: two cards touch`);
      if (L.mid.w < 200 || L.mid.h < 90 || bs.some(b => hit(b, m))) bad.push(`${w}x${h}: the middle ${JSON.stringify(L.mid)} is too small or runs onto a face`);
    }
    ok(!bad.length, 'at every size the cards fit the table, apart, and the middle text has its own box clear of the faces' + (bad.length ? ': ' + bad.join('; ') : ''));
  }
  ok(cards().every((c, i) => c.querySelector('.initial').textContent === tn[i][0]), 'each card carries the initial under its portrait (no portraits here)');
  ok(cards().every((c, i) => c.querySelector('.role-corner .role-token').dataset.role === T.grimoire.seats[i].role), 'each card has its true role small in a corner');
  ok(!!stage.querySelector('.stage-st .face') && /Storyteller/.test(stage.querySelector('.stage-st .name').textContent) && stage.querySelector('.stage-st .st-line').textContent.length > 0,
    "the Storyteller's portrait sits apart with its latest words");
  // a pushed line lights its speaker and sits beside the face
  const base = {type: 'watch', seed: T.seed, clock: T.clock, pending: T.pending, ballot: null, phase: T.phase, day: T.day, night: T.night, winner: null};
  let nid = T.last;
  const push = async e => {const ev = {id: ++nid, phase: 'day', night: T.night, day: T.day, audience: 'all', ...e}; papp.onSocket({...base, last: ev.id, events: [ev]}); await tick(); return ev};
  const s1 = await push({type: 'say', seat: 3, text: 'The tower is wrong by four minutes.'});
  let sp = stage.querySelectorAll('.card.speaking');
  ok(sp.length === 1 && sp[0].dataset.seat === '3' && sp[0].querySelector('.caption .cap-text').textContent === s1.text, `a pushed line lights ${tn[3]}'s card, the line beside the face`);
  const s2 = await push({type: 'say', seat: 5, text: 'Four minutes is a long time in this town.'});
  sp = stage.querySelectorAll('.card.speaking');
  ok(sp.length === 1 && sp[0].dataset.seat === '5' && !card(3).querySelector('.caption') && card(5).querySelector('.cap-text').textContent === s2.text, 'the next line moves the light and the caption');
  const strip = stage.querySelector('.recent');
  ok(strip.firstChild && strip.firstChild.dataset.key === String(s1.id) && /four minutes/.test(strip.firstChild.textContent) && strip.children.length <= 8, 'the line before goes down into the recent strip, newest first, eight at most');
  ok(strip.firstChild.querySelector('.who.sc-3'), 'the strip keeps the speaker colours');
  const wh = await push({type: 'whisper', from: 1, to: 2, text: 'Watch Corwin tonight.', audience: [1, 2]});
  const wc = card(1).querySelector('.caption.whisper');
  ok(!!wc && new RegExp('to ' + tn[2]).test(wc.textContent) && /did not hear/.test(wc.textContent) && wc.querySelector('.cap-text').textContent === wh.text, 'a whisper shows on the whisperer, to whom, marked as unheard by the table');
  await push({type: 'say', seat: 4, room: 'nook', text: 'Just the two of us, then.'});
  ok(/in the Snug/.test(card(4).querySelector('.caption.in-room .cap-head').textContent), 'a line said in a room carries its place');
  ok(strip.querySelector('.r-line[data-kind~="whisper"]'), 'the strip marks the whisper');
  // drawers over the stage's edge
  const firstCard = card(0), talkBox = $('talk').querySelector('.lines'), firstLine = talkBox.firstChild;
  const tab = k => document.querySelector(`#drawer-tabs button[data-drawer="${k}"]`);
  tab('talk').click();
  ok(body.dataset.drawer === 'talk' && tab('talk').getAttribute('aria-expanded') === 'true', 'the Talk tab opens the talk drawer');
  const s3 = await push({type: 'say', seat: 6, text: 'Then I will wait four minutes.'});
  ok(stage.isConnected && card(0) === firstCard && card(6).classList.contains('speaking') && talkBox.firstChild === firstLine && talkBox.querySelector(`.line[data-key="e${s3.id}"]`),
    'with a drawer open the stage stays mounted and goes on; the talk appends behind it');
  tab('grimoire').click();
  ok(body.dataset.drawer === 'grimoire' && tab('talk').getAttribute('aria-expanded') === 'false', 'another tab swaps the drawer');
  tab('grimoire').click();
  ok(body.dataset.drawer === '', 'its tab again closes it');
  tab('agents').click(); body.dispatch('keydown', {key: 'Escape'});
  ok(body.dataset.drawer === '', 'Esc closes a drawer');
  tab('rulings').click(); document.querySelector('#board .drawer-close').click();
  ok(body.dataset.drawer === '' && card(0) === firstCard, 'Close closes it; the same stage is there');
  // the roles switch
  $('roles-toggle').checked = false; $('roles-toggle').dispatch('change');
  ok(body.dataset.roles === 'off' && stage.querySelectorAll('.role-corner').length === 0 && localStorage.getItem('clocktower.roles') === 'off', 'the roles switch hides the roles on the cards, remembered');
  ok(document.querySelectorAll('#grimoire .grim-row .role-token').length === 7, 'the grimoire still shows every role');
  // the view switch and its memory
  tab('talk').click();
  document.querySelector('#view-switch button[data-view="table"]').click();
  ok(body.dataset.view === 'table' && body.dataset.drawer === '' && localStorage.getItem('clocktower.view') === 'table', 'Table switches the view, closes the drawer and is remembered');
  const kept = {...localStorage._d};
  install(HTML); Object.assign(localStorage._d, kept);
  createApp({client: relayClient({base: BASE, fetchImpl: fakeRelay().fetch}), refreshMs: null});
  ok(document.body.dataset.view === 'table' && document.body.dataset.roles === 'off' && !$('roles-toggle').checked, 'the next visit opens on the remembered view, roles hidden');
  document.querySelector('#view-switch button[data-view="people"]').click();
  ok(document.body.dataset.view === 'people' && localStorage.getItem('clocktower.view') === 'people', 'People again, remembered');
}
{
  // the recorded vote, night, dawn and end, as ?fixture shows them
  install(HTML);
  const fapp = createApp({client: relayClient({base: BASE, fetchImpl: fakeRelay().fetch}), fixture: GAME, runnersFixture: RUN, frame: 'vote'});
  const stage = $('stage'), V = GAME.frames.vote, p = V.pending, card = i => stage.querySelector(`.card[data-seat="${i}"]`);
  const vn = V.grimoire.seats.map(s => s.name);
  ok(card(p.nominee).classList.contains('is-nominee') && card(p.nominee).querySelector('.tag.nominee') && card(p.nominator).classList.contains('is-nominator') && card(p.nominator).querySelector('.tag.nominator'),
    `the vote: ${vn[p.nominee]} ringed as the nominee, ${vn[p.nominator]} as the nominator`);
  const votes = V.ballot.votes, yes = Object.values(votes).filter(Boolean).length, no = Object.values(votes).filter(x => !x).length;
  ok(stage.querySelectorAll('.hand-mark.up').length === yes && stage.querySelectorAll('.hand-mark.down').length === no && stage.querySelectorAll('.hand-mark.none').length === p.seats.length - yes - no,
    `hands on the faces: ${yes} yes, ${no} no, ${p.seats.length - yes - no} to cast`);
  for (const [i, x] of Object.entries(votes)) ok(!!card(i).querySelector(x ? '.hand-mark.up' : '.hand-mark.down'), `${vn[i]}'s card shows ${x ? 'yes' : 'no'}`);
  const need = Math.ceil(V.grimoire.seats.filter(s => s.alive).length / 2), c = stage.querySelector('.table-centre');
  const pips = c.querySelectorAll('.pip');
  ok(c.querySelector('.tally-big b').textContent === String(yes) && new RegExp(`of ${need} needed`).test(c.textContent) && pips.filter(x => x.classList.contains('yes')).length === yes && pips.findIndex(x => x.classList.contains('need')) === need - 1,
    `the tally in the middle: ${yes} of ${need} needed, the bar at ${need}`);
  ok(!stage.querySelector('.caption'), 'no caption from before the nomination hangs over the vote');
  // a vote just closed: its result flashed on the nominee
  const E = GAME.frames.end, vote = E.events.find(e => e.type === 'vote');
  fapp.state.watch = frameAt(E, vote.id); fapp.state.epoch++; fapp.render();
  const res = card(vote.target).querySelector('.result');
  ok(card(vote.target).classList.contains('flash') && res && new RegExp(`${vote.tally} of ${vote.need}`).test(res.textContent), `the result flashed on the nominee (${res && res.textContent})`);
  // night
  $('frames').value = 'night'; $('frames').dispatch('change');
  const N = fapp.state.watch;
  ok(stage.dataset.phase === 'night' && /Night \d/.test(stage.querySelector('.night-big').textContent), `night: the stage dims, "${stage.querySelector('.night-big').textContent}" in the middle`);
  ok(stage.querySelector('.stage-st').classList.contains('awake') && stage.querySelectorAll('.st-night div').length > 0, "the Storyteller's card wakes, with what it does tonight");
  const dead = N.grimoire.seats.filter(s => !s.alive);
  ok(dead.length > 0 && dead.every(s => card(s.seat).classList.contains('dead') && card(s.seat).querySelector('.shroud') && card(s.seat).querySelector('.ghost-corner')), `the dead are shrouded in place, with their ghost vote (${dead.map(s => s.name).join(', ')})`);
  ok(stage.querySelectorAll('.card.woken').length === 1, 'the seat the Storyteller has woken glows');
  // dawn
  $('frames').value = 'dawn'; $('frames').dispatch('change');
  const D = fapp.state.watch, dawn = D.events.findLast(e => e.type === 'dawn');
  ok(stage.dataset.phase === 'day' && stage.querySelector('.dawn-big').textContent === dawn.text && stage.querySelector('.dawn-words'), `dawn: "${dawn.text}" large in the middle, with its narration`);
  ok(dawn.deaths.every(i => card(i).querySelector('.shroud')), 'the night\'s dead are shrouded at dawn');
  // rooms break the stage out (#80): the people in a room sit inside its panel, the rest round the Square's table, left of every panel
  $('frames').value = 'rooms'; $('frames').dispatch('change');
  {const R = fapp.state.watch, used = R.places.rooms.filter(r => r.seats.length);
    const num = (s, k) => {const m = new RegExp('(?:^|;)' + k + ':(-?\\d+)px').exec(s || ''); return m ? +m[1] : NaN};
    const at = i => ({x: num(card(i).getAttribute('style'), '--x'), y: num(card(i).getAttribute('style'), '--y')});
    const box = g => ({l: num(g.getAttribute('style'), 'left'), t: num(g.getAttribute('style'), 'top'), w: num(g.getAttribute('style'), 'width'), h: num(g.getAttribute('style'), 'height')});
    const groups = stage.querySelectorAll('.room-group'), byId = Object.fromEntries(groups.map(g => [g.dataset.room, box(g)]));
    const inside = (p, b) => p.x > b.l && p.x < b.l + b.w && p.y > b.t && p.y < b.t + b.h;
    ok(used.length >= 2 && stage.dataset.rooms === 'out' && groups.length === used.length && used.every(r => byId[r.id] && stage.querySelector(`.room-group[data-room="${r.id}"] .room-name`).textContent === r.name),
      `the stage breaks out: one panel per room in use, named (${used.map(r => r.name).join(', ')}); the empty rooms are not drawn`);
    ok(used.every(r => r.seats.every(i => inside(at(i), byId[r.id]))), 'everyone away sits inside their own room\'s panel');
    const left = Math.min(...Object.values(byId).map(b => b.l));
    ok(R.places.square.every(i => at(i).x < left && !Object.values(byId).some(b => inside(at(i), b))), 'everyone at the Square sits round the table, clear of the rooms');
    const said = R.events.findLast(e => e.type === 'say' && e.room != null), rl = stage.querySelector(`.room-group[data-room="${said.room}"] .room-line`);
    ok(!!rl && rl.textContent.includes(said.text), `the room's newest line shows in its panel under its people ("${said.text}")`);
    const firstCard = card(used[0].seats[0]);
    fapp.state.watch = {...R, places: {...R.places, open: false, square: R.grimoire.seats.map(s => s.seat), rooms: R.places.rooms.map(r => ({...r, seats: []}))}}; fapp.state.epoch++; fapp.render();
    ok(stage.querySelectorAll('.room-group').length === 0 && stage.dataset.rooms === '' && card(used[0].seats[0]) === firstCard && !inside(at(used[0].seats[0]), byId[used[0].id]),
      'when the rooms close the panels go and the same cards slide back into the ring');
  }
  $('frames').value = 'end'; $('frames').dispatch('change');
  ok(/wins/.test(stage.querySelector('.winner-big').textContent), 'the end: the winner in the middle');
  // phone layout and no control that acts for a seat
  const css = readFileSync(join(ROOT, 'styles/page.css'), 'utf8'), phone = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  ok(/#stage \.table \{ display: grid; grid-template-columns: repeat\(2,/.test(phone) && /\.card\.speaking \{ grid-column: 1 \/ -1; \}/.test(phone) && /body\[data-view="people"\] #board \{ position: fixed; inset: 0/.test(phone),
    'at phone width: two columns of cards, the speaker across both with its caption under, the drawers over the whole screen');
  ok(stage.querySelectorAll('button, input, select, textarea').length === 0, 'the stage has no control at all');
  const labels = [...document.querySelectorAll('#drawer-tabs button, #view-switch button')].map(b => b.textContent).join(' ') + ' ' + $('bar-start-all').textContent;
  ok(!/\b(nominate|vote|whisper|speak)\b/i.test(labels), `the new controls only switch views, open drawers and start runners (${labels})`);
}

console.log(fails ? `${fails} check(s) failed` : 'the page renders the game and changes nothing');
process.exit(fails ? 1 : 0);
