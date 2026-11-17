import type { Layout } from './snapshot.ts';
import { isViewSession } from './tmux.ts';

// Automatic workspace restore. The snapshot (layout.json) only ever holds what was
// running: closing a session drops it from the next snapshot, and an empty tmux
// never overwrites it (writeLayout). So a saved session that is not running means
// the workspace went away without being closed one by one: a reboot, a quit, or a
// tmux server crash. Loom brings it back on its own; the Restore sessions menu item
// stays as the manual fallback.

export type AutoRestoreMode = 'startup' | 'running';

/** One automatic restore, shown once on the page as a toast. */
export interface AutoRestoreEvent {
  at: number;
  ok: boolean;
  restored: string[];
  detail: string;
}

/** A second automatic restore inside this window is held: something is killing the sessions again, so don't loop. */
export const AUTO_RESTORE_COOLDOWN_MS = 5 * 60_000;

/**
 * The saved sessions to bring back.
 * startup: every saved session that is not running (after a reboot or a quit, some or all are gone).
 * running: only when no workspace session is running at all, which is the tmux server dying. One
 *   session missing while others run is someone closing it; the next snapshot drops it.
 */
export function sessionsToRestore(layout: Layout | null, running: Set<string>, mode: AutoRestoreMode, prefix: string): string[] {
  if (!layout) return [];
  // Loom's own terminal-view sessions share the prefix but are not workspace sessions.
  const mine = (n: string): boolean => n.startsWith(prefix) && !isViewSession(n);
  const saved = layout.sessions.map((s) => s.name).filter(mine);
  if (mode === 'running' && [...running].some(mine)) return [];
  return saved.filter((n) => !running.has(n));
}

/** go: restore now. held: one ran inside the cooldown, so wait for a person (the menu item). */
export function autoRestoreGate(missing: string[], lastAt: number, now: number): 'none' | 'go' | 'held' {
  if (!missing.length) return 'none';
  return lastAt && now - lastAt < AUTO_RESTORE_COOLDOWN_MS ? 'held' : 'go';
}
