// Human input: the two keyboard control sets (arrows + WASD), the driving-action
// mapping, and the game-focus helper. The key EVENT LISTENERS are attached in
// main.js (which wires all DOM), but the handlers live here with the input state.
import { S } from "./state.js";

// 0=forward, 1=reverse, 2=off — matches the AI action space (right = forward).
export function humanAction() {
  if (S.humanKeys.right && !S.humanKeys.left) return 0;
  if (S.humanKeys.left && !S.humanKeys.right) return 1;
  return 2;
}
export function humanActionWASD() {
  if (S.humanKeysWASD.right && !S.humanKeysWASD.left) return 0;
  if (S.humanKeysWASD.left && !S.humanKeysWASD.right) return 1;
  return 2;
}
// Lone human (Human-only / Human-vs-AI): drive with EITHER arrows or WASD.
export function humanActionAny() {
  var left  = S.humanKeys.left  || S.humanKeysWASD.left;
  var right = S.humanKeys.right || S.humanKeysWASD.right;
  if (right && !left) return 0;
  if (left && !right) return 1;
  return 2;
}

// Put keyboard focus on the canvas so driving keys never land on the mode <select>
// (whose native arrow-key behavior would switch modes) or another control.
// preventScroll stops the page from jumping.
export function focusGame() {
  var s = document.getElementById("stage");
  if (s) { try { s.focus({ preventScroll: true }); } catch (e) { s.focus(); } }
}

function _isFormField(t) { return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"); }

// Arrows = right screen / lone human; WASD = left screen (Human-vs-Human). A/S =
// reverse, D/W = forward (mirrors ←/→). We ignore keys while a form field is focused
// (e.g. the tick-budget input) so typing works, and preventDefault on the game keys.
export function _handleGameKey(e, down) {
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  var isDriveKey = (k === "ArrowLeft" || k === "ArrowRight" ||
                    k === "a" || k === "s" || k === "d" || k === "w");
  // The mode <select> must never consume a driving key — its native arrow behavior
  // switches modes. If one arrives while it's focused, drop focus to the game and let
  // the key drive; the preventDefault below also stops the select from changing.
  if (_isFormField(e.target)) {
    if (!(e.target.id === "mode" && isDriveKey)) return;
    if (down) focusGame();
  }
  // Each key feeds BOTH its driving state (humanKeys/humanKeysWASD) and its fly state.
  // WASD → flyKeysWASD, arrows → flyKeysArrows, so Human-vs-Human flies each player
  // independently. Shared by both the Flight and Rocket cheats.
  switch (k) {
    case "ArrowLeft":  S.humanKeys.left      = down; S.flyKeysArrows.rotL = down; e.preventDefault(); break;
    case "ArrowRight": S.humanKeys.right     = down; S.flyKeysArrows.rotR = down; e.preventDefault(); break;
    case "ArrowUp":                                  S.flyKeysArrows.fwd  = down; e.preventDefault(); break;
    case "ArrowDown":                                S.flyKeysArrows.back = down; e.preventDefault(); break;
    case "a": S.humanKeysWASD.left  = down; S.flyKeysWASD.rotL = down; e.preventDefault(); break;
    case "s": S.humanKeysWASD.left  = down; S.flyKeysWASD.back = down; e.preventDefault(); break;
    case "d": S.humanKeysWASD.right = down; S.flyKeysWASD.rotR = down; e.preventDefault(); break;
    case "w": S.humanKeysWASD.right = down; S.flyKeysWASD.fwd  = down; e.preventDefault(); break;
  }
}

// Single-key action shortcuts (fire once on keydown, never while typing in a field).
// Each just clicks its button/checkbox, so it inherits that control's behavior AND its
// disabled state (e.g. Restart is a no-op during a backtrack search).
export function _handleActionKey(e) {
  if (e.repeat) return;
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "escape") { document.getElementById("keybinds_panel").style.display = "none"; return; }
  if (_isFormField(e.target)) return;   // don't fire shortcuts while typing in a field
  var map = { i: "bp_invince", z: "bp_zerog", f: "bp_float", h: "bp_altimeter",
              v: "bp_speed", g: "bp_flight", j: "bp_rocket", r: "reset_pos",
              t: "reset", p: "pause" };
  var id = map[k];
  if (!id) return;
  var el = document.getElementById(id);
  if (el) { el.click(); e.preventDefault(); }
}
