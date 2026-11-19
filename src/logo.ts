// The Loom mark from app/assets/icon.svg: three woven threads on the dark tile.
// Used for the favicon, the setup wizard's header and Settings > About. Plain
// markup with no backtick, dollar-brace or backslash, so views can splice it.
export const LOGO_SVG =
  '<svg width="24" height="24" viewBox="100 100 824 824" xmlns="http://www.w3.org/2000/svg"> <defs><linearGradient id="loom-bg" gradientUnits="userSpaceOnUse" x1="100" y1="100" x2="924" y2="924"><stop offset="0" stop-color="#1f2436"/><stop offset="1" stop-color="#0f1118"/></linearGradient> <clipPath id="loom-x"><rect x="340" y="500" width="230" height="220"/></clipPath></defs> <rect x="100" y="100" width="824" height="824" rx="184" fill="url(#loom-bg)"/> <g fill="none" stroke-linecap="round"><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="26"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(0 0)" stroke="#ffb238" stroke-width="26"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="26"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="url(#loom-bg)" stroke-width="62" clip-path="url(#loom-x)"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(0 0)" stroke="url(#loom-bg)" stroke-width="62" clip-path="url(#loom-x)"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="url(#loom-bg)" stroke-width="62" clip-path="url(#loom-x)"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="26"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(0 0)" stroke="#ffb238" stroke-width="26"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="26"/></g></svg>';

/**
 * The mark at a given pixel size, for inline use. `id` keeps its gradient and
 * clip ids unique on the page: a duplicate id inside a hidden view (the closed
 * wizard) would leave a visible copy's tile unpainted.
 */
export function logoSvg(px: number, id: string, cls = ''): string {
  return LOGO_SVG.split('loom-bg').join('loom-bg-' + id).split('loom-x').join('loom-x-' + id)
    .replace('<svg width="24" height="24"', '<svg' + (cls ? ' class="' + cls + '"' : '') + ' width="' + px + '" height="' + px + '" aria-hidden="true" focusable="false"');
}

// The mark without its tile (the welcome screen, and small sizes where the
// tile would leave the threads too thin to read). Where the second strokes
// cross the first, a mask cuts the first ones (the tile's colour did that before),
// so the weave reads over the starfield.
// Its strokes carry pathLength="1" so the welcome screen can draw them in;
// elsewhere that changes nothing. `id` keeps the mask and clip ids unique.
export function threadMark(cls: string, id: string, px: number | string = 0): string {
  return '<svg class="' + cls + '"' + (px ? ' width="' + px + '" height="' + px + '"' : '') + ' viewBox="180 180 660 640" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<defs><clipPath id="' + id + '-x"><rect x="340" y="500" width="230" height="220"/></clipPath>'
  + '<mask id="' + id + '-m" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect x="0" y="0" width="1024" height="1024" fill="#fff"/>'
  + '<g fill="none" stroke-linecap="round" clip-path="url(#' + id + '-x)"><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#000" stroke-width="62"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" stroke="#000" stroke-width="62"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#000" stroke-width="62"/></g></mask></defs>'
  + '<g fill="none" stroke-linecap="round"><g mask="url(#' + id + '-m)"><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="26" pathLength="1"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" stroke="#ffb238" stroke-width="26" pathLength="1"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="26" pathLength="1"/></g><path class="lw-t2" d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="26" pathLength="1"/><path class="lw-t2" d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" stroke="#ffb238" stroke-width="26" pathLength="1"/><path class="lw-t2" d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="26" pathLength="1"/></g></svg>';
}

/**
 * The loading indicator: the tileless mark with its threads drawing in and out in
 * a loop (the welcome screen's weave, repeated). Use it wherever a spinner was.
 * Needs LOADING_MARK_CSS once on the page; `id` keeps mask and clip ids unique.
 */
export function loadingMark(px: number, id: string): string {
  return threadMark('lmk', id, px);
}

/** CSS for loadingMark, to splice once into each view's shared styles. */
export const LOADING_MARK_CSS = `
  .lmk { display:inline-block; flex:none; vertical-align:-2px; overflow:visible; }
  .lmk path[pathLength] { stroke-width:42; stroke-dasharray:1; stroke-dashoffset:1; animation:lmk-weave 2.4s cubic-bezier(.6,0,.2,1) infinite; }
  .lmk path.lw-t2[pathLength] { animation-delay:.35s; }
  @keyframes lmk-weave { 0% { stroke-dashoffset:1; } 45%, 70% { stroke-dashoffset:0; } 100% { stroke-dashoffset:-1; } }
  @keyframes lmk-pulse { 50% { opacity:.4; } }
  @media (prefers-reduced-motion:reduce) {
    .lmk path[pathLength] { animation:none; stroke-dashoffset:0; }
    .lmk { animation:lmk-pulse 1.6s ease-in-out infinite; }
  }
`;

/**
 * Page side: defines loadingMark(px) in the view's script, a fresh id per call.
 * Splice it into a client script as plain text (no template literal around it).
 */
export const LOADING_MARK_JS = 'var LMK_TPL=' + JSON.stringify(threadMark('lmk', 'lmk@N@', '@PX@')) + ';\nvar LMK_N=0;\nfunction loadingMark(px){return LMK_TPL.split(\'@N@\').join(String(++LMK_N)).split(\'@PX@\').join(String(px));}\n';
