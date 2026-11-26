// Loom mobile PWA stylesheet (served at /m/app.css). Colors and spacing follow the approved
// prototype: light and dark palettes as custom properties, System/Light/Dark through a
// data-theme override. No backtick or dollar-brace inside (it is a template string).

export const APP_CSS = String.raw`
:root {
  color-scheme: dark;
  --bg:#0d0f15; --surface:#161a24; --surface2:#1b1f2a; --border:#262a37; --text:#e6e6e6; --text2:#c4ccdc; --muted:#8b93a7;
  --accent:#79b1ff; --primary:#2563eb; --warn:#e8b84b; --warn-bg:#2a2312; --danger:#ff8086; --green:#7fd18b; --green-dot:#56d364;
  --tabbar:rgba(17,20,28,.96); --bubble:#2563eb; --toast:#2b3040; --sheet:#161a24; --mac-card:#1f2433; --track-off:#3a3f4f;
  --st-discovery-fg:#5fafff; --st-discovery-bg:#15243a; --st-implementation-fg:#87d787; --st-implementation-bg:#16281b;
  --st-shipping-fg:#d787d7; --st-shipping-bg:#2a1a2c; --st-thread-fg:#ffaf5f; --st-thread-bg:#2d2113; --st-blocked-fg:#ff875f; --st-blocked-bg:#2e1a14;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg:#f4f5f8; --surface:#ffffff; --surface2:#eceef3; --border:#dde1e8; --text:#11141c; --text2:#2c3445; --muted:#596273;
  --accent:#1d5fd6; --primary:#2563eb; --warn:#8a5a00; --warn-bg:#fdf1d6; --danger:#c0303b; --green:#1e7a33; --green-dot:#22a447;
  --tabbar:rgba(255,255,255,.94); --bubble:#2563eb; --toast:#1b1f2a; --sheet:#ffffff; --mac-card:#e9ecf2; --track-off:#d5d8df;
  --st-discovery-fg:#1f5fbf; --st-discovery-bg:#e3edfc; --st-implementation-fg:#22743a; --st-implementation-bg:#e0f2e4;
  --st-shipping-fg:#86308f; --st-shipping-bg:#f4e5f6; --st-thread-fg:#9a4f00; --st-thread-bg:#fbecd9; --st-blocked-fg:#b4380c; --st-blocked-bg:#fde4da;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    color-scheme: light;
    --bg:#f4f5f8; --surface:#ffffff; --surface2:#eceef3; --border:#dde1e8; --text:#11141c; --text2:#2c3445; --muted:#596273;
    --accent:#1d5fd6; --primary:#2563eb; --warn:#8a5a00; --warn-bg:#fdf1d6; --danger:#c0303b; --green:#1e7a33; --green-dot:#22a447;
    --tabbar:rgba(255,255,255,.94); --bubble:#2563eb; --toast:#1b1f2a; --sheet:#ffffff; --mac-card:#e9ecf2; --track-off:#d5d8df;
    --st-discovery-fg:#1f5fbf; --st-discovery-bg:#e3edfc; --st-implementation-fg:#22743a; --st-implementation-bg:#e0f2e4;
    --st-shipping-fg:#86308f; --st-shipping-bg:#f4e5f6; --st-thread-fg:#9a4f00; --st-thread-bg:#fbecd9; --st-blocked-fg:#b4380c; --st-blocked-bg:#fde4da;
  }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }
body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
button { font: inherit; cursor: pointer; color: inherit; }
textarea, input { font: inherit; color: inherit; }
h1, h2, p { margin: 0; }
.mono { font-family: var(--mono); }
.muted { color: var(--muted); }
.t2 { color: var(--text2); }
.accent { color: var(--accent); }
.ico { display: inline-flex; vertical-align: middle; }

#app { height: 100vh; height: 100dvh; display: flex; flex-direction: column; padding-top: env(safe-area-inset-top); position: relative; overflow: hidden; }
.scr { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.hdr { padding: 6px 20px 12px; display: flex; flex-direction: column; gap: 4px; }
.hdr .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hdr h1 { font-size: 32px; font-weight: 700; letter-spacing: -.5px; }
.hdr p { font-size: 14px; color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 6px 10px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); color: var(--text2); white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green-dot); flex: none; }
.dot.off { background: var(--warn); }
.dot.accent { background: var(--accent); }

.list { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 20px; }
.grp { display: flex; flex-direction: column; gap: 8px; }
.grp > h2 { margin: 0 4px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.empty { padding: 28px 20px; text-align: center; color: var(--muted); font-size: 15px; line-height: 1.5; }

.srow { display: flex; gap: 12px; align-items: flex-start; width: 100%; text-align: left; padding: 12px 14px; border: 0; background: transparent; }
.srow + .srow { border-top: 1px solid var(--border); }
.srow:active { background: var(--surface2); }
.glyph { flex: none; width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-weight: 700; font-size: 16px; }
.st-discovery { color: var(--st-discovery-fg); background: var(--st-discovery-bg); }
.st-implementation { color: var(--st-implementation-fg); background: var(--st-implementation-bg); }
.st-shipping { color: var(--st-shipping-fg); background: var(--st-shipping-bg); }
.st-thread { color: var(--st-thread-fg); background: var(--st-thread-bg); }
.st-blocked { color: var(--st-blocked-fg); background: var(--st-blocked-bg); }
.sbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sline { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.stopic { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sage { flex: none; font-size: 13px; color: var(--muted); }
.smeta { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); min-width: 0; }
.pill { font-family: var(--mono); font-size: 12px; padding: 1px 6px; border-radius: 6px; background: var(--surface2); color: var(--text2); flex: none; }
.stail { font-size: 14px; line-height: 1.4; color: var(--text2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.stail .pfx { color: var(--muted); }

.dhdr { display: flex; align-items: center; gap: 6px; padding: 0 12px 10px 4px; border-bottom: 1px solid var(--border); }
.iconbtn { width: 44px; height: 44px; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; color: var(--accent); flex: none; }
.dtitle { flex: 1; min-width: 0; }
.hdr h1.sub { font-size: 24px; letter-spacing: -.3px; overflow-wrap: anywhere; }
.dtitle .a { font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dtitle .b { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stagechip { flex: none; font-size: 12px; font-weight: 600; padding: 5px 9px; border-radius: 8px; }
.band { padding: 8px 16px; font-size: 13px; display: flex; justify-content: space-between; gap: 8px; background: var(--surface2); color: var(--text2); }
.band .mono { font-size: 12px; color: var(--muted); }
.msgs { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.m-user { align-self: flex-end; max-width: 85%; padding: 10px 14px; border-radius: 18px 18px 4px 18px; font-size: 15px; line-height: 1.4; background: var(--bubble); color: #fff; white-space: pre-wrap; word-break: break-word; }
.m-tool { display: flex; gap: 8px; font-family: var(--mono); font-size: 12.5px; line-height: 1.45; color: var(--muted); word-break: break-word; }
.m-asst { font-size: 15px; line-height: 1.5; padding: 12px 14px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; background: var(--surface); border: 1px solid var(--border); }
.composer { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); background: var(--bg); }
.quick { display: flex; gap: 8px; overflow-x: auto; }
.qbtn { flex: none; height: 36px; padding: 0 14px; border-radius: 18px; font-size: 14px; background: var(--surface); border: 1px solid var(--border); }
.crow { display: flex; gap: 8px; align-items: flex-end; }
.stopbtn { flex: none; width: 44px; height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; background: var(--surface2); border: 1px solid var(--border); color: var(--danger); }
.sendbtn { flex: none; width: 44px; height: 44px; border-radius: 22px; border: 0; display: flex; align-items: center; justify-content: center; background: var(--primary); color: #fff; }
.sendbtn[disabled], .btn[disabled], .qbtn[disabled], .stopbtn[disabled] { opacity: .45; }
.tinput { flex: 1; resize: none; min-height: 44px; max-height: 140px; padding: 11px 14px; border-radius: 22px; font-size: 16px; outline: none; background: var(--surface); border: 1px solid var(--border); line-height: 20px; }
button.attachbtn { flex: none; width: 44px; height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; background: var(--surface2); border: 1px solid var(--border); color: var(--muted); }
.attachbtn[disabled] { opacity: .45; }
.filein { display: none; }
.thumbs { display: flex; gap: 8px; overflow-x: auto; padding-top: 6px; }
.thumbs:empty { display: none; }
.thumb { position: relative; flex: none; width: 56px; height: 56px; border-radius: 10px; border: 1px solid var(--border); }
.thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 9px; display: block; }
.thumb.up img { opacity: .45; }
.thumb.bad { border-color: var(--danger); }
.thumbx { position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; border-radius: 11px; border: 1px solid var(--border); background: var(--surface2); color: var(--text); font-size: 15px; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center; }
.tinput:focus, .field:focus { border-color: var(--accent); }

.tabbar { flex: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 6px 0 env(safe-area-inset-bottom); min-height: calc(56px + env(safe-area-inset-bottom)); background: var(--tabbar); border-top: 1px solid var(--border); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.tab { position: relative; border: 0; background: transparent; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; height: 50px; font-size: 11px; font-weight: 600; color: var(--muted); }
.tab.on { color: var(--accent); }
.badge { position: absolute; top: -2px; left: calc(50% + 6px); min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--primary); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }

.draft { padding: 14px; border-radius: 16px; display: flex; flex-direction: column; gap: 10px; background: var(--surface); border: 1px solid var(--border); }
.draft .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.draft .l { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kind { flex: none; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; padding: 3px 7px; border-radius: 6px; background: var(--surface2); color: var(--text2); }
.where { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ctx { font-size: 13px; color: var(--muted); }
.ctx .openlnk { margin-left: 8px; font-weight: 600; color: var(--accent); text-decoration: none; white-space: nowrap; }
.lnk { color: inherit; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
.m-asst .lnk, .dtext .lnk { color: var(--accent); }
.warnband { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.4; padding: 8px 10px; border-radius: 10px; background: var(--warn-bg); color: var(--warn); }
.dtext { font-size: 15px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dtext + .dtext { padding-top: 8px; border-top: 1px dashed var(--border); }
.edit { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.edit textarea { font-size: 15px; line-height: 1.5; padding: 10px; border-radius: 10px; resize: vertical; outline: none; background: var(--surface); border: 1px solid var(--border); min-height: 110px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.btn { height: 40px; padding: 0 14px; border-radius: 10px; font-size: 15px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); }
.btn.pri { border: 0; background: var(--primary); color: #fff; font-weight: 600; padding: 0 16px; }
.btn.ghost { background: transparent; border: 0; color: var(--danger); }
.btn.dng { color: var(--danger); }
.btn.big.dng { font-weight: 600; }
.iconbtn.talkbtn[disabled] { opacity: .45; }
.iconbtn.more { font-size: 26px; line-height: 1; margin-right: -8px; }
.dock { flex: none; display: flex; flex-direction: column; border-top: 1px solid var(--border); background: var(--bg); }
.dockbar { flex: none; height: 40px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 0; background: var(--warn-bg); color: var(--warn); font-size: 14px; font-weight: 600; }
.dockbar .chev { font-size: 12px; }
.docklist { max-height: 45vh; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.draft.mini { flex: none; padding: 12px; gap: 8px; border-radius: 14px; }
.draft.mini .where { font-size: 15px; }
.draft.mini .dtext { font-size: 14px; }
.dtext.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
.draft.mini .actions { align-items: center; }
.draft.mini .actions .btn { height: 36px; }
.actions .openlnk { margin-right: auto; font-size: 14px; font-weight: 600; color: var(--accent); text-decoration: none; white-space: nowrap; }
.btn.big { height: 50px; border-radius: 14px; font-size: 17px; flex: 1; }
.btn.big.pri { font-weight: 600; }
.btn.link { background: transparent; border: 0; color: var(--accent); }
.done { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 14px; font-size: 14px; background: var(--surface); border: 1px solid var(--border); }
.done .dot { background: var(--green-dot); }

.setgrp { display: flex; flex-direction: column; gap: 8px; }
.setgrp > h2 { margin: 0 4px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; color: var(--muted); }
.setgrp > .note { margin: 0 4px; font-size: 13px; line-height: 1.4; color: var(--muted); }
.trow { display: flex; align-items: center; gap: 12px; padding: 10px 14px; }
.trow + .trow { border-top: 1px solid var(--border); }
.trow .tx { flex: 1; min-width: 0; }
.trow .tx .a { font-size: 16px; }
.trow .tx .b { font-size: 13px; line-height: 1.35; color: var(--muted); }
.sw { flex: none; width: 51px; height: 31px; border-radius: 16px; border: 0; padding: 2px; display: flex; justify-content: flex-start; background: var(--track-off); }
.sw[aria-checked="true"] { background: #34c759; justify-content: flex-end; }
.sw i { width: 27px; height: 27px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.this { font-size: 12px; font-weight: 600; color: var(--green); margin-left: 4px; }
.small { height: 36px; padding: 0 12px; border-radius: 9px; font-size: 14px; background: var(--surface2); border: 1px solid var(--border); color: var(--danger); flex: none; }
.small.neutral { color: var(--text); }
.seg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 3px; border-radius: 11px; background: var(--surface2); }
.seg button { height: 34px; border-radius: 8px; border: 0; font-size: 14px; background: transparent; color: var(--muted); }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.18); }
.conn { padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.conn > div { display: flex; justify-content: space-between; gap: 12px; }
.conn .mono { font-size: 13px; word-break: break-all; text-align: right; }

.pair { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 24px calc(20px + env(safe-area-inset-bottom)); gap: 18px; overflow-y: auto; }
.bars { display: flex; gap: 6px; }
.bars span { flex: 1; height: 4px; border-radius: 2px; background: var(--surface2); }
.bars span.on { background: var(--accent); }
.pair h1 { font-size: 28px; line-height: 1.2; font-weight: 700; }
.pair p { font-size: 16px; line-height: 1.5; color: var(--text2); }
.pair .fine { font-size: 13px; line-height: 1.45; color: var(--muted); }
.pair .stepn { font-size: 13px; font-weight: 600; color: var(--muted); }
.steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.steps li { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 12px; font-size: 15px; background: var(--surface); border: 1px solid var(--border); }
.steps .n { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; flex: none; background: var(--surface2); color: var(--accent); }
.field-l { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.field { border-radius: 12px; outline: none; background: var(--surface); border: 1px solid var(--border); height: 48px; padding: 0 14px; font-size: 16px; width: 100%; }
.field.code { height: 64px; text-align: center; font-family: var(--mono); font-size: 30px; letter-spacing: 4px; border-radius: 14px; padding: 0 8px; }
.maccard { border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: var(--mac-card); border: 1px solid var(--border); }
.maccard .k { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
.maccard .q { font-size: 16px; font-weight: 600; }
.maccard ul { margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.55; color: var(--text2); }
.err { font-size: 14px; color: var(--danger); }
.spacer { flex: 1; }
.col { display: flex; flex-direction: column; gap: 10px; }
.push-prev { border-radius: 14px; padding: 12px 14px; display: flex; gap: 12px; align-items: flex-start; background: var(--surface); border: 1px solid var(--border); }
.push-prev .app { flex: none; width: 36px; height: 36px; border-radius: 9px; background: #0f1118; display: flex; align-items: center; justify-content: center; color: #ffb238; font-weight: 800; font-size: 18px; }
.push-prev .t { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); }
.push-prev .h { font-size: 15px; font-weight: 600; }
.push-prev .bdy { font-size: 14px; line-height: 1.4; color: var(--text2); }
.waiting { font-size: 14px; display: flex; align-items: center; gap: 8px; color: var(--muted); }

.overlay { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,.5); display: flex; flex-direction: column; justify-content: flex-end; }
.sheet { border-radius: 20px 20px 0 0; padding: 20px 20px calc(20px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 14px; background: var(--sheet); color: var(--text); max-height: 90%; overflow-y: auto; }
.sheet .ttl { font-size: 19px; font-weight: 700; }
.sheet .prev { font-size: 14px; line-height: 1.45; padding: 10px 12px; border-radius: 10px; max-height: 110px; overflow: hidden; background: var(--surface2); color: var(--text2); white-space: pre-wrap; }
.sheet .newm { font-size: 14px; line-height: 1.4; padding: 8px 10px; border-radius: 10px; background: var(--surface2); color: var(--text2); }
.sheet .wl { font-size: 13px; font-weight: 600; color: var(--warn); }
.sheet .ro { display: flex; gap: 10px; }
.toast { position: absolute; z-index: 30; left: 16px; right: 16px; top: calc(8px + env(safe-area-inset-top)); display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; font-size: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.3); background: var(--toast); color: #fff; }
.toast span { flex: 1; }
.toast button { border: 0; background: transparent; font-size: 14px; font-weight: 700; color: #9cc3ff; }
.center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; }
.center p { color: var(--muted); font-size: 15px; line-height: 1.5; }
`;
