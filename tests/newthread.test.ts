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
    expect(html).toContain('id="composer" class="loverlay" hidden');
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

describe('launch confirmation', () => {
  const quiet = () => {};
  const mk = (over: Record<string, unknown> = {}) => {
    const input = { prompt: 'fix the thing '.repeat(30), projectDir: '/tmp', agent: 'claude' as const, ...over };
    return input;
  };
  const world = (cmd: string, inMode = '0', screen = 'prompt $') => {
    const sent: string[][] = [];
    const state = { cmd, inMode, screen };
    const run = (args: string[]) => {
      sent.push(args);
      const a = args.join(' ');
      if (args[0] === 'list-panes' && args.includes('-a')) {
        const fmt = String(args[args.indexOf('-F') + 1]);
        if (fmt.includes('#{pane_width}')) return '%1 loom-tp-2 80 24';
        if (fmt.includes('#{pane_pid}')) return ['%1', 'loom-tp-2', '1', '0', '999999', 'zsh', '', ''].join('~|LOOM|~');
        return ['%1', 'loom-tp-2', ''].join('~|LOOM|~');
      }
      if (a.includes('display-message') && a.includes('session_name')) return 'loom-tp-2 · pane 0';
      if (a.includes('#{pane_current_command}')) return state.cmd;
      if (a.includes('#{pane_in_mode}')) return state.inMode;
      if (args[0] === 'capture-pane') return state.screen;
      if (a.includes('-X cancel')) { state.inMode = '0'; return ''; }
      return '';
    };
    return { run, sent, state };
  };
  const startOne = async () => {
    const { startThread, recentLaunches } = await import('../src/newthread.ts');
    const w = world('zsh');
    const r = startThread(mk(), w.run, { launch: () => ({ ok: true, detail: 'started' }), ready: () => true });
    return { r, recentLaunches, w };
  };

  it('keeps the full prompt and marks a typed launch as starting', async () => {
    const { r, recentLaunches } = await startOne();
    expect(r.ok).toBe(true);
    const l = recentLaunches().find((x) => x.fullPrompt?.startsWith('fix the thing'))!;
    expect(l.status).toBe('starting');
    expect(l.prompt.length).toBe(200);
    expect(l.fullPrompt!.length).toBeGreaterThan(200);
  });

  it('started as soon as the agent process runs, with no transcript yet', async () => {
    const { confirmLaunches, recentLaunches } = await import('../src/newthread.ts');
    const l = recentLaunches().find((x) => x.status === 'starting')!;
    const w = world('2.1.319');
    confirmLaunches({}, w.run, l.at + 1000, quiet);
    expect(l.status).toBe('started');
  });

  it('started when the placement hook tied a session to the pane', async () => {
    const { startThread, confirmLaunches, recentLaunches, dismissLaunch } = await import('../src/newthread.ts');
    const w = world('zsh');
    w.run(['noop']);
    startThread(mk({ prompt: 'tied one' }), w.run, { launch: () => ({ ok: true, detail: 'x' }), ready: () => true });
    const l = recentLaunches().find((x) => x.fullPrompt === 'tied one')!;
    confirmLaunches({ k: { agent: 'claude', session_id: 's', pane_id: l.pane_id } }, w.run, l.at + 1000, quiet);
    expect(l.status).toBe('started');
    dismissLaunch(l.id);
  });

  it('is not failed before the timeout, and fails after it with the pane tail', async () => {
    const { startThread, confirmLaunches, recentLaunches, LAUNCH_CONFIRM_MS } = await import('../src/newthread.ts');
    const screen = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n';
    const w = world('cat', '0', screen);
    startThread(mk({ prompt: 'doomed' }), w.run, { launch: () => ({ ok: true, detail: 'x' }), ready: () => true });
    const l = recentLaunches().find((x) => x.fullPrompt === 'doomed')!;
    const notes: string[] = [];
    confirmLaunches({}, w.run, l.at + LAUNCH_CONFIRM_MS - 1, (x) => notes.push(x.id));
    expect(l.status).toBe('starting');
    confirmLaunches({}, w.run, l.at + LAUNCH_CONFIRM_MS + 1, (x) => notes.push(x.id));
    expect(l.status).toBe('failed');
    expect(l.lines).toHaveLength(15);
    expect(l.lines!.at(-1)).toBe('line 30');
    expect(notes).toEqual([l.id]);
    confirmLaunches({}, w.run, l.at + LAUNCH_CONFIRM_MS * 3, (x) => notes.push(x.id));
    expect(notes).toHaveLength(1); // notified once
    // survives the 5-minute TTL, and carries its full prompt to the board
    const { launchView } = await import('../src/newthread.ts');
    expect(recentLaunches(l.at + 3_600_000).some((x) => x.id === l.id)).toBe(true);
    expect(launchView(l).fullPrompt).toBe('doomed');
  });

  it('leaves copy mode before typing, and types only after', async () => {
    const { startThread } = await import('../src/newthread.ts');
    const w = world('zsh', '1');
    let typedWhileInMode: string | null = null;
    startThread(mk({ prompt: 'scrolled' }), w.run, { launch: () => { typedWhileInMode = w.state.inMode; return { ok: true, detail: 'x' }; }, ready: () => true });
    expect(w.sent.some((a) => a.join(' ').includes('-X cancel'))).toBe(true);
    expect(typedWhileInMode).toBe('0');
  });

  it('refuses to type into a pane stuck in copy mode or without a ready shell', async () => {
    const { startThread, prepareForTyping } = await import('../src/newthread.ts');
    let typed = false;
    const launch = () => { typed = true; return { ok: true as const, detail: 'x' }; };
    const stuck = world('zsh', '1');
    const stubborn = (args: string[]) => (args.join(' ').includes('-X cancel') ? '' : stuck.run(args));
    const r1 = startThread(mk(), stubborn, { launch, ready: () => true });
    expect(r1.ok).toBe(false);
    expect(r1.detail).toMatch(/copy mode/);
    const w = world('zsh');
    const r2 = startThread(mk(), w.run, { launch, ready: () => false });
    expect(r2.ok).toBe(false);
    expect(r2.detail).toMatch(/no shell ready/);
    expect(typed).toBe(false);
    expect(prepareForTyping('%1', w.run, () => true).ok).toBe(true);
  });

  // A project Claude Code was never trusted in (the loom repo itself) opened on the
  // "do you trust this folder" dialog: the agent process ran, so the launch read
  // 'started', and the chat sat unseen in a background pane forever.
  it('a pane sitting on the folder-trust dialog is not started, and fails with the question', async () => {
    const { startThread, confirmLaunches, recentLaunches, LAUNCH_CONFIRM_MS, dismissLaunch } = await import('../src/newthread.ts');
    const trustScreen = [' Accessing workspace:', ' /x/loom', ' Quick safety check: Is this a project you created or one you trust? (Like your own code)', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n');
    const w = world('zsh');
    startThread(mk({ prompt: 'untrusted dir' }), w.run, { launch: () => ({ ok: true, detail: 'x' }), ready: () => true });
    const l = recentLaunches().find((x) => x.fullPrompt === 'untrusted dir')!;
    w.state.cmd = '2.1.322';
    w.state.screen = trustScreen;
    confirmLaunches({}, w.run, l.at + 1000, quiet);
    expect(l.status).toBe('starting');
    confirmLaunches({}, w.run, l.at + LAUNCH_CONFIRM_MS + 1, quiet);
    expect(l.status).toBe('failed');
    expect(l.lines!.join('\n')).toMatch(/trust this folder/);
    dismissLaunch(l.id);
  });

  it('pre-trusts the folder only when the composer asked to, and only for Claude', async () => {
    const { startThread, recentLaunches, dismissLaunch } = await import('../src/newthread.ts');
    const trusted: string[] = [];
    const deps = { launch: () => ({ ok: true as const, detail: 'x' }), ready: () => true, pretrust: (d: string) => trusted.push(d) };
    startThread(mk({ prompt: 't1', trust: true }), world('zsh').run, deps);
    startThread(mk({ prompt: 't2' }), world('zsh').run, deps);
    startThread(mk({ prompt: 't3', trust: true, agent: 'codex' }), world('zsh').run, deps);
    expect(trusted).toEqual(['/tmp']);
    for (const l of recentLaunches().filter((x) => ['t1', 't2', 't3'].includes(x.fullPrompt ?? ''))) dismissLaunch(l.id);
  });
});

describe('failed launch card', () => {
  it('renders red with the pane lines, Retry and Edit in composer, and wires them', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('Chat didn’t start in ');
    expect(html).toContain('data-lact="retry"');
    expect(html).toContain('data-lact="edit"');
    expect(html).toContain('class="lpane"');
    expect(html).toContain("fullPrompt||g.prompt");
    expect(html).toContain('/api/new-thread/');
  });

  it('offers to trust an untrusted project folder and sends the choice', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="ctrust"');
    expect(html).toContain("trust:!$('#ctrustrow').hidden&&$('#ctrust').checked");
  });
});
