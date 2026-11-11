// Types for version.mjs (plain ESM so build.mjs and dist.mjs can import it without a compile step).
export declare const VERSION_BASE: string;
export declare function versionFor(count: number | string): string;
export declare function buildInfo(cwd: string, env?: NodeJS.ProcessEnv): { version: string; commit: string; channel: 'release' | 'local' };
