// Prints "<dir> <key>" for each native helper (see nativecache.mjs), for
// scripts/release/helpers.sh. Run from anywhere.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPERS, helperKeyFor } from './nativecache.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
for (const h of HELPERS) console.log(`${h.dir} ${helperKeyFor(h, APP_DIR)}`);
