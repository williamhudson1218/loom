import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveStaleLayout, SNAPSHOT_GAP_MS, LAYOUT_ARCHIVE_KEEP, type Layout } from '../src/snapshot.ts';

const layout = (taken_at: number, name = 'loom-tp-2'): Layout => ({
  taken_at,
  sessions: [{ name, windows: [] }],
  ghostty_tabs: [name],
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-archive-'));
  file = path.join(dir, 'layout.json');
});

const archived = () => (fs.existsSync(path.join(dir, 'layouts')) ? fs.readdirSync(path.join(dir, 'layouts')).sort() : []);

describe('archiveStaleLayout', () => {
  it('leaves the steady 15s cadence alone', () => {
    const prev = layout(1_000_000);
    expect(archiveStaleLayout(prev, prev.taken_at + 15_000, file)).toBeNull();
    expect(archived()).toEqual([]);
  });

  it('archives the last pre-gap snapshot before the first write after a gap', () => {
    // A crash or reboot stops the snapshotter (writeLayout refuses an empty tmux),
    // so the first write afterwards is the one that would clobber the layout
    // restore needs. That snapshot has to survive somewhere.
    const prev = layout(1_000_000, 'loom-tp-forms-1');
    const out = archiveStaleLayout(prev, prev.taken_at + SNAPSHOT_GAP_MS, file);
    expect(out).not.toBeNull();
    expect(archived()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(out!, 'utf-8'))).toEqual(prev);
  });

  it('is idempotent for the same snapshot', () => {
    const prev = layout(1_000_000);
    archiveStaleLayout(prev, prev.taken_at + SNAPSHOT_GAP_MS, file);
    archiveStaleLayout(prev, prev.taken_at + SNAPSHOT_GAP_MS * 2, file);
    expect(archived()).toHaveLength(1);
  });

  it(`keeps only the newest ${LAYOUT_ARCHIVE_KEEP}`, () => {
    for (let i = 0; i < LAYOUT_ARCHIVE_KEEP + 5; i++) {
      const prev = layout(1_000_000 + i * 10 * SNAPSHOT_GAP_MS);
      archiveStaleLayout(prev, prev.taken_at + SNAPSHOT_GAP_MS, file);
    }
    const names = archived();
    expect(names).toHaveLength(LAYOUT_ARCHIVE_KEEP);
    expect(names[names.length - 1]).toContain(String(1_000_000 + (LAYOUT_ARCHIVE_KEEP + 4) * 10 * SNAPSHOT_GAP_MS));
  });

  it('does nothing without a previous snapshot', () => {
    expect(archiveStaleLayout(null, Date.now(), file)).toBeNull();
    expect(archived()).toEqual([]);
  });
});
