// Persistence for user-named terrains in the browser's localStorage. Pure storage —
// no DOM, no sim; just the JSON blob under one versioned key. The menu UI (render,
// prompt, confirm) lives in main.js.
//
// Blob shape: { version: 1, terrains: [{ name, vertices, spawning_y }] }, with vertices
// in PIXELS ([[x, y], ...]) — the same loadedTrack format the session terrains use, so a
// saved map re-loads through the normal pinned-track path (sim.makeSourceFromTrack).
// It's keyed to the page origin, so saved maps survive close/reopen and redeploys, but
// only on the same browser + domain (see HOW_TO_PLAY). The `version` field lets a future
// format change detect and skip stale blobs instead of choking on them.
const KEY = "hcr_saved_terrains_v1";

export function loadSavedTerrains() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (data && data.version === 1 && Array.isArray(data.terrains)) return data.terrains;
  } catch (e) { /* corrupt JSON or storage unavailable → treat as empty */ }
  return [];
}

// Write the whole list back. Returns true on success, false if storage rejected it
// (quota exceeded, or disabled e.g. private mode) so callers can surface a message.
function _write(terrains) {
  try { localStorage.setItem(KEY, JSON.stringify({ version: 1, terrains })); return true; }
  catch (e) { return false; }
}

// Append one terrain. Returns the updated array on success, or null if the write failed.
export function addSavedTerrain(terrain) {
  const all = loadSavedTerrains();
  all.push(terrain);
  return _write(all) ? all : null;
}

// Remove the terrain at `index`. Returns the updated array (unchanged if out of range).
export function removeSavedTerrain(index) {
  const all = loadSavedTerrains();
  if (index < 0 || index >= all.length) return all;
  all.splice(index, 1);
  _write(all);
  return all;
}
