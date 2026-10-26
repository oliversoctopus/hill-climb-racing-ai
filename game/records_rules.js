// Which runs count as attempts on a map. Pure (no imports), so the same definitions can be
// evaluated against a copy of the stored data.

export const ATTEMPT_SEC = 3;        // a shorter run is an abandon, not an attempt
export const ATTEMPT_SCORE = 100;    // a clean run scoring less is an abandon too
export const NEAR_FINISH = 1700;     // an "almost finished" clean run
