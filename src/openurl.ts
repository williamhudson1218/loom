import { execFile } from 'node:child_process';
import { osascriptCommand } from './nativehelpers.ts';

// One way Loom opens an http(s) link in the user's browser. If the default browser is
// Chrome, Arc or Safari and already has a tab on the page, that tab is brought forward
// instead of opening a duplicate; otherwise (no match, another browser, AppleScript
// refused or slow) it is a normal open. Nothing here ever throws or waits long.

export type Browser = 'chrome' | 'arc' | 'safari';

/** Per-call bound on the browser query and on the focus script. */
export const OPENURL_TIMEOUT_MS = 2_000;

const APP_NAME: Record<Browser, string> = { chrome: 'Google Chrome', arc: 'Arc', safari: 'Safari' };

const BUNDLE_BROWSER: Record<string, Browser> = {
  'com.google.chrome': 'chrome',
  'company.thebrowser.browser': 'arc',
  'com.apple.safari': 'safari',
};

/* -------------------------------------------------------------- matching */

/** The comparable parts of an http(s) URL: scheme, host, port and path without a trailing slash. Null for anything else. */
function parts(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}${path}`;
  } catch {
    return null;
  }
}

/** Whether a tab's URL is the page `target` names: same scheme, host and port, and the same path ignoring a trailing slash. Query and hash are ignored. */
export function urlMatches(tabUrl: string, target: string): boolean {
  const a = parts(tabUrl);
  const b = parts(target);
  return a !== null && a === b;
}

export interface TabRef {
  windowId: number;
  /** 1-based index within the window. */
  tab: number;
  url: string;
}

/** Parse the list script's output: one `windowId<TAB>tabIndex<TAB>url` line per tab. Malformed lines are skipped. */
export function parseTabList(out: string): TabRef[] {
  const tabs: TabRef[] = [];
  for (const line of out.split(/\r?\n/)) {
    const f = line.split('\t');
    if (f.length < 3) continue;
    const windowId = Number(f[0]);
    const tab = Number(f[1]);
    if (!Number.isInteger(windowId) || !Number.isInteger(tab) || tab < 1) continue;
    tabs.push({ windowId, tab, url: f.slice(2).join('\t') });
  }
  return tabs;
}

/** The first tab (in the browser's own window order) that is the page `target` names. */
export function findTab(tabs: TabRef[], target: string): TabRef | null {
  return tabs.find((t) => urlMatches(t.url, target)) ?? null;
}

/* ------------------------------------------------------ default browser */

export type DefaultBrowser = Browser | 'other' | null;

/**
 * The https (else http) handler in `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers`:
 * a supported browser, 'other' for any other app, or null when the output names none.
 */
export function parseDefaultBrowser(text: string): DefaultBrowser {
  const found: Record<string, string> = {};
  for (const m of text.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
    const inner = m[0].slice(1, -1).replace(/\{[^{}]*\}/g, '');
    const scheme = /LSHandlerURLScheme\s*=\s*"?([A-Za-z]+)"?\s*;/.exec(inner)?.[1]?.toLowerCase();
    const role = /LSHandlerRoleAll\s*=\s*"?([^";\s]+)"?\s*;/.exec(inner)?.[1]?.toLowerCase();
    if ((scheme === 'https' || scheme === 'http') && role && role !== '-' && !(scheme in found)) found[scheme] = role;
  }
  const id = found.https ?? found.http;
  if (!id) return null;
  return BUNDLE_BROWSER[id] ?? 'other';
}

/* ------------------------------------------------------------- scripts */

/**
 * AppleScript that prints every tab of `browser` as `windowId<TAB>tabIndex<TAB>url`, or nothing when the
 * browser is not running (so it is never launched). No URL is ever put into a script.
 */
export function listTabsScript(browser: Browser): string {
  const app = APP_NAME[browser];
  return [
    `if application "${app}" is not running then return ""`,
    'set tb to character id 9',
    'set lf to character id 10',
    `tell application "${app}"`,
    '  set wids to id of every window',
    '  set urlLists to URL of every tab of every window',
    'end tell',
    'set out to ""',
    'repeat with i from 1 to count of wids',
    '  set wid to item i of wids',
    '  set j to 0',
    '  repeat with u in (item i of urlLists)',
    '    set j to j + 1',
    '    set out to out & wid & tb & j & tb & (u as text) & lf',
    '  end repeat',
    'end repeat',
    'return out',
  ].join('\n');
}

/**
 * AppleScript that makes tab `item 2 of argv` of window id `item 1 of argv` active, raises the window and
 * activates the app. The target travels as argv, never inside the script text; `focusArgs` makes both integers.
 */
export function focusTabScript(browser: Browser): string {
  const app = APP_NAME[browser];
  const select =
    browser === 'safari'
      ? '    set current tab of w to tab ti of w'
      : browser === 'arc'
        ? '    tell tab ti of w to select'
        : '    set active tab index of w to ti';
  return [
    'on run argv',
    '  set wid to (item 1 of argv) as integer',
    '  set ti to (item 2 of argv) as integer',
    `  tell application "${app}"`,
    '    set w to first window whose id is wid',
    select,
    '    try',
    '      set index of w to 1',
    '    end try',
    '    activate',
    '  end tell',
    'end run',
  ].join('\n');
}

/** The argv for focusTabScript. Only integers get through. */
export function focusArgs(t: TabRef): string[] {
  if (!Number.isInteger(t.windowId) || !Number.isInteger(t.tab) || t.tab < 1) throw new Error('bad tab reference');
  return [String(t.windowId), String(t.tab)];
}

/* --------------------------------------------------------------- open */

export interface OpenDeps {
  /** Run AppleScript; rejects on failure or after the timeout. */
  osascript(script: string, args: string[]): Promise<string>;
  /** The default browser, or null when it cannot be read. */
  defaultBrowser(): Promise<DefaultBrowser>;
  /** The ordinary open (the system's default handler). */
  open(url: string): void | Promise<void>;
}

function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: OPENURL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

let browserCache: { at: number; value: DefaultBrowser } | null = null;

export const realDeps: OpenDeps = {
  osascript: (script, args) => {
    const c = osascriptCommand(script, args);
    return execText(c.cmd, c.args);
  },
  defaultBrowser: async () => {
    if (browserCache && Date.now() - browserCache.at < 60_000) return browserCache.value;
    let value: DefaultBrowser = null;
    try {
      value = parseDefaultBrowser(await execText('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']));
    } catch {
      value = null;
    }
    browserCache = { at: Date.now(), value };
    return value;
  },
  open: (url) => {
    execFile('open', [url], () => {});
  },
};

/**
 * Open an http(s) link. A tab already on the page is made active (window raised, app activated); anything
 * else, or any failure on the way, is the normal open. Resolves true when an existing tab was focused.
 */
export async function openUrl(url: string, deps: OpenDeps = realDeps): Promise<boolean> {
  const plain = async (): Promise<false> => {
    try {
      await deps.open(url);
    } catch {
      /* nothing more to try */
    }
    return false;
  };
  if (!parts(url)) return plain();
  try {
    const found = await deps.defaultBrowser().catch(() => null);
    if (found === 'other') return plain();
    const browser: Browser = found ?? 'chrome';
    const tab = findTab(parseTabList(await deps.osascript(listTabsScript(browser), [])), url);
    if (!tab) return plain();
    await deps.osascript(focusTabScript(browser), focusArgs(tab));
    return true;
  } catch {
    return plain();
  }
}
