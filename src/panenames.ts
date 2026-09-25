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
// right. The two lists are curated as ONE vocabulary: no two words anywhere in
// either list share their first three letters or sit within edit distance 2 of
// each other (see similarWords), and obvious spoken rhymes (goose/moose,
// possum/blossom) were cut by hand. So any word is enough to identify a pane —
// by ear, by a typo, or by the first three letters typed. tests/panenames.test.ts
// holds the lists to that, so an edit can't quietly reintroduce a lookalike.
export const ADJECTIVES = [
  'amber', 'azure', 'blue', 'bold', 'brave', 'breezy', 'bright', 'calm', 'cheery', 'chilly',
  'coral', 'cosmic', 'cozy', 'crisp', 'curly', 'dizzy', 'fancy', 'fluffy', 'frosty', 'gentle',
  'giddy', 'golden', 'green', 'grumpy', 'hungry', 'icy', 'jolly', 'lucky', 'lunar', 'mellow',
  'merry', 'minty', 'olive', 'pink', 'polar', 'proud', 'purple', 'quick', 'red', 'salty', 'silver',
  'sleepy', 'sunny', 'swift', 'zesty', 'agile', 'alpine', 'arctic', 'beige', 'bouncy', 'bubbly',
  'clever', 'cloudy', 'crafty', 'creamy', 'daring', 'dewy', 'earthy', 'easy', 'elated', 'epic',
  'famous', 'fiery', 'fleet', 'fresh', 'friendly', 'gleeful', 'glossy', 'grand', 'hardy', 'honest',
  'humble', 'indigo', 'ivory', 'jade', 'khaki', 'lively', 'lofty', 'oaken', 'ocean', 'orange',
  'ornate', 'plaid', 'quaint', 'rapid', 'regal', 'ripe', 'robust', 'roomy', 'ruby', 'rugged',
  'rustic', 'satin', 'scarlet', 'simple', 'smart', 'smooth', 'snappy', 'snowy', 'snug', 'sparkly',
  'spry', 'steady', 'stormy', 'sugary', 'super', 'tawny', 'tender', 'thrifty', 'topaz', 'tough',
  'tropic', 'upbeat', 'urban', 'valiant', 'velvet', 'vivid', 'violet', 'young', 'bronze', 'denim',
  'garnet', 'lilac', 'magenta', 'mauve', 'ochre', 'saffron', 'jaunty', 'serene', 'tranquil',
  'verdant', 'crunchy', 'foggy', 'twisty', 'wiggly', 'classic', 'elfin', 'jovial', 'lithe',
  'scenic', 'yummy', 'tidal', 'jumbo', 'plush', 'poised', 'spotted', 'stately', 'striped',
  'sublime', 'ultra', 'vibrant', 'chrome', 'joyful', 'nautical', 'tweedy', 'amused', 'angelic',
  'antique', 'aqua', 'ardent', 'artful', 'astral', 'barefoot', 'bendy', 'blissful', 'carefree',
  'charming', 'citrus', 'coastal', 'cobbled', 'dappled', 'deluxe', 'elegant', 'emerald', 'festive',
  'flowing', 'glacial', 'hushed', 'jeweled', 'knotty', 'linen', 'liquid', 'metallic', 'moonlit',
  'nomadic', 'northern', 'onyx', 'painted', 'pastel', 'pillowy', 'retro', 'seaside', 'shimmery',
  'sienna', 'singing', 'skyward', 'squishy', 'tartan', 'terrific', 'tiptop', 'tireless', 'titanic',
  'tufted', 'vintage', 'watery', 'winged', 'wondrous', 'worldly', 'zigzag',
] as const;

