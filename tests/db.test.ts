import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.ts';

describe('openDb', () => {
  it('creates the chats table with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('session_id');
    expect(names).toContain('activity_json');
    expect(names).toContain('breakdown_json');
    expect(names).toContain('summary_dirty');
    expect(names).toContain('last_pane_id'); // forward-compat
    db.close();
  });
});
