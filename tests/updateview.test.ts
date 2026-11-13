import { describe, it, expect } from 'vitest';
import { UPDATE_VIEW_JS } from '../src/updateview.ts';

// The page half of Settings › Updates and the header's Update ready, run with
// stand-ins for the dashboard globals it uses. The bug: one click on Check for
// updates showed nothing (the board's 5s re-render put the idle button back and
// the page never heard the check finish), so it took a second click.

type St = Record<string, unknown>;
function page(initial: St) {
  const el = (o: Record<string, unknown> = {}) => ({ hidden: true, textContent: '', innerHTML: '', title: '', disabled: false, querySelector: () => ({ textContent: '' }), addEventListener() {}, ...o });
  const els: Record<string, ReturnType<typeof el>> = { '#updwrap': el(), '#updbtn': el(), '#updmenu': el() };
  const toasts: string[] = [];
  const posts: Array<(v: unknown) => void> = [];
  let pushed: ((s: St) => void) | null = null;
  const calls: string[] = [];
  let server: St = initial;
  const g = {
    $: (q: string) => els[q] || null,
    esc: (s: string) => s,
    toast: (m: string) => toasts.push(m),
    tab: 'settings',
    SX: { sec: 'updates' },
    sxRerender: () => {},
    sxPill: (_k: string, l: string) => `[${l}]`,
    sxBtn: (a: string, l: string, o: { dis?: boolean } = {}) => `<${a}:${l}${o.dis ? ':disabled' : ''}>`,
    sxRow: (_t: string, _h: string, c: string) => c,
    sxKey: () => '',
    sxNote: () => '',
    sxGrp: () => '',
    sxAgo: () => '',
    sxWhen: () => '',
    sxEsc: (s: string) => s,
    hmenuToggle() {},
    hmenuClose() {},
    setInterval: () => 1,
    clearInterval() {},
    window: {
      loomNative: {
        onUpdateState: (cb: (s: St) => void) => {
          calls.push('subscribe');
          pushed = cb;
          return () => {};
        },
      },
    },
    fetch: (url: string, o?: { method?: string }) => {
      if (o?.method === 'POST') return new Promise((res) => posts.push(res));
      calls.push('read');
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: server }) });
    },
  };
  const names = Object.keys(g);
  const api = new Function(...names, `${UPDATE_VIEW_JS}; return { wireUpdates, updCheck, sxUpdates, updLoad };`)(...names.map((k) => (g as Record<string, unknown>)[k])) as {
    wireUpdates(): void;
    updCheck(btn: unknown): Promise<unknown>;
    sxUpdates(): string;
    updLoad(): Promise<unknown>;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    api, els, toasts, calls, flush,
    setServer: (s: St) => (server = s),
    push: (s: St) => pushed!(s),
    answerPost: (s: St) => posts.shift()!({ json: () => Promise.resolve({ ok: true, state: s }) }),
  };
}

const base = { current: '0.1.5', channel: 'release', commit: 'abc', writable: true, latest: null, ready: null, detail: null, lastChecked: 1, progress: null };

describe('Check for updates: one click', () => {
  it('shows Checking at once and keeps showing it through the board re-render', async () => {
    const p = page({ ...base, status: 'current' });
    p.api.wireUpdates();
    await p.flush();
    void p.api.updCheck({ textContent: '', disabled: false });
    // The board re-renders Settings every few seconds from the page's state.
    const html = p.api.sxUpdates();
    expect(html).toContain('<updcheck:Checking…:disabled>');
    expect(html).toContain('[Checking…]');
  });

  it('follows the pushed state to Downloading x%, Verifying, then Update ready, with no second click', async () => {
    const p = page({ ...base, status: 'current' });
    p.api.wireUpdates();
    await p.flush();
    void p.api.updCheck({ textContent: '', disabled: false });
    p.answerPost({ ...base, status: 'checking' });
    await p.flush();
    const latest = { version: '0.1.9', notes: [] };
    p.push({ ...base, status: 'downloading', latest, progress: 40 });
    expect(p.api.sxUpdates()).toContain('[Downloading 0.1.9 40%]');
    p.push({ ...base, status: 'verifying', latest });
    expect(p.api.sxUpdates()).toContain('[Verifying 0.1.9]');
    expect(p.els['#updwrap'].hidden).toBe(true);
    p.push({ ...base, status: 'ready', latest, ready: { version: '0.1.9', app: '/x', notes: [] } });
    expect(p.els['#updwrap'].hidden).toBe(false);
    expect(p.toasts).toEqual(['Loom 0.1.9 is ready to install']);
  });

  it('says when it is already the latest version', async () => {
    const p = page({ ...base, status: 'idle' });
    p.api.wireUpdates();
    await p.flush();
    void p.api.updCheck({ textContent: '', disabled: false });
    p.answerPost({ ...base, status: 'checking' });
    await p.flush();
    p.push({ ...base, status: 'current' });
    expect(p.toasts).toEqual(["You're on the latest version (0.1.5)"]);
  });

  it('says why a check failed', async () => {
    const p = page({ ...base, status: 'idle' });
    p.api.wireUpdates();
    await p.flush();
    void p.api.updCheck({ textContent: '', disabled: false });
    p.answerPost({ ...base, status: 'error', detail: 'Could not check for updates: offline' });
    await p.flush();
    expect(p.toasts).toEqual(['Could not check for updates: offline']);
  });

  it('subscribes to pushes before reading the state on load, so a change in between is not missed', async () => {
    const p = page({ ...base, status: 'ready', ready: { version: '0.1.9', app: '/x', notes: [] } });
    p.api.wireUpdates();
    await p.flush();
    expect(p.calls.slice(0, 2)).toEqual(['subscribe', 'read']);
    expect(p.els['#updwrap'].hidden).toBe(false);
  });
});
