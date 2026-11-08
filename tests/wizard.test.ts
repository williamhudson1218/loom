import { describe, expect, it } from 'vitest';
import {
  STEP_IDS,
  STEPS,
  allRequirementsMet,
  back,
  buildSummary,
  close,
  continueStep,
  finish,
  freshState,
  goTo,
  isVisible,
  nextVisible,
  parseState,
  prevVisible,
  progress,
  rail,
  rerun,
  shouldShow,
  skipStep,
  validateContinue,
  visibleSteps,
  type StepId,
  type Transition,
  type WizardCtx,
  type WizardState,
} from '../src/wizard.ts';

const direct: WizardCtx = { slackMode: 'direct' };
const mcp: WizardCtx = { slackMode: 'mcp' };
const off: WizardCtx = { slackMode: 'off' };
const REQ = { tmux: true, claude: true, claudeLoggedIn: true, python3: true };

function ok(t: Transition): WizardState {
  if (!t.ok) throw new Error('expected ok, got: ' + t.error);
  return t.state;
}

/** Continue the current step until `id` is current. */
function walkTo(id: StepId, ctx: WizardCtx = direct): WizardState {
  let s = freshState();
  while (s.current !== id) s = ok(continueStep(s, s.current, ctx, { requirements: REQ }, 1));
  return s;
}

describe('the step list', () => {
  it('has the 12 steps in the design order', () => {
    expect(STEP_IDS).toEqual(['welcome', 'requirements', 'projects', 'terminal', 'permissions', 'plugin', 'slack', 'shortcut', 'ship', 'orchestrator', 'watchers', 'done']);
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
  });
  it('blocks only requirements; only welcome, requirements and done cannot be skipped', () => {
    expect(STEPS.filter((s) => s.blocking).map((s) => s.id)).toEqual(['requirements']);
    expect(STEPS.filter((s) => !s.skippable).map((s) => s.id)).toEqual(['welcome', 'requirements', 'done']);
  });
  it('gives every step a purpose and something it unlocks', () => {
    for (const s of STEPS) {
      expect(s.why.length).toBeGreaterThan(20);
      expect(s.unlocks.length).toBeGreaterThan(0);
    }
  });
  it('names nobody and no vendor-specific setup in its copy', () => {
    const text = JSON.stringify(STEPS);
    expect(text).not.toMatch(/Will|Tax Pilot|Superset|loom-tp/);
  });
});

describe('guards', () => {
  it('hides the shortcut step only when Slack is off', () => {
    expect(isVisible('shortcut', direct)).toBe(true);
    expect(isVisible('shortcut', mcp)).toBe(true);
    expect(isVisible('shortcut', off)).toBe(false);
    for (const id of STEP_IDS) if (id !== 'shortcut') expect(isVisible(id, off)).toBe(true);
    expect(visibleSteps(off)).toHaveLength(11);
    expect(visibleSteps(direct)).toHaveLength(12);
  });
  it('next and previous skip a hidden step', () => {
    expect(nextVisible('slack', direct)).toBe('shortcut');
    expect(nextVisible('slack', off)).toBe('ship');
    expect(prevVisible('ship', off)).toBe('slack');
    expect(prevVisible('ship', direct)).toBe('shortcut');
    expect(nextVisible('done', direct)).toBeNull();
    expect(prevVisible('welcome', direct)).toBeNull();
  });
  it('requirements need tmux, claude, a claude login and python3', () => {
    expect(validateContinue('requirements', { requirements: REQ })).toBeNull();
    expect(validateContinue('requirements', {})).toMatch(/has not run/);
    expect(validateContinue('requirements', { requirements: { ...REQ, tmux: false } })).toMatch(/tmux/);
    expect(validateContinue('requirements', { requirements: { ...REQ, claudeLoggedIn: false } })).toMatch(/login/);
    expect(validateContinue('requirements', { requirements: { ...REQ, claude: false, claudeLoggedIn: false } })).toMatch(/Claude Code/);
    expect(validateContinue('requirements', { requirements: { ...REQ, python3: false } })).toMatch(/python3/);
    expect(allRequirementsMet(REQ)).toBe(true);
    expect(allRequirementsMet({ ...REQ, python3: false })).toBe(false);
  });
  it('skip permissions needs the checkbox, for any of the three switches', () => {
    expect(validateContinue('permissions', { permChats: 'normal' })).toBeNull();
    expect(validateContinue('permissions', { permChats: 'skip' })).toMatch(/Tick the box/);
    expect(validateContinue('permissions', { permChats: 'skip', confirmSkip: true })).toBeNull();
    expect(validateContinue('permissions', { permChats: 'normal', permOrchestrator: 'skip' })).toMatch(/Tick the box/);
    expect(validateContinue('permissions', { permWatchers: 'skip', confirmSkip: true })).toBeNull();
  });
});

