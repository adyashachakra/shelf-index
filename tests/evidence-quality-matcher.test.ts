// Evidence-quality changes (report format 9): the short-brand matcher.
//
// Test groups from the approved plan (claude/evidence-quality-revised-implementation-plan.md, section 6):
//   A genuine look-alikes stay caught   B other short brands   C wording modelled on the Stage 2 COS audit
//   D title and snippet judged independently   E documented remaining limitations   G shared-matcher effects
//   H the matched-context field (the parts that need no storage); the rest of H is in evidence-quality-ui.test.ts
//
// Pure functions only: no network, no storage. Every page and sentence here is INVENTED (or generic), modelled on
// the shape of what the live audit met. No real audit report, real person or real page text is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resultsToEvidence, similarNameSetAside } from '../lib/audit/evidence-builders';
import * as bm from '../lib/evidence/brand-match';
import { quoteIsAboutBrand } from '../lib/evidence/quotes';
import type { SetAsideEvidence } from '../lib/types';

const asResults = (pages: { title: string; url: string; content: string }[]) => pages.map((r, i) => ({ ...r, rawContent: null, score: 0.9 - i * 0.01 }));
const fields = (title: string, snippet: string): bm.BrandField[] => [
  { name: 'title', text: title },
  { name: 'snippet', text: snippet },
];

// =====================================================================================================
// A. Genuine look-alikes must stay caught
// =====================================================================================================

test('A1: every genuine look-alike case stays mixed', () => {
  for (const text of [
    'COSRX vs COS',
    'COS & COSRX haul',
    'CosRX and COS',
    'COS RX and COS coats',
    'cos-IQ and COS',
    'Cos De Baha vs COS',
    'From COS to COSRX',
  ]) {
    assert.equal(bm.brandAttribution(text, 'COS').state, 'mixed', text);
  }
});

test('A2: "COS IQ vs COS jackets" is mixed and names the look-alike "COS IQ"', () => {
  const result = bm.brandAttribution('COS IQ vs COS jackets', 'COS');
  assert.equal(result.state, 'mixed');
  assert.deepEqual(result.lookalikes, ['COS IQ']);
});

test('A3: a page about the look-alike alone stays "other"', () => {
  assert.equal(bm.brandAttribution('COS RX snail mucin review', 'COS').state, 'other');
  assert.equal(bm.mentionsBrand('COS RX snail mucin essence', 'COS'), false);
});

// =====================================================================================================
// B. Other short brands: look-alikes are caught and ordinary text stays clear
// =====================================================================================================

/** token = how the name is written in running text; letters = its letters, for the run-together form. */
const SHORT: { brand: string; token: string; letters: string; dotted?: boolean }[] = [
  { brand: 'COS', token: 'COS', letters: 'COS' },
  { brand: 'Zara', token: 'Zara', letters: 'ZARA' },
  { brand: 'Gap', token: 'Gap', letters: 'GAP' },
  { brand: 'Nike', token: 'Nike', letters: 'NIKE' },
  { brand: 'ASOS', token: 'ASOS', letters: 'ASOS' },
  { brand: 'Lush', token: 'Lush', letters: 'LUSH' },
  { brand: 'Vans', token: 'Vans', letters: 'VANS' },
  { brand: 'Boss', token: 'Boss', letters: 'BOSS' },
  { brand: 'RoC', token: 'RoC', letters: 'ROC' },
  { brand: 'REI', token: 'REI', letters: 'REI' },
  { brand: 'UGG', token: 'UGG', letters: 'UGG' },
  // A name written with a final dot: the matcher does not look past that dot (see E6), so B1 to B4 do not apply to it.
  { brand: 'e.l.f.', token: 'e.l.f.', letters: 'ELF', dotted: true },
];
const CONTROLS: { brand: string; token: string; letters: string }[] = [
  { brand: 'CeraVe', token: 'CeraVe', letters: 'CERAVE' },
  { brand: 'Uniqlo', token: 'Uniqlo', letters: 'UNIQLO' },
  { brand: 'H&M', token: 'H&M', letters: 'HM' },
];

