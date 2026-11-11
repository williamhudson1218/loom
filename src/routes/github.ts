import { findBin, ghStatusVia, makeGhConnect, type GhStatus, type Job } from '../ghconnect.ts';
import { setGhStatus } from '../connections.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Connect GitHub: status, start a device login, install gh with Homebrew, cancel.
// Every write row is guarded by requireWrite (tests/auth.test.ts sweeps the table).
// A login is refused while gh is signed in unless the page says `again: true`, which
// it only sends after the person picked Sign in again.

export interface GithubRouteDeps {
  ghBin(): string;
  brewBin(): string;
  status(bin: string): Promise<GhStatus>;
  connect: ReturnType<typeof makeGhConnect>;
}

export function makeGithubRoutes(over: Partial<GithubRouteDeps> = {}): RouteDef[] {
  const ghBin = over.ghBin ?? (() => findBin('gh'));
  const status = over.status ?? ((b: string) => ghStatusVia(b));
  // Refresh the header's dot from a fresh read once a login or install ends.
  const onDone = (_j: Job) => void status(ghBin()).then(setGhStatus, () => {});
  const deps: GithubRouteDeps = {
    ghBin,
    brewBin: over.brewBin ?? (() => findBin('brew')),
    status,
    connect: over.connect ?? makeGhConnect({ onDone }),
  };

  async function view(fresh = true) {
    const bin = deps.ghBin();
    const st = fresh ? await deps.status(bin) : { state: 'unknown' as const, login: '' };
    return { ok: true, state: st.state, login: st.login || null, gh: bin || null, brew: !!deps.brewBin(), job: deps.connect.job() };
  }

  async function getStatus(ctx: RouteCtx): Promise<void> {
    // A running job is polled every second or so; gh is only asked when nothing runs.
    const j = deps.connect.job();
    if (j && j.state === 'running') return ctx.json(200, { ok: true, state: 'unknown', login: null, gh: deps.ghBin() || null, brew: !!deps.brewBin(), job: j });
    ctx.json(200, await view());
  }

  async function postLogin(ctx: RouteCtx): Promise<void> {
    const body = await ctx.body();
    const bin = deps.ghBin();
    if (!bin) return ctx.json(409, { ok: false, error: 'gh_missing', hint: 'Install gh first.' });
    const cur = deps.connect.job();
    if (cur && cur.state === 'running') return ctx.json(409, { ok: false, error: 'busy', hint: 'A GitHub step is already running.', job: cur });
    const st = await deps.status(bin);
    if (st.state === 'ok' && body?.again !== true) {
      return ctx.json(409, { ok: false, error: 'already_signed_in', hint: `gh is already signed in${st.login ? ' as ' + st.login : ''}.`, login: st.login || null });
    }
    const j = deps.connect.login(bin);
    ctx.json(200, { ok: true, job: j });
  }

  async function postInstall(ctx: RouteCtx): Promise<void> {
    if (deps.ghBin()) return ctx.json(409, { ok: false, error: 'gh_installed' });
    const brew = deps.brewBin();
    if (!brew) return ctx.json(409, { ok: false, error: 'no_brew', hint: 'Homebrew is not installed. Get gh from cli.github.com.' });
    const cur = deps.connect.job();
    if (cur && cur.state === 'running') return ctx.json(409, { ok: false, error: 'busy', job: cur });
    ctx.json(200, { ok: true, job: deps.connect.install(brew) });
  }

  function postCancel(ctx: RouteCtx): void {
    ctx.json(200, { ok: true, cancelled: deps.connect.cancel(), job: deps.connect.job() });
  }

  return [
    { method: 'POST', path: '/api/github/login', kind: 'browser', handler: postLogin },
    { method: 'POST', path: '/api/github/install', kind: 'browser', handler: postInstall },
    { method: 'POST', path: '/api/github/cancel', kind: 'browser', handler: postCancel },
    // Read-only: `gh auth status`, which changes nothing.
    { method: 'GET', path: '/api/github/status', kind: 'read', handler: getStatus },
  ];
}

export const routes: RouteDef[] = makeGithubRoutes();
