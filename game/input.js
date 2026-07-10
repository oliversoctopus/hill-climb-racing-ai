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
  const left  = S.humanKeys.left  || S.humanKeysWASD.left;
  const right = S.humanKeys.right || S.humanKeysWASD.right;
  if (right && !left) return 0;
  if (left && !right) return 1;
  return 2;
}

// Put keyboard focus on the canvas so driving keys never land on the mode <select>
// (whose native arrow-key behavior would switch modes) or another control.
// preventScroll stops the page from jumping.
export function focusGame() {
  const s = document.getElementById("stage");
  if (s) { try { s.focus({ preventScroll: true }); } catch (e) { s.focus(); } }
}

function _isFormField(t) { return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"); }

// Arrows = right screen / lone human; WASD = left screen (Human-vs-Human). A/S =
// reverse, D/W = forward (mirrors ←/→). We ignore keys while a form field is focused
// (e.g. the tick-budget input) so typing works, and preventDefault on the game keys.
export function _handleGameKey(e, down) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const isDriveKey = (k === "ArrowLeft" || k === "ArrowRight" ||
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

// Alt+1..5 jump straight to a mode (in the <select>'s option order: 1 AI only,
// 2 Human only, 3 Human vs AI, 4 Human vs Human, 5 Best of X). We require Alt so a
// BARE digit never switches modes — that keeps typing numbers into a field safe AND
// stops a stray keystroke (typing with no field focused) from walking through modes;
// Alt+digit also inserts no text, so it's safe to fire regardless of what's focused.
// We just drive the dropdown (set + dispatch change) so ALL the existing mode-switch
// logic runs once, instead of duplicating it. Returns true if it consumed the event.
// Uses e.code (Digit1/Numpad1…) so it's layout-independent — some layouts map Alt+1
// to a symbol in e.key. Returns true (swallowing the event) for any Alt+[1-5].
export function _handleModeKey(e) {
  if (!e.altKey) return false;
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
  if (!m) return false;
  e.preventDefault();
  if (e.repeat) return true;   // holding Alt+1 must not rebuild the sim every repeat
  const idx = parseInt(m[1], 10) - 1;
  const sel = document.getElementById("mode");
  if (sel && idx < sel.options.length && sel.selectedIndex !== idx) {
    sel.selectedIndex = idx;
    sel.dispatchEvent(new Event("change"));   // runs mode.onchange (rebuild, resize, refocus)
  }
  return true;
}

// Single-key action shortcuts (fire once on keydown, never while typing in a field).
// Each just clicks its button/checkbox, so it inherits that control's behavior AND its
// disabled state (e.g. Restart is a no-op during a backtrack search).
export function _handleActionKey(e) {
  if (e.repeat) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "escape") { document.getElementById("keybinds_panel").style.display = "none"; return; }
  if (_isFormField(e.target)) return;   // don't fire shortcuts while typing in a field
  const map = { i: "bp_invince", z: "bp_zerog", f: "bp_float", h: "bp_altimeter",
              v: "bp_speed", g: "bp_flight", j: "bp_rocket", r: "reset_pos",
              t: "reset", p: "pause" };
  const id = map[k];
  if (!id) return;
  const el = document.getElementById(id);
  if (el) { el.click(); e.preventDefault(); }
}
