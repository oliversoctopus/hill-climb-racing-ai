// Vanilla-canvas renderer (no p5): scenery, cars, HUD, smooth-follow camera, the
// unified cheat-readout HUD, split-screen for Human-vs-Human, and the DOM stats
// line. Mirrors python/renderer.py but supports multiple players with per-player
// colors. The physics classes' own p5 show() methods are used only by legacy_neat/.
import {
  S, SCALE, SPAWN_X, CANVAS_WIDTH, CANVAS_HEIGHT, FRAME_RATE,
  AI_COLOR, HUMAN_COLOR, HUMAN_L_COLOR, HUMAN_R_COLOR,
} from "./state.js";
import { scoreOf, scorePx, curScoreOf, _vehicleBodies, _vehicleCoM } from "./sim.js";
import { modeDef, stageWidth } from "./modes.js";
import { altitudeAboveKillLine } from "./geom.js";

// Draws a body's sprite at its world position, rotated by its angle. The sprite-rect
// (sx, sy, sw, sh) is in body-LOCAL pixel space (relative to the body's center,
// before rotation) — matches the p5 image(spr, sx, sy, sw, sh) inside push/rotate.
function _drawSprite(ctx, img, body, sx, sy, sw, sh) {
  const p = body.GetPosition();
  const a = body.GetAngle();
  ctx.save();
  ctx.translate(p.x * SCALE - S.cameraPanX, p.y * SCALE - S.cameraPanY);
  ctx.rotate(a);
  ctx.drawImage(img, sx, sy, sw, sh);
  ctx.restore();
}

// Draws a rotated solid rectangle (torso) — same as p5's push/translate/rotate/
// rectMode(CENTER)/rect(0,0,w,h) sequence.
function _drawRotRect(ctx, body, w, h, fill, stroke) {
  const p = body.GetPosition();
  const a = body.GetAngle();
  ctx.save();
  ctx.translate(p.x * SCALE - S.cameraPanX, p.y * SCALE - S.cameraPanY);
  ctx.rotate(a);
  ctx.fillStyle = fill;
  ctx.fillRect(-w/2, -h/2, w, h);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(-w/2, -h/2, w, h);
  }
  ctx.restore();
}

// Render order mirrors Car.show() in Car.js: person, wheels, then chassis sprite on
// top (drawn LAST so it covers the wheel-attach points).
function _drawCar(ctx, car, color, isAI) {
  const assets = S.assets;
  // Torso (rotated solid rect, shirt color)
  const torso = car.person.torso;
  const shirtColor = `rgb(${car.player.shirtColorR},${car.player.shirtColorG},${car.player.shirtColorB})`;
  _drawRotRect(ctx, torso.body, torso.width, torso.height, shirtColor, "#000");

  // Head sprite. AI cars wear Code Bullet's computer head (isCB branch in Person.js:
  // CB uses x=-r-7, person x=-r-8; both y=-r-15, w=h=r*3).
  const head = car.person.head;
  const hr = head.radius;
  if (isAI && assets.cbhead) {
    _drawSprite(ctx, assets.cbhead, head.body, -hr - 7, -hr - 15, hr * 3, hr * 3);
  } else {
    _drawSprite(ctx, assets.head, head.body, -hr - 8, -hr - 15, hr * 3, hr * 3);
  }

  // Wheel sprites (Wheel.js: x=-r, y=-r, w=h=2*r)
  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i];
    _drawSprite(ctx, assets.wheel, w.body, -w.radius, -w.radius, w.radius * 2, w.radius * 2);
  }

  // Chassis sprite (Car.js: x=-cw/2-7, y=-ch-20, w=cw+23, h=ch*2+10)
  const cw = car.chassisWidth, ch = car.chassisHeight;
  _drawSprite(ctx, assets.car, car.chassisBody, -cw/2 - 7, -ch - 20, cw + 23, ch * 2 + 10);
}

