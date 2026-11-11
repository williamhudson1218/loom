import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isLoomCheckout, resolveLoomRepoDir } from '../src/repodir.ts';
import { buildInfo, versionFor } from '../app/version.mjs';

const checkout = (root: string) => {
  const files = new Set([path.join(root, 'app', 'build.mjs'), path.join(root, 'src', 'server.ts'), path.join(root, 'plugin')]);
  return (p: string) => files.has(p);
};

describe('the Loom checkout', () => {
  it('prefers $LOOM_REPO_DIR, then the build stamp', () => {
    expect(resolveLoomRepoDir({ env: { LOOM_REPO_DIR: '/src/loom' }, stamped: '/x' })).toBe('/src/loom');
    expect(resolveLoomRepoDir({ env: {}, stamped: '/built/here', home: '/h', exists: () => false })).toBe('/built/here');
  });

  it('a release build (empty stamp) finds a checkout under $HOME at run time', () => {
    expect(resolveLoomRepoDir({ env: {}, stamped: '', home: '/h', exists: checkout('/h/code/loom') })).toBe('/h/code/loom');
    expect(resolveLoomRepoDir({ env: {}, stamped: '', home: '/h', exists: () => false })).toBe('');
    // No probing when asked not to (the legacy ship migration).
    expect(resolveLoomRepoDir({ env: {}, stamped: '', home: '', exists: checkout('/h/dev/loom') })).toBe('');
  });

  it('a folder named loom that is not Loom does not count', () => {
    expect(isLoomCheckout('/h/dev/loom', (p) => p === '/h/dev/loom/app/build.mjs')).toBe(false);
  });
});

describe('build version', () => {
  it('is 0.1.<commit count>, and CI’s explicit values win', () => {
    expect(versionFor(90)).toBe('0.1.90');
    expect(() => versionFor(-1)).toThrow();
    expect(buildInfo(process.cwd(), { LOOM_VERSION: '0.1.7', LOOM_COMMIT: 'abc', LOOM_RELEASE: '1' })).toEqual({ version: '0.1.7', commit: 'abc', channel: 'release' });
    expect(buildInfo(process.cwd(), {}).version).toMatch(/^0\.1\.\d+$/);
  });
});
