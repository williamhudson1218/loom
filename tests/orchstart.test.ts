import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFirstRunPrompt, isFolderTrusted, pretrustFolder, trustedFolders } from '../src/orchstart.ts';

const TRUST = `
 ─────────────────────────────────────────────
  Accessing workspace:

  /Users/will/.loom/orchestrator

  Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).

  ❯ 1. Yes, I trust this folder
    2. No, exit

  Enter to confirm · Esc to cancel
`;
const APIKEY = `
 Detected a custom API key in your environment

 ANTHROPIC_API_KEY: sk-ant-...abcd

 Do you want to use this API key?

 ❯ 1. Yes
   2. No (recommended)

 Enter to confirm · Esc to cancel
`;
const THEME = `
 Let's get started.

 Choose the text style that looks best with your terminal

 ❯ 1. Dark mode
   2. Light mode

 Enter to confirm
`;
const GENERIC = `
╭──────────────────────────────╮
│ Pick a flavour               │
│ ❯ 1. Vanilla                 │
│   2. Mint                    │
│ Enter to confirm             │
╰──────────────────────────────╯
`;
const RUNNING = `
 ╭─── Claude Code v2.1.318 ───╮
 │ Welcome back               │
 ╰────────────────────────────╯
❯ 
  ? for shortcuts
`;

describe('detectFirstRunPrompt', () => {
  it('finds the trust dialog and returns its first line', () => {
    expect(detectFirstRunPrompt(TRUST)?.question).toMatch(/^Is this a project you created or one you trust/);
  });
  it('finds the API key prompt', () => {
    expect(detectFirstRunPrompt(APIKEY)?.question).toBe('Do you want to use this API key?');
  });
  it('finds a theme prompt', () => {
    expect(detectFirstRunPrompt(THEME)?.question).toMatch(/text style/);
  });
  it('finds a generic selection menu', () => {
    expect(detectFirstRunPrompt(GENERIC)?.question).toBe('Pick a flavour');
  });
  it('strips ANSI', () => {
    expect(detectFirstRunPrompt('\x1b[1mDo you want to use this API key?\x1b[0m\n❯ 1. Yes\nEnter to confirm')?.question).toBe('Do you want to use this API key?');
  });
  it('ignores a normal running session and empty panes', () => {
    expect(detectFirstRunPrompt(RUNNING)).toBeNull();
    expect(detectFirstRunPrompt('')).toBeNull();
    expect(detectFirstRunPrompt('$ ')).toBeNull();
  });
});

describe('pretrustFolder', () => {
  const mk = (content?: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-trust-'));
    const f = path.join(home, '.claude.json');
    if (content !== undefined) fs.writeFileSync(f, content, { mode: 0o600 });
    return { home, f };
  };
  const dir = '/Users/x/.loom/orchestrator';
  it('sets only that key and keeps everything else and the mode', () => {
    const { home, f } = mk(JSON.stringify({ numStartups: 3, projects: { '/other': { hasTrustDialogAccepted: false, a: 1 }, [dir]: { allowedTools: [] } } }, null, 2) + '\n');
    expect(pretrustFolder(dir, home)).toBe('written');
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    expect(j.projects[dir]).toEqual({ allowedTools: [], hasTrustDialogAccepted: true });
    expect(j.projects['/other']).toEqual({ hasTrustDialogAccepted: false, a: 1 });
    expect(j.numStartups).toBe(3);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home)).toEqual(['.claude.json']);
  });
  it('creates the project entry when missing, and projects when missing', () => {
    const { home, f } = mk('{"a":1}');
    expect(pretrustFolder(dir, home)).toBe('written');
    expect(JSON.parse(fs.readFileSync(f, 'utf-8'))).toEqual({ a: 1, projects: { [dir]: { hasTrustDialogAccepted: true } } });
  });
  it('does not rewrite when already true', () => {
    const body = JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } });
    const { home, f } = mk(body);
    const before = fs.statSync(f).mtimeMs;
    expect(pretrustFolder(dir, home)).toBe('already');
    expect(fs.readFileSync(f, 'utf-8')).toBe(body);
    expect(fs.statSync(f).mtimeMs).toBe(before);
  });
  it('skips silently on unparseable or missing files, leaving them alone', () => {
    const bad = mk('{not json');
    expect(pretrustFolder(dir, bad.home)).toBe('skipped');
    expect(fs.readFileSync(bad.f, 'utf-8')).toBe('{not json');
    const none = mk();
    expect(pretrustFolder(dir, none.home)).toBe('skipped');
    expect(fs.existsSync(none.f)).toBe(false);
  });
});

describe('trustedFolders', () => {
  it('lists accepted folders, and sees a pretrust written after it was cached', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-trusted-'));
    const f = path.join(home, '.claude.json');
    fs.writeFileSync(f, JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: true }, '/b': { hasTrustDialogAccepted: false }, '/c': {} } }));
    expect([...trustedFolders(home)]).toEqual(['/a']);
    expect(isFolderTrusted('/b', home)).toBe(false);
    fs.utimesSync(f, new Date(), new Date(Date.now() - 60_000)); // a distinct mtime, so the rewrite below is seen
    expect(pretrustFolder('/b', home)).toBe('written');
    expect(isFolderTrusted('/b', home)).toBe(true);
  });

  it('is empty when the file is missing or broken', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-trusted-'));
    expect(trustedFolders(home).size).toBe(0);
    fs.writeFileSync(path.join(home, '.claude.json'), '{nope');
    expect(isFolderTrusted('/a', home)).toBe(false);
  });
});
