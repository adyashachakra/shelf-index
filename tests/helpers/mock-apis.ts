// Test helper: canned Gemini, Tavily and YouTube responses, shaped like the real APIs' documented
// responses. These are SIMULATED. They prove the engine's logic, not that the live APIs behave
// the same way. Nothing in this file ever contacts a real service.

/**
 * A different brand than the default one, for tests of brand identity. Everything here is invented
 * (or a reconstruction of the shape of the real COS / Skincare failure); nothing is fetched from anywhere.
 */
export interface Scenario {
  brand: string;
  /** What Gemini's own description of the brand says (recognised in this category, or not). */
  recognised: boolean;
  /** The domain Gemini names for a recognised brand. */
  officialDomain?: string;
  /** Results returned for the open-web reviews search. */
  reviews: { title: string; url: string; content: string }[];
  /** Results returned for the Reddit search. */
  reddit?: { title: string; url: string; content: string }[];
  /** Brands Gemini recommends in every shopper answer. The audited brand is not among them unless listed. */
  recommends: string[];
  /** The domain whose site-restricted searches return pages (the brand's own site). */
  siteDomain?: string;
  /** The reader's verdict on whether an evidence item is about the audited business. Default: "yes". */
  sameBusiness?: (id: string) => 'yes' | 'no' | 'unclear' | 'mixed';
  /** Evidence ids that the recommendations try to cite. */
  fixIds?: string[];
  /** Titles of YouTube videos returned by the search. */
  videoTitles?: string[];
  /** Comments returned for every video (scenario audits otherwise return none). */
  videoComments?: string[];
  /** Results returned for a competitor's sentiment search, instead of the default pages. */
  competitorResults?: (name: string) => { title: string; url: string; content: string }[];
  /** The reader's "mixed" verdict for a competitor item, by the competitor it is about. */
  competitorMixed?: (about: string, text: string) => boolean;
}

/** A scripted failure for one generateContent request: an HTTP error reply, a dropped connection, or a timeout. */
export type MockFault = { status: number; body?: unknown } | 'network' | 'timeout';

export interface MockState {
  /** When set, the services answer as if the audited brand were this one. */
  scenario: Scenario | null;
  /** Answer every Tavily request with a rate limit (rejected before any credit is charged). */
  tavilyRateLimited: boolean;
  /** Every Tavily query received, in order. */
  tavilyQueries: string[];
  geminiCalls: number;
  tavilyCalls: number;
  youtubeCalls: number;
  /** Reject the newest structured-output field once, to exercise the format fallback. */
  rejectJsonSchemaOnce: boolean;
  /** Return one per-minute rate limit before answering. */
  rateLimitOnce: boolean;
  /** Question text fragment for which Gemini always fails (missing data path). */
  failQuestionContaining: string | null;
  tavilyQuotaExhausted: boolean;
  youtubeQuotaExhausted: boolean;
  seenAuthHeaders: string[];
  /** generateContent requests only (geminiCalls also counts the health check's metadata request). */
  generateCalls: number;
  /** The parsed body of every generateContent request, in order. */
  generateBodies: Record<string, unknown>[];
  /**
   * Called for every generateContent request with its 1-based number. Return a fault to fail that request,
   * or null to answer normally. The request is counted in generateCalls either way.
   */
  fault: ((requestNumber: number, body: Record<string, unknown>) => MockFault | null) | null;
}

export function newMockState(): MockState {
  return {
    scenario: null,
    tavilyRateLimited: false,
    tavilyQueries: [],
    geminiCalls: 0,
    tavilyCalls: 0,
    youtubeCalls: 0,
    rejectJsonSchemaOnce: false,
    rateLimitOnce: false,
    failQuestionContaining: null,
    tavilyQuotaExhausted: false,
    youtubeQuotaExhausted: false,
    seenAuthHeaders: [],
    generateCalls: 0,
    generateBodies: [],
    fault: null,
  };
}

const BRAND = 'Glowwell';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function blocks(user: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of user.split('\n\n')) {
    const newline = part.indexOf('\n');
    if (newline === -1) continue;
    const name = part.slice(0, newline).replace(/:$/, '');
    try {
      out[name] = JSON.parse(part.slice(newline + 1));
    } catch {
      /* not a JSON block */
    }
  }
  return out;
}