// Draw the car from a recorded pose (meters) instead of live Box2D bodies, by
// mocking the GetPosition/GetAngle the sprite helpers read. dims (px) come from the
// export so sizes are exact. Mirrors _drawCar's order: torso, head, wheels, chassis.
function _mockBody(o) {
  return { GetPosition() { return { x: o.x, y: o.y }; },
           GetAngle() { return o.angle || 0; } };
}
function _drawCarFromPose(ctx, pose, color, d) {
  const assets = S.assets;
  // Ghost replays are always the AI beating the track, so it wears the CB head.
  const shirt = `rgb(${color.shirtR},${color.shirtG},${color.shirtB})`;
  _drawRotRect(ctx, _mockBody(pose.torso), d.torso_w, d.torso_h, shirt, "#000");
  const hr = d.head_r;
  if (assets.cbhead) {
    _drawSprite(ctx, assets.cbhead, _mockBody(pose.head), -hr - 7, -hr - 15, hr * 3, hr * 3);
  } else {
    _drawSprite(ctx, assets.head, _mockBody(pose.head), -hr - 8, -hr - 15, hr * 3, hr * 3);
  }
  for (let i = 0; i < pose.wheels.length; i++) {
    const wr = d.wheel_r;
    _drawSprite(ctx, assets.wheel, _mockBody(pose.wheels[i]), -wr, -wr, wr * 2, wr * 2);
  }
  const cw = d.chassis_w, ch = d.chassis_h;
  _drawSprite(ctx, assets.car, _mockBody(pose.chassis), -cw/2 - 7, -ch - 20, cw + 23, ch * 2 + 10);
}

// Smooth-follow camera update for ONE viewport. Mutates cam.panX/panY so the focus
// car sits at screen-x `anchorX` and stays inside a vertical screen band. Shared by
// single-view render and each half of the split screen.
function _followCamera(cam, focusX, focusYworld, anchorX) {
  const CAM_TRIGGER_MARGIN = 80;   // px from the left edge; once the focus reaches this
                                 // (reversing / flying backwards) the camera catches it
  let target = focusX - anchorX; // normal offset: the focus sits anchorX px from the left
  if (!S.bpZeroG) {
    // Normal play floors the scroll at 0 so the pre-start area stays hidden and the
    // focus is free to drift left across the screen. Once it reaches the trigger
    // margin, catch it and smoothly pan back to the FULL anchorX margin — latched
    // (panX < 0) until it returns to spawn.
    const flooredTarget = Math.max(0, target);
    const triggered = (cam.panX < 0) || (focusX - cam.panX < CAM_TRIGGER_MARGIN);
    target = triggered ? target : flooredTarget;
  }
  // Feed-forward the target's own per-frame velocity so the camera doesn't TRAIL a fast
  // car. A plain lerp (`pan += (target-pan)*k`) lags a moving target by an offset
  // proportional to its SPEED — so at high speed the car drifts off its anchor and either
  // leaves the screen or trips the snap below in visible chunks. Adding (1-k)*(target-
  // lastTarget) cancels that: the steady-state lag is zero, so the car holds its anchor at
  // ANY constant speed and only slides (then eases back) while it's accelerating. k=0.25 =>
  // 0.75 feed-forward.
  if (Math.abs(target - cam.panX) > 400) cam.panX = target;   // snap on big jumps (teleport/respawn)
  else cam.panX += (target - cam.panX) * 0.25 + (target - cam.lastTargetX) * 0.75;
  cam.lastTargetX = target;
  // Vertical follow: keep the focus car inside a screen band. Stays ~0 in normal play,
  // only kicking in when it flies high or falls low. Target from the NEUTRAL-camera
  // world y (not the panned screen position) so the return is smooth and symmetric. Same
  // velocity feed-forward as the horizontal (k=0.2 => 0.8) — this is the axis that had no
  // snap safety net, so without it a fast climb/fall trailed off-screen entirely.
  const topM = 120, botM = CANVAS_HEIGHT - 80;
  let targetY = 0;
  if (focusYworld < topM) targetY = focusYworld - topM;
  else if (focusYworld > botM) targetY = focusYworld - botM;
  cam.panY += (targetY - cam.panY) * 0.2 + (targetY - cam.lastTargetY) * 0.8;
  cam.lastTargetY = targetY;
}

