import { execFileSync } from 'node:child_process';

export interface OpenTabsResult {
  ok: boolean;
  opened: number; // tabs newly created
  reused: number; // existing tabs re-attached instead of duplicated
  leftover: number; // free tabs nothing was assigned to
  detail: string;
  script: string; // the AppleScript that was (or would be) run
}

// A Ghostty tab, in on-screen order. `title` is what the tab shows: while a tmux
// client is attached that is the session name (set-titles-string '#S'), and once
// the client dies the shell's own prompt overwrites it.
export interface GhosttyTab {
  window_index: number; // 1-based, AppleScript's own indexing
  tab_index: number; // 1-based within the window; 1 for a single-tab window
  title: string;
  tabbed: boolean; // false when the window has no tab group (a lone tab)
}

const SEP = '~|LOOM|~';

// Escape a string for embedding inside an AppleScript double-quoted literal.
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Screen geometry of a Ghostty window, in points (System Events' position/size).
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A live Ghostty window as read from the accessibility tree. `window_index` is
// its AX index at read time, which is front-to-back z-order — NOT a stable id.
export interface GhosttyWindow {
  window_index: number;
  tabs: GhosttyTab[];
  bounds?: WindowBounds;
}

// A window as remembered in the layout snapshot: its tab titles in on-screen
// order and where it sat on screen.
export interface SavedGhosttyWindow {
  tabs: string[];
  bounds?: WindowBounds;
}

// Enumerate every Ghostty tab in on-screen order. A window showing a single tab
// has no tab group in the accessibility tree, so its own name is the tab title.
// Each window also emits a "b" line with its position and size (blank when the
// attributes can't be read), which the snapshot keeps so restore can rebuild a
// missing window where it was.
const READ_TABS_SCRIPT = `
tell application "System Events" to tell process "Ghostty"
  set out to ""
  repeat with wi from 1 to (count of windows)
    set w to window wi
    set b to ""
    try
      set p to position of w
      set s to size of w
      set b to "" & (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s)
    end try
    set out to out & wi & "${SEP}" & 0 & "${SEP}" & "b" & "${SEP}" & b & linefeed
    if exists tab group 1 of w then
      set tabs_ to radio buttons of tab group 1 of w
      repeat with ti from 1 to (count of tabs_)
        set out to out & wi & "${SEP}" & ti & "${SEP}" & "t" & "${SEP}" & (title of item ti of tabs_) & linefeed
      end repeat
    else
      set out to out & wi & "${SEP}" & 1 & "${SEP}" & "w" & "${SEP}" & (name of w) & linefeed
    end if
  end repeat
  return out
end tell`;

function parseBounds(v: string): WindowBounds | undefined {
  const n = v.split(',').map((x) => Number(x.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return undefined;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

// Parse the read script into windows, each carrying its tabs in on-screen order.
export function parseWindows(raw: string): GhosttyWindow[] {
  const byIndex = new Map<number, GhosttyWindow>();
  const win = (i: number) => byIndex.get(i) ?? byIndex.set(i, { window_index: i, tabs: [] }).get(i)!;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(SEP);
    if (p.length < 4) continue;
    const wi = Number(p[0]);
    if (p[2] === 'b') {
      const b = parseBounds(p.slice(3).join(SEP));
      if (b) win(wi).bounds = b;
      continue;
    }
    win(wi).tabs.push({
      window_index: wi,
      tab_index: Number(p[1]),
      tabbed: p[2] === 't',
      title: p.slice(3).join(SEP).trim(),
    });
  }
  return [...byIndex.values()].sort((a, b) => a.window_index - b.window_index);
}

export function parseTabs(raw: string): GhosttyTab[] {
  return parseWindows(raw).flatMap((w) => w.tabs);
}

// Group a flat tab list back into windows (for callers that inject tabs).
export function windowsFromTabs(tabs: GhosttyTab[]): GhosttyWindow[] {
  const byIndex = new Map<number, GhosttyWindow>();
  for (const t of tabs) {
    const w = byIndex.get(t.window_index) ?? byIndex.set(t.window_index, { window_index: t.window_index, tabs: [] }).get(t.window_index)!;
    w.tabs.push(t);
  }
  for (const w of byIndex.values()) w.tabs.sort((a, b) => a.tab_index - b.tab_index);
  return [...byIndex.values()].sort((a, b) => a.window_index - b.window_index);
}

// Best-effort: an unreadable accessibility tree (Ghostty closed, permission not
// granted) just means "no windows to reuse", which degrades to opening new ones.
export function readGhosttyWindows(): GhosttyWindow[] {
  try {
    return parseWindows(execFileSync('osascript', ['-e', READ_TABS_SCRIPT], { encoding: 'utf-8' }));
  } catch {
    return [];
  }
}

export function readGhosttyTabs(): GhosttyTab[] {
  return readGhosttyWindows().flatMap((w) => w.tabs);
}

// The snapshot's shape of the live windows: titles plus geometry. Windows with
// no tabs (nothing readable) are dropped.
export function savedWindowsFrom(windows: GhosttyWindow[]): SavedGhosttyWindow[] {
  return windows
    .filter((w) => w.tabs.length)
    .map((w) => (w.bounds ? { tabs: w.tabs.map((t) => t.title), bounds: w.bounds } : { tabs: w.tabs.map((t) => t.title) }));
}

// A tab belongs to a session when its title is (or ends with) the session name —
// the same "ends with" convention gotoPane uses to focus a tab.
export function tabMatchesSession(title: string, session: string): boolean {
  return title === session || title.endsWith(session);
}

// Put sessions back in the order their tabs sat in on screen. Sessions with no
// remembered tab keep their relative order and follow the remembered ones, so a
// session created since the last snapshot lands at the end rather than being
// dropped or shuffled into the middle.
export function orderSessionsByTabs(sessions: string[], tabTitles: string[] = []): string[] {
  const rank = new Map<string, number>();
  sessions.forEach((s) => {
    const i = tabTitles.findIndex((t) => tabMatchesSession(t, s));
    if (i >= 0) rank.set(s, i);
  });
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = rank.get(a.s);
      const rb = rank.get(b.s);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

export interface TabAssignment {
  session: string;
  reuse: GhosttyTab | null; // null -> a new tab has to be opened
}

// One target window and the sessions that land in it, in on-screen tab order.
export interface WindowPlan {
  window: GhosttyWindow | null; // null -> a new Ghostty window has to be opened
  bounds?: WindowBounds; // saved geometry, applied when the window is new
  assignments: TabAssignment[];
}

export interface TabPlan {
  windows: WindowPlan[];
  assignments: TabAssignment[]; // every window's assignments, flattened in plan order
  leftover: GhosttyTab[]; // free tabs nothing was assigned to
  live: number[]; // AX indices of the live windows as read (front-to-back z-order)
}

interface SessionGroup {
  saved: SavedGhosttyWindow | null;
  sessions: string[];
}

// Split the sessions by the saved window they sat in, each group in its saved
// tab order. A session no saved window remembers (created since the last
// snapshot) goes to the end of the LAST window — the flat tab order has always
// put such sessions at the very end, and the last window is where that is.
function groupBySavedWindow(sessions: string[], saved: SavedGhosttyWindow[]): SessionGroup[] {
  const groups: SessionGroup[] = saved.map((w) => ({ saved: w, sessions: [] }));
  const stray: string[] = [];
  for (const s of sessions) {
    const g = groups.find((x) => x.saved!.tabs.some((t) => tabMatchesSession(t, s)));
    if (g) g.sessions.push(s);
    else stray.push(s);
  }
  for (const g of groups) {
    const pos = (s: string) => g.saved!.tabs.findIndex((t) => tabMatchesSession(t, s));
    g.sessions.sort((x, y) => pos(x) - pos(y));
  }
  if (stray.length) {
    const target = [...groups].reverse().find((g) => g.sessions.length) ?? groups[groups.length - 1];
    if (target) target.sessions.push(...stray);
    else groups.push({ saved: null, sessions: stray });
  }
  return groups.filter((g) => g.sessions.length);
}

// Decide which window, and which tab within it, each session should land in.
//
// After a tmux server dies its Ghostty tabs survive as bare shells, so opening a
// fresh tab per session leaves the workspace doubled: one empty tab and one live
// tab per session. A tab is taken to be in use only when its title matches a
// session that currently has a tmux client attached; busy tabs are never reused.
//
// Sessions are grouped by the saved window they sat in, and each group is
// matched to a live window: first the one with the most tabs matching the
// group (its sessions, plus its still-attached sessions, which pin down the
// window a surviving half of it is in); failing that, an unclaimed window whose
// tabs are all free; failing that, a new window at the saved position. Within a
// window, sessions claim a same-named tab first, then that window's other free
// tabs positionally, then new tabs appended after its last tab. Free tabs no
// session takes are left alone.
export function planTabAttach(input: {
  sessions: string[];
  tabs?: GhosttyTab[];
  windows?: GhosttyWindow[]; // live windows; derived from `tabs` when omitted
  saved?: SavedGhosttyWindow[]; // remembered windows; none -> one window
  attached: Iterable<string>;
}): TabPlan {
  const busy = [...input.attached];
  const live = input.windows ?? windowsFromTabs(input.tabs ?? []);
  const isFree = (t: GhosttyTab) => !busy.some((s) => tabMatchesSession(t.title, s));
  const groups = groupBySavedWindow(input.sessions, input.saved ?? []);

  // Score every (group, live window) pair and assign greedily, best first.
  const score = (g: SessionGroup, w: GhosttyWindow): number => {
    const keys = [...g.sessions, ...busy.filter((b) => g.saved?.tabs.some((t) => tabMatchesSession(t, b)))];
    return w.tabs.filter((t) => keys.some((k) => tabMatchesSession(t.title, k))).length;
  };
  const pairs: { gi: number; wi: number; n: number }[] = [];
  groups.forEach((g, gi) =>
    live.forEach((w, wi) => {
      const n = score(g, w);
      if (n > 0) pairs.push({ gi, wi, n });
    }),
  );
  pairs.sort((x, y) => y.n - x.n || x.gi - y.gi || x.wi - y.wi);
  const target = new Map<number, GhosttyWindow>();
  const claimedWin = new Set<GhosttyWindow>();
  for (const p of pairs) {
    if (target.has(p.gi) || claimedWin.has(live[p.wi])) continue;
    target.set(p.gi, live[p.wi]);
    claimedWin.add(live[p.wi]);
  }
  groups.forEach((_, gi) => {
    if (target.has(gi)) return;
    const w = live.find((x) => !claimedWin.has(x) && x.tabs.length && x.tabs.every(isFree));
    if (w) {
      target.set(gi, w);
      claimedWin.add(w);
    }
  });

  const claimed = new Set<GhosttyTab>();
  const windows: WindowPlan[] = groups.map((g, gi) => {
    const w = target.get(gi) ?? null;
    const assignments: TabAssignment[] = g.sessions.map((session) => ({ session, reuse: null }));
    const free = w ? w.tabs.filter(isFree) : [];
    for (const a of assignments) {
      const exact = free.find((t) => !claimed.has(t) && tabMatchesSession(t.title, a.session));
      if (exact) {
        claimed.add(exact);
        a.reuse = exact;
      }
    }
    for (const a of assignments) {
      if (a.reuse) continue;
      const next = free.find((t) => !claimed.has(t));
      if (!next) break; // out of free tabs; the rest open new ones
      claimed.add(next);
      a.reuse = next;
    }
    const plan: WindowPlan = { window: w, assignments };
    if (!w && g.saved?.bounds) plan.bounds = g.saved.bounds;
    return plan;
  });

  return {
    windows,
    assignments: windows.flatMap((w) => w.assignments),
    leftover: live.flatMap((w) => w.tabs).filter((t) => isFree(t) && !claimed.has(t)),
    live: live.map((w) => w.window_index),
  };
}

function typeAttach(lines: string[], session: string): void {
  lines.push(`  keystroke "ta ${esc(session)}"`);
  lines.push('  delay 0.1');
  lines.push('  key code 36'); // Return
  lines.push('  delay 0.25');
}

function clickTab(lines: string[], tab: GhosttyTab): void {
  if (!tab.tabbed) return; // a lone tab is already showing once its window is raised
  lines.push(`  click radio button ${tab.tab_index} of tab group 1 of window 1`);
  lines.push('  delay 0.2');
}

function newTab(lines: string[]): void {
  lines.push('  keystroke "t" using command down');
  lines.push('  delay 0.35');
}

// Build the AppleScript that puts each session into its planned window and tab.
//
// Windows are addressed by AX index, and AX indices are front-to-back z-order:
// AXRaise moves the raised window to index 1 and shifts every window that was in
// front of it back by one, and Cmd-N pushes a new window in at index 1. Reading
// the indices once and reusing them (what this used to do) sends later clicks to
// the wrong window as soon as the first raise lands. So the script is built one
// window at a time against a simulated z-order: the index it raises is that
// window's CURRENT position (read-time order, replayed through every raise and
// Cmd-N emitted so far), and once raised the window is always `window 1` for its
// tab clicks and Cmd-T. Nothing else reorders windows mid-script — clicking a tab
// of the front window or opening a tab in it leaves z-order alone.
//
// Within a window, reused tabs are filled first (their tab indices are fixed);
// then, if it needs new tabs, its last tab is selected before Cmd-T because
// Ghostty inserts a new tab next to the active one — without that they
// interleave with the tabs already there instead of appending in order.
export function buildAttachScript(plan: TabPlan): string {
  const lines: string[] = [
    'tell application "Ghostty" to activate',
    'delay 0.4',
    'tell application "System Events" to tell process "Ghostty"',
  ];
  // Simulated z-order, front first. Live windows are keyed by their read-time
  // index; a window this script opens gets a fresh negative key.
  const zorder = [...plan.live];
  let nextNew = -1;
  for (const wp of plan.windows) {
    if (!wp.assignments.length) continue;
    if (wp.window) {
      const key = wp.window.window_index;
      const pos = zorder.indexOf(key);
      lines.push(`  perform action "AXRaise" of window ${pos + 1}`);
      lines.push('  delay 0.15');
      zorder.splice(pos, 1);
      zorder.unshift(key);
      const reused = wp.assignments.filter((a) => a.reuse);
      const fresh = wp.assignments.filter((a) => !a.reuse);
      for (const a of reused) {
        clickTab(lines, a.reuse!);
        typeAttach(lines, a.session);
      }
      if (fresh.length) {
        const last = wp.window.tabs[wp.window.tabs.length - 1];
        if (last) clickTab(lines, last);
        for (const a of fresh) {
          newTab(lines);
          typeAttach(lines, a.session);
        }
      }
    } else {
      lines.push('  keystroke "n" using command down');
      lines.push('  delay 0.5');
      zorder.unshift(nextNew--);
      if (wp.bounds) {
        const b = wp.bounds;
        lines.push(`  set position of window 1 to {${Math.round(b.x)}, ${Math.round(b.y)}}`);
        lines.push(`  set size of window 1 to {${Math.round(b.w)}, ${Math.round(b.h)}}`);
        lines.push('  delay 0.2');
      }
      wp.assignments.forEach((a, i) => {
        if (i > 0) newTab(lines);
        typeAttach(lines, a.session);
      });
    }
  }
  lines.push('end tell');
  return lines.join('\n');
}

function ghosttyRunning(): boolean {
  try {
    return (
      execFileSync('osascript', ['-e', 'application "Ghostty" is running'], { encoding: 'utf-8' }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

export interface AttachOpts {
  dryRun?: boolean;
  attached?: Iterable<string>; // sessions that already have a tmux client
  saved?: SavedGhosttyWindow[]; // remembered window grouping (restore's `windows`)
  tabs?: GhosttyTab[]; // injectable for tests / dry-run (grouped by window_index)
  windows?: GhosttyWindow[]; // injectable live windows; wins over `tabs`
}

// Attach each session to a Ghostty tab in the window it was saved in, reusing
// the windows and tabs already on screen and only opening new ones when there
// aren't enough. Best-effort keystroke automation (requires Accessibility
// permission, same as goto.ts). If Ghostty isn't running it's launched first and
// its initial empty window is reused like any other free window.
export function attachGhosttyTabs(sessions: string[], opts: AttachOpts = {}): OpenTabsResult {
  const none = { ok: true, opened: 0, reused: 0, leftover: 0, script: '' };
  if (sessions.length === 0) return { ...none, detail: 'no sessions to attach' };

  const running = opts.dryRun ? true : ghosttyRunning();
  if (!running) {
    try {
      execFileSync('open', ['-a', 'Ghostty']);
      execFileSync('sleep', ['0.9']); // let Ghostty create its first window/tab
    } catch (e) {
      return { ...none, ok: false, detail: 'failed to launch Ghostty: ' + (e as Error).message };
    }
  }

  const windows =
    opts.windows ?? (opts.tabs ? windowsFromTabs(opts.tabs) : opts.dryRun ? [] : readGhosttyWindows());
  const plan = planTabAttach({ sessions, windows, saved: opts.saved, attached: opts.attached ?? [] });
  const script = buildAttachScript(plan);
  const reused = plan.assignments.filter((a) => a.reuse).length;
  const opened = plan.assignments.length - reused;
  const newWindows = plan.windows.filter((w) => !w.window).length;
  const counts = { opened, reused, leftover: plan.leftover.length };
  const detail =
    `attached ${sessions.length} session(s): ${reused} tab(s) reused, ${opened} opened` +
    (newWindows ? ` across ${newWindows} new window(s)` : '') +
    (plan.leftover.length ? `, ${plan.leftover.length} spare tab(s) left alone` : '');

  if (opts.dryRun) return { ok: true, ...counts, detail: 'dry-run', script };

  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
    return { ok: true, ...counts, detail, script };
  } catch (e) {
    return {
      ...none,
      ok: false,
      detail: 'osascript failed (grant Accessibility to your terminal): ' + (e as Error).message,
      script,
    };
  }
}
