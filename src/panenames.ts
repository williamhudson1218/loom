import { execFileSync } from 'node:child_process';
import { SESSION_PREFIX } from './paths.ts';

// Every workspace pane gets a short, sayable name ("blue-vanilla") so it can be
// referred to in conversation without the index arithmetic of "session 2 pane 1",
// which also silently changes meaning when a neighbouring pane closes. The name
// lives in the pane's own `@name` option, so tmux keeps it for the pane's whole
// life and it survives Loom restarting; the layout snapshot carries it across a
// tmux server death.

// Short, lowercase, one word each, easy to say and type, and nothing that reads
// badly next to any noun. Colours and moods on the left, concrete things on the
// right — 60 x 60 is 3600 names, far more than a workspace will ever hold.
export const ADJECTIVES = [
  'amber', 'azure', 'blue', 'bold', 'brave', 'breezy', 'bright', 'brisk', 'calm', 'cheery',
  'chilly', 'coral', 'cosmic', 'cozy', 'crisp', 'curly', 'dizzy', 'eager', 'fancy', 'fizzy',
  'fluffy', 'frosty', 'fuzzy', 'gentle', 'giddy', 'golden', 'green', 'grumpy', 'happy', 'hazy',
  'hungry', 'icy', 'jolly', 'jumpy', 'lucky', 'lunar', 'mellow', 'merry', 'minty', 'misty',
  'noble', 'olive', 'peachy', 'pink', 'plucky', 'polar', 'proud', 'purple', 'quick', 'quiet',
  'red', 'rosy', 'rusty', 'salty', 'sandy', 'silver', 'sleepy', 'sunny', 'swift', 'teal',
  'witty', 'zesty',
] as const;

export const NOUNS = [
  'acorn', 'anchor', 'badger', 'bagel', 'banjo', 'basket', 'beacon', 'beaver', 'biscuit', 'bison',
  'button', 'camel', 'candle', 'compass', 'cookie', 'dolphin', 'donut', 'dumpling', 'falcon', 'ferret',
  'gecko', 'goose', 'heron', 'hippo', 'igloo', 'kazoo', 'kettle', 'koala', 'lantern', 'lemur',
  'llama', 'lobster', 'mango', 'marble', 'melon', 'moose', 'muffin', 'noodle', 'otter', 'panda',
  'parrot', 'peach', 'pebble', 'penguin', 'pepper', 'pickle', 'pretzel', 'puffin', 'pumpkin', 'rabbit',
  'radish', 'rocket', 'taco', 'teapot', 'toast', 'trumpet', 'turnip', 'turtle', 'vanilla', 'waffle',
  'walnut', 'walrus', 'whistle', 'wombat',
] as const;

export interface PaneNameRow {
  pane_id: string;
  session_name: string;
  name: string; // '' when the pane has never been named
}

const pick = <T>(xs: readonly T[], rand: () => number): T => xs[Math.floor(rand() * xs.length) % xs.length];

// Split a held name back into its words. Suffixed fallbacks ("red-otter2")
// still claim their noun; a name that isn't adjective-noun claims nothing.
function wordsOf(name: string): [string, string] | null {
  const i = name.indexOf('-');
  if (i < 0) return null;
  return [name.slice(0, i), name.slice(i + 1).replace(/\d+$/, '')];
}

// A random name sharing NO word with any held name, so "the badger pane" is as
// unambiguous as the full name — two panes never both answer to "badger" or
// "polar". With ~60 words a side that covers 60-odd panes; past that the rule
// relaxes to whole-name uniqueness (random draws, then the first free pair) and
// finally a numeric suffix, so a name is always produced.
function freshName(taken: Set<string>, rand: () => number): string {
  const usedA = new Set<string>();
  const usedN = new Set<string>();
  for (const n of taken) {
    const w = wordsOf(n);
    if (w) {
      usedA.add(w[0]);
      usedN.add(w[1]);
    }
  }
  const freeA = ADJECTIVES.filter((a) => !usedA.has(a));
  const freeN = NOUNS.filter((b) => !usedN.has(b));
  if (freeA.length && freeN.length) {
    const n = `${pick(freeA, rand)}-${pick(freeN, rand)}`;
    if (!taken.has(n)) return n; // always true unless a word appears on both sides
  }
  for (let i = 0; i < 50; i++) {
    const n = `${pick(ADJECTIVES, rand)}-${pick(NOUNS, rand)}`;
    if (!taken.has(n)) return n;
  }
  for (const a of ADJECTIVES) for (const b of NOUNS) if (!taken.has(`${a}-${b}`)) return `${a}-${b}`;
  const base = `${pick(ADJECTIVES, rand)}-${pick(NOUNS, rand)}`;
  let k = 2;
  while (taken.has(`${base}${k}`)) k++;
  return `${base}${k}`;
}

// pane_id -> name for every workspace pane that has none yet. Uniqueness (word-
// level, see freshName) is checked against EVERY pane's name, prefixed or not,
// and against names handed out earlier in this same call. A pane that already
// has a name is never renamed: the whole point is that a name, once said, keeps
// meaning that pane.
export function assignNames(
  panes: PaneNameRow[],
  prefix: string = SESSION_PREFIX,
  rand: () => number = Math.random,
): Map<string, string> {
  const taken = new Set(panes.map((p) => p.name).filter(Boolean));
  const out = new Map<string, string>();
  for (const p of panes) {
    if (p.name || !p.session_name.startsWith(prefix) || out.has(p.pane_id)) continue;
    const n = freshName(taken, rand);
    taken.add(n);
    out.set(p.pane_id, n);
  }
  return out;
}

const SEP = '~|LOOM|~';

export function readPaneNames(): PaneNameRow[] {
  let out: string;
  try {
    out = execFileSync('tmux', ['list-panes', '-a', '-F', `#{pane_id}${SEP}#{session_name}${SEP}#{@name}`], {
      encoding: 'utf-8',
    });
  } catch {
    return []; // tmux not running
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.split(SEP);
      return { pane_id: p[0], session_name: p[1] ?? '', name: (p[2] ?? '').trim() };
    });
}

// pane_id -> name, named panes only. The read side for the snapshot and the API.
export function paneNameMap(rows: PaneNameRow[] = readPaneNames()): Map<string, string> {
  return new Map(rows.filter((r) => r.name).map((r) => [r.pane_id, r.name]));
}

export function setPaneName(paneId: string, name: string): void {
  try {
    execFileSync('tmux', ['set-option', '-p', '-t', paneId, '@name', name], { stdio: 'ignore' });
  } catch {
    /* pane vanished between listing it and naming it */
  }
}

// The periodic entry point: name whatever workspace panes appeared since the last
// tick. Never throws — no tmux server simply means nothing to name.
export function nameNewPanes(prefix: string = SESSION_PREFIX): number {
  try {
    const fresh = assignNames(readPaneNames(), prefix);
    for (const [paneId, name] of fresh) setPaneName(paneId, name);
    return fresh.size;
  } catch {
    return 0;
  }
}