// Draw sky + ground + grass for the current global cameraPanX/cameraPanY into a
// viewport `viewWidth` px wide (local coords; caller sets up clip/translate).
function _drawScenery(ctx, viewWidth) {
  const assets = S.assets;
  const ground = S.ground;
  // Sky — fills the viewport. Doesn't pan (matches original sketch.js:411).
  if (assets.sky) {
    ctx.drawImage(assets.sky, 0, 0, viewWidth, CANVAS_HEIGHT);
  } else {
    ctx.fillStyle = "#87ceeb";
    ctx.fillRect(0, 0, viewWidth, CANVAS_HEIGHT);
  }

  // Ground (dirt fill + grass line). Walk only the visible vertex slice. Track vertex
  // INDICES so we can place grass sprites at the same indices.
  const v = ground.vectors;
  const xLeft = S.cameraPanX - 50;
  const xRight = S.cameraPanX + viewWidth + 50;
  const topPts = [];
  const topIdx = [];
  for (let i = 0; i < v.length - 2; i++) {
    const vx = v[i].x * SCALE, vy = v[i].y * SCALE;
    if (vx < xLeft) continue;
    if (vx > xRight) break;
    topPts.push([vx - S.cameraPanX, vy - S.cameraPanY]);
    topIdx.push(i);
  }
  if (topPts.length >= 2) {
    ctx.fillStyle = "#582300";
    ctx.beginPath();
    ctx.moveTo(topPts[0][0], topPts[0][1]);
    for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i][0], topPts[i][1]);
    ctx.lineTo(topPts[topPts.length-1][0], CANVAS_HEIGHT);
    ctx.lineTo(topPts[0][0], CANVAS_HEIGHT);
    ctx.closePath();
    ctx.fill();
    // Main green grass band. Width + color match Code Bullet's Ground.show():
    // stroke(0,120,0) = #007800, strokeWeight(grassThickness*2) = 10 (centered).
    ctx.strokeStyle = "#007800"; ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(topPts[0][0], topPts[0][1]);
    for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i][0], topPts[i][1]);
    ctx.stroke();
    // Four thin (weight-3) detail lines, matching Code Bullet's Ground.show(): two
    // olive lines below the terrain line and two bright-green highlights above it.
    const detail = [
      ["#423c00", 9],   // stroke(66,60,0)  dark olive
      ["#2c5a00", 6],   // stroke(44,90,0)  olive-green
      ["#008c00", -5],  // stroke(0,140,0)  bright green
      ["#008200", -3],  // stroke(0,130,0)  green
    ];
    ctx.lineWidth = 3;
    for (let d = 0; d < detail.length; d++) {
      ctx.strokeStyle = detail[d][0];
      const off = detail[d][1];
      ctx.beginPath();
      ctx.moveTo(topPts[0][0], topPts[0][1] + off);
      for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i][0], topPts[i][1] + off);
      ctx.stroke();
    }
  }

  // Grass sprites (Ground.js show()). Each vertex has 2 grass slots: grassPositions[2i]
  // at vertex i, grassPositions[2i+1] halfway to vertex i+1. -1 = no sprite. Centered on
  // its anchor with a -15 px y-offset (so it sits ABOVE the terrain line).
  if (ground.grassPositions && assets.grass && topIdx.length > 1) {
    const gp = ground.grassPositions;
    for (let k = 0; k < topIdx.length - 1; k++) {
      var i = topIdx[k];
      const sIdx = gp[2 * i];
      if (sIdx !== undefined && sIdx >= 0 && sIdx < assets.grass.length) {
        var spr = assets.grass[sIdx];
        ctx.drawImage(spr,
          topPts[k][0] - spr.width / 2,
          topPts[k][1] - spr.height / 2 - 15);
      }
      const sIdx2 = gp[2 * i + 1];
      if (sIdx2 !== undefined && sIdx2 >= 0 && sIdx2 < assets.grass.length) {
        var spr = assets.grass[sIdx2];
        const midX = (topPts[k][0] + topPts[k+1][0]) / 2;
        const midY = (topPts[k][1] + topPts[k+1][1]) / 2;
        ctx.drawImage(spr,
          midX - spr.width / 2,
          midY - spr.height / 2 - 15);
      }
    }
  }
}

