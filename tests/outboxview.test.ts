import { describe, it, expect } from 'vitest';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_JS } from '../src/outboxview.ts';
import { renderDashboard } from '../src/dashboard.ts';

const lib = new Function(`${OUTBOX_PURE_JS}; return { draftDate, sortDrafts, draftStaleReason, railMode, draftsOfChat, destInitial, draftThreadOf, railShut };`)() as {
  draftsOfChat: (all: any[], sid: string) => any[];
  destInitial: (l: string) => string;
  draftThreadOf: (all: any[], sid: string) => { key: string; url: string } | null;
  draftDate: (d: object) => number;
  sortDrafts: <T extends { id: string; created_at: string }>(d: T[]) => T[];
  draftStaleReason: (d: object, all: object[], now: number) => string;
  railMode: (n: number, collapsed: boolean) => string;
  railShut: (closedAt: number, ds: { created_at: string }[]) => boolean;
};
const d = (id: string, session: string, created: string) => ({ id, session_id: session, created_at: created });
const NOW = Date.parse('2026-11-05T12:00:00');

describe('rail visibility', () => {
  it('is hidden with no drafts, open with drafts, collapsed when folded away', () => {
    expect(lib.railMode(0, false)).toBe('hidden');
    expect(lib.railMode(0, true)).toBe('hidden');
    expect(lib.railMode(2, false)).toBe('open');
    expect(lib.railMode(1, true)).toBe('collapsed');
  });
  it('opens by itself for a waiting draft, and a collapse holds only until a newer draft arrives', () => {
    const a = { created_at: '2026-11-07T10:00:00Z' };
    const b = { created_at: '2026-11-07T10:05:00Z' };
    expect(lib.railShut(0, [a])).toBe(false); // never collapsed: open
    const closedAt = Date.parse(a.created_at);
    expect(lib.railShut(closedAt, [a])).toBe(true); // collapsed while showing a: stays collapsed
    expect(lib.railShut(closedAt, [a, b])).toBe(false); // b is newer: opens again
  });

  it('is wired to the chat view, not the orchestrator, terminals or the Outbox view', () => {
    const html = renderDashboard([], 1);
    expect(html).toContain('id="outrail"');
    expect(html).toContain('id="chatwrap" data-rail="hidden"');
    expect(html).toContain("if(orchSel||tsel||!sel||sel.arch)return [];");
    // Open by default; a collapse is remembered per chat until a newer draft arrives.
    expect(html).toContain("outCollapsed=key?railCollapsed(key,ds):true;");
    expect(html).toContain("else if(outCollapsed&&key&&!railCollapsed(key,ds))outCollapsed=false;");
    expect(html).toContain("setTimeout(refitTerm,60)");
    // The rail sits right of BOTH tabs: it is a sibling of #chatmain, not inside a tab.
    expect(html.indexOf('</section>\n<aside id="outrail"')).toBeGreaterThan(html.indexOf('id="mtxwrap"'));
    expect(html).toContain('flex:0 0 400px');
    expect(html).toContain('flex-basis:28px; width:28px');
  });
});

describe('per-chat outbox', () => {
  it('keeps only the drafts of that chat, oldest first', () => {
    const all = [
      { id: 'b', session_id: 'S1', created_at: '2026-01-02T00:00:00Z' },
      { id: 'x', session_id: 'S2', created_at: '2026-01-01T00:00:00Z' },
      { id: 'a', session_id: 'S1', created_at: '2026-01-01T00:00:00Z' },
    ];
    expect(lib.draftsOfChat(all, 'S1').map((d) => d.id)).toEqual(['a', 'b']);
    expect(lib.draftsOfChat(all, 'S3')).toEqual([]);
    expect(lib.draftsOfChat(undefined as any, 'S1')).toEqual([]);
  });
  it('takes the strip initial from the destination', () => {
    expect(lib.destInitial('#ops')).toBe('O');
    expect(lib.destInitial('@dana')).toBe('D');
    expect(lib.destInitial('')).toBe('?');
  });
});