const MUST_BE_MIXED: [string, (b: { token: string; letters: string }) => string][] = [
  ['B1 follower RX', (b) => `${b.token} RX and ${b.token} coats`],
  ['B2 follower IQ', (b) => `${b.token} IQ vs ${b.token}`],
  ['B3 joined by a hyphen', (b) => `${b.token}-IQ and ${b.token}`],
  ['B4 particle and a word', (b) => `${b.token} De Baha vs ${b.token}`],
  ['B5 run-together', (b) => `${b.letters}RX vs ${b.token}`],
];
const MUST_BE_CLEAR: [string, (b: { token: string; letters: string }) => string][] = [
  ['B6 season abbreviation A/W', (b) => `${b.token} A/W 2026 haul`],
  ['B7 season abbreviation S/S', (b) => `${b.token} S/S 26 collection`],
  ['B8 the brand repeated in capitals', (b) => `${b.token} ${b.token.toUpperCase()} capsule collection`],
  ['B9 caption then sentence', (b) => `Image © ${b.token}\n${b.token} designer shares the thinking behind the range`],
  ['B10 IE', (b) => `${b.token} IE store opening`],
  ['B10 JP', (b) => `${b.token} JP flagship`],
  ['B10 SG', (b) => `${b.token} SG sale`],
  ['B10 HK', (b) => `${b.token} HK pop-up`],
  ['B10 ZA', (b) => `${b.token} ZA online`],
  ['B11 SS', (b) => `${b.token} SS collection`],
  ['B11 AW', (b) => `${b.token} AW drop`],
  ['B11 FW', (b) => `${b.token} FW edit`],
  ['B11 PF', (b) => `${b.token} PF look`],
  ['B11 CR', (b) => `${b.token} CR capsule`],
  ['B11b MEN', (b) => `${b.token} MEN knitwear`],
  ['B11b HQ', (b) => `${b.token} HQ visit`],
  ['B11b XL', (b) => `${b.token} XL fit`],
  ['B11b XS', (b) => `${b.token} XS fit`],
  ['B11b XXL', (b) => `${b.token} XXL fit`],
  ['B11b SPF', (b) => `${b.token} SPF 50 stick`],
  ['B11b UV', (b) => `${b.token} UV shirt`],
  ['B12 existing plain followers', (b) => `${b.token} UK sale and ${b.token} USA stores`],
  ['B13 a single capital letter', (b) => `I think ${b.token} I love`],
];

for (const b of SHORT) {
  for (const [label, make] of MUST_BE_MIXED) {
    if (b.dotted && /^B[1-4] /.test(label)) continue;
    test(`${label}: "${b.brand}" is mixed`, () => {
      assert.equal(bm.brandAttribution(make(b), b.brand).state, 'mixed', make(b));
    });
  }
  for (const [label, make] of MUST_BE_CLEAR) {
    test(`${label}: "${b.brand}" stays clear`, () => {
      const result = bm.brandAttribution(make(b), b.brand);
      assert.equal(result.state, 'clear', make(b));
      assert.deepEqual(result.lookalikes, [], make(b));
    });
  }
}

for (const b of CONTROLS) {
  for (const [label, make] of [...MUST_BE_MIXED, ...MUST_BE_CLEAR]) {
    test(`${label}: the longer name "${b.brand}" is not examined, so it is clear`, () => {
      assert.equal(bm.brandAttribution(make(b), b.brand).state, 'clear', make(b));
    });
  }
}

// =====================================================================================================
// C. Wording modelled on the Stage 2 COS audit (invented text, same shapes)
// =====================================================================================================

test('C1: a video title with "A/W" and a description that names the brand alone is clear', () => {
  const result = bm.brandAttributionOfFields(
    [
      { name: 'title', text: "Skip COS A/W 2026 until you watch this, Part 1" },
      { name: 'description', text: 'My honest thoughts on the new COS season, what fits and what does not.' },
    ],
    'COS',
  );
  assert.equal(result.state, 'clear');
  assert.deepEqual(result.lookalikes, []);
});

