// Shared mutable game state + tuning constants for the browser app.
//
// Why one `S` object instead of module-level `let`s: nearly every concern
// (sim, render, cheats, search, input) both READS and WRITES this state, and ES
// module imports are read-only to the importer. Routing it all through one
// imported object lets any module mutate `S.world = ...` etc. without a setter
// per field. Everything here started life as a top-level `var` in the old
// index.html monolith. (Kept as `var` per CONVENTIONS.md #10 — no modernization
// churn in this structural split.)

// --- Physics/geometry constants (single-sourced in the index.html compat shim,
// which the physics classes read as globals; we re-export them so modules can
// import explicitly rather than reach for bare globals). ---
export var SCALE = window.SCALE;                 // px per meter (30)
export var SPAWN_X = window.SPAWN_X;             // canonical spawn x, px (350)
export var CANVAS_WIDTH = window.CANVAS_WIDTH;   // one screen, px (1280)
export var CANVAS_HEIGHT = window.CANVAS_HEIGHT; // px (720); also the fall-off kill line

// Physics step rate. Box2D wants a fixed timestep; the loop paces to it.
export var FRAME_RATE = 30;
export var SIM_DT = 1.0 / FRAME_RATE;

// AI no-progress timeout — matches python/env.py:244 (the agent trained against it).
export var STUCK_TIMEOUT_TICKS = 500;

// --- Player colors ---
export var AI_COLOR    = { outline: "#5cf", torso: "#3c5ac8", shirtR: 80,  shirtG: 120, shirtB: 200 };
export var HUMAN_COLOR = { outline: "#fc5", torso: "#c8783c", shirtR: 200, shirtG: 120, shirtB: 60  };
// Human-vs-Human: left car (WASD) orange, right car (arrows) green — kept visually
// distinct so each player can spot both cars on the shared terrain.
export var HUMAN_L_COLOR = HUMAN_COLOR;
export var HUMAN_R_COLOR = { outline: "#6f6", torso: "#2f8f2f", shirtR: 90, shirtG: 190, shirtB: 90 };

// --- Cheat / bug-probe tuning ---
export var BP_MAX_LEN = 12000;   // ring-buffer cap (~6.7 min at 30 fps)
export var FLIGHT_SPEED_MIN = 0, FLIGHT_SPEED_MAX = 60, FLIGHT_SPEED_STEP = 5;
export var FLIGHT_ROT_RATE = 2.0;   // spin rate (rad/s) while rotate held
export var FLIGHT_ROT_DAMP = 0.90;  // per-tick angular damping when NOT rotating
export var ROCKET_ACCEL_MIN = 5, ROCKET_ACCEL_MAX = 120, ROCKET_ACCEL_STEP = 5;
export var ROCKET_ROT_RATE = 2.0;
export var ROCKET_ROT_DAMP = 0.90;
export var ROCKET_LIN_DAMP = 0.99;  // per-tick linear drag so thrust settles at a terminal speed

export var MAX_SESSION_TERRAINS = 30;

// --- The single mutable state object ---
export var S = {
  // core simulation
  world: null,
  ground: null,
  listener: null,
  players: [],            // array of player records (see sim.makePlayer)
  tickCount: 0,
  paused: false,
  simSpeed: 1,
  aiAgent: null,          // Agent instance from ai_policy.js (PpoOnnxAgent by default)
  mode: "ai",             // key into modes.MODES

  // Best of X + replay
  storedGround: null,     // canonical map cloned into each attempt's fresh world
  storedSpawningY: 0,
  bestofxRuns: [],        // [{ attempt, distance, score, actions:[int], spawnDx, spawnDy }]
  bestofxAbort: false,
  replayActions: null,    // non-null => feed recorded actions instead of the model
  replayIdx: 0,
  bestofxBusy: false,     // guards the RAF loop while a headless loop owns the world
  worldGen: 0,            // bumped on every world rebuild; in-flight steps bail if it changed

  // Loaded track + ghost replay
  loadedTrack: null,
  ghostPoses: null,       // non-null => ghost replay mode (per-tick poses, meters)
  ghostIdx: -1,
  ghostDims: null,
  ghostScore: 0,
  ghostDone: false,
  ghostBeaten: true,      // false => a "best run" that did NOT beat the game
  backtrackAbort: false,

  // Camera (published into cameraPanX/Y right before each viewport draws)
  cameraPanX: 0,
  cameraPanY: 0,
  cam0: { panX: 0, panY: 0 },   // single-view modes
  camL: { panX: 0, panY: 0 },   // Human-vs-Human left half
  camR: { panX: 0, panY: 0 },   // Human-vs-Human right half

  // Human input (held by keyboard listeners). Two control sets so two humans can
  // race on one keyboard. Semantics match the AI action space (right=forward).
  humanKeys:     { left: false, right: false },  // arrows -> right screen / lone human
  humanKeysWASD: { left: false, right: false },  // A/D (or S/W) -> left screen
  flyKeysWASD:   { fwd: false, back: false, rotL: false, rotR: false },
  flyKeysArrows: { fwd: false, back: false, rotL: false, rotR: false },

  // Bug probe / cheats
  bpRecord: [],           // ring buffer of per-tick human-car snapshots
  bpFlags: [],            // user-set markers {tick, idx}
  bpZeroG: false,
  bpSavedGravity: null,
  bpInvincible: false,    // skip head-ground / fell-off / no-progress death
  bpAltimeter: false,     // live height-above-ground readout
  bpSpeed: false,         // live speed readout
  bpFlight: false,        // constant-velocity hover cheat (G)
  bpRocket: false,        // thrust cheat (J)
  flightSpeed: 20,        // m/s, scroll-adjustable
  rocketAccel: 20,        // m/s^2, scroll-adjustable

  // Loop timing
  accumSec: 0,
  lastWallMs: 0,

  // Session terrains (re-loadable from the Terrains dropdown)
  sessionTerrains: [],
  terrainCounter: 0,

  // Image assets (loaded once at init)
  assets: {},
};
