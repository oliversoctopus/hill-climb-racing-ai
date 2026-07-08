// Bug probe + test-time cheats: per-tick state recorder, live physics-knob tuning,
// Zero-G, Float, and the Flight/Rocket flight cheats. All passive/opt-in — nothing
// here runs unless a checkbox/key turns it on, so AI runs and default driving are
// unaffected. (See HOW_TO_PLAY §7 for the bug-probe panel.)
import {
  S, SCALE, SPAWN_X, FRAME_RATE, BP_MAX_LEN,
  FLIGHT_ROT_RATE, FLIGHT_ROT_DAMP,
  ROCKET_ROT_RATE, ROCKET_ROT_DAMP, ROCKET_LIN_DAMP,
} from "./state.js";
import { Vec2, getSpawningY } from "./bridge.js";
import { _vehicleCoM } from "./sim.js";
import { humanAction } from "./input.js";

function _bpHumanPlayer() {
  if (!S.players) return null;
  for (var i = 0; i < S.players.length; i++) if (!S.players[i].isAI) return S.players[i];
  return null;
}
// Every live car on screen (AI and human alike). The physics-knob cheats apply to
// ALL of these so they affect the AI in every mode, incl. AI-only — same as Zero-G
// (global gravity) and Float already do.
function _bpAllCars() {
  var out = [];
  if (S.players) {
    for (var i = 0; i < S.players.length; i++) if (S.players[i].car) out.push(S.players[i].car);
  }
  return out;
}
export function bpSetStatus(s) { var e = document.getElementById("bp_status"); if (e) e.textContent = s; }

export function recordTick() {
  var p = _bpHumanPlayer();
  if (!p || !p.car || p.dead) return;
  var c = p.car, cb = c.chassisBody;
  var pos = cb.GetPosition(), v = cb.GetLinearVelocity();
  var idt = FRAME_RATE;   // inv_dt for GetReactionTorque
  function jt(j) { try { return j ? j.GetReactionTorque(idt) : 0; } catch (e) { return 0; } }
  var w0 = c.wheels[0], w1 = c.wheels[1];
  var rec = {
    tick: S.tickCount, act: humanAction(),
    keyL: !!S.humanKeys.left, keyR: !!S.humanKeys.right, zeroG: S.bpZeroG, inv: S.bpInvincible,
    x: pos.x, y: pos.y, vx: v.x, vy: v.y,
    angle: cb.GetAngle(), angVel: cb.GetAngularVelocity(),
    motor0: !!(w0.joint && w0.joint.m_enableMotor),
    motor1: !!(w1.joint && w1.joint.m_enableMotor),
    wheelW0: w0.body.GetAngularVelocity(), wheelW1: w1.body.GetAngularVelocity(),
    on0: (w0.onGround === true), on1: (w1.onGround === true),
    rev0: jt(w0.joint), rev1: jt(w1.joint),       // motor-joint angular reaction (~0 when off)
    pris0: jt(w0.prisJoint), pris1: jt(w1.prisJoint)  // suspension torque into chassis
  };
  S.bpRecord.push(rec);
  if (S.bpRecord.length > BP_MAX_LEN) S.bpRecord.shift();
  var live = document.getElementById("bp_live");
  if (live) live.textContent = "angVel " + rec.angVel.toFixed(3) +
    " rad/s  angle " + rec.angle.toFixed(2) + (S.bpZeroG ? "  [ZERO-G]" : "");
}

export function _bpNum(id, dflt) {
  var el = document.getElementById(id);
  if (!el || el.value === "") return dflt;
  var v = parseFloat(el.value);
  return isNaN(v) ? dflt : v;
}
// Apply the physics knobs to every car's bodies/joints. Box2D reads
// frequency/damping fresh each step, so this retunes live without a rebuild.
// Defaults match the source (Car.js angDamp 0.1; Wheel.js susp 70/25; wheel angDamp
// 1.8) so an untouched panel changes nothing.
export function bpApplyPhys(announce) {
  var cars = _bpAllCars();
  if (!cars.length) return;
  var cad = _bpNum("bp_chassisdamp", 0.1), wad = _bpNum("bp_wheeldamp", 1.8);
  var sf = _bpNum("bp_suspfreq", 70), sd = _bpNum("bp_suspdamp", 25);
  var wf = _bpNum("bp_wheelfric", 1.5);
  for (var ci = 0; ci < cars.length; ci++) {
    var c = cars[ci];
    try { c.chassisBody.SetAngularDamping(cad); c.chassisBody.SetAwake(true); } catch (e) {}
    for (var i = 0; i < c.wheels.length; i++) {
      var w = c.wheels[i];
      try { w.body.SetAngularDamping(wad); w.body.SetAwake(true); } catch (e) {}
      try { if (w.distJoint) { w.distJoint.SetFrequency(sf); w.distJoint.SetDampingRatio(sd); } } catch (e) {}
      try { for (var f = w.body.GetFixtureList(); f; f = f.m_next) f.SetFriction(wf); } catch (e) {}
      try { if (w.rimBody) w.rimBody.SetAwake(true); } catch (e) {}
    }
  }
  var modified = (cad !== 0.1) || (wad !== 1.8) || (sf !== 70) || (sd !== 25) || (wf !== 1.5);
  if (announce || modified)
    bpSetStatus("Physics: chassisDamp=" + cad + " wheelDamp=" + wad +
                " suspFreq=" + sf + " suspDamp=" + sd + " wheelFric=" + wf +
                (modified ? "  (MODIFIED)" : ""));
}

