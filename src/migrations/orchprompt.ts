import fs from 'node:fs';
import path from 'node:path';
import type { MigrationContext, MigrationStep } from '../migrate.ts';
import { ORCH_PROMPT, ORCH_PROMPT_OVERRIDE } from '../orchsession.ts';

// The orchestrator prompt, legacy install.
//
// The built-in prompt is now generic, and `prompt.override.md` in the
// orchestrator's folder wins when it has text. An existing install's orchestrator
// was started from `prompt.md`, which the previous build wrote with its built-in
// text and which the new build rewrites with the generic default at its next
// start. So before that happens, keep what the install actually ran: copy
// prompt.md to prompt.override.md.
//
// Skipped when an override already has text (never overwritten), when there is
// no prompt.md (the orchestrator never ran), or when prompt.md is already the
// current default (nothing to keep). Runs inside the transaction: a failure to
// write rolls the migration back, so the next open tries again before the old
// text can be lost.

export type OrchPromptOutcome = 'kept' | 'override-exists' | 'no-prompt' | 'same-as-default';

export function keepOrchPrompt(ctx: Pick<MigrationContext, 'loomHome' | 'log'>): OrchPromptOutcome {
  const dir = path.join(ctx.loomHome, 'orchestrator');
  const override = path.join(dir, ORCH_PROMPT_OVERRIDE);
  try {
    if (fs.readFileSync(override, 'utf-8').trim()) return 'override-exists';
  } catch {
    /* none yet */
  }
  let old: string;
  try {
    old = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf-8');
  } catch {
    return 'no-prompt';
  }
  if (!old.trim()) return 'no-prompt';
  if (old.trim() === ORCH_PROMPT.trim()) return 'same-as-default';
  const tmp = `${override}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, old, { mode: 0o644 });
  fs.renameSync(tmp, override);
  ctx.log(`orchestrator: kept the prompt this install ran as ${override}`);
  return 'kept';
}

export const step: MigrationStep = { id: 'orch-prompt', run: (ctx) => void keepOrchPrompt(ctx) };