test('C2: a caption followed by a sentence that begins with the brand is not a different name, and the page is evidence', () => {
  const page = {
    title: 'COS pays homage to a modernist movement with a capsule collection | News | Example Journal',
    url: 'https://journal.example.org/news/cos-modernist-capsule',
    content: 'The capsule reinterprets a classic chair in knitwear and tailoring.\nImage © COS\nCOS designer Jane Doe shares the thinking behind the range and the fabrics that were chosen for it.',
  };
  const aside: SetAsideEvidence[] = [];
  const items = resultsToEvidence({ results: asResults([page]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(items.length, 1, 'counted as evidence');
  assert.deepEqual(aside, [], 'not set aside');
});

test('C3: a page titled just with the brand, whose snippet starts with a capital abbreviation, is clear', () => {
  const page = {
    title: 'COS',
    url: 'https://profiles.example.net/company/abc123',
    content: 'ID: abc123. A retail apparel and fashion company based in a large city, selling clothing and accessories online.',
  };
  const aside: SetAsideEvidence[] = [];
  const items = resultsToEvidence({ results: asResults([page]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(items.length, 1);
  assert.deepEqual(aside, []);
});

test('C4: a title that is just the brand and a snippet that begins "RX …": each field is judged on its own', () => {
  const result = bm.brandAttributionOfFields(fields('COS', 'RX snail mucin essence is a skincare product that many shoppers like.'), 'COS');
  assert.equal(result.state, 'clear', 'the join does not create "COS RX"');
  assert.deepEqual(result.lookalikes, []);
});

// =====================================================================================================
// D. Title and snippet are judged independently
// =====================================================================================================

test('D1: a look-alike in the snippet and the brand alone in the title is still mixed', () => {
  const result = bm.brandAttributionOfFields(fields('COS winter coat review', 'We compared it with COS IQ products, which are a different business altogether.'), 'COS');
  assert.equal(result.state, 'mixed');
  assert.deepEqual(result.lookalikes, ['COS IQ']);
  assert.equal(result.trigger?.field, 'snippet');
});

test('D2: a brand split across the join only produces no look-alike', () => {
  assert.equal(bm.brandAttributionOfFields(fields('Review of the label COS', 'RX is mentioned later'), 'COS').lookalikes.length, 0);
  assert.equal(bm.brandAttributionOfFields(fields('Review of the label COS', 'IQ is mentioned later'), 'COS').state, 'clear');
  assert.equal(bm.mentionsBrandInFields(fields('Review of COS', 'RX'), 'COS'), true);
});

test('D3: the evidence builder judges the title and snippet separately (a joined adjacency is clear; a real look-alike is set aside with its context)', () => {
  const joined = { title: 'COS', url: 'https://reviews.example.org/a', content: 'IQ tests are not the topic here; this page reviews a winter coat from the label and how it wears over a season.' };
  const aside: SetAsideEvidence[] = [];
  const kept = resultsToEvidence({ results: asResults([joined]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(kept.length, 1);
  assert.deepEqual(aside, []);

  const genuine = { title: 'COS winter coat review', url: 'https://reviews.example.org/b', content: 'We tested the coat for a month, and compared it with a COS IQ serum from a different company entirely, which is unrelated.' };
  const asideGenuine: SetAsideEvidence[] = [];
  const kept2 = resultsToEvidence({ results: asResults([genuine]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => asideGenuine.push(e) });
  assert.equal(kept2.length, 0);
  assert.equal(asideGenuine.length, 1);
  assert.equal(asideGenuine[0].matchedContext?.field, 'snippet');
});

test('D4 (static check): no call site in the three evidence files passes a joined "title text" string to the brand checks', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['lib/audit/evidence-builders.ts', 'lib/audit/stages/youtube.ts', 'lib/audit/stages/website.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const joined = source.match(/(?:mentionsBrand|brandAttribution|similarNameReason|similarNameSetAside)\(\s*`\$\{[^`]*\}\s\$\{[^`]*\}`/g);
    assert.equal(joined, null, `${file} still joins two fields before matching`);
  }
});

// =====================================================================================================
// E. Documented remaining limitations (assert today's flagged behaviour so a future change shows up)
// =====================================================================================================

test('E1: sub-brand lines that are not on the list are still flagged', () => {
  assert.equal(bm.brandAttribution('Nike SB and Nike shoes', 'Nike').state, 'mixed');
  assert.equal(bm.brandAttribution('Zara TRF and Zara coats', 'Zara').state, 'mixed');
});
test('E2: "COS DE <word>" is still flagged (the particle rule runs first; "de" stays off the list)', () => {
  assert.equal(bm.brandAttribution('COS DE online shop and COS coats', 'COS').state, 'mixed');
  assert.equal(bm.brandAttribution('COS DE online shop and COS coats', 'COS').lookalikes[0], 'COS DE online');
});
test('E3: "COS ID" is still flagged ("id" is not on the list) unless it is a field label followed by a colon (L1)', () => {
  assert.equal(bm.brandAttribution('COS ID and COS', 'COS').state, 'mixed');
  assert.equal(bm.brandAttribution('COS ID-card and COS', 'COS').state, 'mixed');
});
test('E4: a genuine one-letter name is an accepted false negative', () => {
  assert.equal(bm.brandAttribution('COS X and COS', 'COS').state, 'clear');
});
test('E6: a name that ends in a dot ("e.l.f.") is not examined for spaced or hyphenated look-alikes (documented limitation; run-together forms are still caught)', () => {
  for (const text of ['e.l.f. RX and e.l.f. coats', 'e.l.f. IQ vs e.l.f.', 'e.l.f.-IQ and e.l.f.', 'e.l.f. De Baha vs e.l.f.']) {
    assert.equal(bm.brandAttribution(text, 'e.l.f.').state, 'clear', text);
  }
  assert.equal(bm.brandAttribution('ELFRX vs e.l.f.', 'e.l.f.').state, 'mixed');
  // and the sentence-boundary case the change would have turned into a false positive stays clear
  assert.equal(bm.brandAttribution('I just bought e.l.f. PR said it sold out. e.l.f. is great', 'e.l.f.').state, 'clear');
});

test('E5: "COS DE." (no word after it) is flagged by the all-caps rule because "de" is not on the list', () => {
  assert.equal(bm.brandAttribution('COS DE. and COS', 'COS').state, 'mixed');
});

test('the allow-list is exactly the approved 81 words', () => {
  const list = bm.PLAIN_FOLLOWERS;
  assert.equal(list.size, 81);
  for (const word of 'aw ss fw pf cr es jp ie ch dk se nl sg hk be pt pl mx br ae za kr cn men hq xs xl xxl spf uv'.split(' ')) assert.ok(list.has(word), word);
  for (const word of ['de', 'id']) assert.ok(!list.has(word), `${word} must stay off the list`);
  for (const word of 'and the for are not but all new our you has had was its out off one two can get buy vs is at in on to of by or an as it no my we so do if up us uk usa eu ca au nz fr am pm tv'.split(' ')) assert.ok(list.has(word), word);
});

// =====================================================================================================
// G. Shared-matcher effects
// =====================================================================================================

test('G1: a Gemini answer that names the brand next to "A/W" counts as naming it', () => {
  assert.equal(bm.mentionsBrand('For autumn, COS A/W picks are a good place to start.', 'COS'), true);
});
test('G2: "COS RX essence" is not the brand', () => {
  assert.equal(bm.mentionsBrand('COS RX essence is the one to buy', 'COS'), false);
});
test('G3: the quote check accepts a passage that names the brand beside "S/S"', () => {
  const result = quoteIsAboutBrand({ quote: 'the linen shirt keeps its shape', title: 'Spring review', text: 'COS S/S linen shirts are light, and the linen shirt keeps its shape after washing.', brand: 'COS', ownSite: false });
  assert.equal(result, 'ok');
});

// =====================================================================================================
// H. Matched context: the exact occurrence that fired (pure part)
// =====================================================================================================

const ctx = (text: string, brand = 'COS', field: bm.BrandField['name'] = 'snippet') => bm.triggerContext([{ name: field, text }], brand);

test('H1: the context is built around the look-alike that fired, with the rule and the field', () => {
  const c = ctx("Don't buy COS IQ 2026 until you watch this", 'COS', 'title');
  assert.ok(c);
  assert.equal(c.field, 'title');
  assert.equal(c.rule, 'follower');
  assert.equal(c.text.slice(c.markFrom, c.markTo), 'COS IQ');
  assert.ok(c.text.includes('COS IQ 2026'));
});

test('H2: the trigger is the look-alike, not the first mention of the brand', () => {
  const c = ctx('COS jackets are great. Later in the video: COS RX serum and COS coats.');
  assert.ok(c);
  assert.equal(c.text.slice(c.markFrom, c.markTo), 'COS RX');
  assert.ok(c.markFrom > 20, 'the mark is not at the first "COS"');
});

test('H3: with two fields the look-alike is in the snippet, so the field is "snippet" and offsets are relative to the snippet context', () => {
  const c = bm.triggerContext(fields('COS winter coat review', 'We compared it with COS IQ products, a different business.'), 'COS');
  assert.ok(c);
  assert.equal(c.field, 'snippet');
  assert.equal(c.text.slice(c.markFrom, c.markTo), 'COS IQ');
});

test('H4: with two look-alikes the context belongs to the first one listed in the reason', () => {
  const two = bm.brandAttribution('COS RX and COS IQ and COS', 'COS');
  assert.deepEqual(two.lookalikes, ['COS RX', 'COS IQ']);
  assert.equal(ctx('COS RX and COS IQ and COS')?.text.slice(ctx('COS RX and COS IQ and COS')!.markFrom, ctx('COS RX and COS IQ and COS')!.markTo), 'COS RX');
  // A fused form is listed after the spaced ones, and the context follows the listing, not the position in the text.
  const mixedOrder = bm.brandAttribution('COSRX vs COS IQ vs COS', 'COS');
  assert.equal(mixedOrder.lookalikes[0], 'COS IQ');
  const c = ctx('COSRX vs COS IQ vs COS');
  assert.equal(c?.text.slice(c.markFrom, c.markTo), 'COS IQ');
});

test('H5: original capitalisation and accents are kept, and the offsets index the original text', () => {
  for (const [text, expected] of [
    ['Cos De Baha vs Cós jackets', 'Cos De Baha'],
    ['COS ÍQ vs COS coats', 'COS ÍQ'],
    ['Cós RX and COS', 'Cós RX'],
  ] as const) {
    const c = ctx(text);
    assert.ok(c, text);
    assert.equal(c.text.slice(c.markFrom, c.markTo), expected, text);
  }
});

test('H6: where folding changes the length (a ligature, a decomposed accent) the mark still covers exactly the trigger', () => {
  const ligature = 'The ﬁnest ﬂoral prints, COS RX vs COS shirts';
  const c1 = ctx(ligature);
  assert.ok(c1);
  assert.equal(c1.text.slice(c1.markFrom, c1.markTo), 'COS RX');
  const decomposed = 'Coś RX and COS';
  const c2 = ctx(decomposed);
  assert.ok(c2);
  assert.equal(c2.text.slice(c2.markFrom, c2.markTo).normalize('NFC'), 'Co\u015b RX'); // s with an acute accent, as written
});

test('H6b: folding one code point at a time gives exactly the same text as folding the whole string', () => {
  for (const text of ['Cós RX', 'ﬁnest ﬂoral', 'Coś RX', 'L’Oréal Paris', 'Crème brûlée', 'ＣＯＳ RX', 'plain ascii text']) {
    assert.equal(bm.foldWithMap(text).folded, text.normalize('NFKD').replace(/[̀-ͯ]/g, ''), text);
  }
});

test('H6c: if a span cannot be mapped back, the entry falls back to the accent-free text with its own correct span', () => {
  const c = bm.matchedContext('Cós RX and COS', { text: 'Cos RX', from: 400, to: 500, foldedFrom: 0, foldedTo: 6, rule: 'follower' }, 'title');
  assert.equal(c.text, 'Cos RX and COS');
  assert.equal(c.text.slice(c.markFrom, c.markTo), 'Cos RX');
});

test('H7: each rule sets its own name and a span that covers exactly the triggering text', () => {
  for (const [text, rule, expected] of [
    ['we love pre-cos and COS', 'prefix', 'pre-cos'],
    ['cos-IQ and COS', 'joined', 'cos-IQ'],
    ['Cos De Baha vs COS', 'particle', 'Cos De Baha'],
    ['COSRX vs COS', 'run-together', 'COSRX'],
    ['COS RX and COS', 'follower', 'COS RX'],
  ] as const) {
    const c = ctx(text);
    assert.ok(c, text);
    assert.equal(c.rule, rule, text);
    assert.equal(c.text.slice(c.markFrom, c.markTo), expected, text);
  }
});

function longText(trigger: string, position: 'start' | 'middle' | 'end'): string {
  const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}word`).join(' ');
  if (position === 'start') return `COS ${trigger.replace('COS ', '')} ${filler(60, 'tail')}`;
  if (position === 'middle') return `COS opens ${filler(30, 'head')} then ${trigger} ${filler(30, 'tail')}`;
  return `COS opens ${filler(60, 'head')} then ${trigger}`;
}

test('H8: a long field gives at most 160 characters, the trigger fully inside, cut at word boundaries, with "…" only where cut', () => {
  for (const position of ['start', 'middle', 'end'] as const) {
    const text = longText('COS RX', position);
    assert.ok(text.length > 400);
    const c = ctx(text);
    assert.ok(c, position);
    assert.ok(c.text.length <= 160, `${position}: ${c.text.length}`);
    assert.equal(c.text.slice(c.markFrom, c.markTo), 'COS RX', position);
    const startsCut = c.text.startsWith('…');
    const endsCut = c.text.endsWith('…');
    if (position === 'start') assert.equal(startsCut, false, 'nothing before it was cut');
    else assert.equal(startsCut, true, `${position}: the start was cut`);
    if (position === 'end') assert.equal(endsCut, false, 'nothing after it was cut');
    else assert.equal(endsCut, true, `${position}: the end was cut`);
    // Whole words only: every word in the context is a word of the original text.
    const original = new Set(text.split(/\s+/));
    for (const word of c.text.replace(/…/g, ' ').split(/\s+/).filter(Boolean)) assert.ok(original.has(word), `${position}: "${word}" is a whole word`);
  }
});

test('H8b: a field of 160 characters or fewer is used whole', () => {
  const text = 'A short title about COS IQ and the COS brand';
  const c = ctx(text);
  assert.equal(c?.text, text);
});

test('H9: whitespace and newlines are collapsed, and the offsets are still exact', () => {
  const c = ctx('line one\n\n   line two COS \n RX\tand COS coats\n\n\nend');
  assert.ok(c);
  assert.ok(!/\s{2,}|\n|\t/.test(c.text), 'no runs of whitespace, newlines or tabs');
  assert.equal(c.text.slice(c.markFrom, c.markTo), 'COS RX');
});

test('H17: the matcher decides exactly as before on every existing input (position tracking changes no verdict)', () => {
  const inputs: [string, string, string][] = [
    ['COSRX vs COS', 'COS', 'mixed'],
    ['COS RX and COS coats', 'COS', 'mixed'],
    ['COS RX snail mucin review', 'COS', 'other'],
    ['COS UK has stores', 'COS', 'clear'],
    ['COS and H&M have stores', 'COS', 'clear'],
    ['Nothing about it', 'COS', 'none'],
    ['Zara and ZaraX picks', 'Zara', 'mixed'],
    ['Cetaphil and CETAPHILX', 'Cetaphil', 'clear'],
    ['Cós RX and COS', 'COS', 'mixed'],
    ['pre-cos and COS', 'COS', 'mixed'],
  ];
  for (const [text, brand, state] of inputs) assert.equal(bm.brandAttribution(text, brand).state, state, text);
});

test('the set-aside helper returns the reason and the context together, and no context for a reason that has no matched text', () => {
  const withContext = similarNameSetAside([{ name: 'title', text: 'COS to COSRX' }], 'lemon8-app.com', 'COS');
  assert.ok(withContext);
  assert.match(withContext.reason, /Names both "COS" and "COSRX"/);
  assert.equal(withContext.matchedContext?.rule, 'run-together');
  const domainOnly = similarNameSetAside([{ name: 'title', text: 'Nothing relevant' }], 'cosgram.com', 'COS');
  assert.ok(domainOnly);
  assert.equal(domainOnly.matchedContext, undefined);
});

// =====================================================================================================
// L. Live format 9 COS audit, Nov 23 (report c81c30c57cc8f2465550c4b8). Titles and the Tavily snippet are as the
// report stored them; the other snippets are invented in the same shape.
// =====================================================================================================

const TAVILY_PROFILE = {
  title: 'COS',
  url: 'https://tavily.com/knowledge/company/IrthV3LEdVhE',
  content:
    '# COS ID: IrthV3LEdVhE Website: www.cos.com Headquarters: London, England, United Kingdom LinkedIn: www.linkedin.com/company/cos · 342,493 followers Industry: Retail Apparel and Fashion',
};

test('L1: "COS ID: IrthV3LEdVhE" on a company profile of COS is a field label, so the page is counted, not set aside', () => {
  const fields: bm.BrandField[] = [
    { name: 'title', text: TAVILY_PROFILE.title },
    { name: 'snippet', text: TAVILY_PROFILE.content },
  ];
  const result = bm.brandAttributionOfFields(fields, 'COS');
  assert.equal(result.state, 'clear');
  assert.deepEqual(result.lookalikes, []);
  const aside: SetAsideEvidence[] = [];
  const items = resultsToEvidence({ results: asResults([TAVILY_PROFILE]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(items.length, 1);
  assert.equal(aside.length, 0);
});

test('L1b: the field-label exception is narrow: "ID" at the start of the field, then a colon and a code-like value', () => {
  for (const text of ['COS ID: IrthV3 and COS coats', 'COS ID : IrthV3 and COS coats', '  # COS ID: IrthV3LEdVhE Website: www.cos.com', '## COS ID: IrthV3LEdVhE Website: www.cos.com']) {
    assert.equal(bm.brandAttribution(text, 'COS').state, 'clear', text);
  }
  for (const [text, lookalike] of [
    ['COS ID and COS coats', 'COS ID'],
    ['COS ID-card and COS', 'COS ID'],
    ['COS ID\n: x and COS', 'COS ID'],
    ['COS IQ: a review, and COS coats', 'COS IQ'],
    ['COS RX: snail mucin, and COS coats', 'COS RX'],
    ['COS IQ: Ab12cd and COS coats', 'COS IQ'],
    ['COS RX: Ab12cd and COS coats', 'COS RX'],
  ] as const) {
    const result = bm.brandAttribution(text, 'COS');
    assert.equal(result.state, 'mixed', text);
    assert.deepEqual(result.lookalikes, [lookalike], text);
  }
});

test('L2: "COS to COSRX" (the live Lemon8 title) is still a genuine look-alike, with its matched context intact', () => {
  const page = { title: 'COS to COSRX - Trench Coats, Denim Jacket & Jeans', url: 'https://www.lemon8-app.com/experience/cos-reviews', content: 'Trench coats, denim jackets and jeans from COS, and a few COSRX skincare picks.' };
  const aside: SetAsideEvidence[] = [];
  const items = resultsToEvidence({ results: asResults([page]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(items.length, 0);
  assert.equal(aside.length, 1);
  assert.match(aside[0].reason, /Names both "COS" and "COSRX"/);
  assert.deepEqual(aside[0].matchedContext, { text: 'COS to COSRX - Trench Coats, Denim Jacket & Jeans', markFrom: 7, markTo: 12, field: 'title', rule: 'run-together' });
});

test('L3: "Don\'t buy COS A/W 2026 until you watch this, Part 1" (the live title) is counted as COS evidence', () => {
  const page = { title: "Don't buy COS A/W 2026 until you watch this, Part 1", url: 'https://www.youtube.com/watch?v=example1', content: 'My honest thoughts on the new COS season, piece by piece.' };
  assert.equal(bm.brandAttributionOfFields([{ name: 'title', text: page.title }, { name: 'description', text: page.content }], 'COS').state, 'clear');
  const aside: SetAsideEvidence[] = [];
  const items = resultsToEvidence({ results: asResults([page]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(items.length, 1);
  assert.equal(aside.length, 0);
});

test('L4: "COS COS" (Archinect shape: a caption ending "© COS" read straight on into "COS designer…") is the brand written twice, so the page is counted', () => {
  const page = {
    title: 'COS pays homage to the Bauhaus with their remastered capsule collection | News | Archinect',
    url: 'https://archinect.com/news/article/example',
    content: 'Image © COS COS designer Christophe Copin shares the thinking behind the capsule.',
  };
  const result = bm.brandAttributionOfFields([{ name: 'title', text: page.title }, { name: 'snippet', text: page.content }], 'COS');
  assert.equal(result.state, 'clear');
  assert.deepEqual(result.lookalikes, []);
  const aside: SetAsideEvidence[] = [];
  const items = resultsToEvidence({ results: asResults([page]), kind: 'review', prefix: 'R', brand: 'COS', startIndex: 0, seenUrls: new Set(), onSetAside: (e) => aside.push(e) });
  assert.equal(items.length, 1);
  assert.equal(aside.length, 0);
  // The same shape with a genuine look-alike after it is still caught.
  const genuine = bm.brandAttribution('Image © COS COS IQ designer, and COS coats', 'COS');
  assert.equal(genuine.state, 'mixed', 'the repeated COS is not the trigger; "COS IQ" after the second COS is');
  assert.deepEqual(genuine.lookalikes, ['COS IQ']);
});

test('L5: the field-label rule follows the page shape, not the brand: company-profile pages for Zara, Nike, ASOS and Gap are counted too', () => {
  for (const [brand, text] of [
    ['Zara', '# Zara ID: Xk29Lm Website: www.zara.com LinkedIn: www.linkedin.com/company/zara'],
    ['Nike', '# Nike ID: Pq81Zt Website: www.nike.com LinkedIn: www.linkedin.com/company/nike'],
    ['ASOS', '# ASOS ID: Rt55Qw Website: www.asos.com'],
    ['Gap', '# Gap ID: Lm77Ab Website: www.gap.com'],
  ] as const) {
    const result = bm.brandAttributionOfFields([{ name: 'title', text: brand }, { name: 'snippet', text }], brand);
    assert.equal(result.state, 'clear', `${brand}: ${text}`);
    assert.deepEqual(result.lookalikes, [], brand);
  }
});

test('L6: for other brands too, "ID" without a colon, a joined "ID-", and other followers before a colon are still look-alikes', () => {
  for (const [brand, text, lookalike] of [
    ['Zara', 'Zara ID and Zara coats', 'Zara ID'],
    ['Nike', 'Nike ID and Nike shoes', 'Nike ID'],
    ['Zara', 'Zara ID-card and Zara', 'Zara ID'],
    ['Zara', 'Zara IQ: a review, and Zara coats', 'Zara IQ'],
    ['Nike', 'Nike RX: a review, and Nike shoes', 'Nike RX'],
  ] as const) {
    const result = bm.brandAttribution(text, brand);
    assert.equal(result.state, 'mixed', text);
    assert.deepEqual(result.lookalikes, [lookalike], text);
  }
});

test('L7: "ID:" in running text, after introductory text, or followed by words instead of a code is still a look-alike, for any brand', () => {
  for (const [brand, text, lookalike] of [
    ['Nike', 'Nike ID: design your own shoes, and Nike running', 'Nike ID'],
    ['Nike', '# Nike ID: design your own shoes, and Nike running', 'Nike ID'],
    ['COS', 'A company called COS ID: ... and COS clothing', 'COS ID'],
    ['COS', 'A company called COS ID: Ab12cd and COS clothing', 'COS ID'],
    ['Zara', 'Visit our partners. Zara ID: Xk29Lm and Zara coats', 'Zara ID'],
    ['Zara', 'Profile\nZara ID: Xk29Lm and Zara coats', 'Zara ID'],
    ['COS', '# COS ID: and COS coats', 'COS ID'],
    ['COS', '# COS ID: IrthV3LEdVhE-extra and COS coats', 'COS ID'],
  ] as const) {
    const result = bm.brandAttribution(text, brand);
    assert.equal(result.state, 'mixed', text);
    assert.deepEqual(result.lookalikes, [lookalike], text);
  }
});

test('L8: the field start is judged per field: a profile snippet is counted even when the title is the brand alone', () => {
  const fields: bm.BrandField[] = [
    { name: 'title', text: 'Gap' },
    { name: 'snippet', text: '# Gap ID: Lm77Ab Website: www.gap.com' },
  ];
  assert.equal(bm.brandAttributionOfFields(fields, 'Gap').state, 'clear');
  const prose: bm.BrandField[] = [
    { name: 'title', text: 'Gap' },
    { name: 'snippet', text: 'Our list. Gap ID: Lm77Ab and Gap jeans' },
  ];
  const result = bm.brandAttributionOfFields(prose, 'Gap');
  assert.equal(result.state, 'mixed');
  assert.equal(result.trigger?.field, 'snippet');
});