// On-screen score label in Code Bullet's style, with a dark outline so it stays
// legible over sky and terrain.
function _hudText(ctx, text, x, y, align, color, size) {
  const px = size || 28;   // optional font size; defaults to the standard 28px HUD text
  ctx.save();
  ctx.textAlign = align;
  ctx.font = `bold ${px}px monospace`;
  ctx.lineJoin = "round";
  ctx.lineWidth = px * 0.18;   // keep the outline proportional so smaller text isn't over-stroked
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Distance (info readout): the CURRENT-position score, drawn just under a score label at
// (x, y) when the toggle is on. Smaller than the score so it reads as a sub-line.
function _drawDistanceUnder(ctx, curScore, x, y, align, color) {
  if (!S.bpDistance) return;
  _hudText(ctx, `Distance ${curScore}`, x, y + 26, align, color, 18);
}

// Live-play score HUD for the single-screen modes: your score top-left, and the AI's
// top-right when racing it (mirrors the Human-vs-AI layout in sketch.js).
function _drawSingleScoreHUD(ctx) {
  let ai = null, hum = null;
  for (let i = 0; i < S.players.length; i++) { if (S.players[i].isAI) ai = S.players[i]; else hum = S.players[i]; }
  if (S.mode === "vs" && hum && ai) {
    _hudText(ctx, `You — Score ${scoreOf(hum)}`, 24, 48, "left",  HUMAN_COLOR.outline);
    _drawDistanceUnder(ctx, curScoreOf(hum), 24, 48, "left", HUMAN_COLOR.outline);
    _hudText(ctx, `AI — Score ${scoreOf(ai)}`,  CANVAS_WIDTH - 24, 48, "right", AI_COLOR.outline);
    _drawDistanceUnder(ctx, curScoreOf(ai), CANVAS_WIDTH - 24, 48, "right", AI_COLOR.outline);
  } else if (S.mode === "human" && hum) {
    _hudText(ctx, `Your Score: ${scoreOf(hum)}`, 24, 48, "left", HUMAN_COLOR.outline);
    _drawDistanceUnder(ctx, curScoreOf(hum), 24, 48, "left", HUMAN_COLOR.outline);
  } else if ((S.mode === "ai" || S.mode === "bestofx") && ai) {
    _hudText(ctx, `AI Score: ${scoreOf(ai)}`, 24, 48, "left", AI_COLOR.outline);
    _drawDistanceUnder(ctx, curScoreOf(ai), 24, 48, "left", AI_COLOR.outline);
  }
}

// ---- Readout cheats (altimeter, speed) ----------------------------------
// Altimeter (info readout): the chassis's ABSOLUTE elevation above the fixed kill-line
// level, in meters (y-down; see geom.altitudeAboveKillLine) — a constant reference, not
// the clearance over the hill directly below, so it reads true height along the track.
function _altitudeMeters(car) {
  if (!car) return 0;
  const p = car.chassisBody.GetPosition();
  return altitudeAboveKillLine(p.y);
}
// Speed meter (cheat): the WHOLE-VEHICLE center-of-mass velocity in m/s (mass-weighted
// mean of every body's CoM velocity). The chassis CoM orbits the vehicle CoM while the
// car spins, so a chassis-only reading wobbles; the combined CoM velocity is the true
// translational speed. x>0 is forward/right; world y is DOWN, so vertical is -vy.
function _speedComponents(car) {
  if (!car) return { h: 0, v: 0, total: 0 };
  const bodies = _vehicleBodies(car);
  let mx = 0, my = 0, mtot = 0;
  for (let i = 0; i < bodies.length; i++) {
    const m = bodies[i].GetMass(); if (!(m > 0)) continue;   // static/frozen bodies have mass 0
    const bv = bodies[i].GetLinearVelocity();
    mx += m * bv.x; my += m * bv.y; mtot += m;
  }
  if (mtot <= 0) {   // dead/frozen car — fall back to the chassis body
    const cv = car.chassisBody.GetLinearVelocity();
    return { h: cv.x, v: -cv.y, total: Math.sqrt(cv.x * cv.x + cv.y * cv.y) };
  }
  const vx = mx / mtot, vy = my / mtot;
  return { h: vx, v: -vy, total: Math.sqrt(vx * vx + vy * vy) };
}

// Ghost-replay data sources for the readout cheats. A ghost is a recorded pose stream
// (no live bodies), so both readouts anchor on the recorded WHOLE-VEHICLE CoM (pose.com),
// NOT the chassis origin, so they don't wobble. Altitude = elevation above the fixed
// kill-line level; speed = finite-difference of the CoM across neighbouring frames.
// Older poses fall back to chassis.
function _ghostRef(pose) { return (pose && pose.com) ? pose.com : (pose ? pose.chassis : null); }
function _ghostAltitudeMeters(pose) {
  const r = _ghostRef(pose);
  if (!r) return 0;
  return altitudeAboveKillLine(r.y);
}
function _ghostSpeedComponents(idx) {
  if (!S.ghostPoses || S.ghostPoses.length < 2) return { h: 0, v: 0, total: 0 };
  const i  = Math.max(0, Math.min(idx, S.ghostPoses.length - 1));
  const i0 = Math.max(0, i - 1), i1 = Math.min(S.ghostPoses.length - 1, i + 1);
  if (i1 === i0) return { h: 0, v: 0, total: 0 };
  const a = _ghostRef(S.ghostPoses[i0]), b = _ghostRef(S.ghostPoses[i1]);
  if (!a || !b) return { h: 0, v: 0, total: 0 };
  const dt = (i1 - i0) / FRAME_RATE;
  const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
  return { h: vx, v: -vy, total: Math.sqrt(vx * vx + vy * vy) };
}

// One registry for every centre-screen "readout" cheat so EVERY render path (single
// screen, split-screen, ghost replay) draws them identically. Each render path builds
// a "cheat target" (a live car OR a replay frame) and calls drawCheatHUD once.
function cheatTargetFromCar(car) {
  return { altitude() { return _altitudeMeters(car); },
           speed() { return _speedComponents(car); } };
}
function cheatTargetFromGhost(pose, idx) {
  return { altitude() { return _ghostAltitudeMeters(pose); },
           speed() { return _ghostSpeedComponents(idx); } };
}
// Registry entries render top-to-bottom in this order. `on` reads the toggle flag;
// `line` turns a target into the display string; `color`/`size` style the text.
// To add a readout cheat: add its flag to state.S, a checkbox/key, a target accessor,
// and ONE entry here — it then appears in all modes automatically.
const CHEAT_HUD = [
  { color: "#9fd4ff",
    on() { return S.bpAltimeter; },
    line(t) { return `⛰ Altitude ${t.altitude().toFixed(1)} m`; } },
  { color: "#ffd27f", size: 20,
    on() { return S.bpSpeed; },
    line(t) { const s = t.speed();
      return `🚗 H ${s.h.toFixed(1)}  V ${s.v.toFixed(1)}  Tot ${s.total.toFixed(1)} m/s`; } },
  { color: "#9df0ff", size: 20,
    on() { return S.bpFlight; },
    line() { return `✈ Flight speed ${S.flightSpeed} m/s  (Alt+scroll to adjust)`; } },
  { color: "#ff9d6e", size: 20,
    on() { return S.bpRocket; },
    line() { return `🚀 Rocket thrust ${S.rocketAccel} m/s²  (Alt+scroll to adjust)`; } },
];
// Draw every enabled readout for `target`, stacked from topY down. Returns the y after
// the last line so callers can keep laying out below it if needed.
function drawCheatHUD(ctx, target, centerX, topY) {
  if (!target) return topY;
  let y = topY;
  for (let i = 0; i < CHEAT_HUD.length; i++) {
    const c = CHEAT_HUD[i];
    if (!c.on()) continue;
    _hudText(ctx, c.line(target), centerX, y, "center", c.color, c.size);
    y += 32;
  }
  return y;
}

export function render() {
  const cv = document.getElementById("stage");
  const ctx = cv.getContext("2d");

  // Human-vs-Human: two live cars on the same terrain, side-by-side split screen.
  if (modeDef(S.mode).split && !S.ghostPoses && S.players.length >= 2) { renderSplit(ctx); return; }

  // Camera target: prefer the LIVING human so they can always see themselves; once the
  // human dies, hand off to the AI. Falls back to whatever's alive (or any player).
  let focus = null;
  for (var pi = 0; pi < S.players.length; pi++) {
    if (!S.players[pi].isAI && !S.players[pi].dead) { focus = S.players[pi]; break; }
  }
  if (focus === null) {
    for (var pi = 0; pi < S.players.length; pi++) {
      if (S.players[pi].isAI && !S.players[pi].dead) { focus = S.players[pi]; break; }
    }
  }
  if (focus === null && S.players.length > 0) focus = S.players[0];
  const ghostPose = (S.ghostPoses && S.ghostPoses.length)
    ? S.ghostPoses[Math.max(0, Math.min(S.ghostIdx, S.ghostPoses.length - 1))] : null;
  const focusCar = focus ? focus.car.chassisBody.GetPosition() : null;
  let focusX = focusCar ? focusCar.x * SCALE : SPAWN_X;
  if (ghostPose) focusX = ghostPose.chassis.x * SCALE;
  let focusYworld = focusCar ? focusCar.y * SCALE : 0;
  if (ghostPose) focusYworld = ghostPose.chassis.y * SCALE;
  _followCamera(S.cam0, focusX, focusYworld, SPAWN_X);
  S.cameraPanX = S.cam0.panX; S.cameraPanY = S.cam0.panY;   // publish to the globals the helpers read

  _drawScenery(ctx, CANVAS_WIDTH);

  // Cars: ghost replay draws the recorded pose stream; otherwise each live player.
  if (ghostPose) {
    _drawCarFromPose(ctx, ghostPose, AI_COLOR, S.ghostDims);
    // Live AI score, top-left, same as the other modes (the ghost is the AI's run).
    const gscore = scorePx(ghostPose.chassis.x * SCALE);
    _hudText(ctx, `AI Score: ${gscore}`, 24, 48, "left", AI_COLOR.outline);
    // Center readout cheats (altimeter/speed) — same HUD as every other mode.
    drawCheatHUD(ctx, cheatTargetFromGhost(ghostPose, S.ghostIdx), CANVAS_WIDTH / 2, 48);
  } else {
    for (var pi = 0; pi < S.players.length; pi++) {
      _drawCar(ctx, S.players[pi].car, S.players[pi].color, S.players[pi].isAI);
    }
    _drawSingleScoreHUD(ctx);   // on-screen score, Code Bullet style (top corners)
    // Center readout cheats for the focused car (altimeter/speed), stacked at y=48.
    if (focus && focus.car) drawCheatHUD(ctx, cheatTargetFromCar(focus.car), CANVAS_WIDTH / 2, 48);
  }

  if (S.ghostPoses) {
    // Ghost mode: celebrate the beat at the end; never the "DEAD" prompt.
    if (S.ghostDone) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.font = "44px monospace";
      ctx.textAlign = "center";
      if (S.ghostBeaten) {
        ctx.fillStyle = "#7fffa0";
        ctx.fillText(`✓ BEAT THE GAME — score ${Math.round(S.ghostScore)}`,
                     CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      } else {
        ctx.fillStyle = "#ffd27f";
        ctx.fillText(`AI's best run — score ${Math.round(S.ghostScore)} (not beaten)`,
                     CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      }
    }
  } else {
    // If ALL players are dead, dim + show prompt. If someone BEAT the game (crossed the
    // finish before falling in), celebrate the win instead of showing "DEAD".
    let allDead = S.players.length > 0;
    let beater = null;
    for (var pi = 0; pi < S.players.length; pi++) {
      if (!S.players[pi].dead) allDead = false;
      if (S.players[pi].beatTick && (!beater || S.players[pi].beatTick < beater.beatTick)) beater = S.players[pi];
    }
    if (allDead) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.font = "48px monospace";
      ctx.textAlign = "center";
      if (beater) {
        ctx.fillStyle = "#7fffa0";
        const who = beater.isAI ? "AI BEAT THE GAME!" : "YOU BEAT THE GAME!";
        ctx.fillText(`${who} — Restart or Regenerate`, CANVAS_WIDTH/2, CANVAS_HEIGHT/2);
      } else {
        ctx.fillStyle = "white";
        ctx.fillText("DEAD — Restart or Regenerate", CANVAS_WIDTH/2, CANVAS_HEIGHT/2);
      }
    }
  }
}

// Draw ONE split-screen half (a full standard-width screen): its own camera following
// `ownP`, the shared world (both cars drawn), and a Human-vs-AI-style score HUD.
function _drawViewport(ctx, cam, offsetX, viewWidth, ownP, oppP, ownName, oppName, ownColor, oppColor) {
  const fc = ownP.car.chassisBody.GetPosition();
  _followCamera(cam, fc.x * SCALE, fc.y * SCALE, SPAWN_X);
  S.cameraPanX = cam.panX; S.cameraPanY = cam.panY;   // publish to globals for the draw helpers

  ctx.save();
  ctx.beginPath(); ctx.rect(offsetX, 0, viewWidth, CANVAS_HEIGHT); ctx.clip();
  ctx.translate(offsetX, 0);

  _drawScenery(ctx, viewWidth);
  for (let pi = 0; pi < S.players.length; pi++) _drawCar(ctx, S.players[pi].car, S.players[pi].color, S.players[pi].isAI);

  // Score HUD, Code Bullet layout: this player's score top-left, opponent top-right.
  _hudText(ctx, `${ownName} — Score ${scoreOf(ownP)}`, 24, 48, "left",  ownColor.outline);
  _drawDistanceUnder(ctx, curScoreOf(ownP), 24, 48, "left", ownColor.outline);
  _hudText(ctx, `${oppName} — Score ${scoreOf(oppP)}`, viewWidth - 24, 48, "right", oppColor.outline);
  _drawDistanceUnder(ctx, curScoreOf(oppP), viewWidth - 24, 48, "right", oppColor.outline);
  // Center readout cheats for THIS player's car — top-center at y=48, identical to
  // every other mode.
  drawCheatHUD(ctx, cheatTargetFromCar(ownP.car), viewWidth / 2, 48);

  // A player who crossed the finish (beatTick) shows BEAT THE GAME — even after they
  // fly off into the void and die, that's still a win, so beatTick wins over dead.
  if (ownP.beatTick || ownP.dead) {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, viewWidth, CANVAS_HEIGHT);
    ctx.textAlign = "center";
    if (ownP.beatTick) {
      ctx.fillStyle = "#7fffa0";
      ctx.font = "36px monospace";
      ctx.fillText("BEAT THE GAME", viewWidth / 2, CANVAS_HEIGHT / 2);
    } else {
      ctx.fillStyle = "#fff";
      ctx.font = "36px monospace";
      ctx.fillText("DEAD", viewWidth / 2, CANVAS_HEIGHT / 2);
    }
  }
  ctx.restore();
}

