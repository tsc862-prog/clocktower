// The seeded RNG (mulberry32). All game randomness comes from an instance of this; never the platform's random, never the clock.
export function createRng(seed) {
  let s = hashSeed(seed);
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = n => Math.floor(next() * n);
  return {
    next, int,
    chance: p => next() < p,
    pick: arr => arr[int(arr.length)],
    shuffle: arr => {const a = [...arr]; for (let i = a.length - 1; i > 0; i--) {const j = int(i + 1); [a[i], a[j]] = [a[j], a[i]]} return a},
    get state() {return s},
  };
}

// A number or a string to a 32-bit seed.
export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  let h = 2166136261 >>> 0;
  for (const c of String(seed ?? '')) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h;
}
