// The welcome screen's gate. Pure: the route (src/routes/wizard.ts) reads the
// settings and the page (src/welcomeview.ts) shows the screen when this says so.
//
// The welcome screen sits in front of the setup wizard on a first launch. Once
// Enter has been pressed, `welcome_seen_at` is set and later launches go to the
// wizard (if setup is unfinished) or straight to the board. Settings > Help can
// replay it at any time.

export interface WelcomeGate {
  /** The wizard would open on this launch (setup unfinished, not a migrated install). */
  setupShow: boolean;
  /** When Enter was pressed on the welcome screen (epoch ms); 0 = never. */
  seenAt: number;
  /** Settings > Help asked to show it again. */
  replay?: boolean;
}

export function showWelcome(g: WelcomeGate): boolean {
  if (g.replay) return true;
  const seen = Number.isFinite(g.seenAt) && g.seenAt > 0;
  return g.setupShow && !seen;
}