function firstWords(text: string, count: number): string {
  return text.split(/\s+/).slice(0, count).join(' ');
}

function recs(...names: string[]) {
  return names.map((brand) => ({ brand, why: `${brand} is a strong choice for this need because of its formulas.` }));
}

function askAnswer(question: string): unknown {
  const q = question.toLowerCase();
  const reply = (names: string[], extra = '', also: { brand: string; stance: string }[] = []) => ({
    answer: `I would look at ${names.join(', ')}. ${extra}`,
    recommendations: recs(...names),
    also_mentioned: also,
  });
  if (q.includes('best known for')) return reply(['Alba Dermics', BRAND]);
  if (q.includes('right now')) return reply(['Alba Dermics', BRAND, 'Verano Labs']);
  if (q.includes('affordable')) return reply(['Alba Dermics', 'Verano Labs']);
  if (q.includes('sensitive skin')) return reply([BRAND, 'Alba Dermics']);
  if (q.includes('acne')) return reply(['Verano Labs', 'Alba Dermics', 'Mirelle']);
  if (q.includes('anti-aging')) return reply(['Alba Dermics', 'Mirelle']);
  if (q.includes('dermatologists')) {
    return reply(['Alba Dermics', 'Verano Labs'], `${BRAND} is sometimes mentioned too.`, [{ brand: BRAND, stance: 'neutral' }]);
  }
  if (q.includes('fragrance-free')) {
    // Includes a brand in the list that is NOT in the answer text: the engine must ignore it.
    const base = reply(['Mirelle', 'Verano Labs', BRAND]);
    return { ...base, recommendations: [{ brand: 'Phantom Brand', why: 'Not in the answer.' }, ...(base.recommendations as object[])] };
  }
  return reply(['Alba Dermics', 'Mirelle']);
}

type Item = { id: string; text: string; about?: string };

function labelsFor(items: Item[]): unknown {
  const labels = items.map((item, index) => {
    const prefix = item.id[0];
    const voice = prefix === 'R' ? 'publication' : prefix === 'V' ? 'creator' : 'customer';
    let sentiment = index % 4 === 1 ? 'negative' : index % 4 === 2 ? 'mixed' : 'positive';
    if (item.id === 'D6') sentiment = 'neutral';
    return { id: item.id, relevant: item.id !== 'R4', voice, sentiment };
  });
  const text = (id: string) => items.find((i) => i.id === id)?.text ?? '';
  return {
    labels,
    praise_themes: [
      { label: 'Gentle on skin', summary: 'People say it is gentle.', evidence_ids: ['D1', 'D4', 'D1'], quote_evidence_id: 'D1', quote_text: firstWords(text('D1'), 7), scope: 'one_product', product: 'oat cleanser' },
      { label: 'Only one source', summary: 'Should be dropped.', evidence_ids: ['D5'], quote_evidence_id: 'D5', quote_text: 'x', scope: 'brand_overall', product: '' },
    ],
    complaint_themes: [
      // Claims to be about one product, but that product is not named in its evidence: the claim must not be kept.
      { label: 'Slow shipping', summary: 'Delivery is slow.', evidence_ids: ['D2', 'C2', 'ZZ9'], quote_evidence_id: 'D2', quote_text: 'this sentence does not appear anywhere in the source text', scope: 'one_product', product: 'Night Repair Balm' },
      // Overclaims on purpose: a cause in the label and a brand-wide verdict in the summary.
      { label: 'Formula change caused delays', summary: 'A widespread safety issue that damages trust.', evidence_ids: ['D2', 'C2'], quote_evidence_id: 'D2', quote_text: '', scope: 'unclear', product: '' },
    ],
    concerns: [
      { label: 'How long does shipping take?', evidence_ids: ['D2', 'C2'] },
      { label: 'Does the cleanser dry out my skin?', evidence_ids: ['D1', 'D4'] },
    ],
    advocacy: [
      { evidence_id: 'D1', note: 'Recommends it to friends.' },
      { evidence_id: 'D2', note: 'Negative item: must be rejected as advocacy.' },
    ],
    creator_vs_customer: 'Creators are warmer than customers.',
    // A price position quoted from a real item, with the price words in the quote.
    price_position: { tier: 'budget', evidence_id: 'R2', quote: firstWords(text('R2'), 12) },
  };
}

