import { describe, it, expect, vi } from 'vitest';
import { findTab, focusArgs, focusTabScript, listTabsScript, openUrl, parseDefaultBrowser, parseTabList, urlMatches, type OpenDeps } from '../src/openurl.ts';

describe('urlMatches', () => {
  it('matches the same page ignoring a trailing slash, query and hash', () => {
    expect(urlMatches('https://example.com/a/b', 'https://example.com/a/b')).toBe(true);
    expect(urlMatches('https://example.com/a/b/', 'https://example.com/a/b')).toBe(true);
    expect(urlMatches('https://example.com/a/b', 'https://example.com/a/b/')).toBe(true);
    expect(urlMatches('https://example.com/a/b?x=1#top', 'https://example.com/a/b')).toBe(true);
    expect(urlMatches('https://example.com/a/b', 'https://example.com/a/b?y=2#z')).toBe(true);
    expect(urlMatches('https://example.com', 'https://example.com/')).toBe(true);
    expect(urlMatches('https://example.com/?q=1', 'https://example.com')).toBe(true);
  });
  it('treats host case and a default port as the same', () => {
    expect(urlMatches('https://Example.COM/a', 'https://example.com/a')).toBe(true);
    expect(urlMatches('https://example.com:443/a', 'https://example.com/a')).toBe(true);
    expect(urlMatches('http://example.com:80/a', 'http://example.com/a')).toBe(true);
  });
  it('rejects a different scheme, host, port or path', () => {
    expect(urlMatches('http://example.com/a', 'https://example.com/a')).toBe(false);
    expect(urlMatches('https://www.example.com/a', 'https://example.com/a')).toBe(false);
    expect(urlMatches('https://example.com:8443/a', 'https://example.com/a')).toBe(false);
    expect(urlMatches('http://localhost:3000/a', 'http://localhost:3001/a')).toBe(false);
    expect(urlMatches('https://example.com/a/b', 'https://example.com/a')).toBe(false);
    expect(urlMatches('https://example.com/a', 'https://example.com/a/b')).toBe(false);
    expect(urlMatches('https://example.com/A', 'https://example.com/a')).toBe(false);
  });
  it('never matches non-http(s) or unparsable URLs', () => {
    expect(urlMatches('about:blank', 'about:blank')).toBe(false);
    expect(urlMatches('chrome://newtab/', 'chrome://newtab/')).toBe(false);
    expect(urlMatches('file:///a', 'file:///a')).toBe(false);
    expect(urlMatches('', '')).toBe(false);
    expect(urlMatches('not a url', 'not a url')).toBe(false);
    expect(urlMatches('https://example.com/a', 'javascript:alert(1)')).toBe(false);
  });
});

describe('tab list', () => {
  const out = '101\t1\thttps://example.com/one\n101\t2\thttps://example.com/two?x=1\n202\t1\thttp://localhost:3000/app/\nbroken line\nx\t1\thttps://bad\n';
  it('parses lines and skips malformed ones', () => {
    expect(parseTabList(out)).toEqual([
      { windowId: 101, tab: 1, url: 'https://example.com/one' },
      { windowId: 101, tab: 2, url: 'https://example.com/two?x=1' },
      { windowId: 202, tab: 1, url: 'http://localhost:3000/app/' },
    ]);
    expect(parseTabList('')).toEqual([]);
  });
  it('findTab returns the first match', () => {
    const tabs = parseTabList(out);
    expect(findTab(tabs, 'https://example.com/two')).toEqual(tabs[1]);
    expect(findTab(tabs, 'http://localhost:3000/app')).toEqual(tabs[2]);
    expect(findTab(tabs, 'https://example.com/three')).toBeNull();
  });
});

describe('parseDefaultBrowser', () => {
  const plist = (bundle: string, scheme = 'https') => `(
        {
        LSHandlerContentType = "public.url";
        LSHandlerPreferredVersions =         {
            LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "com.example.other";
    },
        {
        LSHandlerPreferredVersions =         {
            LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "${bundle}";
        LSHandlerURLScheme = ${scheme};
    }
)`;
  it('maps the https handler to a supported browser', () => {
    expect(parseDefaultBrowser(plist('com.google.chrome'))).toBe('chrome');
    expect(parseDefaultBrowser(plist('com.google.Chrome'))).toBe('chrome');
    expect(parseDefaultBrowser(plist('company.thebrowser.browser'))).toBe('arc');
    expect(parseDefaultBrowser(plist('com.apple.safari'))).toBe('safari');
    expect(parseDefaultBrowser(plist('com.apple.safari', '"http"'))).toBe('safari');
  });
  it('says other for an unsupported browser and null when nothing names one', () => {
    expect(parseDefaultBrowser(plist('org.mozilla.firefox'))).toBe('other');
    expect(parseDefaultBrowser('(\n)')).toBeNull();
    expect(parseDefaultBrowser('')).toBeNull();
    expect(parseDefaultBrowser(plist('-'))).toBeNull();
  });
  it('prefers https over http', () => {
    const both = plist('com.apple.safari', 'http') + plist('com.google.chrome', 'https');
    expect(parseDefaultBrowser(both)).toBe('chrome');
  });
});

