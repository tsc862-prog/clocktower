# ui-designer memory

## Layout (slice 6, page v1; not yet reviewed by the owner)
- 3440x1440: game bar on top; four columns: Square over Grimoire | the day's talk | Storyteller's log | Agents. Each log scrolls by itself.
- Under 1900px: two columns (square+grimoire | talk; log | agents). Under 900px: one column in reading order.
- Plain dark page, Georgia for reading text, system sans for small labels. Colour means something: blue good, red evil,
  violet private (whispers, what a seat is told, tokens), gold the clock, votes and the winner.
- Seats clockwise from the top in seat order. Under each seat "ST sees" + true role, "(thinks X)" for the Drunk, short token words.

## Patterns
- Never rebuild a list: talk and rulings append by event id; grimoire and square patch keyed rows by HTML diff; agent rows are built
  once (inputs and <details> survive). `follower()` in src/ui/dom.js: follows until scrolled up, "N new below" button resumes.
- `epoch` in app state resets talk/rulings (fixture frame change, new game, relay serving a game from id 0).

## Event shapes the page reads
- Watch frame (asked as GET /play/watch?since=N, page origin only; reference implementation `watchView` in scripts/uifixture.mjs):
  {seed, rounds, phase, night, day, clock, pending (raw game.pending), ballot {id, nominee, votes{seat:bool}}, grimoire (api.grimoire),
  nightOrder, rulings, winner, last, events (api.events(game, ST) + raw whispers, sorted), canNewGame?}.
- WebSocket /play: {type:'links', links{id:link}, runners{id:{provider,model}}, ready{id:{state}}, storyteller{link,claimed,runner,ready}};
  {type:'narrate', player, text} -> an aside in the talk.
- GET /play/runner (supervisor view); lastTurn {wake, at, cost, header, tools[{tool,args,ok,error}]} asked, not sent yet.
- /play/health refuses any request with an Origin header, so the page cannot read it; it uses /health and the socket.

## Checks
- npm run uismoke (CI core): stubbed DOM (scripts/stubdom.mjs, from Eldmoor) + src/ui/fixtures/game.json (npm run uifixture, seed 1)
  + runners.json (hand-written). Screenshots: build, `vite preview --port 5791`, headless Chrome --window-size=3440,1440 on ?fixture.

## Live push and pace (PR #43)
- Socket {type:'watch', seed, last, events, clock, pending, ballot, phase, day, night, winner} merged by mergePush (dedupe by id; replay vs new game).
  No grimoire/rulings/nightOrder in the push: a debounced ?since=last read 1.5 s after a push with new events. Timer poll only while the socket is down.
