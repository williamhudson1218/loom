// What the user is told about macOS permissions, in one place, so every surface
// (the shortcut's notification, the wizard, Settings, the docs) names exactly
// the row they will find in System Settings. tests/axcopy.test.ts keeps the
// helpers' old binary names out of anything a user reads.

/** The name of Loom's row in Privacy & Security › Accessibility (the helper bundle's CFBundleName). */
export const AX_ROW_NAME = 'Loom';

/** Where the switch is. */
export const AX_SETTINGS_PATH = 'System Settings › Privacy & Security › Accessibility';

/** One sentence: what to switch on. */
export const AX_GRANT_HINT = `Switch on "${AX_ROW_NAME}" in ${AX_SETTINGS_PATH}.`;