function siteAnalysis(b: Record<string, unknown>): unknown {
  const pages = (b['EVIDENCE (site pages)'] as { id: string; text: string }[]) ?? [];
  const questions = (b.QUESTIONS as { id: string }[]) ?? [];
  const concerns = (b.CONCERNS as { id: string }[]) ?? [];
  const page = (i: number) => pages[i] ?? pages[0];
  const quote = (i: number) => firstWords(page(i).text, 7);
  return {
    product_lines: [
      { name: 'Cleansers', page_id: page(0).id, quote: quote(0) },
      { name: 'Moisturisers', page_id: page(1).id, quote: quote(1) },
      { name: 'Sunscreen', page_id: page(2).id, quote: quote(2) },
      { name: 'Invented line', page_id: page(0).id, quote: 'words that are not on the page at all' },
    ],
    positioning: [{ statement: 'Gentle care that ships fast.', page_id: page(0).id, quote: quote(0) }],
    signature_claim: { claim: 'gentle fragrance-free care', page_id: page(0).id, quote: quote(0) },
    question_relevance: questions.map((q) => ({
      question_id: q.id,
      // q5 is genuinely out of range. q3 is wrongly called out of range: Gemini named the brand there, so it must stay counted.
      // q8 (the luxury question) is called out of range for a price reason, as the model did in the first live V1.1 audit:
      // that verdict must be ignored here, and the question decided by the price rule alone.
      fit: q.id === 'q5' || q.id === 'q3' || q.id === 'q8' ? 'out_of_range' : 'in_range',
      reason: q.id === 'q8' ? 'The brand is positioned as a gentle, everyday brand rather than luxury' : 'The site lists no such products',
    })),
    coverage: [
      ...questions.map((q) => {
        // q1 and q7: a fact about the whole brand. q2: a label whose quote cannot be found on the page.
        if (q.id === 'q1' || q.id === 'q7') return { item_id: q.id, level: 'clear', page_id: page(1).id, quote: quote(1), asks_about: 'any', quote_about: 'brand-wide', relation: 'brand_wide' };
        if (q.id === 'q2') return { item_id: q.id, level: 'partial', page_id: page(0).id, quote: 'a quote that cannot be verified on the page', asks_about: 'any', quote_about: 'brand-wide', relation: 'brand_wide' };
        // q6: the model says "clear" but cannot say how the quote relates to the question.
        if (q.id === 'q6') return { item_id: q.id, level: 'clear', page_id: page(0).id, quote: quote(0), asks_about: '', quote_about: '', relation: 'unknown' };
        return { item_id: q.id, level: 'none', page_id: '', quote: '', asks_about: '', quote_about: '', relation: 'unknown' };
      }).filter((entry) => entry.item_id !== 'q4'), // no verdict at all comes back for q4
      ...concerns.map((c, i) =>
        i === 0
          ? { item_id: c.id, level: 'partial', page_id: page(2).id, quote: quote(2), asks_about: 'any', quote_about: 'sunscreen', relation: 'same_product' }
          : // The fault from the third live audit: a quote about one product offered as a clear answer about another.
            // The model calls it "the same product"; the words quoted are about a sunscreen and the concern is about a cleanser.
            { item_id: c.id, level: 'clear', page_id: page(2).id, quote: quote(2), asks_about: 'cleanser', quote_about: 'sunscreen', relation: 'same_product' },
      ),
    ],
    // The model claims the site calls itself luxury, with a quote that has no price word in it: must be rejected.
    price_position: { tier: 'premium', page_id: page(0).id, quote: quote(0) },
  };
}

function scenarioPages(brand: string, domain: string): [string, string, string][] {
  return [
    [`https://www.${domain}/`, `${brand}: home`, `${brand} makes clothing for everyday wear, with a range of coats, knitwear, shirts and trousers, and the pieces are described here in plain terms for each collection.`],
    [`https://www.${domain}/women`, `${brand} women`, `The ${brand} women's collection includes coats, dresses, knitwear and trousers in a restrained palette, with sizing guidance and care instructions on every product page.`],
    [`https://www.${domain}/help`, `${brand} help and delivery`, `${brand} delivery usually takes three to five working days, and returns are accepted for thirty days after the order arrives, with details on this page.`],
  ];
}

