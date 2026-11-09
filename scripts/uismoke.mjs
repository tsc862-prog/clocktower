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
//   - rooms (#28): a line said in a room carries its place, a move is a one-line mark; in the square, a seat away carries its room's
//     name, the rooms show as discs off the table with their occupants, one line says who is where; all of it goes when the rooms close
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
  const livePage = (r, audio) => {install(HTML); return createApp({client: relayClient({base: BASE, fetchImpl: r.fetch}), refreshMs: null, audio, voiceFile: async () => null})};
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
  const heard = [vr.says[0].text], litBy = [who0 === 'storyteller' ? centreLit() : lit()[0] === who0];
  for (let i = 1; i < want.length; i++) {
    au.end(); await settle();
    heard.push(vr.says[i] && vr.says[i].text);
    litBy.push(want[i].speaker === 'storyteller' ? centreLit() && lit().length === 0 : JSON.stringify(lit()) === JSON.stringify([want[i].speaker]));
  }
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
  ok(va.voice.state.queue.length <= VO.QUEUE_CAP && va.voice.state.dropped > 0, `a burst of ${rest.length} entries leaves at most ${VO.QUEUE_CAP} lines waiting (${va.voice.state.dropped} dropped)`);
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
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY);
    const kr = voiceRelay({clipsOnSay: true}), ka = fakeAudio();
    let tickFn = null;
    install(HTML);
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
    localStorage.removeItem(VO.VOICE_KEY); localStorage.removeItem(VO.WHISPER_KEY);
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

console.log(fails ? `${fails} check(s) failed` : 'the page renders the game and changes nothing');
process.exit(fails ? 1 : 0);
