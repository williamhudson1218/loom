import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HELP_COMMANDS, parseCaps, parseMarketplaceListText, parsePluginListText, versionCmp, MIN_PLUGIN_CLAUDE } from '../src/claudecaps.ts';

// Help and output captured from the npm releases of Claude Code (run with an
// isolated HOME and CLAUDE_CONFIG_DIR), and from the current one.
const FX = path.resolve(__dirname, 'fixtures', 'claude-cli');
const helpOf = (v: string) => Object.fromEntries(HELP_COMMANDS.map((c) => [c, fs.readFileSync(path.join(FX, v, c.replace(/ /g, '-') + '.txt'), 'utf8')]));

describe('parseCaps from real --help', () => {
  it('2.0.20: plugins, but no list and no flags', () => {
    expect(parseCaps('2.0.20', helpOf('2.0.20'))).toEqual({
      version: '2.0.20', plugins: true, pluginList: false, pluginListJson: false, marketplaceListJson: false,
      marketplaceAddScope: false, marketplaceAddJson: false, installScope: false, installJson: false, uninstallJson: false,
    });
  });
  it('2.1.2: install --scope only', () => {
    expect(parseCaps('2.1.2', helpOf('2.1.2'))).toMatchObject({
      plugins: true, pluginList: false, marketplaceAddScope: false, marketplaceAddJson: false, installScope: true, installJson: false,
    });
  });
  it('current (2.1.322): everything', () => {
    expect(parseCaps('2.1.322', helpOf('2.1.322'))).toEqual({
      version: '2.1.322', plugins: true, pluginList: true, pluginListJson: true, marketplaceListJson: true,
      marketplaceAddScope: true, marketplaceAddJson: true, installScope: true, installJson: true, uninstallJson: true,
    });
  });
  it('a claude with no plugin command has no plugins', () => {
    const main = 'Usage: claude [options] [command] [prompt]\n\nCommands:\n  install [options] [target]  Install Claude Code native build\n';
    expect(parseCaps('1.0.128', { plugin: main, 'plugin marketplace': main }).plugins).toBe(false);
  });
  it('the minimum is the first release with plugin install', () => {
    expect(MIN_PLUGIN_CLAUDE).toBe('2.0.20');
    expect(versionCmp('2.0.19', MIN_PLUGIN_CLAUDE)).toBeLessThan(0);
    expect(versionCmp('2.1.2', MIN_PLUGIN_CLAUDE)).toBeGreaterThan(0);
  });
});

describe('listings without --json', () => {
  it('reads marketplace list text', () => {
    const out = fs.readFileSync(path.join(FX, '2.0.20', 'out-marketplace-list.txt'), 'utf8').replace('__DIR__', '/h/.loom/plugin-marketplace');
    expect(parseMarketplaceListText(out)).toEqual([{ name: 'loom-local', installLocation: '/h/.loom/plugin-marketplace' }]);
    expect(parseMarketplaceListText(fs.readFileSync(path.join(FX, '2.0.20', 'out-marketplace-list-empty.txt'), 'utf8'))).toEqual([]);
  });
  it('reads plugin list text', () => {
    expect(parsePluginListText(fs.readFileSync(path.join(FX, 'out-plugin-list-2.1.8.txt'), 'utf8'))).toEqual([{ id: 'loom@loom-local', version: '0.1.0', enabled: true }]);
    expect(parsePluginListText('Installed plugins:\n\n  ❯ loom@loom-local\n    Version: 0.1.0\n    Status: ✘ disabled\n')[0].enabled).toBe(false);
  });
});