describe('slack thread fallback from a draft', () => {
  const u = 'https://t.slack.com/archives/C0TESTADV01/p1793839555348489';
  it('uses the newest pending draft with a thread permalink', () => {
    const all = [
      { id: 'a', session_id: 'S', status: 'pending', created_at: '2026-01-01T00:00:00Z', thread_url: u },
      { id: 'b', session_id: 'S', status: 'sent', created_at: '2026-01-02T00:00:00Z', thread_url: 'https://t.slack.com/archives/C1/p1700000000000100' },
      { id: 'c', session_id: 'S', status: 'pending', created_at: '2026-01-03T00:00:00Z' },
    ];
    expect(lib.draftThreadOf(all, 'S')).toEqual({ key: 'C0TESTADV01/1793839555.348489', url: u });
    expect(lib.draftThreadOf(all, 'other')).toBeNull();
    expect(lib.draftThreadOf([], 'S')).toBeNull();
  });
  it('is wired into Open Slack thread and the header chip', () => {
    const html = renderDashboard([], 1);
    expect(html).toContain('||!!draftThreadOf(DATA.drafts,c.session_id)');
    // Every open posts the thread's own key and url; the pending draft's thread joins the list.
    expect(html).toContain("'&url='+encodeURIComponent(t.url||'')");
    expect(html).toContain('draftThreadOf(DATA.drafts,c.session_id),pk=parkedOf(c)');
  });
});

