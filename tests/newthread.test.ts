import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ansiQuote, buildLaunchCommand } from '../src/goto.ts';
import { LEGACY_LAUNCH_SETTINGS as LEGACY } from '../src/launch.ts';
import { acquirePaneAuto, chooseTarget, promptWithImages, saveImages, type PaneGeom } from '../src/newthread.ts';
import type { LanePane, WorldState } from '../src/compact.ts';
import { renderDashboard } from '../src/dashboard.ts';

function pane(id: string, session: string, idx: string, over: Partial<LanePane> = {}): LanePane {
  return { pane_id: id, tmux_session: session, window_index: '1', pane_index: idx, command: 'zsh', name: '', group: '', agent: false, ...over };
}

describe('ansiQuote', () => {
  it('round-trips through a real shell as one argument, newlines and quotes intact', () => {
    const nasty = "line one\nit's $HOME `whoami` \\ \"q\" !bang\ttab\n\nlast";
    const out = execFileSync('/bin/zsh', ['-c', `printf %s ${ansiQuote(nasty)}`], { encoding: 'utf-8' });
    expect(out).toBe(nasty);
    const bash = execFileSync('/bin/bash', ['-c', `printf %s ${ansiQuote(nasty)}`], { encoding: 'utf-8' });
    expect(bash).toBe(nasty);
  });

  it('never emits a raw newline, so send-keys cannot submit it early', () => {
    expect(ansiQuote('a\nb')).toBe("$'a\\nb'");
    expect(ansiQuote('a\nb')).not.toContain('\n');
  });
});

describe('fresh launch command', () => {
  it('passes the prompt as the agent’s CLI argument', () => {
    expect(buildLaunchCommand({ projectDir: '/p q', sessionId: '', sourceAgent: 'claude', selectedAgent: 'claude', fresh: true, prompt: 'say hi\nand stop' }, LEGACY))
      .toBe("cd '/p q' && claude --dangerously-skip-permissions $'say hi\\nand stop'");
    expect(buildLaunchCommand({ projectDir: '/p', sessionId: '', sourceAgent: 'codex', selectedAgent: 'codex', fresh: true, prompt: 'go' }, LEGACY))
      .toBe("cd '/p' && codex $'go'");
    expect(buildLaunchCommand({ projectDir: '/p', sessionId: '', sourceAgent: 'claude', selectedAgent: 'claude', fresh: true }, LEGACY))
      .toBe("cd '/p' && claude --dangerously-skip-permissions");
  });
});

describe('chooseTarget', () => {
  const world: WorldState = {
    focused: null,
    panes: [
      pane('%1', 'loom-tp-2', '0', { agent: true, command: '2.1.0' }),
      pane('%2', 'loom-tp-2', '1'),
      pane('%3', 'loom-forms-1', '0'),
      pane('%4', 'loom-tp-3', '0', { agent: true, command: '2.1.0' }),
    ],
  };
  const geom: PaneGeom[] = [
    { pane_id: '%1', session: 'loom-tp-2', width: 100, height: 50 },
    { pane_id: '%2', session: 'loom-tp-2', width: 100, height: 50 },
    { pane_id: '%4', session: 'loom-tp-3', width: 200, height: 50 },
  ];

  it('takes the preferred lane’s open pane, then any lane’s', () => {
    expect(chooseTarget(world, geom, '', 'tp')).toEqual({ pane_id: '%2', split: false });
    expect(chooseTarget(world, geom, '', 'nope')).toEqual({ pane_id: '%3', split: false });
    expect(chooseTarget(world, geom, 'tp')).toEqual({ pane_id: '%2', split: false });
  });

  it('splits the roomiest session of a full lane, along the long side', () => {
    const full: WorldState = { focused: null, panes: world.panes.map((p) => ({ ...p, agent: true, command: '2.1.0' })) };
    expect(chooseTarget(full, geom, 'tp')).toEqual({ split: true, session: 'loom-tp-3', from: '%4', horizontal: true });
    expect(chooseTarget(full, geom, 'ghost')).toBeNull();
  });
});

describe('images', () => {
  it('saves pasted images under an inbox id and appends their paths to the prompt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-inbox-'));
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const paths = saveImages([{ name: 'Screen Shot 1.png', type: 'image/png', data: png }], dir, 'abc');
    expect(paths).toEqual([path.join(dir, 'abc', '01-Screen-Shot-1.png')]);
    expect(fs.existsSync(paths[0])).toBe(true);
    expect(promptWithImages('look at this', paths)).toBe('look at this\n\n' + paths[0]);
    expect(() => saveImages([{ type: 'text/html', data: png }], dir, 'x')).toThrow(/unsupported/);
  });
});

