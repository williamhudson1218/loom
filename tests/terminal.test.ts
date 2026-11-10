import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import {
  CLIENT_FORMAT,
  GHOSTTY_FOCUS_SCRIPT,
  ITERM2_SELECT_SCRIPT,
  TERMINAL_APP_SELECT_SCRIPT,
  adapterFor,
  getTerminalSetting,
  insideFocusState,
  jumpWith,
  lanesInUse,
  normalizeTty,
  parseClients,
  parseTerminalKind,
  pickClient,
  requestInsideFocus,
  resolveTerminal,
  setInsideRaiser,
  terminalLabel,
  ttyMatches,
  type JumpDeps,
} from '../src/terminal.ts';
import { applySettings, readSettings, watchersFeatureOn } from '../src/settings.ts';
import { listWatchers } from '../src/watchers.ts';
import { CHAT_MENU_JS } from '../src/chatmenu.ts';
import { addHook } from '../scripts/install-hook.mjs';

const chatMenuItems = new Function(`${CHAT_MENU_JS}; return chatMenuItems;`)() as (x: Record<string, unknown>) => { key: string; label: string; disabled: boolean }[];
const chatMenuItemsFor = (x: Record<string, unknown>) => chatMenuItems({ saved: false, archive: false, prNum: '', ...x });

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-term-'));
  return { db: openDb(path.join(dir, 'm.db'), { migrate: false }), dir }; // an empty pre-registry DB, not a fresh install
}

function fakeDeps(over: Partial<JumpDeps> & { clients?: string } = {}) {
  const calls: string[][] = [];
  const osa: { script: string; args: string[] }[] = [];
  const opened: string[] = [];
  const focus: string[] = [];
  const deps: JumpDeps = {
    tmux: (a) => {
      calls.push(a);
      return a[0] === 'list-clients' ? (over.clients ?? '') : '';
    },
    osascript: (script, args) => {
      osa.push({ script, args });
      return 'ok';
    },
    open: (app) => void opened.push(app),
    insideFocus: (p) => void focus.push(p),
    ...over,
  };
  return { deps, calls, osa, opened, focus };
}

describe('terminal selection', () => {
  it('stored choice wins, otherwise Ghostty on a lane workspace and inside everywhere else', () => {
    expect(resolveTerminal('iterm2', true)).toBe('iterm2');
    expect(resolveTerminal(' Terminal ', false)).toBe('terminal');
    expect(resolveTerminal('', true)).toBe('ghostty');
    expect(resolveTerminal(undefined, true)).toBe('ghostty');
    expect(resolveTerminal('', false)).toBe('inside');
    expect(resolveTerminal('kitty', true)).toBe('ghostty'); // unknown value reads as unset
    expect(parseTerminalKind('INSIDE')).toBe('inside');
    expect(parseTerminalKind(7)).toBeNull();
  });

  it('labels the menu with the app, nothing for inside', () => {
    expect(terminalLabel('ghostty')).toBe('Ghostty');
    expect(terminalLabel('iterm2')).toBe('iTerm2');
    expect(terminalLabel('terminal')).toBe('Terminal');
    expect(terminalLabel('inside')).toBe('');
  });

  it('detects lane sessions from the tmux session list', () => {
    expect(lanesInUse(() => 'loom-tp-2\nloom-tp-terminals\nloom-managed\n')).toBe(true);
    expect(lanesInUse(() => 'loom-managed\nloom-orchestrator\nwork\n')).toBe(false);
    expect(lanesInUse(() => { throw new Error('no server'); })).toBe(false);
  });

  it('the menu item carries the configured app name and is disabled for inside', () => {
    expect(chatMenuItemsFor({ live: true, extLabel: 'iTerm2' }).find((i) => i.key === 'external')).toMatchObject({ label: 'Open in iTerm2', disabled: false });
    expect(chatMenuItemsFor({ live: true, extLabel: '' }).find((i) => i.key === 'external')).toMatchObject({ label: 'Open in external terminal', disabled: true });
    expect(chatMenuItemsFor({ live: false, extLabel: 'Ghostty' }).find((i) => i.key === 'external')).toMatchObject({ disabled: true });
  });
});