// Motor speed/torque overrides. motorOn() resets these to base (700/350, ±13π)
// every tick, so this re-applies the scale AFTER applyAction, before world.Step.
export function bpApplyMotorOverride() {
  var ts = _bpNum("bp_motortorque", 1), ss = _bpNum("bp_motorspeed", 1);
  if (ts === 1 && ss === 1) return;
  var cars = _bpAllCars();
  for (var ci = 0; ci < cars.length; ci++) {
    var ws = cars[ci].wheels;
    for (var i = 0; i < ws.length; i++) {
      var j = ws[i].joint;
      if (j && j.m_enableMotor) {
        try { j.SetMaxMotorTorque(j.GetMaxMotorTorque() * ts); } catch (e) {}
        try { j.SetMotorSpeed(j.GetMotorSpeed() * ss); } catch (e) {}
      }
    }
  }
}

// ---- Flight & Rocket cheats ---------------------------------------------
// Two mutually-exclusive flight cheats sharing the WASD/arrow directional input.
// Rocket (J) is thrust-based (acceleration + drag); Flight (G) is constant-velocity
// hover control. Both rotate the same way. Applied per tick from runOneStep.

// Rocket: forward/back apply thrust along facing; a light linear drag caps the speed.
function _rocketCar(c, input) {
  try { c.motorOff(); } catch (e) {}   // it's a rocket now, not a driven car
  var cb = c.chassisBody;
  var sign = input.fwd ? 1 : (input.back ? -1 : 0);
  var spin = (input.rotL === input.rotR) ? 0 : (input.rotR ? 1 : -1);
  var dir = cb.GetWorldVector(new Vec2(1, 0));  // facing = chassis local +x
  var bodies = c.bodies();
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i]; if (!b) continue;
    var m = b.GetMass(); if (!(m > 0)) continue;   // static/frozen bodies: skip
    if (sign !== 0)
      b.ApplyForce(new Vec2(sign * S.rocketAccel * m * dir.x,
                            sign * S.rocketAccel * m * dir.y), b.GetWorldCenter());
    var v = b.GetLinearVelocity();   // light drag → terminal speed, no runaway
    b.SetLinearVelocity(new Vec2(v.x * ROCKET_LIN_DAMP, v.y * ROCKET_LIN_DAMP));
  }
  if (spin !== 0) { cb.SetAngularVelocity(spin * ROCKET_ROT_RATE); cb.SetAwake(true); }
  else { cb.SetAngularVelocity(cb.GetAngularVelocity() * ROCKET_ROT_DAMP); }
}

// Flight: constant-velocity hover. The car moves at exactly flightSpeed along its
// facing while forward/back is held, and is pinned to zero velocity the instant
// neither is held. We drive the whole assembly as a rigid body (linear V + ω×r about
// the CoM) and pre-cancel the gravity Box2D adds this step, so the commanded velocity
// holds exactly — no fall, no drift.
function _flyVelCar(c, input) {
  try { c.motorOff(); } catch (e) {}
  var cb = c.chassisBody;
  var sign = input.fwd ? 1 : (input.back ? -1 : 0);
  var spin = (input.rotL === input.rotR) ? 0 : (input.rotR ? 1 : -1);
  var omega = (spin !== 0) ? spin * FLIGHT_ROT_RATE
                           : cb.GetAngularVelocity() * FLIGHT_ROT_DAMP;
  var dir = cb.GetWorldVector(new Vec2(1, 0));
  var vx = sign * S.flightSpeed * dir.x, vy = sign * S.flightSpeed * dir.y;
  var g = S.world.GetGravity(), gx = g.x / FRAME_RATE, gy = g.y / FRAME_RATE;
  var com = _vehicleCoM(c), bodies = c.bodies();
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i]; if (!b) continue;
    var p = b.GetWorldCenter();
    var rx = p.x - com.x, ry = p.y - com.y;   // rigid-body velocity field about the CoM
    b.SetLinearVelocity(new Vec2(vx - omega * ry - gx, vy + omega * rx - gy));
    b.SetAngularVelocity(omega); b.SetAwake(true);
  }
}

