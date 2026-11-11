// Writes latest.json for a release: what the in-app updater (src/updater.ts) reads
// from https://github.com/<repo>/releases/latest/download/latest.json.
//
//   node scripts/release/latest.mjs <version> <sha> <zip-file> <out.json> [notes-file]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [version, sha, zipFile, out, notesFile] = process.argv.slice(2);
if (!version || !sha || !zipFile || !out) {
  console.error('usage: latest.mjs <version> <sha> <zip-file> <out.json> [notes-file]');
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY || 'williamhudson1218/loom';
const zipName = path.basename(zipFile);
const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
const latest = {
  version,
  sha,
  zip: `https://github.com/${repo}/releases/download/v${version}/${zipName}`,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex'),
  size: fs.statSync(zipFile).size,
  notes,
  published_at: new Date().toISOString(),
};
fs.writeFileSync(out, JSON.stringify(latest, null, 2) + '\n');
console.log(JSON.stringify(latest));
