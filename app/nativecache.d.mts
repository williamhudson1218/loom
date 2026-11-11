// Types for nativecache.mjs (plain ESM so build.mjs can import it without a compile step).
export declare const CACHE_VERSION: number;
export declare function helperCacheKey(parts: (string | Buffer)[]): string;
export declare function shouldRebuild(o: { key: string; storedKey: string; bundleValid: boolean }): boolean;
export declare function helperInfoPlist(o: { id: string; exe: string; version: string }): string;
export declare const HELPERS: { dir: string; exe: string; id: string; src: string }[];
export declare function helperKeyFor(h: { dir: string; exe: string; id: string; src: string }, appDir: string): string;
