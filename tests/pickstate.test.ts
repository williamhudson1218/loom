import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { clickAction, hoverFor, HOVER_FRESH_MS, needsTrustCheck, overlaysMatch, PickMachine, pressAction, REPRESS_GRACE_MS } from '../src/pickstate.ts';
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

describe('pressAction in the new phases', () => {
  it('ignores a press while the overlay is still being shown', () => {
    expect(pressAction({ phase: 'starting', shownAt: 0, now: 5000 })).toBe('ignore');
  });
  it('only dismisses while a click is being resolved', () => {
    expect(pressAction({ phase: 'hitting', shownAt: 0, now: 5000 })).toBe('dismiss');
  });
});

describe('clickAction', () => {
  it.each([
    ['idle', 'drop'],
    ['starting', 'drop'],
    ['picking', 'hit'],
    ['hitting', 'drop'],
    ['opening', 'drop'],
  ] as const)('a click while %s: %s', (phase, want) => {
    expect(clickAction(phase)).toBe(want);
  });
});

describe('PickMachine', () => {
  it('press, show, click, open, end', () => {
    const m = new PickMachine();
    expect(m.press(1000)).toBe('open');
    expect(m.phase).toBe('starting');
    expect(m.shown(1010)).toBe(true);
    expect(m.phase).toBe('picking');
    expect(m.click()).toBe('hit');
    expect(m.opening()).toBe(true);
    expect(m.phase).toBe('opening');
    expect(m.end()).toBe('opening');
    expect(m.phase).toBe('idle');
  });
  it('a rapid double press opens once and does not toggle the overlay off', () => {
    const m = new PickMachine();
    expect(m.press(1000)).toBe('open');
    expect(m.press(1050)).toBe('ignore'); // still starting
    m.shown(1060);
    expect(m.press(1100)).toBe('ignore'); // inside the grace window
    expect(m.phase).toBe('picking');
    expect(m.press(1060 + REPRESS_GRACE_MS)).toBe('cancel');
  });
  it('drops a click made while the overlay is being shown', () => {
    const m = new PickMachine();
    m.press(1000);
    expect(m.click()).toBe('drop');
    expect(m.phase).toBe('starting');
  });
  it('a double click resolves once: the second click is dropped while the first is in flight', () => {
    const m = new PickMachine();
    m.press(0);
    m.shown(1);
    expect(m.click()).toBe('hit');
    expect(m.click()).toBe('drop');
    expect(m.opening()).toBe(true);
    expect(m.click()).toBe('drop');
  });
  it('a miss goes back to picking, so the next click is resolved', () => {
    const m = new PickMachine();
    m.press(0);
    m.shown(1);
    m.click();
    expect(m.retry()).toBe(true);
    expect(m.click()).toBe('hit');
  });
  it('Esc mid-open ends the pick, and the late result can neither reopen nor retry it', () => {
    const m = new PickMachine();
    m.press(0);
    m.shown(1);
    m.click();
    m.opening();
    m.end(); // Esc
    expect(m.opening()).toBe(false);
    expect(m.retry()).toBe(false);
    expect(m.phase).toBe('idle');
    expect(m.press(10)).toBe('open');
  });
  it('Esc during the hit-test: the result is ignored', () => {
    const m = new PickMachine();
    m.press(0);
    m.shown(1);
    m.click();
    m.end();
    expect(m.opening()).toBe(false);
  });
  it('a pick ended before its overlays were shown stays ended', () => {
    const m = new PickMachine();
    m.press(0);
    m.end();
    expect(m.shown(5)).toBe(false);
    expect(m.phase).toBe('idle');
  });
});

describe('hoverFor', () => {
  const h = { rect: { x: 100, y: 200, w: 300, h: 40 }, at: 1000, hit: 'msg' };
  it('uses the outlined message when the click is inside it and the outline is fresh', () => {
    expect(hoverFor(h, 150, 210, 1500)).toBe('msg');
  });
  it('not when the click is outside it', () => {
    expect(hoverFor(h, 99, 210, 1500)).toBeNull();
    expect(hoverFor(h, 150, 240, 1500)).toBeNull();
  });
  it('not when the outline is stale, or there is none', () => {
    expect(hoverFor(h, 150, 210, 1000 + HOVER_FRESH_MS + 1)).toBeNull();
    expect(hoverFor(null, 150, 210, 1500)).toBeNull();
  });
});

describe('the overlay renderer', () => {
  // Runs the overlay's script against stub DOM and ipcRenderer objects.
  function load() {
    const sent: [string, unknown][] = [];
    const handlers: Record<string, (e: unknown, v?: unknown) => void> = {};
    const listeners: Record<string, (e: unknown) => void> = {};
    const el = () => ({ style: {} as Record<string, string>, textContent: '', className: '' });
    const els: Record<string, ReturnType<typeof el>> = { box: el(), hint: el(), msg: el(), spin: el() };
    const ctx = {
      require: () => ({ ipcRenderer: { send: (c: string, v: unknown) => sent.push([c, v]), on: (c: string, f: (e: unknown, v?: unknown) => void) => (handlers[c] = f) } }),
      location: { hash: '#' + encodeURIComponent(JSON.stringify({ x: -1512, y: 0, d: 1 })) },
      document: { getElementById: (id: string) => els[id], body: { style: {} as Record<string, string> }, visibilityState: 'visible' },
      window: { addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f) },
      requestAnimationFrame: (f: () => void) => f(),
      setTimeout: () => 0,
      clearTimeout: () => {},
      Date,
      JSON,
      decodeURIComponent,
      Object,
    };
    const src = [...OVERLAY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    vm.runInNewContext(src, ctx);
    return { sent, handlers, listeners, els };
  }
  it('sends the click first, with its global screen point and display', () => {
    const { sent, listeners } = load();
    let prevented = false;
    listeners.mousedown({ clientX: 30, clientY: 40, button: 0, preventDefault: () => (prevented = true) });
    expect(sent[0][0]).toBe('loom-pick-click');
    expect(sent[0][1]).toMatchObject({ x: -1482, y: 40, d: 1, button: 0 });
    expect(typeof (sent[0][1] as { t: number }).t).toBe('number');
    expect(prevented).toBe(true);
  });
  it('reports when a reset has painted', () => {
    const { sent, handlers } = load();
    handlers.reset({});
    expect(sent.find(([c]) => c === 'loom-pick-painted')?.[1]).toMatchObject({ d: 1, vis: 'visible' });
  });
  it('shows the busy state with a spinner, and an error in place', () => {
    const { handlers, els } = load();
    handlers.busy({}, 'Opening…');
    expect(els.msg.textContent).toBe('Opening…');
    expect(els.hint.className).toBe('busy');
    handlers.error({}, 'No project directory for chat 1234');
    expect(els.msg.textContent).toBe('No project directory for chat 1234');
    expect(els.hint.className).toBe('err');
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