- Pace knob (fast 20 s/120 min, readable 60/360 default, slow 150/720) sent as minGap/heartbeat in start bodies; the supervisor ignores them
  until infra wires --min-gap/--heartbeat (asked in #43).

## Tokens (PR #44) and phone (PR 3)
- src/ui/tokens.js: all SVG drawings (ROLE_ICONS, REMINDER_ICONS, seatMarker, ghostCoin, handMarker); colours as CSS custom properties.
  Text arcs via shared <defs> (installDefs, #ct-arc-low, #ct-arc-seat). Style not yet approved by the owner.
- Talk: speaker colour per seat (.who.sc-0..6, --seat-c0..6). Under 600 px: one column, smaller markers, overflow-x: clip (not hidden:
  hidden makes body a scroll container). ?fixture=vote|talk|end opens that recorded moment.
- True 390 px measurement needs CDP Emulation.setDeviceMetricsOverride (headless Chrome's window has a ~500 px minimum).

## Local art, portraits, voices (PRs #54, #56, #58, 2026-11-08)
- Owner's token art is WebP in his own E:/clocktower/public/tokens-local/ (never read, copy or commit it). src/ui/art.js probes
  /tokens-local/<id>.png then .webp once per page load; tokens.js must name no image file (smoke checks it). .gitignore: folder/* + !README.
- Portrait index (infra #55 accept script): {version:1, portraits:{Odette:{file:'Odette.png',...}, ..., Storyteller}}; files in
  assets/portraits/. vite.config.js plugin serves /assets/portraits/* in dev and preview (plain 404; Vite's own fallback returns HTML 200).
- /tts/status (infra #53): {ok, voices:[engine ids], seatVoices:{Name:{voice,speed}}}; src/data/voices.js (lore #52) VOICES same shape.
  Voice toggle off by default (localStorage clocktower.voice); recorded game never spoken; queue cap 4 waiting, talk dropped first.
- Bash heredocs here collapse `\` to `\`: write files containing backslashes with the Write tool. CDP screenshots: ws package + Chrome
  --remote-debugging-port (script pattern: launch, Page.navigate, Runtime.evaluate, Page.captureScreenshot).

## Keeping time and rooms in the square (PRs #63, #64, 2026-11-08)
- Relay clips (infra #62): watch event `clip:{id,ms}` or socket {type:'clip', id:<event id>, clip:{id,ms}}; play GET /tts?id=. Page waits
  CLIP_WAIT_MS 1 s only when /tts/status clipsOnSay, then POST /tts/say; whispers say at once. `ms` is generation time, not duration.
- POST /play/heard {last, voice}: last = newest event played/skipped (st.seen when idle). Sent on end, skip, turn on, unmute, 20 s tick
  while on; voice:false at once on mute/off; never while off or recorded. #voice-time "keeping time" pill when clipsOnSay + reporting.
- mergePush ignores `clip` when testing replay. Smoke timers: Windows setTimeout(0) ~16 ms, so clip waits in the smoke are 600 ms.
- places {square, rooms:[{id,name,size,seats,free}], open}: square.js openRooms/roomsLine; tag .away-tag under the marker, discs in
  .rooms-strip under the ring (roomDisc in tokens.js, clip ids ct-room-N-i), --room-* variables. All hidden when !open. Not yet reviewed.

## People view (PR #78, issue #77, owner decision 2026-11-08: "make the people the main screen"; layout not yet reviewed)
- Default view: src/ui/stage.js. body[data-view=people|table] (localStorage clocktower.view; ?view= one visit, not stored),
  body[data-roles] (clocktower.roles), body[data-drawer=talk|grimoire|rulings|agents|''].
- 3440: Storyteller column left (portrait, latest ST words, tonight's ST-only lines) | ellipse of 7 cards (seatPlace: rx 39%, ry 37%,
  caption on the inward side) | right tab rail. Recent strip (8 lines, newest first, fading) under it. Centre: day line / vote tally +
  pip bar with need marker / fresh result / Night N / dawn large / winner.
- Drawers = the Table view's own #board panels, absolutely stacked and visibility-hidden (never unmounted, scroll kept).
- Caption = newest say/whisper/narration/dawn (voice on: the line playing, else last played); dims after a vote/phase; gone after
  nomination/night/win. Phone <600: 2-col grid, speaker card spans both with caption under, drawers fixed full-screen, tabs bottom.
- Recorded game: model.fixtureMoments(end) adds 'night' and 'dawn' cut by frameAt (dawn events carry grimoire snapshots).
- Screens: logs/tmp/shot.mjs pattern (CDP, Emulation.setDeviceMetricsOverride); vite preview binds localhost (IPv6), not 127.0.0.1.
- Bash heredocs with quotes in this tool can fail to parse: write edit scripts/CSS chunks with the Write tool, then run/append.

## Stage sizing (PR #86, issue #79, owner's "bad UI" at ~2000x900 CSS px, 2026-11-09)
- stage.js stageLayout(w, h, seats, rooms) measures .table (ResizeObserver) and writes px vars: table --ring-cw --ring-name --table-h
  --mid-x/y/w/h (on the table, so the oval ::before reads them too); cards --x --y. CSS reads them only in @media (min-width: 601px).
- Card = largest cw (<= min(320, .34h, .16w)) with every box + pad inside the table, no two boxes (cw x cw+label) within 12 px, and a
  free middle >= min(520,.28w) x min(260,.24h). Seats at equal arc length on the ellipse (wide windows spread along the long sides).
- Middle = largest centred box clear of all cards; .table-centre is a size container (cqh fonts, safe-center flex, scrolls inside).
- Window scroll locked in People view (owner's clipped ST column/strip was a scrolled viewport); strip height clamp(4.9rem,16vh,13.2rem).
- logs/tmp/shot.mjs pattern: also measure card/name/centre rects vs #stage rect, report overlaps.

## Rooms break-out (PR #95, issue #80, owner: "When rooms break out, the view should break out"; not yet reviewed)
- Any room occupied: Square ring (its seats only, seat order) on the left; right column (26-48% of table, best min(square cw, room cw))
  holds one .room-group per room in use, stacked or side by side (short windows); empty rooms not drawn. Room cards inline --card-w.
- Room's newest line (since dawn / rooms closing) shows in its panel (.room-line, arrow at speaker, .now when it is the stage line);
  card captions hidden for away cards while broken out. Cards slide via left/top transition. #stage[data-rooms=out].
- Recorded game: ?fixture=rooms (day 2: evil pair in the Snug, one seat alone in the Vestry); uifixture frames carry places + room talk.

## The page follows the voices (issue #103, 2026-11-09; not yet reviewed by the owner)
- app.js keeps a ring of 64 live frames {seq, max event id}; pickShown(ring, {boundary: queue[0].id, now, shown}) picks the newest
  frame below the first waiting line (cut at the boundary when the playing line came in the same push); never steps back.
- Panels but agents, and the bar's phase/winner/rooms line, draw the shown frame; voice.feed always gets the live frame (fed first in
  render). Live when Voice off, muted, blocked, recorded, or nothing waits. voice.state.behind -> note "; the page keeps pace".
- Relay hold (backend.js) only delays soft/heartbeat wakes, per seat, 30 s cap; 'now' wakes (votes, nights) are never held.