describe('scripts', () => {
  it('the list script never launches the browser and carries no URL', () => {
    for (const b of ['chrome', 'arc', 'safari'] as const) {
      const s = listTabsScript(b);
      expect(s.split('\n')[0]).toMatch(/is not running then return ""/);
      expect(s).not.toMatch(/https?:/);
    }
    expect(listTabsScript('chrome')).toContain('application "Google Chrome"');
    expect(listTabsScript('safari')).toContain('application "Safari"');
    expect(listTabsScript('arc')).toContain('application "Arc"');
  });
  it('the focus script takes its target as argv, so no URL can reach the script text', () => {
    for (const b of ['chrome', 'arc', 'safari'] as const) {
      const s = focusTabScript(b);
      expect(s).toContain('item 1 of argv');
      expect(s).toContain('activate');
      expect(s).not.toMatch(/https?:/);
    }
    expect(focusTabScript('chrome')).toContain('set active tab index of w to ti');
    expect(focusTabScript('safari')).toContain('set current tab of w to tab ti of w');
    expect(focusTabScript('arc')).toContain('select');
  });
  it('focusArgs passes integers only', () => {
    expect(focusArgs({ windowId: 12, tab: 3, url: 'x' })).toEqual(['12', '3']);
    expect(() => focusArgs({ windowId: 1.5, tab: 3, url: '' })).toThrow();
    expect(() => focusArgs({ windowId: 1, tab: 0, url: '' })).toThrow();
    expect(() => focusArgs({ windowId: '1" & (do shell script "id")' as any, tab: 1, url: '' })).toThrow();
  });
  it('a hostile URL changes nothing in either script', () => {
    const evil = 'https://example.com/a"&(do shell script "id")&"';
    expect(listTabsScript('chrome')).not.toContain('do shell script');
    expect(focusTabScript('chrome')).not.toContain('do shell script');
    expect(evil).toBeTruthy();
  });
});

describe('openUrl', () => {
  const target = 'https://example.com/orders/42';
  const tabs = '9\t1\thttps://example.com/other\n9\t2\thttps://example.com/orders/42/?tab=x\n';
  const mk = (over: Partial<OpenDeps> = {}) => {
    const calls: { script: string; args: string[] }[] = [];
    const opened: string[] = [];
    const deps: OpenDeps = {
      osascript: async (script, args) => {
        calls.push({ script, args });
        return calls.length === 1 ? tabs : '';
      },
      defaultBrowser: async () => 'chrome',
      open: (u) => void opened.push(u),
      ...over,
    };
    return { deps, calls, opened };
  };

  it('focuses a matching tab and does not open', async () => {
    const { deps, calls, opened } = mk();
    expect(await openUrl(target, deps)).toBe(true);
    expect(opened).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(['9', '2']);
    expect(calls[1].script).toContain('Google Chrome');
  });
  it('opens normally when no tab matches', async () => {
    const { deps, calls, opened } = mk();
    expect(await openUrl('https://example.com/none', deps)).toBe(false);
    expect(opened).toEqual(['https://example.com/none']);
    expect(calls).toHaveLength(1);
  });
  it('opens normally when the browser is not running (empty list)', async () => {
    const { deps, opened } = mk({ osascript: async () => '' });
    expect(await openUrl(target, deps)).toBe(false);
    expect(opened).toEqual([target]);
  });
  it('opens normally when AppleScript fails or times out', async () => {
    const { deps, opened } = mk({ osascript: async () => { throw new Error('not authorised'); } });
    expect(await openUrl(target, deps)).toBe(false);
    expect(opened).toEqual([target]);
  });
  it('opens normally when the focus step fails after a match', async () => {
    let n = 0;
    const { deps, opened } = mk({ osascript: async () => { if (n++ === 0) return tabs; throw new Error('boom'); } });
    expect(await openUrl(target, deps)).toBe(false);
    expect(opened).toEqual([target]);
  });
  it('never runs AppleScript for an unsupported default browser', async () => {
    const osascript = vi.fn(async () => tabs);
    const { deps, opened } = mk({ osascript, defaultBrowser: async () => 'other' });
    expect(await openUrl(target, deps)).toBe(false);
    expect(osascript).not.toHaveBeenCalled();
    expect(opened).toEqual([target]);
  });
  it('tries Chrome when the default cannot be read', async () => {
    const { deps, calls } = mk({ defaultBrowser: async () => null });
    expect(await openUrl(target, deps)).toBe(true);
    expect(calls[0].script).toContain('Google Chrome');
  });
  it('uses the detected browser', async () => {
    const { deps, calls } = mk({ defaultBrowser: async () => 'safari' });
    await openUrl(target, deps);
    expect(calls[0].script).toContain('application "Safari"');
  });
  it('a detection failure falls back to Chrome, and a failing open does not throw', async () => {
    const { deps } = mk({ defaultBrowser: async () => { throw new Error('x'); }, open: () => { throw new Error('no open'); }, osascript: async () => '' });
    await expect(openUrl(target, deps)).resolves.toBe(false);
  });
  it('passes non-http(s) straight to the normal open', async () => {
    const { deps, calls, opened } = mk();
    await openUrl('mailto:a@example.com', deps);
    expect(calls).toEqual([]);
    expect(opened).toEqual(['mailto:a@example.com']);
  });
});
