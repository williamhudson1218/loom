import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The directory of the module whose import.meta.url is given, or null.
//
// The app bundle (app/build.mjs) defines import.meta.url to the sentinel
// "loom-bundled", which is not a URL at all: `new URL(import.meta.url)` and
// `fileURLToPath(import.meta.url)` both throw "Invalid URL" there. Any src module
// that wants its own location goes through this, which says null in the bundle
// and lets the caller fall back to another candidate.
export function moduleDirOf(metaUrl: string | undefined): string | null {
  if (typeof metaUrl !== 'string' || !metaUrl.startsWith('file:')) return null;
  try {
    return path.dirname(fileURLToPath(metaUrl));
  } catch {
    return null;
  }
}
