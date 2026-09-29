// Cosmetic effects: wheel dust (world space), screen shake, and confetti (screen
// space). Advanced from render() with wall-clock dt so they never touch the physics.
import { S, SCALE, CANVAS_HEIGHT } from "./state.js";

const dust = [];
const confetti = [];
let shakeT = 0, shakeMag = 0;
const MAX_DUST = 260;

// Emit dust behind every grounded, powered wheel of a live car.
export function emitDust(p, dt) {
  const car = p.car;
  if (!car || p.dead || !car.motorState) return;
  const v = car.chassisBody.GetLinearVelocity();
  const speed = Math.hypot(v.x, v.y);
  for (const w of car.wheels) {
    if (w.onGround !== true) continue;
    const c = w.body.GetPosition();
    const rate = 18 + speed * 4;                 // particles per second
    let n = rate * dt;
    while (n > 0 && dust.length < MAX_DUST) {
      if (n < 1 && Math.random() > n) break;
      n -= 1;
      const dir = -car.motorState;               // kicked opposite the drive direction
      dust.push({
        x: c.x * SCALE + (Math.random() - 0.5) * 10,
        y: c.y * SCALE + w.radius * 0.8,
        vx: dir * (30 + Math.random() * 60) + v.x * SCALE * 0.2,
        vy: -(20 + Math.random() * 50),
        r: 3 + Math.random() * 4, life: 0, max: 0.5 + Math.random() * 0.5,
      });
    }
  }
}

export function shake(mag, dur) { shakeMag = Math.max(shakeMag, mag); shakeT = Math.max(shakeT, dur); }
export function shakeOffset() {
  if (shakeT <= 0) return [0, 0];
  const m = shakeMag * Math.min(1, shakeT * 4);
  return [(Math.random() - 0.5) * 2 * m, (Math.random() - 0.5) * 2 * m];
}

const CONF_COLORS = ["#ff5a5a", "#ffc933", "#5cd65c", "#4fb3ff", "#c77dff", "#ff8fd1"];
export function burstConfetti(width) {
  for (let i = 0; i < 180; i++) {
    confetti.push({
      x: Math.random() * width, y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 120, vy: 60 + Math.random() * 160,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 10,
      w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
      c: CONF_COLORS[i % CONF_COLORS.length], life: 0, max: 3.5 + Math.random() * 1.5,
    });
  }
}

export function stepFx(dt) {
  shakeT = Math.max(0, shakeT - dt);
  if (shakeT === 0) shakeMag = 0;
  for (let i = dust.length - 1; i >= 0; i--) {
    const d = dust[i];
    d.life += dt;
    if (d.life >= d.max) { dust.splice(i, 1); continue; }
    d.x += d.vx * dt; d.y += d.vy * dt;
    d.vy += 90 * dt; d.vx *= 0.96; d.r += 8 * dt;
  }
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.life += dt;
    if (c.life >= c.max || c.y > CANVAS_HEIGHT + 30) { confetti.splice(i, 1); continue; }
    c.x += (c.vx + Math.sin(c.life * 3 + c.rot) * 40) * dt;
    c.y += c.vy * dt; c.rot += c.vr * dt;
  }
}

export function clearFx() { dust.length = 0; confetti.length = 0; shakeT = 0; }

export function drawDust(ctx) {
  for (const d of dust) {
    const a = 0.45 * (1 - d.life / d.max);
    ctx.fillStyle = `rgba(150,110,70,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(d.x - S.cameraPanX, d.y - S.cameraPanY, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawConfetti(ctx) {
  for (const c of confetti) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, (c.max - c.life) * 2);
    ctx.translate(c.x, c.y); ctx.rotate(c.rot);
    ctx.fillStyle = c.c;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h * Math.abs(Math.cos(c.life * 6 + c.rot)));
    ctx.restore();
  }
}
