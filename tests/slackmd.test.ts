import { describe, it, expect } from 'vitest';
import { SLACKMD_JS } from '../src/slackmd.ts';
import { EMOJI_MAP } from '../src/emojimap.ts';

const lib = new Function(`${SLACKMD_JS}; return { slkRender, slkBubbles, slkToMrkdwn, slkInline };`)() as {
  slkRender: (t: string, ctx?: object) => string;
  slkBubbles: (m: string[], ctx?: object, time?: string) => string;
  slkToMrkdwn: (t: string) => string;
};
const ctx = { users: { U1: 'Alex' }, channels: { C1: 'ops' }, emoji: EMOJI_MAP, custom: { party: 'https://emoji.slack-edge.com/x/party.png', yes: 'alias:party', bad: 'javascript:alert(1)' } };
const r = (t: string, c: object = ctx) => lib.slkRender(t, c);

describe('slkRender: mrkdwn', () => {
  it('renders bold, italic and strike at word boundaries', () => {
    expect(r('*bold* and _italic_ and ~gone~')).toBe('<div class="slk-p"><b>bold</b> and <i>italic</i> and <s>gone</s></div>');
    expect(r('a *b*, c')).toContain('<b>b</b>,');
    expect(r('(*x*)')).toContain('(<b>x</b>)');
  });
  it('nests marks', () => {
    expect(r('*_both_*')).toContain('<b><i>both</i></b>');
  });
  it('leaves marks inside words and unmatched marks alone', () => {
    expect(r('snake_case_name')).toBe('<div class="slk-p">snake_case_name</div>');
    expect(r('2 * 3 * 4')).toBe('<div class="slk-p">2 * 3 * 4</div>');
    expect(r('*unclosed')).toBe('<div class="slk-p">*unclosed</div>');
    expect(r('** **')).not.toContain('<b>');
  });
  it('converts the markdown the Slack CLI converts on send', () => {
    expect(r('**bold** [docs](https://x.test/a)')).toContain('<b>bold</b> <a class="slk-link" href="https://x.test/a"');
    expect(r('# Heading')).toBe('<div class="slk-p"><b>Heading</b></div>');
    expect(r('__it__ ~~st~~')).toContain('<i>it</i> <s>st</s>');
    expect(lib.slkToMrkdwn('* item')).toBe('• item');
  });
  it('does not format inside code', () => {
    expect(r('`*not bold*`')).toBe('<div class="slk-p"><code class="slk-code">*not bold*</code></div>');
    expect(r('a ```*x*\n_y_``` b')).toContain('<pre class="slk-pre">*x*\n_y_</pre>');
  });
  it('renders fenced blocks verbatim and keeps text around them', () => {
    const h = r('before\n```\nline1\n  line2 <b>\n```\nafter');
    expect(h).toBe('<div class="slk-p">before</div><pre class="slk-pre">line1\n  line2 &lt;b&gt;</pre><div class="slk-p">after</div>');
  });
  it('treats an unclosed fence as text', () => {
    expect(r('```oops')).not.toContain('<pre');
  });
  it('renders multi-line quotes as one block, and >>> quotes the rest', () => {
    expect(r('> one\n> two\nplain')).toBe('<blockquote class="slk-quote">one<br>two</blockquote><div class="slk-p">plain</div>');
    expect(r('intro\n>>> a\nb\n*c*')).toBe('<div class="slk-p">intro</div><blockquote class="slk-quote">a<br>b<br><b>c</b></blockquote>');
  });
  it('renders bullet and numbered lists with their markers', () => {
    const h = r('- one\n• two\n* three');
    expect(h.match(/slk-bul">•/g)).toHaveLength(3);
    expect(h).toContain('slk-lt">one<');
    const n = r('1. first\n2) second\n  - nested');
    expect(n).toContain('slk-bul">1.</span>');
    expect(n).toContain('slk-bul">2.</span>');
    expect(n).toContain('margin-left:18px');
  });
  it('keeps line breaks and blank lines', () => {
    expect(r('a\nb')).toBe('<div class="slk-p">a<br>b</div>');
    expect(r('a\n\nb')).toBe('<div class="slk-p">a</div><div class="slk-gap"></div><div class="slk-p">b</div>');
    expect(r('a\r\nb')).toBe('<div class="slk-p">a<br>b</div>');
  });
});

describe('slkRender: links and mentions', () => {
  it('renders <url|text>, <url> and bare links, trimming trailing punctuation', () => {
    expect(r('<https://a.test/x|the doc>')).toContain('href="https://a.test/x" target="_blank" rel="noopener noreferrer">the doc</a>');
    expect(r('<https://a.test/x>')).toContain('>https://a.test/x</a>');
    const bare = r('see https://a.test/p?q=1, ok.');
    expect(bare).toContain('href="https://a.test/p?q=1"');
    expect(bare).toContain('</a>, ok.');
    expect(r('<mailto:a@b.test|mail>')).toContain('href="mailto:a@b.test"');
  });
  it('resolves user, channel and special mentions from the cache', () => {
    expect(r('<@U1> in <#C1|x>')).toBe('<div class="slk-p"><span class="slk-mention">@Alex</span> in <span class="slk-mention">#ops</span></div>');
    expect(r('<!here> <!channel|channel> <!everyone>')).toContain('@here</span> <span class="slk-mention">@channel');
    expect(r('<!subteam^S1|@eng>')).toContain('slk-mention">@eng');
  });
  it('falls back to the raw id, or the inline label, styled as a mention', () => {
    expect(r('<@U9ZZ>', {})).toContain('<span class="slk-mention">@U9ZZ</span>');
    expect(r('<@U9ZZ|alex>', {})).toContain('@alex');
    expect(r('<#C9|general>', {})).toContain('slk-mention">#general');
    expect(r('<#C9>', {})).toContain('slk-mention">#C9');
  });
});

describe('slkRender: emoji', () => {
  it('maps shortcodes to Unicode, and ignores skin-tone suffixes', () => {
    expect(r(':white_check_mark: done')).toContain('✅');
    expect(r(':eyes:')).toContain('👀');
    expect(r(':+1::skin-tone-3:')).toContain('👍');
    expect(EMOJI_MAP.thumbsup).toContain('👍');
    expect(Object.keys(EMOJI_MAP).length).toBeGreaterThan(1500);
  });
  it('shows a custom emoji as an image, following one alias', () => {
    expect(r(':party:')).toContain('<img class="slk-emoji" src="https://emoji.slack-edge.com/x/party.png"');
    expect(r(':yes:')).toContain('party.png');
  });
  it('refuses a custom emoji that is not an https URL, and pills an unknown name', () => {
    expect(r(':bad:')).not.toContain('<img');
    expect(r(':bad:')).toContain('slk-epill">:bad:</span>');
    expect(r(':nope_name:')).toContain('slk-epill">:nope_name:</span>');
  });
  it('leaves clock times and stray colons as text', () => {
    expect(r('at 10:30:45 sharp')).toBe('<div class="slk-p">at 10:30:45 sharp</div>');
    expect(r('a: b :c')).toBe('<div class="slk-p">a: b :c</div>');
  });
});

describe('slkRender: untrusted input', () => {
  it('escapes raw HTML everywhere', () => {
    for (const evil of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=1>', '<b onclick=x>hi</b>']) {
      const h = r(evil);
      expect(h).not.toMatch(/<(script|img|svg|b onclick)/i);
      expect(h).toContain('&lt;');
    }
  });
  it('never emits a non-http(s)/mailto href', () => {
    expect(r('<javascript:alert(1)|x>')).not.toContain('href');
    expect(r('[x](javascript:alert(1))')).not.toContain('href');
    expect(r('<https://a.test/"onmouseover="x|y>')).toContain('href="https://a.test/&quot;onmouseover=&quot;x"');
  });
  it('escapes link labels, mention names and code', () => {
    expect(r('<https://a.test|<b>x</b>>')).not.toContain('<b>x</b>');
    expect(r('<@U1>', { users: { U1: '<i>x</i>' } })).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(r('`<b>`')).toContain('&lt;b&gt;');
  });
  it('cannot be tricked by placeholder characters in the input', () => {
    expect(r('0 `x`')).toContain('slk-code">x</code>');
    expect(r('9')).not.toContain('undefined');
  });
  it('handles empty and non-string input', () => {
    expect(r('')).toBe('');
    expect(lib.slkRender(undefined as never, ctx)).toBe('');
  });
});

describe('slkBubbles', () => {
  it('renders a lone message as one plain bubble', () => {
    expect(lib.slkBubbles(['only'], ctx).match(/class="slk-msg"/g)).toHaveLength(1);
    expect(lib.slkBubbles(['only'], ctx)).not.toContain('slk-burst');
    expect(lib.slkBubbles([], ctx)).toBe('');
  });
  it('renders each message of a burst as its own card with a n/N marker and hover time', () => {
    const burst = lib.slkBubbles(['first', '*second*', 'third'], ctx, '14:05');
    expect(burst.match(/class="slk-msg slk-burst"/g)).toHaveLength(3);
    expect(burst).toContain('<span class="slk-mark">1/3</span>');
    expect(burst).toContain('<span class="slk-mark">3/3</span>');
    expect(burst.match(/<span class="slk-hts">14:05<\/span>/g)).toHaveLength(3);
    expect(burst).toContain('<div class="slk-p"><b>second</b></div></div>');
  });
  it('keeps line breaks: single newline is a <br>, blank lines are a gap, numbered lines stay on their own lines', () => {
    const html = lib.slkBubbles(['Found it.\nSecond line\n\nNew paragraph\n1. one\n2. two\n\n3 items', 'x'], ctx);
    expect(html).toContain('<div class="slk-p">Found it.<br>Second line</div><div class="slk-gap"></div><div class="slk-p">New paragraph</div>');
    expect(html).toContain('<div class="slk-list"><div class="slk-li"');
    expect(html.match(/class="slk-li"/g)).toHaveLength(2);
    expect(html).toContain('<div class="slk-gap"></div><div class="slk-p">3 items</div>');
  });
  it('drops leading and trailing blank lines instead of leaving a gap', () => {
    expect(lib.slkRender('\n\nhello\n\n', ctx)).toBe('<div class="slk-p">hello</div>');
  });
});
