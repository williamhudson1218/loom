import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db.ts';
import {
  getEmMode, setEmMode, recordFinding, recordAction,
  setFindingStatus, newFindings, paneWritesSince, recentLedger,
} from '../../src/em/ledger.ts';

const HOUR = 3_600_000;

function finding(overrides: Partial<Parameters<typeof recordFinding>[1]> = {}) {
  return {
    agent: 'claude' as const,
    session_id: 's1',
    kind: 'BLOCKED' as const,
    signals: { idleMs: 120_000 },
    detected_at: 1_000_000,
    ...overrides,
  };
}

describe('em_mode', () => {
  it('defaults to shadow so a fresh install observes without acting', () => {
    const db = openDb(':memory:');
    expect(getEmMode(db)).toBe('shadow');
    db.close();
  });

  it('round-trips a set mode', () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    expect(getEmMode(db)).toBe('live');
    db.close();
  });

  it('reads an unrecognised stored value as off, the safe direction', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO settings(key, value) VALUES ('em_mode', 'banana')`).run();
    expect(getEmMode(db)).toBe('off');
    db.close();
  });
});

describe('recordFinding', () => {
  it('records a finding and returns its id', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR);
    expect(id).toBeTypeOf('number');
    const rows = newFindings(db);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('BLOCKED');
    expect(JSON.parse(rows[0].signals_json)).toEqual({ idleMs: 120_000 });
    db.close();
  });

  it('suppresses a repeat of the same (session, kind) inside the cooldown', () => {
    const db = openDb(':memory:');
    expect(recordFinding(db, finding(), HOUR)).toBeTypeOf('number');
    // Without this, a stuck session is re-detected every 30s forever.
    expect(recordFinding(db, finding({ detected_at: 1_000_000 + 60_000 }), HOUR)).toBeNull();
    expect(newFindings(db).length).toBe(1);
    db.close();
  });

  it('allows the same kind again once the cooldown has elapsed', () => {
    const db = openDb(':memory:');
    recordFinding(db, finding(), HOUR);
    expect(recordFinding(db, finding({ detected_at: 1_000_000 + HOUR + 1 }), HOUR)).toBeTypeOf('number');
    db.close();
  });

  it('does not let one kind suppress a different kind on the same session', () => {
    const db = openDb(':memory:');
    recordFinding(db, finding({ kind: 'BLOCKED' }), HOUR);
    expect(recordFinding(db, finding({ kind: 'BLOATED' }), HOUR)).toBeTypeOf('number');
    db.close();
  });
});

describe('actions and status', () => {
  it('drops a finding out of newFindings once its status advances', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR)!;
    setFindingStatus(db, id, 'acted');
    expect(newFindings(db).length).toBe(0);
    db.close();
  });

  it('counts only non-shadow pane writes toward the rate limit', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR)!;
    recordAction(db, { finding_id: id, kind: 'answer', payload: 'a', shadow: 1, result: 'shadow', taken_at: 2_000 });
    recordAction(db, { finding_id: id, kind: 'answer', payload: 'b', shadow: 0, result: 'sent', taken_at: 3_000 });
    recordAction(db, { finding_id: id, kind: 'issue', payload: 'c', shadow: 0, result: 'ok', taken_at: 4_000 });
    // Shadow actions send nothing, and filing an issue is not a pane write.
    expect(paneWritesSince(db, 0)).toBe(1);
    db.close();
  });

  it('returns findings and actions together for the feed', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR)!;
    recordAction(db, { finding_id: id, kind: 'answer', payload: 'x', shadow: 1, result: 'shadow', taken_at: 2_000 });
    const led = recentLedger(db, 0);
    expect(led.findings.length).toBe(1);
    expect(led.actions.length).toBe(1);
    expect(led.actions[0].finding_id).toBe(id);
    db.close();
  });
});