export const NOUNS = [
  'acorn', 'anchor', 'badger', 'banjo', 'basket', 'beacon', 'biscuit', 'button', 'camel', 'candle',
  'compass', 'cookie', 'dolphin', 'donut', 'dumpling', 'falcon', 'ferret', 'gecko', 'goose',
  'heron', 'hippo', 'igloo', 'kazoo', 'koala', 'lantern', 'lemur', 'llama', 'lobster', 'marble',
  'muffin', 'noodle', 'otter', 'panda', 'parrot', 'peach', 'pebble', 'penguin', 'pepper', 'pickle',
  'pretzel', 'pumpkin', 'rabbit', 'radish', 'rocket', 'taco', 'teapot', 'toast', 'trumpet',
  'turnip', 'vanilla', 'waffle', 'walnut', 'whistle', 'wombat', 'bobcat', 'buffalo', 'condor',
  'coyote', 'dingo', 'dove', 'dragon', 'elk', 'fox', 'gazelle', 'gerbil', 'giraffe', 'gopher',
  'gull', 'hawk', 'hedgehog', 'hyena', 'ibis', 'iguana', 'impala', 'jackal', 'jaguar', 'kiwi',
  'kitten', 'leopard', 'lizard', 'lynx', 'macaw', 'mallard', 'manatee', 'meerkat', 'monkey',
  'narwhal', 'octopus', 'orca', 'ostrich', 'owl', 'pelican', 'pigeon', 'raccoon', 'reindeer',
  'sardine', 'shrimp', 'skunk', 'swan', 'tiger', 'urchin', 'weasel', 'whale', 'zebra', 'almond',
  'apricot', 'avocado', 'burrito', 'cabbage', 'cashew', 'chowder', 'cinnamon', 'cocoa', 'coffee',
  'crouton', 'cupcake', 'custard', 'fudge', 'kebab', 'ketchup', 'lasagna', 'lentil', 'lettuce',
  'nectar', 'nougat', 'nutmeg', 'omelet', 'onion', 'papaya', 'potato', 'praline', 'pudding',
  'raisin', 'ravioli', 'rhubarb', 'risotto', 'scone', 'sesame', 'sherbet', 'spinach', 'sushi',
  'syrup', 'tofu', 'yogurt', 'zucchini', 'anvil', 'atlas', 'bagpipe', 'balloon', 'bicycle',
  'bonnet', 'bottle', 'bugle', 'cactus', 'drum', 'engine', 'fiddle', 'flag', 'fountain', 'funnel',
  'goblet', 'guitar', 'hammock', 'jigsaw', 'kayak', 'mirror', 'orbit', 'ribbon', 'sailboat',
  'shovel', 'sticker', 'umbrella', 'yoyo', 'bamboo', 'blossom', 'cedar', 'feather', 'galaxy',
  'geyser', 'island', 'leaf', 'mesa', 'nebula', 'oasis', 'summit', 'tundra', 'volcano', 'abacus',
  'acrobat', 'biplane', 'domino', 'dynamo', 'emblem', 'gondola', 'jukebox', 'kimono', 'lollipop',
  'mailbox', 'oboe', 'origami', 'tiara', 'trellis', 'ukulele', 'visor', 'yacht', 'yodel',
  'zeppelin', 'fossil', 'pulley',
] as const;

export interface PaneNameRow {
  pane_id: string;
  session_name: string;
  name: string; // '' when the pane has never been named
}

const pick = <T>(xs: readonly T[], rand: () => number): T => xs[Math.floor(rand() * xs.length) % xs.length];

// Levenshtein distance, with an early exit: callers only ask "is it <= 2?".
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

// Two words are too alike to tell apart when spoken, misheard or half-typed:
// the same first three letters (tab-completion and "the pol- one" both stop
// there) or within two edits (fizzy/fuzzy, walnut/walrus).
export function similarWords(a: string, b: string): boolean {
  return a.slice(0, 3) === b.slice(0, 3) || editDistance(a, b) <= 2;
}

// Split a held name back into its words. Suffixed fallbacks ("red-otter2")
// still claim their noun; a name that isn't adjective-noun claims nothing.
function wordsOf(name: string): [string, string] | null {
  const i = name.indexOf('-');
  if (i < 0) return null;
  return [name.slice(0, i), name.slice(i + 1).replace(/\d+$/, '')];
}

// A random name whose words are unlike every word already held, so any one word
// ("the badger pane") is as unambiguous as the full name. The lists are curated
// so that only reusing a word collides, which makes the capacity one pane per
// list entry; the similarity test still matters for held names that predate
// the curation. When nothing fits the rule relaxes in steps — no word reused,
// then whole-name uniqueness (random draws, then the first free pair), then a
// numeric suffix — so a name is always produced.
function freshName(taken: Set<string>, rand: () => number): string {
  const heldWords = new Set<string>();
  const usedA = new Set<string>();
  const usedN = new Set<string>();
  for (const n of taken) {
    const w = wordsOf(n);
    if (!w) continue;
    usedA.add(w[0]);
    usedN.add(w[1]);
    heldWords.add(w[0]);
    heldWords.add(w[1]);
  }
  const unlike = (w: string) => ![...heldWords].some((h) => similarWords(w, h));
  const tryPair = (as: readonly string[], ns: readonly string[]): string | null => {
    if (!as.length || !ns.length) return null;
    const n = `${pick(as, rand)}-${pick(ns, rand)}`;
    return taken.has(n) ? null : n;
  };
  const distinct = tryPair(ADJECTIVES.filter(unlike), NOUNS.filter(unlike));
  if (distinct) return distinct;
  const unused = tryPair(ADJECTIVES.filter((a) => !usedA.has(a)), NOUNS.filter((b) => !usedN.has(b)));
  if (unused) return unused;
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

// pane_id -> name for every workspace pane that has none yet. Uniqueness (by
// word similarity, see freshName) is checked against EVERY pane's name, prefixed or not,
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