describe('composer shell', () => {
  it('ships the New thread button, the composer and its launch call', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="newbtn"');
    expect(html).toContain('id="composer" hidden');
    expect(html).toContain("fetch('/api/new-thread'");
    expect(html).toContain("fetch('/api/lanes?all=1')");
  });

  it('autosaves the draft, restores it on open, and keeps the last launched prompt for 24 h', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="crestore"');
    expect(html).toContain("addEventListener('input',saveDraft)");
    const open = html.slice(html.indexOf('function openComposer'), html.indexOf('function projLabel'));
    expect(open).toContain("lsGet('loom.draft')");
    const launch = html.slice(html.indexOf('function launchThread'));
    // the last-launched copy is written only on the ok path, before the reset that clears the draft
    expect(launch.indexOf("'loom.lastPrompt'")).toBeGreaterThan(launch.indexOf('if(!j.ok)'));
    expect(launch.indexOf("'loom.lastPrompt'")).toBeLessThan(launch.indexOf('resetComposer()'));
    expect(html).toContain('86400000');
    expect(html.slice(html.indexOf('function resetComposer'))).toContain("lsDel('loom.draft')");
  });

  it('keeps the typed prompt when a launch fails, and clears it only on success', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    const js = html.slice(html.indexOf('function launchThread'), html.indexOf("$('#newbtn').onclick"));
    const fail = js.slice(js.indexOf('if(!j.ok){'), js.indexOf('lsSet('));
    expect(fail).toContain("'✕ '");
    expect(fail).not.toContain('resetComposer');
    expect(fail).not.toContain('closeComposer');
    // the catch path (non-JSON / 5xx / network) must not clear either
    expect(js.slice(js.indexOf('.catch('))).not.toContain('resetComposer');
    expect(js.indexOf('resetComposer()')).toBeGreaterThan(js.indexOf('✓ started'));
  });
});

describe('dashboard script', () => {
  // The page's JS lives in a TS template literal, where `\/` and `\d` silently
  // lose their backslash. Parsing the emitted script catches that class of bug.
  it('emits a script that parses', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(js)).not.toThrow();
  });
});

describe('acquirePaneAuto: lanes keep today\'s picker, no lanes means a managed window', () => {
  const SEP = '~|LOOM|~';
  // A fake tmux: list-panes answers with the given panes, every other call is recorded.
  function fake(panes: { id: string; session: string; idx: string; cmd?: string }[]) {
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args[0] === 'list-panes' && args.includes('-a')) {
        const fmt = String(args[args.indexOf('-F') + 1]);
        if (fmt.includes('#{pane_width}')) return panes.map((p) => `${p.id} ${p.session} 80 24`).join('\n');
        if (fmt.includes('#{pane_pid}')) return panes.map((p) => [p.id, p.session, '1', p.idx, '999999', p.cmd ?? 'zsh', '', ''].join(SEP)).join('\n');
        return panes.map((p) => [p.id, p.session, ''].join(SEP)).join('\n');
      }
      if (args[0] === 'has-session') throw new Error('no session');
      if (args[0] === 'new-session') return '%88\n';
      if (args[0] === 'display-message') return '';
      if (args[0] === 'capture-pane') return 'prompt';
      return '';
    };
    return { run, calls };
  }
  const env = { free: process.env.LOOM_MIN_FREE_MB, load: process.env.LOOM_MAX_LOAD_PER_CPU };
  const restore = () => {
    if (env.free === undefined) delete process.env.LOOM_MIN_FREE_MB; else process.env.LOOM_MIN_FREE_MB = env.free;
    if (env.load === undefined) delete process.env.LOOM_MAX_LOAD_PER_CPU; else process.env.LOOM_MAX_LOAD_PER_CPU = env.load;
  };

  it('with a lane session, uses the lane\'s open pane and never creates a managed window', () => {
    const { run, calls } = fake([{ id: '%1', session: 'loom-tp-2', idx: '0' }]);
    expect(acquirePaneAuto('/p', 'tp', '', run)).toEqual({ ok: true, paneId: '%1', split: false, managed: false });
    expect(calls.some((c) => c[0] === 'new-session' || c[0] === 'new-window')).toBe(false);
  });

  it('with no lane session, creates the managed session in the project dir', () => {
    process.env.LOOM_MIN_FREE_MB = '1';
    process.env.LOOM_MAX_LOAD_PER_CPU = '100000';
    try {
      const { run, calls } = fake([{ id: '%1', session: 'work', idx: '0' }]);
      const r = acquirePaneAuto('/proj', '', '', run);
      expect(r).toMatchObject({ ok: true, paneId: '%88', split: false, managed: true });
      const ns = calls.find((c) => c[0] === 'new-session')!;
      expect(ns).toEqual(expect.arrayContaining(['-s', 'loom-managed', '-c', '/proj']));
    } finally {
      restore();
    }
  });

  it('relays the cap\'s refusal without touching tmux', () => {
    process.env.LOOM_MIN_FREE_MB = '99999999';
    try {
      const { run, calls } = fake([]);
      const r = acquirePaneAuto('/proj', '', '', run);
      expect(r).toMatchObject({ ok: false, detail: expect.stringContaining('Not starting a new chat') });
      expect(calls.some((c) => c[0] === 'new-session')).toBe(false);
    } finally {
      restore();
    }
  });
});
