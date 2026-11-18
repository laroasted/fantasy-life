// Default placeholder — overwritten at build time by
// scripts/build-preload-snapshot.js with a real season snapshot. If that
// script ever fails or hasn't run (e.g. local `npm start`), this null is
// what src/utils/storage.js's readPreloadedSeason() sees, and the app falls
// back to its pre-existing behavior (localStorage cache, then a live fetch).
window.__PRELOADED_SEASON__ = null;
window.__PRELOADED_SEASON_GENERATED_AT__ = null;
