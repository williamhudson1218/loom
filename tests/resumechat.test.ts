import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { renderDashboard } from '../src/dashboard.ts';

// Restart to update relaunches Loom with ?resume=1 (app/main.ts); the page then
// reopens the chat that was open instead of landing on Home.

const html = String(renderDashboard([], Date.now(), {}, 'claude'));
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const line = (re: RegExp): string => {
  const m = script.match(re);
  if (!m) throw new Error(`no line ${re}`);
  return m[0];
};

function page(search: string, stored: string | null, chats: { session_id: string; agent: string }[]) {
  const opened: string[] = [];
  const replaced: string[] = [];
  const ctx: any = vm.createContext({
    JSON,
    location: { search, pathname: '/' },
    history: { replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) },
    lsGet: (k: string) => (k === 'loom.lastChat' ? stored ?? '' : ''),
    DATA: { chats },
    selectChat: (sid: string, agent: string) => opened.push(agent + ':' + sid),
  });
  vm.runInContext(line(/^var RESUME=null;.*$/m).replace(/^var /, 'var ') + '\n' + line(/^function resumeLastChat\(.*$/m), ctx);
  return { ctx, opened, replaced };
}

const stored = JSON.stringify({ sid: 'sid-1', agent: 'claude' });
const chats = [{ session_id: 'sid-1', agent: 'claude' }];

describe('reopen the last chat after Restart to update', () => {
  it('opens the remembered chat once, and drops ?resume=1 from the URL', () => {
    const { ctx, opened, replaced } = page('?resume=1', stored, chats);
    ctx.resumeLastChat();
    ctx.resumeLastChat();
    expect(opened).toEqual(['claude:sid-1']);
    expect(replaced).toEqual(['/']);
  });

  it('a normal launch stays on Home', () => {
    const { ctx, opened } = page('', stored, chats);
    ctx.resumeLastChat();
    expect(opened).toEqual([]);
  });

  it('nothing remembered, a chat no longer listed, or a bad value: stays on Home', () => {
    for (const [s, list] of [[null, chats], [stored, []], ['{oops', chats]] as const) {
      const { ctx, opened } = page('?resume=1', s, [...list]);
      ctx.resumeLastChat();
      expect(opened).toEqual([]);
    }
  });

  it('opening a chat remembers it; leaving for Home or deselecting forgets it', () => {
    expect(line(/^function selectChat\(.*$/m)).toContain("if(!arch)lsSet('loom.lastChat',JSON.stringify({sid:sid,agent:agent}));");
    expect(line(/^function deselect\(.*$/m)).toContain("lsDel('loom.lastChat')");
    expect(line(/^function selectHome\(.*$/m)).toContain("lsDel('loom.lastChat')");
  });
});
