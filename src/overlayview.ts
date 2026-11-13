// The one overlay every Loom modal sits in: a fixed layer over the whole window
// that centres its single child both ways and scrolls when the child is taller
// than the window (margin:auto in a flex box centres without clipping the top,
// which place-items:center does). Modals add the class and keep only their own
// z-index and backdrop colour; positioning lives here so they cannot drift
// apart again. Before, the new-chat, new-terminal and rename boxes sat at 12-18vh
// and the opening card 96px under the top bar.
//
// Users: #composer, #termbox, #renamebox, #mpending (src/dashboard.ts,
// src/pendingview.ts), #shipmodal (src/shipmodal.ts), .tpmodal (src/pruneview.ts),
// .sxmodal (src/settingsview.ts). The Cmd-K palette (src/jumpbox.ts) stays
// top-anchored on purpose: its list grows downward from a fixed input.

export const OVERLAY_CLASS = 'loverlay';

export const OVERLAY_CSS = `
  .loverlay { position:fixed; inset:0; z-index:20; display:flex; overflow-y:auto; padding:16px; box-sizing:border-box; background:rgba(5,6,10,.6); }
  .loverlay[hidden] { display:none; }
  .loverlay > * { margin:auto; flex-shrink:0; max-width:100%; }
`;
