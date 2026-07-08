// Bridge from classic-script globals into ES-module scope.
//
// The physics classes (Car/Wheel/Person/Ground), the Box2D handles, the p5 noise
// seeder, and the AI-policy factory are all declared in classic <script>s. They
// have to stay classic: the SAME physics files are loaded verbatim into V8 for
// training (python/js_backend.py) and by legacy_neat/, neither of which has an ES
// module loader or a `window`. Top-level `class`/`const` in a classic script live
// in the global LEXICAL environment, invisible to module scope, so index.html
// publishes exactly what the app needs onto `window.HCR` in a one-line classic
// shim (right after the physics scripts). We re-export it here as normal module
// bindings. (See CONVENTIONS.md #4 / CLAUDE.md gotcha #4.)
var H = window.HCR || {};

export var Car = H.Car;
export var Ground = H.Ground;
export var Box2D = H.Box2D;
export var Vec2 = H.Vec2;
export var b2World = H.b2World;
export var b2StaticBody = H.b2StaticBody;
export var perlinSeed = H.perlinSeed;   // p5-noise permutation seeder (_perlinSeed)
export var AiPolicy = H.AiPolicy;        // { PpoOnnxAgent, ConstantForwardAgent, ACT }

// `spawningY` and `grassSprites` are genuinely shared with the physics layer:
// Ground.randomizeGround() WRITES spawningY and READS grassSprites as globals, and
// the game logic reads/writes spawningY too. They must stay `window` globals; these
// accessors make the cross-boundary access explicit (a bare `spawningY = x` in a
// module would silently create a module-local, not touch the global the classes see).
export function getSpawningY() { return window.spawningY; }
export function setSpawningY(v) { window.spawningY = v; }
export function setGrassSprites(v) { window.grassSprites = v; }
