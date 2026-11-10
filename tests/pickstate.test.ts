import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { needsTrustCheck, overlaysMatch, pressAction, PickTimer, REPRESS_GRACE_MS } from '../src/pickstate.ts';
import { NEW_THREAD_HTML, OVERLAY_HTML, PASTE_HTML, newThreadWhere } from '../src/pickpages.ts';

const A = { x: 0, y: 0, width: 1512, height: 982 };
const B = { x: 1512, y: -200, width: 2560, height: 1440 };

describe('overlaysMatch', () => {
  it('reuses the overlays while the displays are the same, in any order', () => {
    expect(overlaysMatch([A, B], [B, A])).toBe(true);
    expect(overlaysMatch([A], [A])).toBe(true);
  });
  it('rebuilds when a display is added, removed, moved or resized', () => {
    expect(overlaysMatch([], [A])).toBe(false);
    expect(overlaysMatch([A], [A, B])).toBe(false);
    expect(overlaysMatch([A, B], [A])).toBe(false);
    expect(overlaysMatch([A], [{ ...A, width: 1728 }])).toBe(false);
    expect(overlaysMatch([B], [{ ...B, x: -2560 }])).toBe(false);
  });
});

describe('pressAction', () => {
  it('opens when idle', () => {
    expect(pressAction({ phase: 'idle', shownAt: 0, now: 5 })).toBe('open');
  });
  it('ignores a second press right after the overlay appeared, instead of toggling it off', () => {
    expect(pressAction({ phase: 'picking', shownAt: 1000, now: 1000 + REPRESS_GRACE_MS - 1 })).toBe('ignore');
  });
  it('cancels on a later press while picking', () => {
    expect(pressAction({ phase: 'picking', shownAt: 1000, now: 1000 + REPRESS_GRACE_MS })).toBe('cancel');
  });
  it('only dismisses the overlay while a picked thread is opening', () => {
    expect(pressAction({ phase: 'opening', shownAt: 1000, now: 1001 })).toBe('dismiss');
  });
});

describe('needsTrustCheck', () => {
  it('asks the helper until it has said yes, then not again', () => {
    expect(needsTrustCheck(false)).toBe(true);
    expect(needsTrustCheck(true)).toBe(false);
  });
});

describe('PickTimer', () => {
  it('records marks from the press when on, nothing when off', () => {
    let t = 100;
    const on = new PickTimer(true, () => t);
    on.start();
    t = 103.4;
    on.mark('shown');
    t = 250;
    on.mark('click');
    expect(on.line()).toBe('shown=3.4ms click=150.0ms');
    const off = new PickTimer(false, () => t);
    off.start();
    off.mark('shown');
    expect(off.line()).toBe('');
  });
});

describe('the pick pages', () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  it.each([
    ['overlay', OVERLAY_HTML],
    ['paste', PASTE_HTML],
    ['new thread', NEW_THREAD_HTML],
  ])('the %s page is one document whose script parses', (_name, html) => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    const s = scripts(html);
    expect(s).toHaveLength(1);
    expect(() => new vm.Script(s[0])).not.toThrow();
  });
  it('the overlay resets between picks and shows a busy state after the click', () => {
    expect(OVERLAY_HTML).toContain("ipcRenderer.on('reset'");
    expect(OVERLAY_HTML).toContain("ipcRenderer.on('busy'");
  });
  it('the new-thread prompt offers context, send as is, and cancel, in plain copy', () => {
    for (const t of ['No open chat for this thread', 'Add context for Claude (optional)', 'Start with context', 'Send as is', 'Cancel']) expect(NEW_THREAD_HTML).toContain(t);
    expect(NEW_THREAD_HTML).not.toMatch(/!\s*</);
  });
});

describe('newThreadWhere', () => {
  it('names the channel, the author and the start of the message', () => {
    expect(newThreadWhere({ channel: 'C1', channelName: 'filings', author: 'Alex', text: 'Can you  confirm\nWV?' })).toBe('#filings · Alex: Can you confirm WV?');
  });
  it('falls back to the channel id, and trims a long message', () => {
    expect(newThreadWhere({ channel: 'C1' })).toBe('C1');
    const w = newThreadWhere({ channel: 'C1', text: 'x'.repeat(200) });
    expect(w.startsWith('C1 · ')).toBe(true);
    expect(w.endsWith('…')).toBe(true);
    expect(w.length).toBe('C1 · '.length + 90);
  });
});
