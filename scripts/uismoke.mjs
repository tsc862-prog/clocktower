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
const allowed = new Set([...Object.values(READS), ...Object.values(ACTIONS)]);
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
ok($('frames').options.length === 3 && !$('frames').hidden, 'a picker offers the three recorded moments');
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

console.log(fails ? `${fails} check(s) failed` : 'the page renders the game and changes nothing');
process.exit(fails ? 1 : 0);
