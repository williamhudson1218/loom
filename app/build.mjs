import { build } from 'esbuild';

// Bundle the Electron main process + all imported ../src/*.ts into one CJS file.
// better-sqlite3 stays external (native, loaded from node_modules at runtime).
// The src auto-run guards use import.meta.url; define it to a sentinel so those
// `=== file://...` checks are false in the bundle (we drive everything from main).
await build({
  entryPoints: ['main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/main.js',
  external: ['electron', 'better-sqlite3'],
  define: { 'import.meta.url': '"loom-bundled"' },
  logLevel: 'info',
});
console.log('built dist/main.js');
