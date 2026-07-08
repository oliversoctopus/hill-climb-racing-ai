// Coordinate/sign helpers (CONVENTIONS.md #3).
//
// World space is y-DOWN: larger y = lower on screen. That makes clearance/altitude
// sign errors easy to introduce, so the two sign conventions live here, named, in
// one place instead of as bare subtractions scattered through render + sim.
import { CANVAS_HEIGHT } from "./state.js";

// Height of a point above the ground line directly below it, in whatever unit the
// inputs are (meters or px, as long as they match). Positive = the point is ABOVE
// the ground; y-down means groundY > pointY when airborne.
export function altitudeAbove(groundY, pointY) {
  return groundY - pointY;
}

// A car has fallen off the world once its chassis drops below the bottom of the
// screen (the death line the policy was trained against — chassis y*30 > 720).
// Argument is in PIXELS.
export function isBelowKillLine(yPx) {
  return yPx > CANVAS_HEIGHT;
}
