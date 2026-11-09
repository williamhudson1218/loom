import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import type { LanePane, WorldState } from '../src/compact.ts';
import { LEGACY_LAUNCH_SETTINGS } from '../src/launch.ts';
import { orchSettings, recentLog } from '../src/orchestrator.ts';
import {
  CRASH_WINDOW_MS,
  LAUNCH_GRACE_MS,
  MAX_LAUNCHES_PER_WINDOW,
  ORCH_PROMPT,
  ORCH_ROLE,
  buildOrchestratorCommand,
  ensureOrchFiles,
  ensureOrchToken,
  orchTranscriptPath,
  remoteControlUrl,
  superviseOrchestrator,
  type OrchFiles,
  type SuperviseDeps,
  type SuperviseMemo,
} from '../src/orchsession.ts';

const T0 = 1_700_000_000_000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-orch-'));
const pane = (pane_id: string, extra: Partial<LanePane> = {}): LanePane => ({
  pane_id, tmux_session: 'loom-managed', window_index: '1', pane_index: '0', command: 'zsh', name: '', group: '', agent: false, ...extra,
});

describe('orchestrator files and command', () => {
  it('writes the prompt, an MCP config naming the loom server with the token file, and a private token it reuses', () => {
    const dir = tmpDir();
    const f = ensureOrchFiles(dir, { command: '/Applications/Loom.app/Contents/MacOS/Loom', args: ['/x/orchmcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(fs.readFileSync(f.promptFile, 'utf-8')).toContain('Loom orchestrator');
    const cfg = JSON.parse(fs.readFileSync(f.mcpConfig, 'utf-8'));
    expect(cfg.mcpServers.loom).toEqual({
      type: 'stdio', command: '/Applications/Loom.app/Contents/MacOS/Loom', args: ['/x/orchmcp.js', f.tokenFile], env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const tok = fs.readFileSync(f.tokenFile, 'utf-8').trim();
    expect(tok).toMatch(/^[0-9a-f]{48}$/);
    expect(fs.statSync(f.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureOrchToken(dir)).toBe(tok);
    ensureOrchFiles(dir, { command: 'node', args: [] });
    expect(fs.readFileSync(f.tokenFile, 'utf-8').trim()).toBe(tok);
  });

  it('starts with Remote Control, the MCP config and the prompt; a new session takes its id, a restart resumes it', () => {
    const files: OrchFiles = { dir: "/Users/x/.loom/orchestrator", mcpConfig: '/m.json', promptFile: '/p.md', tokenFile: '/t' };
    const fresh = buildOrchestratorCommand({ files, sessionId: 'abc', resume: false }, LEGACY_LAUNCH_SETTINGS);
    expect(fresh).toContain("cd '/Users/x/.loom/orchestrator' && claude --session-id 'abc'");
    expect(fresh).toContain("--remote-control 'Loom orchestrator'");
    expect(fresh).toContain("--mcp-config '/m.json'");
    expect(fresh).toContain(`--append-system-prompt "$(cat '/p.md')"`);
    expect(fresh).toContain('--dangerously-skip-permissions');
    expect(fresh).not.toContain('--safe-mode');
    const again = buildOrchestratorCommand({ files, sessionId: 'abc', resume: true }, LEGACY_LAUNCH_SETTINGS);
    expect(again).toContain("claude --resume 'abc'");
    expect(again).toContain('CLAUDE_CODE_RESUME_THRESHOLD_MINUTES');
    expect(again).toContain("--remote-control 'Loom orchestrator'");
    expect(again).toContain('Loom restarted you');
  });

  it('tells the session to relay without confirming, keep the items accurate, and only message for needs_you', () => {
    expect(ORCH_PROMPT).toMatch(/without asking them to confirm/);
    expect(ORCH_PROMPT).toMatch(/source of truth/);
    expect(ORCH_PROMPT).toMatch(/Do not message the user about events that do not create or change a needs_you item/);
    expect(ORCH_PROMPT).toMatch(/Keep replies concise/);
  });

  it('reads the Remote Control link back off the pane', () => {
    const run = () => 'Remote Control active\nhttps://claude.ai/code/session_01AbC?x=1 \nmore';
    expect(remoteControlUrl(run, '%4')).toBe('https://claude.ai/code/session_01AbC?x=1');
    expect(remoteControlUrl(() => 'nothing here', '%4')).toBe('');
    expect(remoteControlUrl(() => { throw new Error('no pane'); }, '%4')).toBe('');
  });
});

describe('orchestrator supervision', () => {
  function rig(opts: { panes?: LanePane[]; role?: Record<string, string>; transcript?: boolean } = {}) {
    const db = openDb(':memory:');
    const dir = tmpDir();
    const files = ensureOrchFiles(dir, { command: 'node', args: ['mcp.js'] });
    const calls: string[][] = [];
    const role = { ...(opts.role ?? {}) };
    const world: WorldState = { panes: opts.panes ?? [], focused: null };
    let now = T0;
    let acquired = 0;
    const deps: SuperviseDeps = {
      run: (args) => {
        calls.push(args);
        if (args[0] === 'display-message') return (role[args[3]] ?? '') + '\n';
        if (args[0] === 'set-option' && args[4] === '@loom_role') role[args[3]] = args[5];
        return '';
      },
      world: () => world,
      acquire: () => {
        acquired++;
        const id = `%${40 + acquired}`;
        world.panes.push(pane(id));
        return { ok: true, paneId: id, name: 'red-otter', where: 'loom-managed · red-otter' };
      },
      now: () => now,
      exists: (f) => !!opts.transcript && f.endsWith('.jsonl'),
      uuid: () => '11111111-2222-3333-4444-555555555555',
    };
    const memo: SuperviseMemo = { launches: [] };
    const sends = () => calls.filter((c) => c[0] === 'send-keys' && c[3] === '-l');
    return { db, files, deps, memo, calls, world, role, sends, acquired: () => acquired, tick: (ms: number) => { now += ms; } };
  }

  it('opens a managed window, marks it, and starts a new session with a fixed id', () => {
    const r = rig();
    const out = superviseOrchestrator(r.db, r.files, r.deps, r.memo);
    expect(out).toMatchObject({ action: 'started', paneId: '%41' });
    expect(orchSettings.paneId(r.db)).toBe('%41');
    expect(orchSettings.sessionId(r.db)).toBe('11111111-2222-3333-4444-555555555555');
    expect(r.calls).toContainEqual(['set-option', '-p', '-t', '%41', '@loom_role', ORCH_ROLE]);
    expect(r.calls).toContainEqual(['set-option', '-p', '-t', '%41', '@name', 'orchestrator']);
    expect(r.sends()).toHaveLength(1);
    expect(r.sends()[0][4]).toContain("--session-id '11111111-2222-3333-4444-555555555555'");
    expect(recentLog(r.db, 0).map((l) => l.kind)).toEqual(['started']);
  });

  it('leaves a running orchestrator alone', () => {
    const r = rig({ panes: [pane('%9', { agent: true, command: 'node' })], role: { '%9': ORCH_ROLE } });
    orchSettings.setPaneId(r.db, '%9');
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo)).toMatchObject({ action: 'running' });
    expect(r.sends()).toHaveLength(0);
  });

  it('restarts a session that exited, in its own window, by resuming it', () => {
    const r = rig({ panes: [pane('%9')], role: { '%9': ORCH_ROLE }, transcript: true });
    orchSettings.setPaneId(r.db, '%9');
    orchSettings.setSessionId(r.db, 'sid-1');
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo)).toMatchObject({ action: 'restarted', paneId: '%9' });
    expect(r.acquired()).toBe(0);
    expect(r.sends()[0]).toEqual(['send-keys', '-t', '%9', '-l', expect.stringContaining("claude --resume 'sid-1'")]);
    expect(r.calls.filter((c) => c[0] === 'send-keys').pop()).toEqual(['send-keys', '-t', '%9', 'Enter']);
  });

  it('never mistakes a reused pane id for its window (a new tmux server restarts the numbering)', () => {
    const r = rig({ panes: [pane('%9', { agent: true })], role: {} });
    orchSettings.setPaneId(r.db, '%9');
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo)).toMatchObject({ action: 'started', paneId: '%41' });
  });

  it('waits out a launch that is still starting, and gives up after repeated deaths', () => {
    const r = rig();
    superviseOrchestrator(r.db, r.files, r.deps, r.memo);
    r.tick(LAUNCH_GRACE_MS - 1);
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo).action).toBe('starting');
    for (let i = 1; i < MAX_LAUNCHES_PER_WINDOW; i++) {
      r.tick(LAUNCH_GRACE_MS + 1);
      expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo).action).toBe('restarted');
    }
    r.tick(LAUNCH_GRACE_MS + 1);
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo).action).toBe('gave_up');
    expect(r.sends()).toHaveLength(MAX_LAUNCHES_PER_WINDOW);
    // The window slides: once the old launches age out it tries again.
    r.tick(CRASH_WINDOW_MS);
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo).action).toBe('restarted');
  });

  it('does nothing when turned off, and does not type into a window running something else', () => {
    const off = rig();
    off.db.prepare(`INSERT INTO settings(key, value) VALUES ('orchestrator_enabled', '0')`).run();
    expect(superviseOrchestrator(off.db, off.files, off.deps, off.memo).action).toBe('disabled');
    const busy = rig({ panes: [pane('%9', { command: 'vim' })], role: { '%9': ORCH_ROLE } });
    orchSettings.setPaneId(busy.db, '%9');
    expect(superviseOrchestrator(busy.db, busy.files, busy.deps, busy.memo).action).toBe('busy');
    expect(busy.sends()).toHaveLength(0);
  });

  it('refuses cleanly when no window can be had', () => {
    const r = rig();
    r.deps.acquire = () => ({ ok: false, detail: 'Not starting a new chat: only 0.1 GB of memory is free' });
    expect(superviseOrchestrator(r.db, r.files, r.deps, r.memo)).toEqual({ action: 'refused', detail: 'Not starting a new chat: only 0.1 GB of memory is free' });
  });

  it('keeps its transcript under the orchestrator dir project', () => {
    expect(orchTranscriptPath('/Users/x/.loom/orchestrator', 'sid')).toMatch(/-Users-x--loom-orchestrator\/sid\.jsonl$/);
  });
});
