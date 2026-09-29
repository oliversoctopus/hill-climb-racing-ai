// Personal records (human runs only), persisted in localStorage: best score and fastest
// finish time, per map and across all maps. A map is identified by a hash of its
// geometry, so the same terrain matches whether it was generated, re-loaded from the
// session list, or loaded from Saved. Runs that used a cheat (or slow-mo) are "tainted":
// they never count toward the clean records, only toward a second "incl. cheats" track
// (m.all) — the best of ALL runs, each value flagged with whether a cheated run set it.
// A clean run that beats that track updates it too; a cheated run never touches the
// clean one. The UI shows the second track behind a "Show cheat records" checkbox.
//
// Each map with a record gets a permanent sequential `id` (in the order maps first set a
// record) and a stored copy of its terrain, so it can be re-loaded from the Records menu.
// No names are stored: the label is resolved at display time — the map's current Saved
// name if it's saved, else "Record map <id>". The all-maps bests are derived from the
// per-map entries, so deleting a record map can't leave a stale global.
import { S, SCALE, FRAME_RATE } from "./state.js";
import { getSpawningY, Vec2 } from "./bridge.js";
import { loadSavedTerrains } from "./saved_terrains.js";

const KEY = "hcr_records_v1";
const MAPS_KEY = "hcr_record_maps_v1";   // key → stored terrain (kept apart: it's the bulky part)

function _load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "null");
    if (d && d.version === 1 && d.maps) {
      if (d.nextId == null) {   // blob from before ids: number maps in stored order
        let id = 1;
        for (const k of Object.keys(d.maps)) { d.maps[k].id = id++; delete d.maps[k].name; }
        d.nextId = id;
      }
      delete d.global;           // now derived (see _global)
      for (const m of Object.values(d.maps)) if (!m.all) m.all = _cleanAll(m);   // pre-cheat-track blob
      return d;
    }
  } catch (e) { /* corrupt or storage blocked → start fresh */ }
  return { version: 1, nextId: 1, maps: {} };
}
// The incl.-cheats track, seeded from a map's clean bests.
function _cleanAll(m) {
  return { score: m.bestScore, scoreCheated: false, scoreParts: m.bestScoreParts || null,
           time: m.bestTime, timeCheated: false };
}
function _save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }

// Best score / fastest finish over all maps, with the key of the map holding each.
function _global(d) {
  const g = { bestScore: 0, bestScoreKey: "", bestTime: null, bestTimeKey: "" };
  for (const [k, m] of Object.entries(d.maps)) {
    if (m.bestScore > g.bestScore) { g.bestScore = m.bestScore; g.bestScoreKey = k; }
    if (m.bestTime != null && (g.bestTime == null || m.bestTime < g.bestTime)) { g.bestTime = m.bestTime; g.bestTimeKey = k; }
  }
  return g;
}
// Same over the incl.-cheats track (+ whether each winning value was a cheated run).
function _globalAll(d) {
  const g = { score: 0, scoreKey: "", scoreCheated: false, time: null, timeKey: "", timeCheated: false };
  for (const [k, m] of Object.entries(d.maps)) {
    const a = m.all;
    if (a.score > g.score) { g.score = a.score; g.scoreKey = k; g.scoreCheated = a.scoreCheated; }
    if (a.time != null && (g.time == null || a.time < g.time)) { g.time = a.time; g.timeKey = k; g.timeCheated = a.timeCheated; }
  }
  return g;
}

// ---- "Show cheat records" setting (shared by the Records menu and the end card) ----
const SHOW_KEY = "hcr_show_cheat_records";
let _show = null;
export function showCheatRecords() {
  if (_show === null) { try { _show = localStorage.getItem(SHOW_KEY) === "1"; } catch (e) { _show = false; } }
  return _show;
}
export function setShowCheatRecords(on) {
  _show = !!on;
  try { localStorage.setItem(SHOW_KEY, _show ? "1" : "0"); } catch (e) {}
  refreshRecordsStrip();   // labels of cheat-only maps appear/disappear
  document.dispatchEvent(new Event("hcr-cheat-records-toggled"));
}

// ---- Map identity ------------------------------------------------------------
// FNV-1a over the px vertices rounded to 0.1 px (absorbs the px↔m save/load round trip).
function _hashVerts(pxVerts, spawningY) {
  let h = 0x811c9dc5;
  const mix = n => { h ^= n & 0xffff; h = Math.imul(h, 0x01000193); h ^= n >>> 16; h = Math.imul(h, 0x01000193); };
  for (const [x, y] of pxVerts) { mix(Math.round(x * 10)); mix(Math.round(y * 10)); }
  mix(Math.round(spawningY * 10));
  return (h >>> 0).toString(36);
}
export function mapKeyOf(ground) {
  return _hashVerts(ground.vectors.map(v => [v.x * SCALE, v.y * SCALE]), getSpawningY());
}

