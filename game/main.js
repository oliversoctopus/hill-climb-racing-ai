// Entry point: loads assets + the AI agent, runs the wall-clock loop, and wires
// every DOM control. This is the only module that touches the page's buttons/inputs
// and the requestAnimationFrame loop; the concern modules it imports do the work.
import {
  S, CANVAS_HEIGHT, SIM_DT, SCALE,
  FLIGHT_SPEED_MIN, FLIGHT_SPEED_MAX, FLIGHT_SPEED_STEP, FLIGHT_SPEED_STEP_HI, FLIGHT_SPEED_STEP_BREAK,
  ROCKET_ACCEL_MIN, ROCKET_ACCEL_MAX, ROCKET_ACCEL_STEP,
} from "./state.js";
import { AiPolicy, setGrassSprites, getSpawningY } from "./bridge.js";
import { modeLabel, stageWidth } from "./modes.js";
import { buildSimulation, buildWithGround, currentGroundSource, runOneStep,
         refreshSessionTerrainsMenu, updateCurrentTerrainBox } from "./sim.js";
import { loadSavedTerrains, addSavedTerrain, removeSavedTerrain, renameSavedTerrain,
         findSavedByName, findSavedByGeometry } from "./saved_terrains.js";
import { render, updateStats } from "./render.js";
import { runBestOfX, watchSelectedRun, _bestofxPanelVisible, runBacktrack } from "./search.js";
import {
  bpSetStatus, bpSetZeroG, bpFloatCar, bpUnderworld, bpTeleport, bpTeleportCurrent,
  bpFlag, bpDownload, bpApplyPhys, _bpNum,
} from "./cheats.js";
import { focusGame, _handleGameKey, _handleActionKey, _handleModeKey } from "./input.js";

export function setStatus(s) { document.getElementById("status").textContent = s; }

// ---- Assets --------------------------------------------------------------
// Mirrors sketch.js preload() — the same files the original browser game used.
function _loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { resolve(img); };
    img.onerror = () => { reject(new Error(`failed to load ${src}`)); };
    img.src = src;
  });
}
async function loadAssets() {
  const paths = {
    sky:    "Pics/sky.png",
    car:    "Pics/car.png",
    wheel:  "Pics/wheel2.png",
    head:   "Pics/headLarge.png",   // person head (human cars)
    cbhead: "Pics/CBHead3.png",     // Code Bullet's computer-ish head (AI cars)
    g0:    "Pics/grass.png",
    g1:    "Pics/grass2.png",
    g2:    "Pics/grass3.png",
    g3:    "Pics/grass4.png",
    g4:    "Pics/grass5.png",
  };
  const keys = Object.keys(paths);
  const imgs = await Promise.all(keys.map(k => _loadImg(paths[k])));
  for (let i = 0; i < keys.length; i++) S.assets[keys[i]] = imgs[i];
  S.assets.grass = [S.assets.g0, S.assets.g1, S.assets.g2, S.assets.g3, S.assets.g4];
  // Replace the stub grassSprites polyfill with the real loaded array so
  // Ground.randomizeGround()'s grassPositions stay valid for rendering.
  setGrassSprites(S.assets.grass);
}

