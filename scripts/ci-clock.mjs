// The CI fast clock: the one place that reads CI_FAST. With CI_FAST=1 the checks scale the real-time
// waits they depend on (grace periods, settle sleeps, mock table windows) down tenfold; without it every
// value is returned unchanged. Only the check scripts import this: the game, the relay and the runners never do,
// so play always runs at real timing. A scheduled/manual CI run leaves CI_FAST unset to exercise real timing.
export const FAST = process.env.CI_FAST === '1';
export const FAST_DIV = 10;
// ms(15000) -> 15000, or 1500 under CI_FAST (never below `min`, default 1)
export const ms = (n, min = 1) => FAST ? Math.max(min, Math.round(n / FAST_DIV)) : n;
