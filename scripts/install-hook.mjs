#!/usr/bin/env node
// Register Loom's placement hook for Codex (~/.codex/hooks.json), under both
// SessionStart and UserPromptSubmit. Claude Code gets the hook from the Loom
// plugin (Settings › Helpers), so this never touches ~/.claude/settings.json.
//
// Consent first: without --yes it only prints the exact change it would make.
// Idempotent: an event that already runs a record-placement.sh (from any path)
// is left alone. A file that would change is copied to <file>.loom-bak first.
//
//   node scripts/install-hook.mjs <path-to-record-placement.sh>         show the change
//   node scripts/install-hook.mjs <path-to-record-placement.sh> --yes   make it
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVENTS = ['SessionStart', 'UserPromptSubmit'];

/** Add the hook to `cfg` where missing. Returns the events that changed. */
export function addHook(cfg, command) {
  const changed = [];
  cfg.hooks ??= {};
  for (const ev of EVENTS) {
    const groups = (cfg.hooks[ev] ??= []);
    const has = groups.some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes('record-placement.sh')));
    if (has) continue;
    groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    changed.push(ev);
  }
  return changed;
}

export function install(file, command, apply) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      console.log(`  ! ${file} is not valid JSON; not touching it. Add the hook by hand (see SETUP.md).`);
      return 'invalid';
    }
  }
  const changed = addHook(cfg, command);
  if (!changed.length) {
    console.log(`  ${file}: hook already registered`);
    return 'already';
  }
  const entry = JSON.stringify({ hooks: [{ type: 'command', command, timeout: 5 }] });
  if (!apply) {
    console.log(`  ${file}: would add to ${changed.join(', ')}: ${entry}`);
    console.log(`  (re-run with --yes to make this change)`);
    return 'would';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.loom-bak');
    console.log(`  ${file}: backed up to ${file}.loom-bak`);
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`  ${file}: added to ${changed.join(', ')}: ${entry}`);
  return 'written';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!command || command.startsWith('--')) {
    console.error('usage: install-hook.mjs <path-to-record-placement.sh> [--yes]');
    process.exit(2);
  }
  const apply = process.argv.includes('--yes');
  const codexDir = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexDir)) {
    console.log('  Codex is not installed (~/.codex is missing): nothing to do');
  } else {
    install(path.join(codexDir, 'hooks.json'), command, apply);
  }
}
