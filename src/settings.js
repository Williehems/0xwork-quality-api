// Runtime settings layer. Sits between static config.js (env vars, immutable) and the
// rest of the app. Values loaded from the `runtime_settings` DB table override env-var
// defaults without requiring a redeploy.
//
// Hot-path reads (rate limits, bypass) hit only the in-memory Map — no DB round-trips.
// Writes go to DB first, then update the cache, so a DB failure never corrupts the cache.
//
// Graceful degradation: if DATABASE_URL is unset or the DB is unreachable at startup,
// loadSettings() logs a warning and the cache stays empty. All get*() calls fall through
// to their fallback values, so the app works exactly as it did before this module existed.

import { getRuntimeSettings, setRuntimeSetting } from "../db/index.js";

const _cache = new Map();
let _dbAvailable = false;

export async function loadSettings() {
  try {
    const rows = await getRuntimeSettings();
    for (const [k, v] of Object.entries(rows)) _cache.set(k, v);
    _dbAvailable = true;
    console.log(`[settings] loaded ${_cache.size} runtime setting(s) from DB`);
  } catch (err) {
    console.warn("[settings] DB unavailable — using env-var defaults only:", err.message);
  }
}

export function isDbAvailable() { return _dbAvailable; }

/** Returns the raw string value for key, or fallback if not set. */
export function get(key, fallback = undefined) {
  const v = _cache.get(key);
  return v !== undefined ? v : fallback;
}

export function getBool(key, fallback = false) {
  const v = _cache.get(key);
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export function getNum(key, fallback = 0) {
  const v = _cache.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Persists key=value to DB and updates in-memory cache. */
export async function set(key, value) {
  await setRuntimeSetting(key, value);  // throws on DB error — caller handles
  _cache.set(key, String(value));
}

/** Returns all current effective values (DB overrides only — fallbacks not included). */
export function getAll() {
  return Object.fromEntries(_cache);
}
