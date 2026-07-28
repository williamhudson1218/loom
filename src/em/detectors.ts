import type { EmSignals } from './signals.ts';
import type { Finding } from './ledger.ts';

// INITIAL GUESSES. These exist to be recalibrated from a week of shadow-mode
// em_findings rows — that is the entire point of Phase 1. Do not treat them as
// tuned values.
export interface Thresholds {
  blockedIdleMs: number;
  wrappableIdleMs: number;
  bloatedFraction: number;
}

export const THRESHOLDS: Thresholds = {
  // Long enough that Will simply reading the question does not trip it.
  blockedIdleMs: 90_000,
  // Grace period so a just-finished session is not yanked out from under him.
  wrappableIdleMs: 10 * 60_000,
  // NOTE: context.ts's tier promotion makes `fraction` an UPPER bound on real
  // pressure, so this fires early on 1M sessions. Calibrate against that bias.
  bloatedFraction: 0.70,
};

function finding(s: EmSignals, kind: Finding['kind'], now: number, extra: Record<string, unknown>): Finding {
  return {
    agent: s.agent,
    session_id: s.session_id,
    kind,
    // Retained so Phase 2's thresholds can be set from what actually fired.
    signals: { state: s.state, idleMs: s.idleMs, ageMs: s.ageMs, messageCount: s.messageCount, ...extra },
    detected_at: now,
  };
}

export function detect(signals: EmSignals[], now: number, t: Thresholds = THRESHOLDS): Finding[] {
  const out: Finding[] = [];

  for (const s of signals) {
    // BLOCKED and WRAPPABLE are definitionally idle states: a session that is
    // generating is neither waiting on the user nor finished, whatever the last
    // summarizer pass recorded.
    const idleAndLive = s.live && !s.working;

    if (idleAndLive && s.state === 'waiting_on_user' && s.idleMs > t.blockedIdleMs) {
      out.push(finding(s, 'BLOCKED', now, {}));
    }

    if (idleAndLive && s.state === 'done' && s.idleMs > t.wrappableIdleMs) {
      out.push(finding(s, 'WRAPPABLE', now, {}));
    }

    // Unlike the other two, this fires while working: context only ever grows,
    // so waiting for idle means waiting through the degraded turns the detector
    // exists to prevent.
    if (s.live && s.context && s.context.fraction >= t.bloatedFraction) {
      out.push(
        finding(s, 'BLOATED', now, {
          contextTokens: s.context.tokens,
          contextLimit: s.context.limit,
          contextFraction: Number(s.context.fraction.toFixed(4)),
          model: s.context.model,
        }),
      );
    }
  }
  return out;
}
