/**
 * AI policy interface for ai_play.html.
 *
 * Contract every agent implements:
 *   async init()      Load model / allocate resources. Called once.
 *   reset()           Clear per-episode state. Called at every terrain reset.
 *   async act(ctx)    ctx = { car, ground, scale }. Returns one of:
 *                       0 = motor forward
 *                       1 = motor reverse
 *                       2 = motor off
 *
 * Adding a new agent (different obs, different model, different action enum,
 * etc.) means writing a new class here and changing one line in ai_play.html
 * (`new PpoOnnxAgent(...)` → `new MyNewAgent(...)`). No edits to the sim/render
 * code required.
 *
 * ctx.car points at the JS Car instance (Car.js). ctx.ground points at the
 * Ground instance (Ground.js). ctx.scale is the pixels-per-meter conversion.
 * Agents extract whatever they need from those.
 */
(function(global) {
  "use strict";

  // ----- Action enum (shared across agents) -----
  var ACT = { FORWARD: 0, REVERSE: 1, OFF: 2 };

  // ----- Constants matching python/env.py for the PPO obs format ----
  // The current ai_policy.onnx is ppo_p5_combo_a — trained with per_wheel_obs=True
  // (12-dim obs: angle + rear_grounded + front_grounded + 3 vel + 6 ground samples)
  // and reward_shaping=True on the p5-noise terrain distribution.
  var PPO_PER_WHEEL          = true;
  // Rear ground samples (python/env.py GROUND_REAR_N/SKIP). Set to 0 to load a
  // model trained BEFORE rearward vision was added. Must match the checkpoint.
  // Reverse-curriculum models are trained with GROUND_REAR_N=0 (clean 12-dim
  // A/B vs the champion), so this is 0 to match them at deploy.
  var PPO_REAR_N             = 0;
  var PPO_REAR_SKIP          = 5;
  var PPO_N_OBS              = (PPO_PER_WHEEL ? 12 : 11) + PPO_REAR_N;
  var PPO_N_STACK            = 4;
  var PPO_COYOTE_FRAMES      = 10;
  var PPO_LOOKAHEAD_N        = 6;
  var PPO_LOOKAHEAD_SKIP     = 5;
  var PPO_CHASSIS_HEIGHT_PX  = 40;          // matches Car.js chassisHeight + python/constants.py
  var PPO_CLEARANCE_MIN      = -3.0;
  var PPO_CLEARANCE_MAX      = 10.0;
  var PPO_CLEARANCE_CENTER   = (PPO_CLEARANCE_MAX + PPO_CLEARANCE_MIN) / 2;  // 3.5
  var PPO_CLEARANCE_HALF     = (PPO_CLEARANCE_MAX - PPO_CLEARANCE_MIN) / 2;  // 6.5

  /**
   * SB3 PPO policy exported to ONNX via python/export_onnx.py.
   *
   * Encapsulates:
   *   - ONNX Runtime Web session loading (one session per instance, but ORT
   *     internally shares the WASM module across sessions so memory is fine
   *     for 1-2 AI players).
   *   - The exact obs construction from python/env.py (angle wrap + coyote
   *     groundedness + velocity normalizations + 6 ground-clearance samples).
   *   - A 4-deep frame stack matching SB3's VecFrameStack (oldest first,
   *     newest last; pre-filled on reset).
   *   - Argmax over action logits.
   *
   * Per-episode state (frame stack, coyote counter) is reset via reset().
   * The session itself persists across resets — it's expensive to reload.
   */
  function PpoOnnxAgent(modelPath) {
    this.modelPath = modelPath;
    this.session = null;
    // Coyote counters — one per wheel when PPO_PER_WHEEL; both used for
    // backward compat (single-bit mode reuses _lastGroundedRear).
    this._lastGroundedRear  = 0;
    this._lastGroundedFront = 0;
    this._frameStack = [];
    this._obsScratch = new Float32Array(PPO_N_OBS);
    this._stackedScratch = new Float32Array(PPO_N_OBS * PPO_N_STACK);
  }

  PpoOnnxAgent.prototype.init = async function() {
    if (typeof ort === "undefined") {
      throw new Error("ONNX Runtime Web (ort.min.js) not loaded before agent init");
    }
    // Single-threaded WASM; SIMD if available. Threading needs cross-origin
    // isolation HTTP headers which our static server doesn't set.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ["wasm"],
    });
  };

  PpoOnnxAgent.prototype.reset = function() {
    this._lastGroundedRear = 0;
    this._lastGroundedFront = 0;
    this._frameStack = [];
  };

  // Snapshot / restore the agent's resumable per-episode state (frame stack +
  // coyote counters). Used by the in-browser backtracking ("save-scum") search so
  // the policy resumes with the EXACT obs history it had at a rewind point — the
  // browser analogue of python/autorun/backtrack_search.py snapshotting the
  // VecFrameStack + env coyote counters. Deep-copies the frame buffers.
  PpoOnnxAgent.prototype.snapshotState = function() {
    var fs = [];
    for (var i = 0; i < this._frameStack.length; i++) fs.push(new Float32Array(this._frameStack[i]));
    return { lgr: this._lastGroundedRear, lgf: this._lastGroundedFront, fs: fs };
  };
  PpoOnnxAgent.prototype.restoreState = function(s) {
    this._lastGroundedRear = s.lgr;
    this._lastGroundedFront = s.lgf;
    this._frameStack = [];
    for (var i = 0; i < s.fs.length; i++) this._frameStack.push(new Float32Array(s.fs[i]));
  };

  PpoOnnxAgent.prototype.act = async function(ctx) {
    var obs = this._buildObs(ctx);
    this._pushFrame(obs);
    var stacked = this._buildStacked();
    var result = await this.session.run({
      observation: new ort.Tensor("float32", stacked, [1, PPO_N_OBS * PPO_N_STACK]),
    });
    var logits = result.action_logits.data;   // Float32Array(3)
    var a = ACT.FORWARD;
    if (logits[ACT.REVERSE] > logits[a]) a = ACT.REVERSE;
    if (logits[ACT.OFF]     > logits[a]) a = ACT.OFF;
    return a;
  };

  // -------- Internal helpers --------

  // Build the obs vector. Must match python/env.py._build_obs EXACTLY for the
  // policy to see in-distribution input. Shape depends on PPO_PER_WHEEL:
  //   - false: 11-dim, single grounded bit
  //   - true:  12-dim, separate rear + front grounded bits
  PpoOnnxAgent.prototype._buildObs = function(ctx) {
    var car = ctx.car, ground = ctx.ground, SCALE = ctx.scale;
    var c = car.chassisBody;
    var p = c.GetPosition();
    var v = c.GetLinearVelocity();
    var angle = c.GetAngle();
    var angVel = c.GetAngularVelocity();
    // wheels[0] = rear (left at spawn), wheels[1] = front (right at spawn).
    var rearGround  = (car.wheels[0].onGround === true);
    var frontGround = (car.wheels[1].onGround === true);
    var obs = this._obsScratch;
    var idx = 0;

    // [0] chassis angle, wrapped through (a+PI) mod 2*PI -> [0, 1]
    var aa = angle;
    while (aa < 0) aa += 2 * Math.PI;
    aa = (aa + Math.PI) % (2 * Math.PI);
    obs[idx++] = aa / (2 * Math.PI);

    // Groundedness with 10-frame coyote: persist "grounded=1" for 10 ticks after liftoff.
    if (PPO_PER_WHEEL) {
      this._lastGroundedRear += 1;
      if (rearGround) this._lastGroundedRear = 0;
      obs[idx++] = (this._lastGroundedRear < PPO_COYOTE_FRAMES) ? 1.0 : 0.0;
      this._lastGroundedFront += 1;
      if (frontGround) this._lastGroundedFront = 0;
      obs[idx++] = (this._lastGroundedFront < PPO_COYOTE_FRAMES) ? 1.0 : 0.0;
    } else {
      this._lastGroundedRear += 1;
      if (rearGround || frontGround) {
        this._lastGroundedRear = 0;
        obs[idx++] = 1.0;
      } else {
        obs[idx++] = (this._lastGroundedRear < PPO_COYOTE_FRAMES) ? 1.0 : 0.0;
      }
    }

    // angular velocity, /4 clipped
    obs[idx++] = Math.max(-1, Math.min(1, angVel / 4));
    // linear velocity, per-axis normalized + clipped
    obs[idx++] = Math.max(-1, Math.min(1, v.x / 17));
    obs[idx++] = Math.max(-1, Math.min(1, v.y / 12));

    // 6 ground-clearance samples ahead of chassis_x, normalized.
    var chassisBottomYm = p.y + PPO_CHASSIS_HEIGHT_PX / SCALE;
    var samplesM = ground.getPositions(p.x, PPO_LOOKAHEAD_N, PPO_LOOKAHEAD_SKIP);
    for (var i = 0; i < PPO_LOOKAHEAD_N; i++) {
      var posYm = (i < samplesM.length) ? samplesM[i] : samplesM[samplesM.length - 1];
      var cc = posYm - chassisBottomYm;
      if (cc < PPO_CLEARANCE_MIN) cc = PPO_CLEARANCE_MIN;
      if (cc > PPO_CLEARANCE_MAX) cc = PPO_CLEARANCE_MAX;
      obs[idx++] = (cc - PPO_CLEARANCE_CENTER) / PPO_CLEARANCE_HALF;
    }

    // Rear ground-clearance samples (chassis_x - 75/-150/-225 px), normalized
    // the same way. Mirrors js_backend.getRear + python/env.py: walk backward
    // from the first vertex at/after chassis_x. Ground.js vectors are in meters.
    if (PPO_REAR_N > 0) {
      var rearM = this._getRear(ground, p.x, PPO_REAR_N, PPO_REAR_SKIP);
      for (var k = 0; k < PPO_REAR_N; k++) {
        var ry = (k < rearM.length) ? rearM[k] : rearM[rearM.length - 1];
        var rc = ry - chassisBottomYm;
        if (rc < PPO_CLEARANCE_MIN) rc = PPO_CLEARANCE_MIN;
        if (rc > PPO_CLEARANCE_MAX) rc = PPO_CLEARANCE_MAX;
        obs[idx++] = (rc - PPO_CLEARANCE_CENTER) / PPO_CLEARANCE_HALF;
      }
    }
    return obs;
  };

  // Backward counterpart to Ground.getPositions: n ground y-values (meters)
  // behind x at -skip, -2*skip, ... vertices (closest-behind first).
  PpoOnnxAgent.prototype._getRear = function(ground, x, n, skip) {
    var vs = ground.vectors;
    var idx = -1;
    for (var i = 0; i < vs.length; i++) {
      if (vs[i].x >= x) { idx = i; break; }
    }
    if (idx < 0) idx = vs.length - 1;
    var out = [];
    for (var k = 1; k <= n; k++) {
      var j = idx - k * skip;
      if (j < 0) j = 0;
      out.push(vs[j].y);   // meters, matches getPositions
    }
    return out;
  };

  // Push the new obs into a 4-frame stack matching SB3's VecFrameStack:
  // oldest first, newest last. On reset, pre-fill with the first observation.
  PpoOnnxAgent.prototype._pushFrame = function(obs) {
    if (this._frameStack.length === 0) {
      // Note: we push a COPY because _obsScratch is reused next tick. Without
      // copying, all 4 stack slots would alias the same buffer and update
      // together — the policy would only ever see one frame of history.
      var copy = new Float32Array(obs);
      for (var i = 0; i < PPO_N_STACK; i++) this._frameStack.push(new Float32Array(copy));
    } else {
      this._frameStack.shift();
      this._frameStack.push(new Float32Array(obs));
    }
  };

  PpoOnnxAgent.prototype._buildStacked = function() {
    var out = this._stackedScratch;
    for (var i = 0; i < PPO_N_STACK; i++) {
      out.set(this._frameStack[i], i * PPO_N_OBS);
    }
    return out;
  };

  // ----- Example: stub agent for testing without ONNX -----
  // Drives forward constantly. Useful for verifying the env loop works
  // without a model loaded.
  function ConstantForwardAgent() {}
  ConstantForwardAgent.prototype.init = async function() {};
  ConstantForwardAgent.prototype.reset = function() {};
  ConstantForwardAgent.prototype.act = async function(ctx) { return ACT.FORWARD; };

  // ----- Exports -----
  global.AiPolicy = {
    ACT: ACT,
    PpoOnnxAgent: PpoOnnxAgent,
    ConstantForwardAgent: ConstantForwardAgent,
  };
})(window);