function geminiResponse(system: string, user: string, state: MockState): unknown {
  const scenario = state.scenario;
  if (system.includes('Write questions real shoppers ask')) {
    const intents = ['best overall', 'value', 'premium', 'sensitive needs', 'trust', 'beginners', 'gifts', 'durability'];
    return { questions: intents.map((intent, i) => ({ intent, text: `Which brands are best for ${intent} in this category? (${i + 1})` })) };
  }
  if (system.includes('answering a shopper')) {
    if (scenario) {
      const names = scenario.recommends;
      return { answer: `I would look at ${names.join(', ')}.`, recommendations: recs(...names), also_mentioned: [] };
    }
    return askAnswer(user);
  }
  if (scenario && system.includes('Describe a brand using only what you already know')) {
    return scenario.recognised
      ? {
          recognized: true,
          description: `${scenario.brand} is a clothing brand known for coats and knitwear.`,
          known_for: ['Coats'],
          products: ['Coats', 'Knitwear'],
          price_positioning: 'mid',
          official_domain: scenario.officialDomain ?? '',
          strengths: [],
          criticisms: [],
          claims: [],
        }
      : { recognized: false, description: '', known_for: [], products: [], price_positioning: 'unknown', official_domain: '', strengths: [], criticisms: [], claims: [] };
  }
  if (system.includes('Describe a brand using only what you already know')) {
    return {
      recognized: true,
      description: `${BRAND} is a gentle skincare brand known for its oat cleanser.`,
      known_for: ['Oat cleanser'],
      products: ['Cleansers', 'Moisturisers'],
      price_positioning: 'mid',
      official_domain: 'https://www.glowwell.com/shop',
      strengths: ['Gentle formulas'],
      criticisms: ['Slow shipping'],
      claims: [
        { text: `${BRAND} sells an oat cleanser`, type: 'product', polarity: 'positive' },
        { text: `${BRAND} still sells its Bright C serum`, type: 'availability', polarity: 'neutral' },
      ],
    };
  }
  const b = blocks(user);
  if (system.includes('reading what people say about a brand')) {
    const items = (b.EVIDENCE as Item[]) ?? [];
    const out = labelsFor(items) as { labels: Record<string, unknown>[] };
    // The reader answers "same_business" for every item, as the prompt asks; the scenario decides what it says.
    if (!system.includes('"same_business"')) throw new Error('The labelling instruction must ask for "same_business"');
    out.labels = out.labels.map((label) => ({ ...label, same_business: scenario?.sameBusiness ? scenario.sameBusiness(String(label.id)) : 'yes' }));
    return out;
  }
  if (system.includes("auditing a brand's own website")) {
    const ids = [...((b.QUESTIONS as { id: string }[]) ?? []), ...((b.CONCERNS as { id: string }[]) ?? [])].map((entry) => entry.id);
    if (!system.includes(`exactly ${ids.length} entries`) || !system.includes(ids.join(', '))) {
      throw new Error('The site-analysis instruction must name every checklist id');
    }
    return siteAnalysis(b);
  }
  if (system.includes('fact-checking')) {
    const claims = (b.CLAIMS as { id: string }[]) ?? [];
    const evidence = (b.EVIDENCE as Item[]) ?? [];
    return {
      verdicts: claims.map((claim, index) =>
        index === 0
          ? { claim_id: claim.id, verdict: 'supported', evidence_id: evidence[0].id, quote: firstWords(evidence[0].text, 7), note: 'Stated by a source.' }
          : { claim_id: claim.id, verdict: 'contradicted', evidence_id: evidence[0].id, quote: 'a fabricated quote that is not in the source', note: 'Claimed contradiction.' },
      ),
    };
  }
  if (system.includes('labeling what people say about several brands')) {
    const items = (b.EVIDENCE as Item[]) ?? [];
    if (!system.includes('"same_business"')) throw new Error('The competitor labelling instruction must ask for "same_business"');
    return {
      labels: items.map((item, index) => ({
        id: item.id,
        relevant: true,
        voice: index % 3 === 0 ? 'publication' : 'customer',
        sentiment: index % 5 === 0 ? 'negative' : 'positive',
        same_business: scenario?.competitorMixed?.(String(item.about ?? ''), item.text) ? 'mixed' : 'yes',
      })),
    };
  }
  if (system.includes('brand strategist comparing')) {
    return {
      disagreements: [
        { title: 'Shipping', kind: 'risk', audience_says: 'Delivery is slow, as reported across 3 sources.', gemini_says: 'Recommended without caveats.', implication: 'Ignoring this will erode loyalty and lead to lost sales.', audience_evidence_ids: ['D2'], gemini_evidence_ids: ['G1'] },
        { title: 'Unsupported point', kind: 'disagreement', audience_says: 'x', gemini_says: 'y', implication: 'z', audience_evidence_ids: ['ZZ9'], gemini_evidence_ids: ['G1'] },
        { title: 'Wrong side', kind: 'disagreement', audience_says: 'x', gemini_says: 'y', implication: 'z', audience_evidence_ids: ['G2'], gemini_evidence_ids: ['D1'] },
      ],
      insights: [
        { pattern: 'complaint_as_fact', observed: 'Unsupported: cites only the model.', why_it_matters: 'x', strategic_implication: 'y', evidence_ids: ['G1', 'GP'] },
        // Patterns this list no longer carries. A model that returns them anyway must be ignored.
        { pattern: 'narrow_range', observed: 'Only the cleanser is mentioned.', why_it_matters: 'Caps reach.', strategic_implication: 'Explain the range.', evidence_ids: ['GP', 'S2'] },
        { pattern: 'positioning_contradiction', observed: 'A reading that names no exact statement.', why_it_matters: 'x', strategic_implication: 'y', evidence_ids: ['S2', 'D2'] },
      ],
      positioning_checks: [
        { complaint: 'A theme that does not exist', statement_id: 'P1', note: 'Must be ignored: no such complaint theme.' },
        { complaint: 'Slow shipping', statement_id: 'P9', note: 'Must be ignored: there is no statement P9 on the site.' },
        { complaint: 'slow shipping', statement_id: 'P1', note: 'The site says it ships fast, while customers report slow delivery.' },
      ],
    };
  }
  if (system.includes('prioritised fix list')) {
    if (scenario?.fixIds) {
      return { fixes: scenario.fixIds.map((id, index) => ({ action: `Address what customers say in ${id}.`, why: `Evidence ${id} describes it.`, priority: index + 1, effort: 'Low', expected_impact: 'A later audit could show whether this changes.', evidence_ids: [id] })) };
    }
    return {
      fixes: [
        // Overclaims on purpose: a cause, a business outcome and a promised result. None may reach the report.
        { action: 'Publish real delivery times.', why: 'Slow delivery causes churn and damages trust.', priority: 1, effort: 'Low', expected_impact: 'Improves conversion and rebuilds trust.', evidence_ids: ['D2', 'S1'] },
        { action: 'Explain the wider range.', why: 'Gemini names one product across two sources.', priority: 2, effort: 'Medium', expected_impact: "If the range is explained on the site, a later audit could show whether Gemini's description names more of it.", evidence_ids: ['GP'] },
        { action: 'A fix with no real evidence.', why: 'x', priority: 3, effort: 'High', expected_impact: 'y', evidence_ids: ['Q99'] },
        // Real evidence, but the action itself asserts a cause and a business result: left out whole.
        { action: 'Fix the slow courier that causes lost sales.', why: 'Two sources report slow delivery.', priority: 4, effort: 'High', expected_impact: 'If fixed, a later audit could show fewer reports.', evidence_ids: ['D2'] },
      ],
    };
  }
  return {};
}

