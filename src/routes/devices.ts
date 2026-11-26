import type { RouteCtx, RouteDef } from './index.ts';
import { phoneAccessView, setPhoneAccess } from '../mobile/api.ts';
import { tailscaleSetup } from '../mobile/tailscale.ts';
import { deviceStore, formatCode } from '../mobile/devices.ts';
import { startVoiceInstall, voiceSetupView } from '../mobile/voice-setup.ts';

// Settings › Devices on Loom's own page: Phone access (tailscale serve), pairing a
// phone, and the paired devices. Writes are browser-guarded rows (launch token +
// Loom's Origin). GET /api/devices is a tokenless read, like every read route: it
// carries the live pairing code, which is acceptable only because a read needs
// Loom's own Host (no tailnet Host reaches /api/*, and the page's origin is the
// only one that can read the response).
//   GET  /api/devices                    { phoneAccess, setup, devices, pending, pairing }
//   POST /api/devices/phone-access {on}  same shape
//   POST /api/devices/pair-start         { code, url, expires_at }
//   POST /api/devices/approve {id} | deny {id} | revoke {id}
//   POST /api/devices/voice-install      starts the Conversation mode install; same shape

function pairingUrl(access: { url?: string }): string {
  return access.url ?? '';
}

async function view() {
  const s = deviceStore();
  const phoneAccess = await phoneAccessView();
  const code = s.liveCode();
  const ts = await tailscaleSetup();
  const devs = s.devices();
  return {
    phoneAccess,
    // The Set up your phone checklist reads these; each is a plain fact, never a secret.
    setup: { ...ts, phoneAccess: phoneAccess.state === 'on', paired: devs.length > 0, notifications: devs.some((d) => !!d.push) },
    devices: devs.map((d) => ({ id: d.id, name: d.name, created_at: d.created_at, last_seen_at: d.last_seen_at, push: !!d.push })),
    pending: s.pendingRequests(),
    pairing: code ? { code: formatCode(code.code), url: pairingUrl(phoneAccess), expires_at: code.expires_at } : null,
    // Conversation mode: whisper, its model and Kokoro on this Mac, plus a running install.
    voice: voiceSetupView(),
  };
}

async function getDevices(ctx: RouteCtx): Promise<void> {
  ctx.json(200, await view());
}

async function postPhoneAccess(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  if (typeof b?.on !== 'boolean') return ctx.json(400, { ok: false, detail: 'on must be true or false' });
  await setPhoneAccess(b.on);
  ctx.json(200, await view());
}

async function postPairStart(ctx: RouteCtx): Promise<void> {
  await ctx.body();
  const c = deviceStore().startPairing();
  ctx.json(200, { code: formatCode(c.code), url: pairingUrl(await phoneAccessView()), expires_at: c.expires_at });
}

async function postVoiceInstall(ctx: RouteCtx): Promise<void> {
  await ctx.body();
  startVoiceInstall();
  ctx.json(200, await view());
}

const byId = (fn: (id: string) => boolean, missing: string) => async (ctx: RouteCtx): Promise<void> => {
  const b = await ctx.body();
  const id = typeof b?.id === 'string' ? b.id : '';
  if (!id) return ctx.json(400, { ok: false, detail: 'id is required' });
  if (!fn(id)) return ctx.json(404, { ok: false, detail: missing });
  ctx.json(200, { ok: true, ...(await view()) });
};

export const routes: RouteDef[] = [
  { method: 'GET', path: '/api/devices', kind: 'read', handler: getDevices },
  { method: 'POST', path: '/api/devices/phone-access', kind: 'browser', handler: postPhoneAccess },
  { method: 'POST', path: '/api/devices/pair-start', kind: 'browser', handler: postPairStart },
  { method: 'POST', path: '/api/devices/voice-install', kind: 'browser', handler: postVoiceInstall },
  { method: 'POST', path: '/api/devices/approve', kind: 'browser', handler: byId((id) => !!deviceStore().approve(id), 'no such pending request') },
  { method: 'POST', path: '/api/devices/deny', kind: 'browser', handler: byId((id) => deviceStore().deny(id), 'no such pending request') },
  { method: 'POST', path: '/api/devices/revoke', kind: 'browser', handler: byId((id) => deviceStore().revoke(id), 'no such device') },
];
