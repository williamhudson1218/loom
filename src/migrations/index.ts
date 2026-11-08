import { registerSteps, type MigrationStep } from '../migrate.ts';
import { step as settings } from './settings.ts';
import { step as ship } from './ship.ts';
import { step as orchPrompt } from './orchprompt.ts';
import { step as watchers } from './watchers.ts';
import { step as state } from './state.ts';

// The legacy migration, in order. settings goes first: it reads the legacy
// watcher tables (briefs, spawn lanes) before the watchers step converts them.
export const STEPS: MigrationStep[] = [settings, ship, orchPrompt, watchers, state];
registerSteps(STEPS);