function reddit(n: number) {
  const texts = [
    `${BRAND} oat cleanser is the gentlest thing I have used on my rosacea and I recommend it to friends constantly.`,
    `Ordered from ${BRAND} and shipping took three weeks, which was really frustrating for a simple cleanser order.`,
    `${BRAND} is fine. The moisturiser is nice but the pump broke, so mixed feelings overall about the brand.`,
    `Second bottle of the ${BRAND} cleanser now, it has been gentle and reliable on my sensitive skin every day.`,
    `I switched to ${BRAND} last year and my skin barrier has honestly never been better than it is now.`,
    `Does anyone know where ${BRAND} is based? Asking because of customs charges on delivery to my country.`,
    'A thread about something else entirely that never names the audited brand at all in its text here.',
  ];
  return texts.slice(0, n).map((content, i) => ({ title: `Reddit thread ${i + 1}`, url: `https://www.reddit.com/r/SkincareAddiction/comments/abc${i}/thread_${i}/`, content, score: 0.9 - i * 0.05, raw_content: null }));
}

function tavilyResponse(body: Record<string, unknown>, state: MockState): unknown {
  const include = (body.include_domains as string[] | undefined) ?? [];
  const query = String(body.query ?? '');
  const scenario = state.scenario;
  let results: unknown[];
  if (scenario) {
    const shape = (rows: { title: string; url: string; content: string }[]) => rows.map((row, i) => ({ ...row, score: 0.8 - i * 0.02, raw_content: null }));
    if (include.includes('reddit.com')) results = shape(scenario.reddit ?? []);
    else if (scenario.siteDomain && include.includes(scenario.siteDomain)) {
      results = scenarioPages(scenario.brand, scenario.siteDomain).map(([url, title, content], i) => ({ title, url, content, score: 0.8 - i * 0.05, raw_content: `[Home](/) [Shop](/shop)\n\n# ${title}\n\n${content}` }));
    } else if (query.includes('review honest opinion forum')) results = shape(scenario.reviews);
    else if (query.includes('reviews honest opinions')) {
      const name = query.split(` clothing`)[0];
      if (scenario.competitorResults) results = shape(scenario.competitorResults(name));
      else results = shape(Array.from({ length: 4 }, (_, i) => ({ title: `${name} review ${i + 1}`, url: `https://comp${i}.example.org/${encodeURIComponent(name)}/${i}`, content: `${name} has been reliable and worth the price according to this long-term reviewer of the brand.` })));
    } else results = [];
    return { query, results, response_time: 0.4, usage: { credits: 1 }, request_id: 'mock' };
  }
  if (include.includes('reddit.com')) {
    results = reddit(7);
  } else if (include.includes('glowwell.com')) {
    const second = query.includes('guide FAQ');
    const pages = second
      ? [
          ['https://www.glowwell.com/blogs/journal/how-to-choose', 'How to choose a cleanser', 'Choosing a cleanser for sensitive skin starts with avoiding fragrance and harsh surfactants, and our guide explains how to do it step by step for every skin type.'],
          ['https://www.glowwell.com/pages/faq', 'Frequently asked questions', 'Shipping usually takes five to seven working days within the country and returns are accepted for thirty days after delivery of the order to your address.'],
          ['https://www.glowwell.com/pages/about', 'About Glowwell', 'Glowwell was started in a small studio to make gentle fragrance-free skincare for reactive skin, and every formula is tested on sensitive skin before launch.'],
        ]
      : [
          ['https://www.glowwell.com/', 'Glowwell: gentle skincare', 'Gentle fragrance-free care that ships fast, made for reactive skin by people who have it, with cleansers, moisturisers and a mineral sunscreen in the range today.'],
          ['https://www.glowwell.com/products/oat-cleanser', 'Oat Cleanser', 'Our oat cleanser is the best everyday choice for sensitive skin and it is fragrance-free, soap-free and gentle enough to use morning and night on any skin.'],
          ['https://www.glowwell.com/collections/sunscreen', 'Mineral sunscreen', 'A mineral sunscreen with zinc oxide that leaves no white cast and is free from fragrance, made to sit comfortably under makeup throughout a long working day.'],
          ['https://www.glowwell.com/products/barrier-cream', 'Barrier cream', 'Short.'],
          ['https://www.othersite.com/glowwell', 'Wrong domain', 'This result is from another domain and must be ignored by the page builder entirely.'],
        ];
    results = pages.map(([url, title, text], i) => ({ title, url, content: text, score: 0.8 - i * 0.05, raw_content: `[Home](/) [Shop](/shop) [About](/about)\n\n# ${title}\n\n${text}` }));
  } else if (query.includes('reviews honest opinions')) {
    const name = query.split(' skincare')[0];
    results = Array.from({ length: 10 }, (_, i) => ({
      title: `${name} review ${i + 1}`,
      url: `https://site${i % 4}.example.org/${encodeURIComponent(name)}/review-${i}`,
      content: `${name} has been ${i % 5 === 0 ? 'disappointing lately with weaker formulas' : 'excellent for my skin and worth the price'} according to this long-term reviewer of the brand.`,
      score: 0.7,
      raw_content: null,
    }));
  } else if (query.startsWith(`"${BRAND}"`)) {
    results = [
      { title: 'Glowwell oat cleanser listing', url: 'https://shop.example.net/glowwell-oat-cleanser', content: `${BRAND} sells an oat cleanser that is listed here at a mid-range price with free returns for thirty days.`, score: 0.8, raw_content: null },
      { title: 'Glowwell on its own site', url: 'https://www.glowwell.com/products/oat-cleanser', content: `${BRAND} oat cleanser is available now from the official store in two sizes for sensitive skin.`, score: 0.7, raw_content: null },
    ];
  } else {
    results = [
      { title: 'Glowwell review: gentle, affordable and slow to arrive', url: 'https://skinjournal.example.net/glowwell-review', content: `${BRAND} formulas are gentle and well priced, though our order was slow. We may earn a commission from links on this page.`, score: 0.9, raw_content: null },
      { title: 'Best gentle cleansers tested', url: 'https://beautydesk.example.com/best-gentle-cleansers', content: `${BRAND} Oat Cleanser was the gentlest of the twelve affordable drugstore cleansers we tested this season for reactive skin.`, score: 0.85, raw_content: null },
      { title: 'Glowwell complaints roundup', url: 'https://forum.example.org/t/glowwell-complaints/88', content: `Several members complained that ${BRAND} pumps break and that support is slow to respond to messages.`, score: 0.8, raw_content: null },
      { title: 'Unrelated listicle', url: 'https://listicle.example.com/top-10', content: `A list that briefly names ${BRAND} among forty other brands without saying anything about it whatsoever.`, score: 0.5, raw_content: null },
      { title: 'Glowwell official', url: 'https://www.glowwell.com/pages/reviews', content: `${BRAND} customers love us. Read five star reviews on our own site from happy customers everywhere.`, score: 0.4, raw_content: null },
      { title: 'Instagram post', url: 'https://www.instagram.com/p/abc/', content: `${BRAND} on Instagram, which must never be used as a source by this project.`, score: 0.4, raw_content: null },
    ];
  }
  return { query, results, response_time: 0.4, usage: { credits: 1 }, request_id: 'mock' };
}