function renderSplit(ctx) {
  const W = CANVAS_WIDTH;   // each half is one full standard-width screen
  const pL = S.players[0], pR = S.players[1];
  // Left screen shows P1 (own, top-left) vs P2 (opp, top-right); right screen mirrors it.
  _drawViewport(ctx, S.camL, 0, W, pL, pR, "P1 · WASD",   "P2 · Arrows", HUMAN_L_COLOR, HUMAN_R_COLOR);
  _drawViewport(ctx, S.camR, W, W, pR, pL, "P2 · Arrows", "P1 · WASD",   HUMAN_R_COLOR, HUMAN_L_COLOR);

  // Divider between the two screens.
  ctx.save();
  ctx.strokeStyle = "#111"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(W, 0); ctx.lineTo(W, CANVAS_HEIGHT); ctx.stroke();
  ctx.restore();

  // Only reveal the conclusion once BOTH players are DEAD (fell off, hit their head, or
  // flew off the end after beating the game). beatTick records WHO beat the game first;
  // the winner is whoever crossed first; if neither beat it, the higher score wins.
  const someoneBeat = pL.beatTick || pR.beatTick;
  const bothDead = pL.dead && pR.dead;
  if (bothDead) {
    let msg, sub;
    if (someoneBeat) {
      // Smaller beatTick = crossed the finish first; equal tick → further past it.
      let lWins;
      if (pL.beatTick && pR.beatTick) {
        lWins = (pL.beatTick !== pR.beatTick) ? (pL.beatTick < pR.beatTick)
                                              : (pL.maxDistPx >= pR.maxDistPx);
      } else {
        lWins = !!pL.beatTick;
      }
      msg = lWins ? "◀ P1 (WASD) BEAT THE GAME FIRST" : "P2 (Arrows) BEAT THE GAME FIRST ▶";
      sub = (pL.beatTick && pR.beatTick) ? "both beat the game — first to the finish wins"
                                         : "beat the game — opponent didn't finish";
    } else {
      const ls = scoreOf(pL), rs = scoreOf(pR);
      msg = (ls === rs) ? "TIE!" : (ls > rs ? "◀ P1 (WASD) WINS" : "P2 (Arrows) WINS ▶");
      sub = `neither beat the game — P1 score ${ls} vs P2 score ${rs}`;
    }
    const stageW = stageWidth();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 8, stageW, 104);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd27f"; ctx.font = "bold 44px monospace";
    ctx.fillText(msg, stageW / 2, 60);
    ctx.fillStyle = "#fff"; ctx.font = "20px monospace";
    ctx.fillText(`${sub}   —   ↺ Restart (rematch) or 🎲 Regenerate`, stageW / 2, 94);
    ctx.restore();
  }
}