function _setupHiDPI() {
  // On HiDPI displays devicePixelRatio > 1. Bump the backing store and scale the
  // context so 1 canvas-unit = 1 CSS-pixel (crisp, not upscaled). Width tracks the
  // mode (hvh = 2× for split screen); re-run this whenever the mode changes.
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = stageWidth();
  canvas.width  = w * dpr;
  canvas.height = CANVAS_HEIGHT * dpr;
  // Cap the DISPLAY size at the logical (CSS-px) resolution; CSS max-width:100% +
  // height:auto shrink it to fit narrower viewports without distortion; margin:auto
  // centers it. Set only the width so height:auto keeps aspect.
  canvas.style.width  = `${w}px`;
  canvas.style.removeProperty("height");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
// Exported so the backtrack search can shrink the 2×-wide split canvas back to 1×.
export { _setupHiDPI };

// ---- Wall-clock loop -----------------------------------------------------
// Physics dt is fixed at 1/30 simulated seconds per step (Box2D wants a fixed
// timestep). We accumulate real wall time and run however many steps that
// corresponds to. simSpeed multiplies the accumulator so "2x" = 2 simulated seconds
// per real second.
async function loop() {
  const now = performance.now();
  if (S.lastWallMs === 0) S.lastWallMs = now;
  // Real wall seconds since last frame. Cap at 100ms so a tab-background pause doesn't
  // cause a burst of catch-up steps when we resume.
  const realDt = Math.min(0.1, (now - S.lastWallMs) / 1000);
  S.lastWallMs = now;

  let didStep = false;
  if (!S.paused && S.aiAgent && !S.bestofxBusy) {
    S.accumSec += realDt * S.simSpeed;
    while (S.accumSec >= SIM_DT) {
      const allDead = await runOneStep();
      S.accumSec -= SIM_DT;
      didStep = true;
      if (allDead) { S.accumSec = 0; break; }
    }
  }

  // Render only when something changed (a step happened) or we're paused (so the user
  // sees the final/static frame after death). Without this, the smooth-camera lerp
  // keeps running at RAF rate (60Hz) while physics steps at 30Hz — the car appears to
  // slide backward between steps.
  if (didStep || S.paused) {
    render();
    updateStats();
  }
  requestAnimationFrame(loop);
}

async function init() {
  _setupHiDPI();
  setStatus("Loading sprites...");
  try {
    await loadAssets();
  } catch (e) {
    setStatus(`ERROR loading assets: ${e.message}`);
    throw e;
  }

  // Pick the AI agent here. Swap to a different class (or args) to deploy a different
  // model — no other file changes. See ai_policy.js for the Agent contract.
  setStatus("Loading AI agent...");
  S.aiAgent = new AiPolicy.PpoOnnxAgent("ai_policy.onnx");
  try {
    await S.aiAgent.init();
  } catch (e) {
    setStatus(`ERROR loading agent: ${e.message}`);
    throw e;
  }

  setStatus("Building simulation...");
  buildSimulation();
  setStatus(`Ready — ${modeLabel()}`);
  requestAnimationFrame(loop);
}

// ---- DOM wiring ----------------------------------------------------------
// Top controls
document.getElementById("reset_pos").onclick = () => {
  // "Restart (same terrain)" — put the car(s) back at the start of THIS map. No new
  // terrain: rebuild from a clone of the current ground. Exits ghost mode.
  S.replayActions = null;
  S.ghostPoses = null; S.ghostDone = false;
  setStatus("Restarting on the same terrain...");
  buildWithGround(currentGroundSource(), getSpawningY(), 0, 0);
  setStatus(`Ready — ${modeLabel()}`);
};
document.getElementById("reset").onclick = () => {
  // "Regenerate terrain" — throw away this map and generate a brand-new random one.
  if (S.mode === "bestofx") {
    S.bestofxRuns = [];
    document.getElementById("bestofx_results").style.display = "none";
    document.getElementById("bestofx_status").textContent = "";
  }
  // Clear any pinned track so a prior backtrack solve / loaded track isn't replayed
  // instead (the pin survives a Mode switch, but Regenerate always makes new).
  S.loadedTrack = null;
  setStatus("Building new terrain...");
  buildSimulation();
  setStatus(`Ready — ${modeLabel()}`);
};
// ---- Terrains + Saved Terrains menus ----
// Load a terrain object ({vertices px, spawning_y, name}) from either menu. Pinning it
// via loadedTrack means Restart re-drives it and a Mode switch keeps it (Regenerate
// clears it). Same path the old Terrains dropdown used.
function loadTerrainObject(t) {
  if (S.mode === "bestofx") {   // clear stale Best-of-X runs like Regenerate does
    S.bestofxRuns = [];
    document.getElementById("bestofx_results").style.display = "none";
    document.getElementById("bestofx_status").textContent = "";
  }
  S.loadedTrack = { vertices: t.vertices, spawning_y: t.spawning_y, name: t.name };
  S.currentTerrainName = t.name;
  setStatus(`Loaded ${t.name} — ${modeLabel()}`);
  buildSimulation();
  updateCurrentTerrainBox();
  closeTerrainMenus();
  focusGame();
}
function closeTerrainMenus() {
  document.getElementById("terrains_panel").style.display = "none";
  document.getElementById("saved_panel").style.display = "none";
}
// Render the Saved Terrains list from localStorage: one row per map with Load + Delete.
function renderSavedTerrainsMenu() {
  const list = document.getElementById("saved_list");
  const saved = loadSavedTerrains();
  list.innerHTML = "";
  if (!saved.length) {
    list.innerHTML = '<div class="menu-empty">No saved terrains yet. Find a map you like, then “Save Current Terrain”.</div>';
    return;
  }
  for (let i = 0; i < saved.length; i++) {
    const row = document.createElement("div");
    row.className = "terrain-row";
    const nm = document.createElement("span");
    nm.className = "terrain-name";
    nm.textContent = saved[i].name;
    const load = document.createElement("button");
    load.textContent = "Load";
    load.dataset.savedLoad = String(i);
    const ren = document.createElement("button");
    ren.textContent = "Rename";
    ren.dataset.savedRename = String(i);
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.dataset.savedDel = String(i);
    row.appendChild(nm);
    row.appendChild(load);
    row.appendChild(ren);
    row.appendChild(del);
    list.appendChild(row);
  }
}
// Open buttons refresh their list first so it's always current.
document.getElementById("terrains_btn").onclick = () => {
  refreshSessionTerrainsMenu();
  document.getElementById("terrains_panel").style.display = "block";
};
document.getElementById("saved_btn").onclick = () => {
  renderSavedTerrainsMenu();
  document.getElementById("saved_panel").style.display = "block";
};
document.getElementById("terrains_close").onclick = () => { document.getElementById("terrains_panel").style.display = "none"; focusGame(); };
document.getElementById("saved_close").onclick    = () => { document.getElementById("saved_panel").style.display = "none"; focusGame(); };
// Delegated clicks on the session list: load by terrain id.
document.getElementById("terrains_list").onclick = (e) => {
  const el = e.target;
  if (!el || !el.dataset || el.dataset.sessionLoad === undefined) return;
  const id = parseInt(el.dataset.sessionLoad, 10);
  for (let i = 0; i < S.sessionTerrains.length; i++) {
    if (S.sessionTerrains[i].id === id) { loadTerrainObject(S.sessionTerrains[i]); return; }
  }
};
// Delegated clicks on the saved list: Load, or Delete-with-confirm (re-read from storage
// so the index is always against the current list).
document.getElementById("saved_list").onclick = (e) => {
  const el = e.target;
  if (!el || !el.dataset) return;
  if (el.dataset.savedLoad !== undefined) {
    const saved = loadSavedTerrains();
    const i = parseInt(el.dataset.savedLoad, 10);
    if (i >= 0 && i < saved.length) loadTerrainObject(saved[i]);
  } else if (el.dataset.savedRename !== undefined) {
    const saved = loadSavedTerrains();
    const i = parseInt(el.dataset.savedRename, 10);
    if (i < 0 || i >= saved.length) return;
    const oldName = saved[i].name;
    const newName = (window.prompt(`Rename “${oldName}” to:`, oldName) || "").trim();
    if (!newName || newName === oldName) return;   // cancelled, blank, or unchanged
    if (findSavedByName(newName, i) !== -1) {
      window.alert(`You already have a saved terrain named “${newName}”. Please choose a different name.`);
      return;
    }
    renameSavedTerrain(i, newName);
    // If the renamed map is the one we're currently driving, rename the current box too.
    if (S.currentTerrainName === oldName) { S.currentTerrainName = newName; updateCurrentTerrainBox(); }
    renderSavedTerrainsMenu();
    setStatus(`Renamed “${oldName}” to “${newName}”.`);
  } else if (el.dataset.savedDel !== undefined) {
    const saved = loadSavedTerrains();
    const i = parseInt(el.dataset.savedDel, 10);
    if (i >= 0 && i < saved.length && window.confirm(`Delete saved terrain “${saved[i].name}”?`)) {
      removeSavedTerrain(i);
      renderSavedTerrainsMenu();
    }
  }
};
// Save the CURRENT terrain to localStorage under a user-supplied name.
document.getElementById("save_current_btn").onclick = () => {
  if (!S.ground || !S.ground.vectors) { setStatus("No terrain to save yet."); return; }
  const terrain = {
    name: "",
    vertices: S.ground.vectors.map(v => [v.x * SCALE, v.y * SCALE]),   // px, loadedTrack format
    spawning_y: getSpawningY(),
  };
  // Block saving the same map twice — name which existing saved terrain it duplicates.
  const dupGeo = findSavedByGeometry(terrain);
  if (dupGeo !== -1) {
    const existing = loadSavedTerrains()[dupGeo];
    setStatus(`Already saved as “${existing.name}”.`);
    window.alert(`This terrain is identical to your saved terrain “${existing.name}”, so it wasn't saved again.`);
    return;
  }
  const name = (window.prompt("Name this terrain:", S.currentTerrainName || "") || "").trim();
  if (!name) return;   // cancelled or blank
  // Names must be unique (case-insensitive).
  if (findSavedByName(name) !== -1) {
    setStatus(`A saved terrain named “${name}” already exists.`);
    window.alert(`You already have a saved terrain named “${name}”. Please choose a different name.`);
    return;
  }
  terrain.name = name;
  if (!addSavedTerrain(terrain)) { setStatus("Couldn't save — browser storage is full or disabled."); return; }
  S.currentTerrainName = name;
  updateCurrentTerrainBox();
  renderSavedTerrainsMenu();
  setStatus(`Saved terrain “${name}”.`);
};
document.getElementById("pause").onclick = function() {
  S.paused = !S.paused;
  if (!S.paused) S.lastWallMs = 0;   // avoid huge dt burst on resume
  this.textContent = S.paused ? "Resume" : "Pause";
};
document.getElementById("speed").onchange = function() {
  S.simSpeed = parseFloat(this.value);   // fractional (0.25x/0.5x) as well as integer speeds
};
document.getElementById("mode").onchange = function() {
  S.mode = this.value;
  _bestofxPanelVisible(S.mode === "bestofx");
  _setupHiDPI();   // resize the canvas (hvh = 2× wide split screen; others = 1×)
  setStatus(`Building ${S.mode} mode...`);
  buildSimulation();
  setStatus(`Ready — ${modeLabel()}`);
  // Move keyboard focus OFF the dropdown so driving keys go to the game instead of
  // scrolling the <select>.
  this.blur();
  focusGame();
};

// Best of X
document.getElementById("bestofx_run").onclick   = () => { runBestOfX(); };
document.getElementById("bestofx_abort").onclick = () => { S.bestofxAbort = true; };
document.getElementById("bestofx_watch").onclick = () => { watchSelectedRun(); };

// Backtrack search
document.getElementById("backtrack_run").onclick = () => { runBacktrack(); };
document.getElementById("backtrack_abort").onclick = () => { S.backtrackAbort = true; };

// Cheats / bug probe
document.getElementById("bp_invince").onchange = function() {
  S.bpInvincible = this.checked;
  bpSetStatus(S.bpInvincible ? "Invincible ON — head-hit / fall-off / AI no-progress timeout won't kill any car."
                             : "Invincible OFF.");
};
document.getElementById("bp_zerog").onchange   = function() { bpSetZeroG(this.checked); };
document.getElementById("bp_altimeter").onchange = function() {
  S.bpAltimeter = this.checked;
  bpSetStatus(S.bpAltimeter ? "Altimeter ON — altitude above the fall-off line (a fixed level) shown on screen."
                            : "Altimeter OFF.");
};
document.getElementById("bp_speed").onchange = function() {
  S.bpSpeed = this.checked;
  bpSetStatus(S.bpSpeed ? "Speed meter ON — chassis velocity (m/s) shown on screen."
                        : "Speed meter OFF.");
};
document.getElementById("bp_distance").onchange = function() {
  S.bpDistance = this.checked;
  bpSetStatus(S.bpDistance ? "Distance ON — your CURRENT-position score shown under the score (drops if you roll back)."
                           : "Distance OFF.");
};
document.getElementById("bp_flight").onchange = function() {
  S.bpFlight = this.checked;
  if (S.bpFlight && S.bpRocket) {   // mutually exclusive — they share the same keys
    S.bpRocket = false; document.getElementById("bp_rocket").checked = false;
  }
  bpSetStatus(S.bpFlight
    ? `Flight mode ON — WASD/arrows fly at a constant speed (↑/W forward, ↓/S backward, ←/A & →/D rotate); release forward/back to stop dead in the air. Speed ${S.flightSpeed} m/s; scroll wheel to adjust (0–300). Tip: Invincible survives crashes.`
    : "Flight mode OFF.");
};
document.getElementById("bp_rocket").onchange = function() {
  S.bpRocket = this.checked;
  if (S.bpRocket && S.bpFlight) {   // mutually exclusive
    S.bpFlight = false; document.getElementById("bp_flight").checked = false;
  }
  bpSetStatus(S.bpRocket
    ? `Rocket mode ON — WASD/arrows thrust the car like a rocket (↑/W & ↓/S thrust, ←/A & →/D rotate). Thrust ${S.rocketAccel} m/s²; scroll wheel to adjust. Tip: turn on Invincible to survive crashes.`
    : "Rocket mode OFF.");
};
// Scroll wheel over the canvas adjusts whichever fly cheat is active: Flight speed
// (0–300) or Rocket thrust. passive:false so we can preventDefault the page scroll.
document.getElementById("stage").addEventListener("wheel", e => {
  if (S.bpFlight) {
    e.preventDefault();
    const up = e.deltaY < 0;
    // Increments of FLIGHT_SPEED_STEP up to the break, FLIGHT_SPEED_STEP_HI past it.
    // Going up uses the band you're entering; going down the band you're leaving, so the
    // grid stays clean (…95, 100, 110, 120…) around the break.
    const step = up ? (S.flightSpeed >= FLIGHT_SPEED_STEP_BREAK ? FLIGHT_SPEED_STEP_HI : FLIGHT_SPEED_STEP)
                    : (S.flightSpeed >  FLIGHT_SPEED_STEP_BREAK ? FLIGHT_SPEED_STEP_HI : FLIGHT_SPEED_STEP);
    S.flightSpeed = Math.max(FLIGHT_SPEED_MIN, Math.min(FLIGHT_SPEED_MAX, S.flightSpeed + (up ? step : -step)));
    bpSetStatus(`Flight speed ${S.flightSpeed} m/s  (scroll up = faster, down = slower; ${FLIGHT_SPEED_MIN}–${FLIGHT_SPEED_MAX})`);
  } else if (S.bpRocket) {
    e.preventDefault();
    const d2 = (e.deltaY < 0 ? 1 : -1) * ROCKET_ACCEL_STEP;
    S.rocketAccel = Math.max(ROCKET_ACCEL_MIN, Math.min(ROCKET_ACCEL_MAX, S.rocketAccel + d2));
    bpSetStatus(`Rocket thrust ${S.rocketAccel} m/s²  (scroll up = faster, down = slower; ${ROCKET_ACCEL_MIN}–${ROCKET_ACCEL_MAX})`);
  }
}, { passive: false });
document.getElementById("bp_float").onclick    = bpFloatCar;
document.getElementById("bp_underworld").onclick = bpUnderworld;
// Teleport: open the panel, prefilling X/Y from the current car so it's a sane start.
document.getElementById("bp_teleport").onclick = () => {
  const cur = bpTeleportCurrent();
  if (cur) {
    document.getElementById("teleport_x").value = String(cur.score);
    document.getElementById("teleport_y").value = cur.altitude.toFixed(1);
  }
  document.getElementById("teleport_panel").style.display = "block";
};
document.getElementById("teleport_go").onclick = () => {
  const x = parseFloat(document.getElementById("teleport_x").value);
  const y = parseFloat(document.getElementById("teleport_y").value);
  if (isNaN(x) || isNaN(y)) { bpSetStatus("Teleport: enter a numeric score (X) and altitude (Y)."); return; }
  bpTeleport(x, y);
  document.getElementById("teleport_panel").style.display = "none";
  focusGame();
};
document.getElementById("teleport_close").onclick = () => {
  document.getElementById("teleport_panel").style.display = "none";
  focusGame();
};
document.getElementById("bp_flag").onclick     = bpFlag;
document.getElementById("bp_download").onclick = bpDownload;
document.getElementById("bp_applyphys").onclick = () => { bpApplyPhys(true); };
["bp_chassisdamp", "bp_wheeldamp", "bp_suspfreq", "bp_suspdamp"].forEach(id => {
  document.getElementById(id).onchange = () => { bpApplyPhys(true); };
});
document.getElementById("bp_unmask").onclick = () => {
  // Drive the suspension instability hard so the latent spin becomes obvious: no
  // chassis/wheel angular damping + a very stiff, under-damped suspension spring. It's
  // resonance-driven, so DRIVE around / over bumps to provoke it.
  document.getElementById("bp_chassisdamp").value = "0";
  document.getElementById("bp_wheeldamp").value   = "0";
  document.getElementById("bp_suspfreq").value    = "200";
  document.getElementById("bp_suspdamp").value    = "0.3";
  bpApplyPhys(true);
};
document.getElementById("bp_resetphys").onclick = () => {
  document.getElementById("bp_chassisdamp").value = "0.1";
  document.getElementById("bp_wheeldamp").value   = "1.8";
  document.getElementById("bp_suspfreq").value    = "70";
  document.getElementById("bp_suspdamp").value    = "25";
  document.getElementById("bp_wheelfric").value   = "1.5";
  document.getElementById("bp_motorspeed").value  = "1";
  document.getElementById("bp_motortorque").value = "1";
  bpApplyPhys(true);
};
document.getElementById("bp_wheelfric").onchange = () => { bpApplyPhys(true); };
document.getElementById("bp_motorspeed").onchange =
document.getElementById("bp_motortorque").onchange = () => {
  bpSetStatus(`motor speed ×${_bpNum("bp_motorspeed", 1)} torque ×${_bpNum("bp_motortorque", 1)} (applied live while driving)`);
};
document.getElementById("bp_motorspin").onclick = () => {
  // Double the motor's target speed — the lever that reproduces the sustained CCW spin.
  // Drive / floor it (into a hill, or after a flip) to provoke it.
  document.getElementById("bp_motorspeed").value  = "2";
  document.getElementById("bp_motortorque").value = "1";
  bpSetStatus("Motor-spin: motor speed ×2 — drive & floor it to provoke the sustained CCW spin.");
};

// Keybinds cheat-sheet overlay.
document.getElementById("keybinds_btn").onclick = () => {
  const pnl = document.getElementById("keybinds_panel");
  pnl.style.display = (pnl.style.display === "none") ? "block" : "none";
};
document.getElementById("keybinds_close").onclick = () => {
  document.getElementById("keybinds_panel").style.display = "none";
  focusGame();
};

// Keyboard + focus
window.addEventListener("keydown", e => { if (_handleModeKey(e)) return; _handleGameKey(e, true); _handleActionKey(e); });
window.addEventListener("keyup",   e => { _handleGameKey(e, false); });
document.getElementById("stage").addEventListener("mousedown", focusGame);

// Interacting with a button/checkbox/dropdown leaves keyboard focus ON that control:
// a focused button keeps a black ring, and a focused checkbox or <select> swallows
// every driving key (_handleGameKey ignores keys while a form field is focused — and a
// focused <select> would change its own value on arrow keys), so you can't drive. Two
// delegated listeners hand focus straight back to the game so every current AND future
// control is covered (superseding the per-handler blur() the mode/terrain menus already
// do). Number/text inputs are deliberately left alone so you can still type in them.
//  - buttons on `click` (a button has no `change` event)
//  - checkboxes and <select>s on `change`, NOT click: blurring a <select> mid-click
//    would slam the dropdown shut before you could pick an option.
document.addEventListener("click", e => {
  const t = e.target;
  if (t && t.tagName === "BUTTON") { t.blur(); focusGame(); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t && (t.tagName === "SELECT" || (t.tagName === "INPUT" && t.type === "checkbox"))) {
    t.blur();
    focusGame();
  }
});

window.addEventListener("load", () => { init(); focusGame(); });
