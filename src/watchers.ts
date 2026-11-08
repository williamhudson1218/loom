// Watchers moved to src/watchers/ (model, engine, sources, actions, templates).
// This shim keeps the old import path working for the few callers that used it.
export { launchCommand, pickPane, renderBrief, tmuxLaunch } from './watchers/actions.ts';
export { getWatcher, listWatchers, setWatcherEnabled } from './watchers/model.ts';
export { BRIEFS_DIR, TICK_MS, WATCHERS_DIR, isDryRun, startWatcherTicks } from './watchers/engine.ts';
