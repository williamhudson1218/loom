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

// Enumerate every Ghostty tab in on-screen order. A window showing a single tab
// has no tab group in the accessibility tree, so its own name is the tab title.
const READ_TABS_SCRIPT = `
tell application "System Events" to tell process "Ghostty"
  set out to ""
  repeat with wi from 1 to (count of windows)
    set w to window wi
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

export function parseTabs(raw: string): GhosttyTab[] {
  const out: GhosttyTab[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(SEP);
    if (p.length < 4) continue;
    out.push({
      window_index: Number(p[0]),
      tab_index: Number(p[1]),
      tabbed: p[2] === 't',
      title: p.slice(3).join(SEP).trim(),
    });
  }
  return out;
}

// Best-effort: an unreadable accessibility tree (Ghostty closed, permission not
// granted) just means "no tabs to reuse", which degrades to the old behaviour.
export function readGhosttyTabs(): GhosttyTab[] {
  try {
    return parseTabs(execFileSync('osascript', ['-e', READ_TABS_SCRIPT], { encoding: 'utf-8' }));
  } catch {
    return [];
  }
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

export interface TabPlan {
  assignments: TabAssignment[];
  leftover: GhosttyTab[]; // free tabs nothing was assigned to
}

// Decide which existing tab each session should land in.
//
// After a tmux server dies its Ghostty tabs survive as bare shells, so opening a
// fresh tab per session leaves the workspace doubled: one empty tab and one live
// tab per session. A tab is taken to be in use only when its title matches a
// session that currently has a tmux client attached; everything else is free to
// be re-homed.
//
// Sessions claim a same-named tab first, so a workspace whose tabs kept their
// titles rebuilds exactly where it was. Whatever is left is filled positionally
// in tab order, which preserves the on-screen order for the common case where
// every tab is free and the caller passes sessions in the saved tab order.
export function planTabAttach(input: {
  sessions: string[];
  tabs: GhosttyTab[];
  attached: Iterable<string>;
}): TabPlan {
  const busy = [...input.attached];
  const free = input.tabs.filter((t) => !busy.some((s) => tabMatchesSession(t.title, s)));
  const claimed = new Set<GhosttyTab>();
  const assignments: TabAssignment[] = input.sessions.map((session) => ({ session, reuse: null }));

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
  return { assignments, leftover: free.filter((t) => !claimed.has(t)) };
}

function typeAttach(lines: string[], session: string): void {
  lines.push(`  keystroke "ta ${esc(session)}"`);
  lines.push('  delay 0.1');
  lines.push('  key code 36'); // Return
  lines.push('  delay 0.25');
}

function selectTab(lines: string[], tab: GhosttyTab): void {
  lines.push(`  perform action "AXRaise" of window ${tab.window_index}`);
  lines.push('  delay 0.15');
  if (tab.tabbed) {
    lines.push(`  click radio button ${tab.tab_index} of tab group 1 of window ${tab.window_index}`);
    lines.push('  delay 0.2');
  }
}

// Build the AppleScript that puts each session into its planned tab: reused tabs
// are clicked and typed into, everything else gets a fresh Cmd-T. New tabs are
// opened only after selecting the last existing tab, because Ghostty inserts a
// new tab next to the active one — without that they interleave with the tabs
// already on screen instead of appending in order.
export function buildAttachScript(plan: TabPlan, tabs: GhosttyTab[]): string {
  const lines: string[] = [
    'tell application "Ghostty" to activate',
    'delay 0.4',
    'tell application "System Events" to tell process "Ghostty"',
  ];
  let openedAny = false;
  for (const a of plan.assignments) {
    if (a.reuse) {
      selectTab(lines, a.reuse);
    } else {
      if (!openedAny) {
        const last = tabs[tabs.length - 1];
        if (last) selectTab(lines, last);
        openedAny = true;
      }
      lines.push('  keystroke "t" using command down');
      lines.push('  delay 0.35');
    }
    typeAttach(lines, a.session);
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
  tabs?: GhosttyTab[]; // injectable for tests / dry-run
}

// Attach each session to a Ghostty tab, reusing the tabs already on screen and
// only opening new ones when there aren't enough. Best-effort keystroke
// automation (requires Accessibility permission, same as goto.ts). If Ghostty
// isn't running it's launched first and its initial empty tab is reused like any
// other free tab.
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

  const tabs = opts.tabs ?? (opts.dryRun ? [] : readGhosttyTabs());
  const plan = planTabAttach({ sessions, tabs, attached: opts.attached ?? [] });
  const script = buildAttachScript(plan, tabs);
  const reused = plan.assignments.filter((a) => a.reuse).length;
  const opened = plan.assignments.length - reused;
  const counts = { opened, reused, leftover: plan.leftover.length };
  const detail =
    `attached ${sessions.length} session(s): ${reused} tab(s) reused, ${opened} opened` +
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