export function updateStats() {
  // Show "Replaying run…" next to the backtrack button ONLY while a ghost replay is
  // actively playing (not once finished, not in live modes).
  const repEl = document.getElementById("backtrack_replaying");
  if (repEl) repEl.style.display = (S.ghostPoses && !S.ghostDone) ? "inline" : "none";
  // Ghost replay: no live players — show the recorded run's live score instead.
  if (S.ghostPoses && S.ghostPoses.length) {
    const gp = S.ghostPoses[Math.max(0, Math.min(S.ghostIdx, S.ghostPoses.length - 1))];
    const distPx = Math.round(gp.chassis.x * SCALE - SPAWN_X);
    const hud = document.getElementById("hud_ai");
    hud.style.display = "inline";
    document.getElementById("dist_ai").textContent = distPx;
    document.getElementById("hud_hum").style.display = "none";
    document.getElementById("tick").textContent =
      `${Math.max(0, S.ghostIdx + 1)}/${S.ghostPoses.length}`;
    return;
  }
  // Human-vs-Human draws its per-side score on the canvas (see _drawViewport), so hide
  // the single-line DOM HUD to avoid showing only one of the two.
  if (modeDef(S.mode).split) {
    document.getElementById("hud_ai").style.display = "none";
    document.getElementById("hud_hum").style.display = "none";
    document.getElementById("tick").textContent = S.tickCount;
    return;
  }
  // Find AI + human players in the current array (either may be absent).
  let ai = null, hum = null;
  for (let pi = 0; pi < S.players.length; pi++) {
    if (S.players[pi].isAI) ai = S.players[pi]; else hum = S.players[pi];
  }
  function fill(prefix, p, hudId) {
    const hud = document.getElementById(hudId);
    if (p === null) { hud.style.display = "none"; return; }
    hud.style.display = "inline";
    const distPx = Math.round(p.maxDistPx - SPAWN_X);
    document.getElementById(`dist_${prefix}`).textContent = distPx;
  }
  fill("ai", ai, "hud_ai");
  fill("hum", hum, "hud_hum");
  document.getElementById("tick").textContent = S.tickCount;
}
