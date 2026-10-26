// Which runs count as attempts on a map, and which maps are notable enough to keep for
// good (the rest expire KEEP_DAYS after their last attempt). Pure (no imports), so the
// same rules can be evaluated against a copy of the stored data.

export const ATTEMPT_SEC = 3;        // a shorter run is an abandon, not an attempt
export const ATTEMPT_SCORE = 100;    // a clean run scoring less is an abandon too
export const NEAR_FINISH = 1700;     // an "almost finished" clean run
export const KEEP_DAYS = 7;
export const CHEAT_ATTEMPTS = 3;     // cheated attempts that make a map notable

// An unfinished map: enough attempts at a high enough best.
export function ladder(n, max) {
  return (n >= 3 && max >= 1500) || (n >= 4 && max >= 1000) || (n >= 6 && max >= 700) || n >= 10;
}
// A finished map: a fastest-quarter time, or repeated near-finishes.
export function finishNotable(n1700) { return n1700 >= 3; }
// The slowest time still in the fastest quarter of `times` (null if empty).
export function fastCutoff(times) {
  if (!times.length) return null;
  const s = times.slice().sort((a, b) => a - b);
  return s[Math.ceil(s.length * 0.25) - 1];
}
