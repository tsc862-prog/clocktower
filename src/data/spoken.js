// What the table says aloud in the Storyteller's voice (issue #82): the relay (src/game/backend.js) and the page (src/ui/voice.js)
// both read this one list, so they agree. Pure data: no imports, no clock. 'vote-result' is the table's name for a vote's
// outcome ('vote' is the raw log's); 'phase' is night falling, a round beginning, nominations opening, the day ending; 'move' is who
// went to which room and who came back.
export const STORYTELLER_SPOKEN = ['narration', 'dawn', 'nomination', 'vote', 'vote-result', 'execution', 'no-execution', 'slayer-shot', 'virgin', 'win', 'phase', 'move'];

// What a seat says aloud in its own voice: its line of talk, and its thought before dawn (#111: 'thought', heard by the watcher alone,
// {type: 'thought', seat, night, day, text, audience: 'watcher'}).
export const SEAT_SPOKEN = ['say', 'thought'];