describe('continue', () => {
  it('starts on welcome and advances one visible step at a time', () => {
    let s = freshState();
    expect(s.current).toBe('welcome');
    s = ok(continueStep(s, 'welcome', direct, {}, 10));
    expect(s.current).toBe('requirements');
    expect(s.steps.welcome).toEqual({ status: 'done', at: 10 });
  });
  it('refuses requirements until they pass, and does not move', () => {
    const s = walkTo('requirements');
    const t = continueStep(s, 'requirements', direct, { requirements: { ...REQ, tmux: false } }, 5);
    expect(t.ok).toBe(false);
    expect(s.current).toBe('requirements');
    expect(s.steps.requirements.status).toBe('pending');
  });
  it('refuses a step that is not the current one', () => {
    expect(continueStep(freshState(), 'terminal', direct, {}, 1).ok).toBe(false);
  });
  it('refuses to continue the Done step', () => {
    expect(continueStep(walkTo('done'), 'done', direct, {}, 1).ok).toBe(false);
  });
  it('does not mutate the state it was given', () => {
    const s = freshState();
    const before = JSON.stringify(s);
    continueStep(s, 'welcome', direct, {}, 1);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('lands on the shortcut step after Slack when Slack is on', () => {
    const s = walkTo('slack');
    expect(ok(continueStep(s, 'slack', direct, {}, 2)).current).toBe('shortcut');
    expect(ok(continueStep(s, 'slack', mcp, {}, 2)).current).toBe('shortcut');
  });
  it('passes over the shortcut step, marking it skipped, when Slack is off', () => {
    const s = ok(continueStep(walkTo('slack'), 'slack', off, {}, 7));
    expect(s.current).toBe('ship');
    expect(s.steps.slack.status).toBe('done');
    expect(s.steps.shortcut).toEqual({ status: 'skipped', at: 7 });
  });
});

describe('skip', () => {
  it('skips an optional step without a check, and moves on', () => {
    const s = ok(skipStep(walkTo('projects'), 'projects', direct, 3));
    expect(s.steps.projects).toEqual({ status: 'skipped', at: 3 });
    expect(s.current).toBe('terminal');
  });
  it('skipping Slack also skips the shortcut step', () => {
    const s = ok(skipStep(walkTo('slack'), 'slack', off, 4));
    expect(s.steps.slack.status).toBe('skipped');
    expect(s.steps.shortcut.status).toBe('skipped');
    expect(s.current).toBe('ship');
  });
  it('refuses to skip welcome, requirements and done', () => {
    expect(skipStep(freshState(), 'welcome', direct, 1).ok).toBe(false);
    expect(skipStep(walkTo('requirements'), 'requirements', direct, 1).ok).toBe(false);
    expect(skipStep(walkTo('done'), 'done', direct, 1).ok).toBe(false);
  });
  it('skipping permissions needs no confirmation, since nothing is written', () => {
    expect(skipStep(walkTo('permissions'), 'permissions', direct, 1).ok).toBe(true);
  });
});

describe('back', () => {
  it('goes to the previous visible step and keeps every status', () => {
    const s = walkTo('terminal');
    const b = ok(back(s, direct));
    expect(b.current).toBe('projects');
    expect(b.steps.projects.status).toBe('done');
    expect(b.steps.terminal.status).toBe('pending');
  });
  it('steps over the hidden shortcut step', () => {
    const s = ok(continueStep(walkTo('slack'), 'slack', off, {}, 1));
    expect(s.current).toBe('ship');
    expect(ok(back(s, off)).current).toBe('slack');
  });
  it('is refused on the first step', () => {
    expect(back(freshState(), direct).ok).toBe(false);
  });
  it('continuing again after Back re-settles the step', () => {
    const s = ok(back(walkTo('terminal'), direct));
    const again = ok(continueStep(s, 'projects', direct, {}, 99));
    expect(again.steps.projects.at).toBe(99);
    expect(again.current).toBe('terminal');
  });
  it('turning Slack on after going back brings the shortcut step back', () => {
    let s = ok(continueStep(walkTo('slack'), 'slack', off, {}, 1)); // shortcut skipped
    s = ok(back(s, off));
    expect(s.current).toBe('slack');
    s = ok(continueStep(s, 'slack', direct, {}, 2));
    expect(s.current).toBe('shortcut');
  });
});

describe('goTo (the rail)', () => {
  it('allows settled steps and the current one', () => {
    const s = walkTo('plugin');
    expect(goTo(s, 'projects', direct).ok).toBe(true);
    expect(ok(goTo(s, 'welcome', direct)).current).toBe('welcome');
    expect(goTo(s, 'plugin', direct).ok).toBe(true);
  });
  it('refuses to jump forward over pending steps', () => {
    expect(goTo(walkTo('plugin'), 'ship', direct).ok).toBe(false);
    expect(goTo(freshState(), 'done', direct).ok).toBe(false);
  });
  it('refuses anything past requirements until requirements are done', () => {
    const s = ok(back(walkTo('requirements'), direct)); // on welcome, requirements pending
    expect(goTo(s, 'projects', direct).ok).toBe(false);
  });
  it('refuses a hidden step', () => {
    expect(goTo(walkTo('ship', off), 'shortcut', off).ok).toBe(false);
  });
  it('lets a skipped step be revisited', () => {
    const s = ok(skipStep(walkTo('projects'), 'projects', direct, 1));
    expect(goTo(s, 'projects', direct).ok).toBe(true);
  });
});

describe('close and resume', () => {
  it('close changes nothing, so a reopen lands on the same step with the same progress', () => {
    const s = walkTo('slack');
    const closed = close(s);
    expect(closed).toEqual(s);
    expect(closed).not.toBe(s);
    const stored = JSON.parse(JSON.stringify(closed));
    const reopened = parseState(stored);
    expect(reopened.current).toBe('slack');
    expect(reopened.steps.welcome.status).toBe('done');
    expect(reopened.steps.slack.status).toBe('pending');
  });
  it('closing does not write a done marker', () => {
    expect(shouldShow({ completedAt: 0, origin: '' })).toBe(true);
    const s = close(walkTo('done'));
    expect(s.steps.done.status).toBe('pending');
  });
  it('parseState survives junk and drops unknown ids and statuses', () => {
    for (const junk of [null, undefined, 5, 'x', [], {}, { current: 'nope' }, { steps: 3 }]) {
      const s = parseState(junk);
      expect(s.current).toBe('welcome');
      expect(Object.keys(s.steps)).toEqual([...STEP_IDS]);
    }
    const s = parseState({ current: 'plugin', steps: { welcome: { status: 'done', at: 5 }, plugin: { status: 'weird' }, bogus: { status: 'done' }, slack: { status: 'skipped', at: 'x' } } });
    expect(s.current).toBe('plugin');
    expect(s.steps.welcome).toEqual({ status: 'done', at: 5 });
    expect(s.steps.plugin.status).toBe('pending');
    expect(s.steps.slack).toEqual({ status: 'skipped', at: 0 });
    expect('bogus' in s.steps).toBe(false);
  });
  it('round-trips through JSON', () => {
    const s = walkTo('orchestrator');
    expect(parseState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('the done marker', () => {
  it('shows the wizard only without a marker and off a migrated install', () => {
    expect(shouldShow({ completedAt: 0, origin: '' })).toBe(true);
    expect(shouldShow({ completedAt: 0, origin: 'fresh' })).toBe(true);
    expect(shouldShow({ completedAt: 123, origin: 'fresh' })).toBe(false);
    expect(shouldShow({ completedAt: 0, origin: 'migrated' })).toBe(false);
    expect(shouldShow({ completedAt: 123, origin: 'migrated' })).toBe(false);
    expect(shouldShow({ completedAt: NaN, origin: '' })).toBe(true);
  });
  it('finish needs the last step and passed requirements', () => {
    expect(finish(freshState(), '', 5).ok).toBe(false);
    const s = walkTo('done');
    const bad = { ...s, steps: { ...s.steps, requirements: { status: 'pending' as const, at: 0 } } };
    expect(finish(bad, '', 5).ok).toBe(false);
  });
  it('finish marks done and returns the marker with origin fresh', () => {
    const f = finish(walkTo('done'), '', 777);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.state.steps.done).toEqual({ status: 'done', at: 777 });
    expect(f.marker).toEqual({ completedAt: 777, origin: 'fresh' });
    expect(shouldShow(f.marker)).toBe(false);
  });
  it('finishing a re-run on a migrated install keeps the origin migrated', () => {
    const f = finish(walkTo('done'), 'migrated', 900);
    expect(f.ok && f.marker).toEqual({ completedAt: 900, origin: 'migrated' });
  });
  it('re-run starts over at Welcome with every step pending, and leaves the marker alone', () => {
    const r = rerun();
    expect(r.current).toBe('welcome');
    expect(Object.values(r.steps).every((e) => e.status === 'pending')).toBe(true);
    expect(shouldShow({ completedAt: 5, origin: 'fresh' })).toBe(false);
  });
});

describe('rail and progress', () => {
  it('marks status, current and reachability', () => {
    const s = walkTo('permissions');
    const r = rail(s, direct);
    expect(r.find((x) => x.id === 'permissions')!.current).toBe(true);
    expect(r.find((x) => x.id === 'projects')!.status).toBe('done');
    expect(r.find((x) => x.id === 'projects')!.reachable).toBe(true);
    expect(r.find((x) => x.id === 'ship')!.reachable).toBe(false);
    expect(r.find((x) => x.id === 'shortcut')!.visible).toBe(true);
    expect(rail(s, off).find((x) => x.id === 'shortcut')!.visible).toBe(false);
  });
  it('counts only visible steps', () => {
    expect(progress(freshState(), direct)).toEqual({ index: 1, total: 12, percent: 8 });
    expect(progress(walkTo('ship', off), off)).toEqual({ index: 8, total: 11, percent: 73 });
    expect(progress(walkTo('done'), direct).percent).toBe(100);
  });
});

describe('the done summary', () => {
  const base = {
    projects: [], terminal: 'inside', permChats: 'normal' as const, pluginInstalled: false, slackMode: 'off' as const, slackConnected: false,
    shortcut: '⌘⇧L', shortcutReady: null, shipRepos: [], orchestrator: false, watchers: 0,
  };
  it('says what is off on a minimal install', () => {
    const rows = buildSummary(base);
    expect(rows.map((r) => r.id)).toEqual(['projects', 'terminal', 'permissions', 'plugin', 'slack', 'shortcut', 'ship', 'orchestrator', 'watchers']);
    expect(rows.find((r) => r.id === 'slack')).toMatchObject({ on: false, detail: 'Off' });
    expect(rows.find((r) => r.id === 'shortcut')).toMatchObject({ on: false, detail: 'Off (needs Slack)' });
    expect(rows.find((r) => r.id === 'plugin')!.on).toBe(false);
    expect(rows.find((r) => r.id === 'terminal')!.detail).toBe('Inside Loom');
  });
  it('reflects direct Slack, a ready shortcut, skip permissions, ship and watchers', () => {
    const rows = buildSummary({ ...base, projects: ['a', 'b'], permChats: 'skip', pluginInstalled: true, slackMode: 'direct', slackConnected: true, slackTeam: 'Acme', shortcutReady: true, shipRepos: ['o/r'], orchestrator: true, watchers: 2 });
    expect(rows.find((r) => r.id === 'projects')!.detail).toBe('2 added: a, b');
    expect(rows.find((r) => r.id === 'permissions')!.detail).toBe('Skip permissions for chats');
    expect(rows.find((r) => r.id === 'slack')).toMatchObject({ on: true, detail: 'Direct app, connected to Acme' });
    expect(rows.find((r) => r.id === 'shortcut')).toMatchObject({ on: true, detail: 'Ready' });
    expect(rows.find((r) => r.id === 'watchers')!.detail).toMatch(/^2 templates/);
  });
  it('flags an untested direct token and a missing Accessibility grant', () => {
    const rows = buildSummary({ ...base, slackMode: 'direct', slackConnected: false, shortcutReady: false });
    expect(rows.find((r) => r.id === 'slack')).toMatchObject({ on: false, detail: 'Direct app, token not tested' });
    expect(rows.find((r) => r.id === 'shortcut')).toMatchObject({ on: false, detail: 'Accessibility not granted' });
  });
});
