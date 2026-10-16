import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ansiQuote, buildLaunchCommand } from '../src/goto.ts';
import { chooseTarget, promptWithImages, saveImages, type PaneGeom } from '../src/newthread.ts';
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
    expect(buildLaunchCommand({ projectDir: '/p q', sessionId: '', sourceAgent: 'claude', selectedAgent: 'claude', fresh: true, prompt: 'say hi\nand stop' }))
      .toBe("cd '/p q' && claude --dangerously-skip-permissions $'say hi\\nand stop'");
    expect(buildLaunchCommand({ projectDir: '/p', sessionId: '', sourceAgent: 'codex', selectedAgent: 'codex', fresh: true, prompt: 'go' }))
      .toBe("cd '/p' && codex $'go'");
    expect(buildLaunchCommand({ projectDir: '/p', sessionId: '', sourceAgent: 'claude', selectedAgent: 'claude', fresh: true }))
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
