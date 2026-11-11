import { describe, expect, it } from 'vitest';
import { pickMayArm, pickMayLook, SLACK_BUNDLE_ID } from '../src/pickstate.ts';
import { parseBundleId, parseFrontAsn } from '../src/frontapp.ts';

// The helper skips every Loom window when it decides whether Slack is on top
// (so the overlay never hides Slack), which also made Loom's main window
// see-through: the hover box outlined Slack messages hidden under Loom.
const loomWin = { x: 0, y: 25, width: 1200, height: 800 };
const base = { loomFocused: false, slackFrontmost: null as boolean | null, loomWindows: [loomWin] };

describe('pickMayArm', () => {
  it('never arms while a Loom window is focused, unless Slack is somehow frontmost', () => {
    expect(pickMayArm({ loomFocused: true, slackFrontmost: false })).toBe(false);
    expect(pickMayArm({ loomFocused: true, slackFrontmost: null })).toBe(false);
    expect(pickMayArm({ loomFocused: false, slackFrontmost: null })).toBe(true);
    expect(pickMayArm({ loomFocused: false, slackFrontmost: true })).toBe(true);
  });
});

describe('pickMayLook', () => {
  it('skips a point inside a visible Loom window when Slack is not known to be frontmost', () => {
    expect(pickMayLook(base, 100, 100)).toBe('over-loom');
    expect(pickMayLook({ ...base, slackFrontmost: false }, 100, 100)).toBe('over-loom');
    expect(pickMayLook(base, 1300, 100)).toBe('ok'); // outside Loom: the helper's own check applies
  });
  it('with Slack frontmost, its windows are above Loom, so the helper decides', () => {
    expect(pickMayLook({ ...base, slackFrontmost: true }, 100, 100)).toBe('ok');
  });
  it('nothing is looked at while Loom is focused', () => {
    expect(pickMayLook({ ...base, loomFocused: true }, 1300, 100)).toBe('loom-focused');
  });
  it('a hidden or minimized Loom window is simply not in the list', () => {
    expect(pickMayLook({ ...base, loomWindows: [] }, 100, 100)).toBe('ok');
  });
  it('window edges: the right and bottom edges are outside', () => {
    expect(pickMayLook(base, 1199, 824)).toBe('over-loom');
    expect(pickMayLook(base, 1200, 100)).toBe('ok');
    expect(pickMayLook(base, 100, 825)).toBe('ok');
  });
});

describe('frontmost app from lsappinfo', () => {
  it('reads the ASN and the bundle id', () => {
    expect(parseFrontAsn('ASN:0x0-0x1578176c:\n')).toBe('ASN:0x0-0x1578176c:');
    expect(parseFrontAsn('')).toBeNull();
    expect(parseBundleId('"CFBundleIdentifier"="com.tinyspeck.slackmacgap"\n')).toBe(SLACK_BUNDLE_ID);
    expect(parseBundleId('')).toBeNull();
  });
});
