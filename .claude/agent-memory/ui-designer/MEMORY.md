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
