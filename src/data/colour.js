// Thistlewick's touches: one small thing about the town the Storyteller's header offers for a narration (#70). Pure data and a
// seeded pick, no imports. Our own words, using the town's names in docs/ROLES.md (the Square, the Tower, Lamp Row, the Wick and
// Candle) and the millpond. The Storyteller gets one as the makings of a line and says it in its own words; it is never pasted.
//   touchFor(seed, day, 'dawn' | 'dusk')  the touch for that dawn or that day's dusk: the same seed and day give the same touch,
//                                         and within one game no dawn touch repeats for DAWN_TOUCHES.length days (dusk likewise).

export const DAWN_TOUCHES = [
  'fog lay on Lamp Row until the lamps gave up and went out by themselves',
  'the heron stood on the millpond again and did not move for an hour',
  'there was frost on the Tower stair, and one set of footprints in it',
  'the baker\'s early smoke went straight up, as if nothing at all were wrong',
  'the tower clock showed a quarter past an hour nobody could name',
  'rain had washed the Square in the night, and nobody trusted it for that',
  'the rooks on the Tower rail counted themselves and came out one short',
  'the Wick and Candle opened its shutters late, and the landlord did not say why',
  'the millwheel turned backwards for a while before it thought better of it',
  'every lamp on Lamp Row was burning at sunrise, though nobody had lit one',
  'the milk cart came down the one street slower than usual, and stopped at the pump',
  'the dogs of the town were quiet, and so was the bell',
];

export const DUSK_TOUCHES = [
  'the tower struck once, late, and the Square emptied',
  'the lamps on Lamp Row came on one by one behind the crowd',
  'somebody shut the Wick and Candle\'s door, and the latch was loud',
  'the heron left the millpond as the light went',
  'a cold draught came down the Tower stair and put the candles out',
  'the rooks went quiet on the Tower rail',
  'the baker banked his oven for the night and did not look up',
  'the fog came back down Lamp Row before the last of them had gone home',
];

// A small seeded generator (mulberry32) for the pick only; the engine's own RNG is not touched.
function rng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The order a game walks a list in: a seeded shuffle, the same for the same seed and kind.
const orders = new Map();
export function touchOrder(seed, kind = 'dawn') {
  const key = `${kind}:${seed}`;
  if (orders.has(key)) return orders.get(key);
  const list = kind === 'dusk' ? DUSK_TOUCHES : DAWN_TOUCHES, next = rng((Number(seed) || 0) * 2 + (kind === 'dusk' ? 1 : 0));
  const idx = list.map((_, k) => k);
  for (let k = idx.length - 1; k > 0; k--) {const j = Math.floor(next() * (k + 1)); [idx[k], idx[j]] = [idx[j], idx[k]]}
  const out = idx.map(k => list[k]);
  orders.set(key, out);
  return out;
}

// The touch for the dawn of `day` (day 1 is the first) or the dusk of `day`.
export function touchFor(seed, day, kind = 'dawn') {
  const order = touchOrder(seed, kind), d = Math.max(1, Number(day) || 1);
  return order[(d - 1) % order.length];
}