describe('outbox ordering and staleness', () => {
  it('lists oldest first', () => {
    const ds = [d('b', 's', '2026-11-05T10:00:00'), d('a', 's', '2026-11-05T09:00:00'), d('c', 't', '2026-11-05T09:00:00')];
    expect(lib.sortDrafts(ds).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });
  it('marks a draft stale when its chat has a newer draft', () => {
    const old = d('old', 's', '2026-11-05T09:00:00');
    const newer = d('new', 's', '2026-11-05T11:00:00');
    expect(lib.draftStaleReason(old, [old, newer], NOW)).toBe('newer draft in this chat');
    expect(lib.draftStaleReason({ ...newer, stale: true, stale_reason: 'chat ended' }, [newer], NOW)).toBe('chat ended');
    expect(lib.draftStaleReason(newer, [old, newer], NOW)).toBe('');
  });
  it('does not compare drafts across chats', () => {
    const a = d('a', 's1', '2026-11-05T09:00:00');
    const b = d('b', 's2', '2026-11-05T11:00:00');
    expect(lib.draftStaleReason(a, [a, b], NOW)).toBe('');
  });
  it('marks a draft stale after 24 hours', () => {
    const day = d('x', 's', '2026-11-04T11:59:00');
    expect(lib.draftStaleReason(day, [day], NOW)).toBe('over 24h old');
    expect(lib.draftStaleReason(d('y', 's', '2026-11-04T12:01:00'), [], NOW)).toBe('');
    expect(lib.draftStaleReason(d('z', 's', 'garbage'), [], NOW)).toBe('');
  });
});

describe('outbox UI wiring', () => {
  const html = renderDashboard([], 1);
  it('has no global Outbox: no sidebar entry, no all-drafts view', () => {
    expect(html).not.toContain('id="outpin"');
    expect(html).not.toContain('id="outview"');
    expect(html).not.toContain('selectOutbox');
    expect(html).not.toContain('allPending');
  });
  it('keeps every write on the existing endpoints, and adds Edit, Copy, Send, Discard to each card', () => {
    expect(html).toContain("fetch('/api/outbox/send'");
    expect(html).toContain("fetch('/api/outbox/discard'");
    for (const act of ['edit', 'send', 'discard', 'post-none', 'post-park', 'post-close', 'cancel']) expect(html).toContain(`data-dact="${act}"`);
    expect(html).toContain('data-dact="copy">Copy</button>');
    // One Send button on the card; park and close live in the confirm step, Send first and default-focused.
    expect(html).not.toContain('data-dact="sendpark"');
    expect(html).toContain('data-dact="send">Send</button>');
    expect(html).toContain('Enter send · \u2325Enter send &amp; park · \u21e7Enter send &amp; close · Esc cancel');
    expect(html).toContain("body:JSON.stringify({id,messages:texts,after,ack_stale})");
    // No second write path: send, discard, send-now (cuts a gap short, posts nothing itself) and the state poll,
    // plus the read-only thumbnail route (/api/outbox/file, GET) and PR head check (/api/outbox/review-head, GET).
    expect(html.match(/\/api\/outbox\//g)!.length).toBeLessThanOrEqual(6);
  });
  it('no longer renders drafts inside the transcript detail column', () => {
    expect(html).not.toContain('function draftsHtml(');
    expect(html).not.toContain('awaiting your okay');
  });
  it('loads names, custom emoji and the shortcode map for the renderer', () => {
    expect(html).toContain("fetch('/api/slack/directory')");
    expect(html).toContain("fetch('/api/emoji-map')");
    expect(html).toContain('function slkRender(');
  });
  it('escapes a literal </script> in the embedded data', () => {
    const view = { agent: 'claude' as const, session_id: 's', project: 'p', project_dir: '/p', jsonl_path: '', title: '</script><img src=x onerror=1>', claude_auto_title: '', pr_url: '', overview: '', state: '', breakdown: [], first_message: '', message_count: 0, started_at: 0, last_active_at: 0, last_turn_at: 0, activity: {}, summary_pending: false, saved: false, saved_at: 0, tags: [] };
    const out = renderDashboard([view], 1, {}, 'claude', [], [{ id: 'd', session_id: 's', messages: ['</script><b>x</b>'] }]);
    expect(out).not.toContain('</script><img');
    expect(out).not.toContain('</script><b>');
  });
});

describe('burst send progress rendering', () => {
  const view = (SENDING: object, local = false) => {
    const OUT = require_view();
    return OUT(SENDING, local);
  };
  function require_view() {
    return (SENDING: object, local: boolean) => {
      const f = new Function(
        'DATA', 'esc', 'rel', 'hhmm', 'NL', 'canParkStub',
        `var TERM_TOKEN='t',SENDING=${JSON.stringify(SENDING)},SEND_LOCAL=${local ? '{"d1":1}' : '{}'},LEAVING={},DRAFT_EDITS={},DRAFT_EDIT_ON={},draftConfirm=null,draftArmDiscard=null,draftMsg={},SLK_DIR=null,SLK_EMOJI=null;
         var slkCtx=function(){return {users:{},channels:{},emoji:{},custom:{}};};var slkRender=function(m){return '<p>'+esc(m)+'</p>';};
         ${OUTBOX_PURE_JS}${OUTBOX_VIEW_JS.slice(OUTBOX_VIEW_JS.indexOf('function draftTexts'))}
         return draftCardHtml(DATA.drafts[0],{});`,
      );
      return f({ drafts: [{ id: 'd1', session_id: 's', created_at: '2026-11-09T10:00:00Z', messages: ['one', 'two', 'three'], channel: 'C1' }] }, (x: string) => x, () => '', () => '10:00', '\n', null) as string;
    };
  }
  it('shows sent, a countdown with Send now on the next, and queued for the rest', () => {
    const html = view({ d1: { total: 3, sent: 1, next_at: Date.now() + 12_000, started_at: 0 } });
    expect(html).toContain('\u2713 Sent');
    expect(html).toMatch(/data-eta="\d+">in \d+s</);
    expect(html).toContain('data-dact="sendnow"');
    expect(html).toContain('Queued');
    expect(html).toContain('Sending 2 of 3');
    expect(html).not.toContain('data-dact="send"');
  });
  it('shows Sending while a message posts, and Sending before the first poll lands', () => {
    expect(view({ d1: { total: 3, sent: 0, next_at: null, started_at: 0 } })).toContain('Sending\u2026');
    expect(view({}, true)).toContain('Sending 1 of 3');
  });
  it('the page script still parses', () => {
    expect(() => new Function(OUTBOX_VIEW_JS)).not.toThrow();
  });
});