describe('tty matching', () => {
  it('normalizes ttys', () => {
    expect(normalizeTty('ttys003')).toBe('/dev/ttys003');
    expect(normalizeTty('/dev/ttys003\n')).toBe('/dev/ttys003');
    expect(normalizeTty('')).toBe('');
    expect(ttyMatches('ttys003', '/dev/ttys003')).toBe(true);
    expect(ttyMatches('/dev/ttys003', '/dev/ttys004')).toBe(false);
    expect(ttyMatches('', '')).toBe(false);
  });

  const raw = ['/dev/ttys003\tmain\t100', '/dev/ttys007\tloom-view-ab12\t900', '/dev/ttys010\twork\t300', ''].join('\n');

  it('parses list-clients output', () => {
    expect(parseClients(raw)).toEqual([
      { tty: '/dev/ttys003', session: 'main', activity: 100 },
      { tty: '/dev/ttys007', session: 'loom-view-ab12', activity: 900 },
      { tty: '/dev/ttys010', session: 'work', activity: 300 },
    ]);
  });

  it("never picks Loom's own embedded view client", () => {
    expect(pickClient(parseClients(raw), 'nowhere')?.tty).toBe('/dev/ttys010'); // most recent real client
    expect(pickClient(parseClients('/dev/ttys007\tloom-view-x\t5'), 'a')).toBeNull();
  });

  it('prefers a client already on the target session', () => {
    expect(pickClient(parseClients(raw), 'main')?.tty).toBe('/dev/ttys003');
  });
});

describe('adapters', () => {
  const target = { paneId: '%7', session: 'loom-tp-2' };

  it('ghostty keeps the original sequence: select-window, select-pane, title-match script', () => {
    const f = fakeDeps();
    const r = jumpWith('ghostty', target, f.deps);
    expect(f.calls.filter((c) => c[0] !== 'list-panes')).toEqual([['select-window', '-t', '%7'], ['select-pane', '-t', '%7']]);
    expect(f.osa).toEqual([{ script: GHOSTTY_FOCUS_SCRIPT, args: ['loom-tp-2'] }]);
    expect(r).toEqual({ ok: true, detail: 'tmux ok; ghostty ok' });
    expect(f.opened).toEqual([]);
  });

  it("selects the window in the pane's own session, never in one of Loom's terminal views", () => {
    // tmux resolves a bare pane target to an attached view of the group, so
    // `select-window -t %1084` moved a view, and another chat's terminal showed this pane.
    const listing = ['%899\tloom-view-0de2\t@854\t2', '%1084\tloom-view-0de2\t@1039\t7', '%1084\tloom-managed\t@1039\t7', ''].join('\n');
    for (const k of ['inside', 'ghostty'] as const) {
      const f = fakeDeps({ tmux: (a) => (f.calls.push(a), a[0] === 'list-panes' ? listing : '') });
      jumpWith(k, { paneId: '%1084', session: 'loom-managed' }, f.deps);
      const sel = f.calls.filter((c) => c[0] === 'select-window');
      expect(sel).toEqual([['select-window', '-t', '=loom-managed:@1039']]);
      expect(f.calls.some((c) => c.some((x) => x.includes('loom-view')))).toBe(false);
    }
  });

  it('ghostty: a failed focus is still ok (tmux selected)', () => {
    const f = fakeDeps({ osascript: () => { throw new Error('not allowed'); } });
    const r = jumpWith('ghostty', target, f.deps);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('grant Accessibility');
  });

  it('a tmux select failure is a failure for every adapter', () => {
    for (const k of ['inside', 'ghostty', 'iterm2', 'terminal'] as const) {
      const f = fakeDeps({ tmux: () => { throw new Error('gone'); } });
      expect(jumpWith(k, target, f.deps)).toMatchObject({ ok: false });
    }
  });

  it('iterm2: switches the attached client, then selects the tab by its tty', () => {
    const f = fakeDeps({ clients: '/dev/ttys003\tmain\t100' });
    const r = jumpWith('iterm2', target, f.deps);
    expect(f.calls).toContainEqual(['list-clients', '-F', CLIENT_FORMAT]);
    expect(f.calls).toContainEqual(['switch-client', '-c', '/dev/ttys003', '-t', 'loom-tp-2']);
    expect(f.osa).toEqual([{ script: ITERM2_SELECT_SCRIPT, args: ['/dev/ttys003'] }]);
    expect(r).toEqual({ ok: true, detail: 'tmux ok; iTerm2 tab selected' });
  });

  it('terminal: same path with the Terminal.app script; no switch when already on the session', () => {
    const f = fakeDeps({ clients: '/dev/ttys004\tloom-tp-2\t5' });
    const r = jumpWith('terminal', target, f.deps);
    expect(f.calls.some((c) => c[0] === 'switch-client')).toBe(false);
    expect(f.osa).toEqual([{ script: TERMINAL_APP_SELECT_SCRIPT, args: ['/dev/ttys004'] }]);
    expect(r.detail).toBe('tmux ok; Terminal tab selected');
  });

  it('iterm2: no matching tab raises the app instead; no attached client is a clear failure', () => {
    const f = fakeDeps({ clients: '/dev/ttys003\tmain\t1', osascript: () => 'tab-not-found' });
    expect(jumpWith('iterm2', target, f.deps).detail).toContain('brought forward');
    expect(f.opened).toEqual(['iTerm']);
    const g = fakeDeps({ clients: '/dev/ttys007\tloom-view-z\t1' });
    const r = jumpWith('iterm2', target, g.deps);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no tmux client is attached');
  });

  it('inside: selects in tmux and asks the page, never touches AppleScript', () => {
    const f = fakeDeps();
    const r = jumpWith('inside', target, f.deps);
    expect(f.focus).toEqual(['%7']);
    expect(f.osa).toEqual([]);
    expect(r.ok).toBe(true);
    expect(adapterFor('inside').label).toBe('Loom');
  });

  it('inside focus requests are sequenced and raise the window', () => {
    const raise = vi.fn();
    setInsideRaiser(raise);
    const before = insideFocusState().seq;
    requestInsideFocus('%9');
    expect(insideFocusState()).toEqual({ seq: before + 1, pane_id: '%9' });
    expect(raise).toHaveBeenCalledTimes(1);
    setInsideRaiser(null);
  });
});

