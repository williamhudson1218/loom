import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { renderDashboard } from '../src/dashboard.ts';
import { PRCI_PURE_JS, PRCI_VIEW_JS } from '../src/prci.ts';
import { assemblePipeline, activeJobs } from '../src/pipeline.ts';

const dots = (checks: string, merged = 'waiting') => [
  { key: 'checks', label: 'Checks', state: checks, detail: checks === 'fail' ? '1 failed: Unit Tests' : '3/5' },
  { key: 'review', label: 'Review', state: 'waiting' },
  { key: 'merged', label: 'Merged', state: merged },
];
const jobs = [
  { label: 'CI / Unit Tests', state: 'fail', url: 'https://github.com/o/r/actions/runs/1/job/2' },
  { label: 'CI / Lint', state: 'running' },
];

function harness(data: any, chat: any = { agent: 'claude', session_id: 's1' }) {
  const ctx: any = {
    DATA: data,
    esc: (s: string) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m as '&']),
    chatKey: (c: any) => c.agent + ':' + c.session_id,
    chatPrUrl: (c: any) => ((data.chatPr || {})[c.agent + ':' + c.session_id] ? 'https://github.com/' + data.chatPr['claude:s1'].replace('#', '/pull/') : ''),
    prStateOf: () => '',
    dotsHtml: (p: any) => (p ? '<span class="pdots"></span>' : ''),
    mbtn: (act: string, label: string, cls?: string, extra?: string) => `<button type="button" class="mbtn${cls ? ' ' + cls : ''}" data-act="${act}"${extra || ''}>${label}</button>`,
    $: () => null,
    selChat: () => chat,
    copyText: () => {},
    window: { open() {}, addEventListener() {} },
    document: { addEventListener() {}, querySelector: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(PRCI_PURE_JS + PRCI_VIEW_JS, ctx);
  return { ctx, head: () => vm.runInContext('prciHeadHtml(' + JSON.stringify(chat) + ')', ctx) as string, menu: () => vm.runInContext('prciMenuHtml(prciOf(' + JSON.stringify(chat) + '))', ctx) as string };
}

const own = { 'claude:s1': 'o/r#10' };
const ships = [{ slug: 'o/r', shipped: [{ number: 20, url: 'https://github.com/o/r/pull/20', state: 'MERGED', members: ['claude:s1'] }] }];

describe('PR and CI split button', () => {
  it('no button without a PR, and not for a ship that did not carry the chat', () => {
    expect(harness({ chatPr: {}, pipes: {}, ships: [] }).head()).toBe('');
    expect(harness({ chatPr: {}, pipes: {}, ships: [{ slug: 'o/r', shipped: [{ number: 20, url: 'https://github.com/o/r/pull/20', state: 'OPEN', members: ['claude:other'] }] }] }).head()).toBe('');
  });

  it('shows PR #N, a state pill, CI summary, and a caret even with one PR', () => {
    const h = harness({ chatPr: own, pipes: { 'o/r#10': { dots: dots('fail'), jobs, events: [] } }, ships: [] }).head();
    expect(h).toContain('data-act="prci"');
    expect(h).toContain('data-act="prcimenu"');
    expect(h).toContain('PR #10');
    expect(h).toContain('>open<');
    expect(h).toContain('CI 1 failed');
  });

  it('menu lists own PR, the ship PR, and failing and running CI rows with links', () => {
    const m = harness({ chatPr: own, pipes: { 'o/r#10': { dots: dots('fail'), jobs, events: [] }, 'o/r#20': { dots: dots('pass', 'pass'), jobs: [], events: [] } }, ships }).menu();
    expect(m).toContain('PR #10');
    expect(m).toContain('PR #20');
    expect(m).toContain('ship PR');
    expect(m).toContain('>merged<');
    expect(m).toContain('title="https://github.com/o/r/pull/20/checks"');
    expect(m).toContain('title="https://github.com/o/r/pull/10/files"');
    expect(m).toContain('CI / Unit Tests');
    expect(m).toContain('title="https://github.com/o/r/actions/runs/1/job/2"');
    expect(m).toContain('CI / Lint');
    expect((m.match(/Copy PR link/g) || []).length).toBe(2);
  });

  it('server side: activeJobs keeps failing and running checks with their urls', () => {
    const p = assemblePipeline({ repo: 'o/r', pr: { number: 1, url: 'u', state: 'OPEN', statusCheckRollup: [
      { name: 'Unit Tests', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/run/1' },
      { name: 'Lint', workflowName: 'CI', status: 'IN_PROGRESS', detailsUrl: 'https://x/run/2' },
      { name: 'Types', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://x/run/3' },
    ] }, run: null, jobs: [] } as any);
    const j = activeJobs(p);
    expect(j.map((x) => x.state)).toEqual(['fail', 'running']);
    expect(j[0].url).toBe('https://x/run/1');
  });

  it('page carries the menu container, uses window.open, and parses', () => {
    const html = String(renderDashboard([], Date.now(), {}, 'claude'));
    expect(html).toContain('id="prdd"');
    expect(html).toContain("window.open(u,'_blank','noopener')");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1])).not.toThrow();
  });
});