// ---- Stored terrains -----------------------------------------------------------
// Vertices are kept exactly (meters, as Float64 → base64, ~14 KB/map) with the grass
// layout, so a re-loaded record map is bit-identical to the one the record was set on.
// A freshly generated map's x's are exactly k*smoothness/SCALE (+ the 2 closing verts),
// so they're only stored when they don't match that (e.g. a px-round-tripped map).
function _f64ToB64(arr) {
  const u8 = new Uint8Array(new Float64Array(arr).buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function _b64ToF64(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return Array.from(new Float64Array(u8.buffer));
}
function _loadMaps() {
  try { return JSON.parse(localStorage.getItem(MAPS_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function _saveMaps(all) {
  try { localStorage.setItem(MAPS_KEY, JSON.stringify(all)); return true; } catch (e) { return false; }
}
function _regularXs(g, n) {
  const xs = [];
  for (let k = 0; k < n - 2; k++) xs.push((k * g.smoothness) / SCALE);
  xs.push(g.distance / SCALE, 0 / SCALE);
  return xs;
}
function _storeCurrentMap(key) {
  const all = _loadMaps();
  if (all[key]) return true;
  const g = S.ground, n = g.vectors.length;
  const reg = _regularXs(g, n);
  const regular = g.vectors.every((v, i) => v.x === reg[i]);
  all[key] = {
    n, smoothness: g.smoothness, distance: g.distance,
    xs: regular ? null : _f64ToB64(g.vectors.map(v => v.x)),
    ys: _f64ToB64(g.vectors.map(v => v.y)),
    grass: g.grassPositions.map(x => (x < 0 ? "." : String(x))).join(""),   // sprite idx 0-4, "." = none
    spawning_y: getSpawningY(),
    tuned: !!g.tuned,   // a physics-playground map: runs on it stay "cheated" when re-loaded
  };
  return _saveMaps(all);   // false = storage full; the record still counts, just can't be re-loaded
}
// A Ground.cloneFrom() source for a record map, or null if its terrain wasn't stored.
export function recordMapSource(key) {
  const t = _loadMaps()[key];
  if (!t) return null;
  try {
    const ys = _b64ToF64(t.ys);
    const xs = t.xs ? _b64ToF64(t.xs) : _regularXs(t, t.n);
    const grass = Array.from(t.grass, c => (c === "." ? -1 : Number(c)));
    return { vectors: xs.map((x, i) => new Vec2(x, ys[i])), grassPositions: grass,
             spawning_y: t.spawning_y, tuned: !!t.tuned };
  } catch (e) { return null; }
}
export function deleteRecordMap(key) {
  const d = _load();
  delete d.maps[key];
  _save(d);
  const all = _loadMaps();
  delete all[key];
  _saveMaps(all);
  refreshRecordsStrip();
}

// ---- Labels --------------------------------------------------------------------
function _savedNames() {
  const out = {};
  for (const t of loadSavedTerrains()) {
    try { out[_hashVerts(t.vertices, t.spawning_y)] = t.name; } catch (e) {}
  }
  return out;
}
function _label(d, key, saved) {
  const m = key && d.maps[key];
  if (!m) return "";
  // A map holding only cheated records stays anonymous while those are hidden.
  if (!(m.bestScore > 0 || m.bestTime != null) && !showCheatRecords()) return "";
  return saved[key] || `Record map ${m.id}`;
}
export function recordMapLabel(key) { return _label(_load(), key, _savedNames()); }

// Every record map for the Records menu, oldest id first. `clean` = has a clean record
// (a map can hold only cheated ones); `all` = its incl.-cheats track.
export function listRecordMaps() {
  const d = _load(), saved = _savedNames(), stored = _loadMaps(), g = _global(d), ga = _globalAll(d);
  return Object.entries(d.maps)
    .map(([key, m]) => ({ key, id: m.id, label: _label(d, key, saved), bestScore: m.bestScore,
                          bestScoreParts: m.bestScoreParts || null,
                          bestTime: m.bestTime, loadable: !!stored[key],
                          clean: m.bestScore > 0 || m.bestTime != null, all: m.all,
                          globalScore: key === g.bestScoreKey, globalTime: key === g.bestTimeKey,
                          globalAllScore: key === ga.scoreKey, globalAllTime: key === ga.timeKey }))
    .sort((a, b) => a.id - b.id);
}

export function mapRecord(key) {
  const m = _load().maps[key];
  return { bestScore: m ? m.bestScore : 0, bestTime: m ? m.bestTime : null };
}
export function globalRecord() { return _global(_load()); }
export function mapRecordAll(key) {
  const m = _load().maps[key];
  return m ? m.all : { score: 0, scoreCheated: false, time: null, timeCheated: false };
}
export function globalRecordAll() { return _globalAll(_load()); }

// ---- Runs ----------------------------------------------------------------------
// Seconds a player has been driving: frozen at the finish, or at death.
export function runSeconds(p) {
  const t = p.beatTick || p.deadTick || S.tickCount;
  return t / FRAME_RATE;
}
export function fmtTime(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

// Anything that makes a run easier than a straight drive.
export function cheatsActive() {
  return S.bpInvincible || S.bpZeroG || S.bpFlight || S.bpRocket || S.simSpeed < 1 || S.bpPhysModified
      || !!(S.ground && S.ground.tuned);   // a playground-generated map (flat/short/...)
}

// Fold a human player's run into the stored records. Idempotent (max/min), so it's safe
// to call on finish, on death, and again when the run is abandoned. New-record flags
// are OR-ed onto p.newRec for the end card (clean: mapScore/globalScore/...; incl.-cheats
// track: allMapScore/allGlobalScore/...). A map only gets an entry (id + stored terrain)
// once a run actually sets something on it. `parts` (sim.scoreParts: to finish / fly-off /
// after fly-off, or null if unfinished) is stored with each score record it sets.
export function commitRun(p, score, parts) {
  if (!p || p.isAI || !S.mapKey) return;
  const cheated = S.runTainted;
  const time = p.beatTick ? p.beatTick / FRAME_RATE : null;
  const d = _load();
  const g = _global(d), ga = _globalAll(d);
  const prev = d.maps[S.mapKey] || { bestScore: 0, bestTime: null, all: _cleanAll({ bestScore: 0, bestTime: null }) };
  const betterScore = !cheated && score > prev.bestScore;
  const betterTime = !cheated && time != null && (prev.bestTime == null || time < prev.bestTime);
  const allScore = score > prev.all.score;
  const allTime = time != null && (prev.all.time == null || time < prev.all.time);
  if (!betterScore && !betterTime && !allScore && !allTime) return;
  if (!d.maps[S.mapKey]) {
    d.maps[S.mapKey] = { id: d.nextId++, bestScore: 0, bestTime: null, all: prev.all };
    _storeCurrentMap(S.mapKey);
  }
  const m = d.maps[S.mapKey];
  const nr = p.newRec || (p.newRec = {});
  nr.cheated = cheated;
  if (betterScore) { m.bestScore = score; m.bestScoreParts = parts || null; nr.mapScore = true; }
  if (betterTime) { m.bestTime = time; nr.mapTime = true; }
  if (betterScore && score > g.bestScore) nr.globalScore = true;
  if (betterTime && (g.bestTime == null || time < g.bestTime)) nr.globalTime = true;
  if (allScore) { m.all.score = score; m.all.scoreCheated = cheated; m.all.scoreParts = parts || null; nr.allMapScore = true; }
  if (allTime) { m.all.time = time; m.all.timeCheated = cheated; nr.allMapTime = true; }
  if (allScore && score > ga.score) nr.allGlobalScore = true;
  if (allTime && (ga.time == null || time < ga.time)) nr.allGlobalTime = true;
  _save(d);
  refreshRecordsStrip();
}

// The four tiles under the toolbar. Re-run after the Saved list changes so labels follow
// saves, renames and deletes.
export function refreshRecordsStrip() {
  const d = _load();
  const saved = _savedNames();
  const mr = (S.mapKey && d.maps[S.mapKey]) || { bestScore: 0, bestTime: null };
  const g = _global(d);
  const set = (id, v, sub) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector(".rec-val").textContent = v;
    const s = el.querySelector(".rec-sub");
    if (s) { s.textContent = sub; s.title = sub; }
  };
  const here = _label(d, S.mapKey, saved);
  const hereSfx = here ? ` (${here})` : "";
  set("rec_map_score", mr.bestScore || "—", `best score · this map${hereSfx}`);
  set("rec_map_time",  fmtTime(mr.bestTime), `fastest finish · this map${hereSfx}`);
  const sl = _label(d, g.bestScoreKey, saved), tl = _label(d, g.bestTimeKey, saved);
  set("rec_all_score", g.bestScore || "—", `best score · all maps${sl ? ` (${sl})` : ""}`);
  set("rec_all_time",  fmtTime(g.bestTime), `fastest finish · all maps${tl ? ` (${tl})` : ""}`);
  // Labels may have changed (new record map, save/rename/delete) — main.js refreshes the
  // Map chip on this (an event, since sim.js already imports this module).
  document.dispatchEvent(new Event("hcr-records-changed"));
}