function youtubeResponse(url: URL, state: MockState): Response {
  if (state.youtubeQuotaExhausted) {
    return json(403, { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } });
  }
  const path = url.pathname;
  if (state.scenario && path.endsWith('/search')) {
    return json(200, { items: (state.scenario.videoTitles ?? []).map((title, i) => ({ id: { videoId: `sv${i}` }, snippet: { title, description: 'A video', channelTitle: 'Creator' } })) });
  }
  if (state.scenario && path.endsWith('/commentThreads') && state.scenario.videoComments) {
    return json(200, { items: state.scenario.videoComments.map((text, i) => ({ snippet: { topLevelComment: { id: `scmt${i}`, snippet: { textDisplay: text, likeCount: 30 - i, authorDisplayName: 'Should Not Be Stored' } } } })) });
  }
  if (state.scenario) return json(200, { items: [] });
  if (path.endsWith('/search')) {
    return json(200, {
      items: [
        { id: { videoId: 'vid1' }, snippet: { title: `${BRAND} review after 30 days`, description: 'My honest thoughts', channelTitle: 'Creator One' } },
        { id: { videoId: 'vid2' }, snippet: { title: `Is ${BRAND} worth it?`, description: 'Testing the cleanser', channelTitle: 'Creator Two' } },
        { id: { videoId: 'vid3' }, snippet: { title: 'My morning routine', description: 'No brand named here', channelTitle: 'Creator Three' } },
      ],
    });
  }
  if (path.endsWith('/videos')) {
    return json(200, {
      items: [
        { id: 'vid1', snippet: { title: `${BRAND} review after 30 days`, description: `This video is sponsored by ${BRAND}. Use my code GLOW for 15% off.`, channelTitle: 'Creator One' }, statistics: { commentCount: '120' }, paidProductPlacementDetails: { hasPaidProductPlacement: true } },
        { id: 'vid2', snippet: { title: `Is ${BRAND} worth it?`, description: 'Testing the cleanser for a month, bought with my own money.', channelTitle: 'Creator Two' }, statistics: { commentCount: '0' }, paidProductPlacementDetails: { hasPaidProductPlacement: false } },
      ],
    });
  }
  if (path.endsWith('/commentThreads')) {
    if (url.searchParams.get('videoId') === 'vid2') {
      return json(403, { error: { code: 403, message: 'disabled', errors: [{ reason: 'commentsDisabled', domain: 'youtube.commentThread' }] } });
    }
    const texts = [
      `Bought the ${BRAND} cleanser after this and it has been great for my sensitive skin so far.`,
      `Delivery from ${BRAND} took forever for me, nearly three weeks, which was annoying.`,
      'The cleanser is lovely and gentle, my skin has calmed down a lot since I started using it.',
      'Their pumps always break on me. The product is good but the packaging really is not.',
      'Great video, very helpful breakdown of the ingredients and how the cleanser feels on skin.',
      'Has anyone else found the moisturiser pills under sunscreen? Otherwise I really like the range.',
      'short',
      'Check out my channel at https://spam.example.com for free stuff and giveaways every day',
    ];
    return json(200, {
      items: texts.map((text, i) => ({ snippet: { topLevelComment: { id: `cmt${i}`, snippet: { textDisplay: text, likeCount: 50 - i * 3, authorDisplayName: 'Should Not Be Stored' } } } })),
    });
  }
  return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
}

