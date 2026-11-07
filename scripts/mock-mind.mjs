// A mock mind for the checks: what a stand-in player or Storyteller does next in one turn, from the tool results it has seen
// this turn. Shared by the fake Agent SDK (scripts/fake-agent-sdk.mjs) and the mock Ollama's mock-play model
// (scripts/mock-ollama.mjs), so a mock game plays the same whichever mind sits in a seat. No model, no randomness.
//
// A player looks, asks what is asked of it, then: answers a night choice (the first option that is not itself, or "nobody"
// when that is offered), votes yes, nominates when it is the last living seat in seat order and nobody has been nominated
// today (the first other living seat), else passes on nominating; with nothing asked, says one line in its speaking round.
// The Storyteller asks what waits on it and answers it with the first legal option(s) and a reason.
// nextCall(kind, seen) -> {tool, args} | {text}; seen: [{tool, args, result}] this turn, oldest first.
let lines = 0, idle = 0;
// idle words that differ turn to turn, so a quiet seat's narration is never a repeat (an empty turn to the local loop)
const IDLE = ['listens to the table.', 'keeps quiet for now.', 'watches the others closely.', 'thinks over what was said.', 'waits for a better moment.', 'studies the faces around the room.'];
const last = (seen, tool) => [...seen].reverse().find(s => s.tool === tool);
const ACTS = new Set(['speak', 'whisper', 'nominate', 'vote', 'night_choice', 'pass', 'decide', 'fallback', 'narrate', 'end_day', 'close_vote', 'open_nominations']);
export const MOCK_REASON = 'The first legal option keeps this mock game moving along.';

export function nextCall(kind, seen = []) {
  if (seen.some(s => ACTS.has(s.tool))) return {text: kind === 'storyteller' ? 'The Storyteller made the call and waits.' : 'The player acted and waits for the table.'};
  if (kind === 'storyteller') {
    const w = last(seen, 'what_is_asked');
    if (!w) return {tool: 'what_is_asked', args: {}};
    const p = w.result && w.result.pending;
    if (!p) return {text: 'Nothing waits on the Storyteller now.'};
    const many = /exactly (\d+)/.exec(p.pick || '');
    return {tool: 'decide', args: many ? {value: Array.from({length: Number(many[1])}, (_, k) => '#' + (k + 1)).join(', '), reason: MOCK_REASON} : {option: 1, reason: MOCK_REASON}};
  }
  const look = last(seen, 'look'), w = last(seen, 'what_is_asked');
  if (!look) return {tool: 'look', args: {}};
  if (!w) return {tool: 'what_is_asked', args: {}};
  const L = look.result || {}, a = w.result || {}, me = L.you && L.you.name, alive = L.alive || [];
  if (a.asked === 'choose') {
    const opts = a.options || [], n = a.count || 1;
    if (opts.includes('nobody')) return {tool: 'night_choice', args: {pick: ['nobody']}};
    const others = opts.filter(o => o !== me), pick = (others.length >= n ? others : opts).slice(0, n);
    return {tool: 'night_choice', args: {pick}};
  }
  if (a.asked === 'vote' && a.tool === 'vote') return {tool: 'vote', args: {yes: 'yes'}};
  if (a.asked === 'nomination') {
    const none = !((L.today && L.today.nominations) || []).length, target = (a.options || []).find(o => o !== me);
    if (none && me === alive[alive.length - 1] && target) return {tool: 'nominate', args: {target}};
    return {tool: 'pass', args: {}};
  }
  if (L.phase === 'day' && /still yours/.test(String(L.clock || ''))) return {tool: 'speak', args: {text: `${me} says line ${++lines} of this mock game.`}};
  return {text: `${me || 'The player'} ${IDLE[idle++ % IDLE.length]}`};
}