// OR-merge two control sets (single-player: either hand flies the lone car).
function _mergeFly(a, b) {
  return { fwd: a.fwd || b.fwd, back: a.back || b.back,
           rotL: a.rotL || b.rotL, rotR: a.rotR || b.rotR };
}
// Apply a per-car fly function to every player's car, routing input per control set:
// Human-vs-Human gives each player their OWN keys; other modes merge both and apply
// to all cars (incl. the AI's).
function _applyFlyCheat(flyFn) {
  if (!S.players || !S.players.length) return;
  var merged = (S.mode === "hvh") ? null : _mergeFly(S.flyKeysWASD, S.flyKeysArrows);
  for (var pi = 0; pi < S.players.length; pi++) {
    var p = S.players[pi]; if (!p.car) continue;
    var input = merged || (p.control === "arrows" ? S.flyKeysArrows : S.flyKeysWASD);
    flyFn(p.car, input);
  }
}
export function applyFlyCheats() {
  if (S.bpFlight)      _applyFlyCheat(_flyVelCar);
  else if (S.bpRocket) _applyFlyCheat(_rocketCar);
}

export function bpSetZeroG(on) {
  if (on) {
    // Capture the REAL gravity only when first entering zero-G — otherwise a second
    // enable would read the already-zeroed gravity. Store a copy, not the world's
    // internal vector.
    if (!S.bpZeroG) {
      var g = S.world.GetGravity();
      S.bpSavedGravity = new Vec2(g.x, g.y);
    }
    S.world.SetGravity(new Vec2(0, 0));
    S.bpZeroG = true;
    bpSetStatus("Zero-G ON — gravity off (everything keeps its velocity). Press F to float the car(s) up.");
  } else {
    // Fall back to normal gravity if the saved value is missing or (defensively) zero.
    var gv = S.bpSavedGravity;
    if (!gv || (gv.x === 0 && gv.y === 0)) gv = new Vec2(0, 10);
    S.world.SetGravity(gv);
    S.bpZeroG = false;
    bpSetStatus("Zero-G OFF — gravity restored.");
  }
}
function _bpFloatOneCar(c) {
  // Translate the WHOLE car up ~300px, PRESERVING both linear AND angular velocity so
  // it keeps doing exactly what it was doing. With no gravity (press Zero-G first) and
  // no ground, a spin that grows/persists is a pure joint/solver artifact.
  var dyM = 300 / SCALE;
  var bodies = c.bodies();
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i]; if (!b) continue;
    var bp = b.GetPosition();
    b.SetPositionAndAngle(new Vec2(bp.x, bp.y - dyM), b.GetAngle());
    b.SetAwake(true);   // velocity (linear + angular) preserved
  }
}
export function bpFloatCar() {
  // Float every car on screen — AI and human alike (both players in Human-vs-Human).
  var n = 0;
  if (S.players) {
    for (var i = 0; i < S.players.length; i++) {
      var p = S.players[i];
      if (p.car) { _bpFloatOneCar(p.car); n++; }
    }
  }
  if (n === 0) { bpSetStatus("No car to float — start a run first."); return; }
  bpSetStatus("Floated " + (n > 1 ? n + " cars" : "car") + " up (velocity preserved, camera follows). Enable Zero-G to watch a pure joint/solver spin.");
}
export function bpFlag() {
  S.bpFlags.push({ tick: S.tickCount, idx: S.bpRecord.length });
  bpSetStatus("Flagged at tick " + S.tickCount + " (flag #" + S.bpFlags.length + "). Keep playing, then Download.");
}
export function bpDownload() {
  var gv = (S.ground && S.ground.vectors)
    ? S.ground.vectors.map(function (v) { return [v.x, v.y]; }) : [];
  var data = {
    meta: {
      units: "position/velocity in meters & m/s, angle rad, ang_vel rad/s, torque N*m; ground in meters",
      frame_rate: FRAME_RATE, scale: SCALE, spawn_x: SPAWN_X,
      spawning_y: getSpawningY(),
      mode: S.mode,
      phys: { chassisAngDamp: _bpNum("bp_chassisdamp", 0.1), wheelAngDamp: _bpNum("bp_wheeldamp", 1.8),
              suspFreq: _bpNum("bp_suspfreq", 70), suspDamp: _bpNum("bp_suspdamp", 25),
              wheelFric: _bpNum("bp_wheelfric", 1.5), motorSpeedScale: _bpNum("bp_motorspeed", 1),
              motorTorqueScale: _bpNum("bp_motortorque", 1) },
      n_ticks: S.bpRecord.length, flags: S.bpFlags
    },
    ground: gv, ticks: S.bpRecord
  };
  var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = "hcr_bugrun_" + (new Date().toISOString().replace(/[:.]/g, "-")) + ".json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  bpSetStatus("Downloaded " + S.bpRecord.length + " ticks, " + S.bpFlags.length + " flag(s).");
}