/** Replace global fetch. Requests to the Redis shim pass through to the real fetch. */
export function installMockFetch(state: MockState, passthroughPrefix: string): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(passthroughPrefix)) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const parsed = new URL(url);

    if (parsed.hostname === 'generativelanguage.googleapis.com') {
      state.geminiCalls += 1;
      state.seenAuthHeaders.push(headers.get('x-goog-api-key') ?? '');
      if (parsed.search !== '') throw new Error('Gemini requests must not carry query parameters');
      if (!url.includes(':generateContent')) return json(200, { name: 'models/mock' });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const generationConfig = (body.generationConfig ?? {}) as Record<string, unknown>;
      state.generateCalls += 1;
      state.generateBodies.push(body);
      const fault = state.fault ? state.fault(state.generateCalls, body) : null;
      if (fault === 'network') throw new TypeError('fetch failed');
      if (fault === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      if (fault) return json(fault.status, fault.body ?? { error: { code: fault.status, status: 'FAULT', message: 'Scripted test failure.' } });
      if (body.tools !== undefined) throw new Error('The engine must never send tools (no Search grounding)');
      if (state.rejectJsonSchemaOnce && generationConfig.responseJsonSchema !== undefined) {
        state.rejectJsonSchemaOnce = false;
        return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "responseJsonSchema" at \'generation_config\': Cannot find field.' } });
      }
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false;
        return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded. Please retry in 7.5s.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } });
      }
      const system = String(((body.systemInstruction as { parts: { text: string }[] }).parts[0] ?? { text: '' }).text);
      const user = String(((body.contents as { parts: { text: string }[] }[])[0].parts[0] ?? { text: '' }).text);
      if (state.failQuestionContaining && system.includes('answering a shopper') && user.includes(state.failQuestionContaining)) {
        return json(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } });
      }
      return json(200, {
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(geminiResponse(system, user, state)) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        modelVersion: 'gemini-3.5-flash-lite',
      });
    }

    if (parsed.hostname === 'api.tavily.com') {
      state.tavilyCalls += 1;
      state.seenAuthHeaders.push(headers.get('authorization') ?? '');
      state.tavilyQueries.push(String((JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>).query ?? ''));
      if (state.tavilyRateLimited) return json(429, { detail: { error: 'Too many requests.' } });
      if (state.tavilyQuotaExhausted) return json(432, { detail: { error: 'This request exceeds your plan usage limit.' } });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (body.search_depth !== 'basic') throw new Error('Searches must use basic depth (1 credit)');
      if (body.auto_parameters === true) throw new Error('auto_parameters must stay off');
      return json(200, tavilyResponse(body, state));
    }

    if (parsed.hostname === 'www.googleapis.com' && parsed.pathname.startsWith('/youtube/v3/')) {
      state.youtubeCalls += 1;
      return youtubeResponse(parsed, state);
    }

    throw new Error(`Unexpected outbound request to ${parsed.hostname}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}