describe('settings defaults', () => {
  it('an existing install (no rows) keeps Ghostty-on-lanes, the default socket and watchers on', () => {
    const { db } = tmpDb();
    const s = readSettings(db, true);
    expect(s.terminal).toMatchObject({ stored: '', effective: 'ghostty', label: 'Ghostty' });
    expect(s.tmux_socket.stored).toBe('default');
    expect(s.slack_watchers).toBe(true);
    expect(readSettings(db, false).terminal.effective).toBe('inside'); // no lanes, no setting
    db.close();
  });

  it('a new install (setup.sh rows) is inside, own socket, watchers off', () => {
    const { db } = tmpDb();
    const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
    for (const [k, v] of [['tmux_socket', 'loom'], ['terminal', 'inside'], ['slack_watchers', 'off']]) ins.run(k, v);
    const s = readSettings(db, true); // even with lanes present the stored choice wins
    expect(s.terminal.effective).toBe('inside');
    expect(s.tmux_socket.stored).toBe('loom');
    expect(s.slack_watchers).toBe(false);
    db.close();
  });

  it('applySettings validates, persists and flags a socket change as needing a restart', () => {
    const { db } = tmpDb();
    expect(applySettings(db, { terminal: 'kitty' })).toMatchObject({ ok: false });
    expect(applySettings(db, { tmux_socket: 'bad name!' })).toMatchObject({ ok: false });
    expect(applySettings(db, { slack_watchers: 'yes' })).toMatchObject({ ok: false });
    expect(applySettings(db, { terminal: 'iterm2', slack_watchers: false })).toEqual({ ok: true, restart: false });
    expect(getTerminalSetting(db)).toBe('iterm2');
    expect(watchersFeatureOn(db)).toBe(false);
    expect(applySettings(db, { tmux_socket: 'loom' })).toEqual({ ok: true, restart: true });
    expect(applySettings(db, { tmux_socket: 'loom' })).toEqual({ ok: true, restart: false });
    db.close();
  });

  it('no watchers are seeded, with watchers on or off (new installs start empty, §9.5)', () => {
    const { db } = tmpDb();
    applySettings(db, { slack_watchers: false });
    expect(listWatchers(db)).toHaveLength(0);
    applySettings(db, { slack_watchers: true });
    expect(listWatchers(db)).toHaveLength(0);
    db.close();
  });
});

describe('placement hook installer', () => {
  it('adds the hook to both events once, and leaves an existing registration (any path) alone', () => {
    const cfg: any = { model: 'x' };
    expect(addHook(cfg, '/a/hooks/record-placement.sh')).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(cfg.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: '/a/hooks/record-placement.sh', timeout: 5 });
    expect(addHook(cfg, '/a/hooks/record-placement.sh')).toEqual([]);
    const owner: any = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/Users/x/dev/loom/hooks/record-placement.sh' }] }] } };
    expect(addHook(owner, '/other/record-placement.sh')).toEqual(['UserPromptSubmit']);
    expect(owner.hooks.SessionStart).toHaveLength(1);
  });
});
