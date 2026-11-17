import 'server-only';
import { differentBusinessItems, mixedByReaderReason, readablePages } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
import { QUESTION_BANK_VERSION } from '../audit/questions';
import { config, GEMINI_REQUESTS_PER_AUDIT } from '../config';
import { mostCommonCasing } from '../evidence/brand-match';
import { addSetAside, brandNotRecognised, identitySection } from '../evidence/identity';
import { clip } from '../evidence/normalize';
import { overallConfidence } from '../scoring/confidence';
import { rankCompetitors, visibilityOverQuestions } from '../scoring/competitors';
import { scorePerception } from '../scoring/perception';
import { placementOf, verifiedRecommendations, MIN_COUNTED_QUESTIONS } from '../scoring/visibility';
import type {
  BetweenLinesCheck,
  CompetitorRow,
  CompetitorSection,
  DisconnectSection,
  EvidenceItem,
  InsightEvidence,
  Metric,
  MetricOrSkipped,
  Report,
  SetAsideEvidence,
} from '../types';
import { computeCore, type Core } from './core';
import { buildEvidenceIndex, describePlacement, siteStatements, type EvidenceIndex } from './digest';

// Assembles the final report. Everything numeric here is arithmetic; everything interpretive
// was written by Gemini earlier and has already had its evidence ids and quotes checked.

function insightList(index: EvidenceIndex, ids: string[]): InsightEvidence[] {
  const out: InsightEvidence[] = [];
  for (const id of ids) {
    const entry = index.toInsight(id);
    if (entry && !out.some((e) => e.id === entry.id)) out.push(entry);
  }
  return out;
}

function competitorSection(meta: JobMeta, data: JobData, core: Core): CompetitorSection {
  const answers = data.answers ?? [];
  const names = data.competitors?.names ?? rankCompetitors(answers, meta.brand).map((r) => r.name);
  const brandVisibility = core.visibility.metric;
  const notMeasured = (reason: string) => ({ status: 'not_measured' as const, reason });

  const rows: CompetitorRow[] = [
    {
      name: meta.brand,
      isAuditedBrand: true,
      visibility: brandVisibility,
      appearances: core.visibility.detail.appearances,
      sentiment: core.perception.metric,
      sentimentSample: core.perception.detail.raw.counted,
      contentCoverage: notMeasured('See the content gap section for the audited brand.'),
    },
  ];

  // When Gemini did not recognise the audited brand, the brands it recommended are not verified competitors of it.
  // They are listed as what they are, with no comparison drawn and no sentiment searched.
  const notIdentified = brandNotRecognised(data.identity);
  for (const name of names) {
    const v = visibilityOverQuestions(name, answers, core.countedQuestionIds);
    let visibility: Metric;
    if (notIdentified) {
      visibility = { status: 'not_recognised', reason: 'Not compared: the audited brand was not recognised in this category.' };
    } else if (brandVisibility.status !== 'scored' || v.score === null || v.counted < MIN_COUNTED_QUESTIONS) {
      visibility = { status: 'insufficient', reason: 'Too few counted questions to score.' };
    } else {
      visibility = {
        status: 'scored',
        score: v.score,
        confidence: brandVisibility.confidence,
        confidenceReason: 'Same formula over the same counted questions as the audited brand.',
      };
    }

    let sentiment: MetricOrSkipped;
    let sample = 0;
    const competitorData = data.competitors;
    if (notIdentified) {
      sentiment = notMeasured('Not searched: the audited brand was not recognised in this category.');
    } else if (meta.tier !== 'full') {
      sentiment = notMeasured('Skipped in this audit to stay inside the monthly research budget.');
    } else if (!competitorData || !competitorData.searchedNames.includes(name)) {
      sentiment = { status: 'insufficient', reason: 'The search for this competitor did not run or returned nothing usable.' };
    } else if (!competitorData.labeled || competitorData.labels.length === 0) {
      sentiment = { status: 'insufficient', reason: 'The evidence for this competitor could not be analysed.' };
    } else {
      const items = competitorData.items.filter((i) => i.competitor === name);
      const scored = scorePerception(items, competitorData.labels);
      sentiment = scored.metric;
      sample = scored.detail.raw.counted;
    }

    rows.push({
      name,
      isAuditedBrand: false,
      visibility,
      appearances: v.appearances,
      sentiment,
      sentimentSample: sample,
      contentCoverage: notMeasured('Competitor content coverage is not measured in V1.'),
    });
  }

  if (notIdentified) {
    return {
      kind: 'recommended_brands',
      rows,
      note:
        names.length === 0
          ? 'Gemini did not recommend other brands often enough to list them here.'
          : `These are the brands Gemini recommended most across the shopper questions. They are not verified competitors of ${meta.brand}: Gemini did not recognise ${meta.brand} in this category, so no comparison is drawn, no sentiment was searched for them, and none of them is used in the recommendations. The counts show how often each was named, for reference only.`,
    };
  }

  const note =
    names.length === 0
      ? 'Gemini did not recommend other brands often enough to name competitors.'
      : 'Competitors are the brands Gemini recommended most across the same questions. Their sentiment comes from one search each, a lighter sample than the audited brand received. Content coverage is not measured for competitors in V1, and nothing is estimated in its place.';
  return { kind: 'competitors', rows, note };
}

function disconnectSection(data: JobData, core: Core): DisconnectSection {
  const disagreements = data.synthesis?.disagreements ?? [];
  const note = data.synthesis?.insightsAvailable === false ? 'The comparison of specific points could not be generated for this audit.' : undefined;
  const v = core.visibility.metric;
  const p = core.perception.metric;
  if (v.status === 'not_recognised') {
    return {
      status: 'cannot_assess',
      reason: 'The two scores cannot be compared because the brand was not recognised in this category, so Gemini API recommendation visibility is not shown.',
      disagreements,
      note,
    };
  }
  if (v.status !== 'scored' || p.status !== 'scored') {
    const missing = [v.status !== 'scored' ? 'Gemini API recommendation visibility' : null, p.status !== 'scored' ? 'audience perception' : null]
      .filter(Boolean)
      .join(' and ');
    return {
      status: 'cannot_assess',
      reason: `The two scores cannot be compared because ${missing} could not be assessed.`,
      disagreements,
      note,
    };
  }
  const gap = v.score - p.score;
  let direction: DisconnectSection['direction'] = 'aligned';
  let headline = `Gemini's recommendations and audience sentiment are broadly in line (visibility ${v.score}, perception ${p.score}).`;
  if (gap <= -20) {
    direction = 'ai_under';
    headline = `People rate this brand better than Gemini recommends it: audience perception is ${p.score}, Gemini API recommendation visibility is ${v.score}.`;
  } else if (gap >= 20) {
    direction = 'ai_over';
    headline = `Gemini recommends this brand more readily than customer sentiment supports: visibility is ${v.score}, audience perception is ${p.score}.`;
  }
  return { status: 'assessed', direction, gap, headline, disagreements, note };
}

/**
 * A pattern that depends on customer complaints is called established only when this many
 * separate sources report the complaint. Below that it is shown as a possibility.
 */
export const ESTABLISHED_MIN_SOURCES = 5;

function sourceWord(count: number): string {
  return `${count} customer or reviewer source${count === 1 ? '' : 's'}`;
}

function betweenTheLines(meta: JobMeta, data: JobData, core: Core, index: EvidenceIndex): BetweenLinesCheck[] {
  const checks: BetweenLinesCheck[] = [];
  const synthesis = data.synthesis;
  const insightsAvailable = synthesis?.insightsAvailable === true;
  const profile = data.profile;
  const analysis = data.siteAnalysis;
  const answers = data.answers ?? [];
  const brandNamedSomewhere =
    (profile?.recognized ?? false) || answers.some((a) => a.status === 'answered' && placementOf(a, meta.brand).kind !== 'absent');
  const firstInsight = (pattern: 'complaint_as_fact' | 'positioning_contradiction') =>
    (synthesis?.insights ?? []).find((i) => i.pattern === pattern);
  const audienceSourcesBehind = (ids: string[]) => index.audienceSources(ids.filter((id) => index.family(id) === 'audience'));
  const sourcesRead = core.perception.detail.uniqueSources;

  // 1. Signature claim
  {
    const title = "Does Gemini recommend a competitor for the brand's signature claim?";
    const claim = analysis?.signatureClaim ?? null;
    const signature = data.signature ?? null;
    if (!claim) {
      checks.push({ id: 'signature_claim', title, status: 'cannot_assess', basis: 'computed', evidence: [], reason: "No signature claim could be verified from the brand's own site." });
    } else if (!signature || signature.status !== 'answered') {
      checks.push({ id: 'signature_claim', title, status: 'cannot_assess', basis: 'computed', evidence: [], reason: 'Gemini did not answer the question built from the signature claim.' });
    } else {
      const placement = placementOf(signature, meta.brand);
      const first = verifiedRecommendations(signature)[0]?.brand;
      const evidence: InsightEvidence[] = [
        { id: claim.ref.pageId, label: `Brand site states: "${claim.claim}"`, url: claim.ref.url, quote: claim.ref.quote },
        ...insightList(index, ['GS']),
      ];
      if (placement.kind === 'recommended' && placement.position === 1) {
        checks.push({
          id: 'signature_claim',
          title,
          status: 'not_observed',
          basis: 'computed',
          observed: `Asked "${signature.question}", Gemini named ${meta.brand} first.`,
          evidence,
        });
      } else {
        checks.push({
          id: 'signature_claim',
          title,
          status: 'observed',
          basis: 'computed',
          strength: 'established',
          observed: `The brand's site leads with "${claim.claim}". Asked "${signature.question}", Gemini's first recommendation was ${first ?? 'not a specific brand'}; ${meta.brand} was ${describePlacement(placement)}. This is one answer from one model, asked once.`,
          evidence,
          whyItMatters: 'In this answer a competitor was named first for the claim the brand leads with on its own site.',
          implication: `If "${claim.claim}" were stated plainly in places other than ${meta.brand}'s own site, such as independent reviews and comparisons, a later audit could show whether Gemini's answer changes. This audit did not test that.`,
        });
      }
    }
  }

  // 2. Complaint repeated as fact
  {
    const title = 'Does Gemini repeat an online complaint as established fact?';
    const insight = firstInsight('complaint_as_fact');
    if (!insightsAvailable || !brandNamedSomewhere || core.perception.complaints.length === 0) {
      const reason = !brandNamedSomewhere
        ? 'Gemini said nothing about the brand to compare against.'
        : core.perception.complaints.length === 0
          ? 'No customer complaint appeared in at least two sources, so there was nothing to compare against.'
          : 'The comparison step did not run for this audit.';
      checks.push({ id: 'complaint_as_fact', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason });
    } else if (insight) {
      const sources = audienceSourcesBehind(insight.evidenceIds);
      const tentative = sources < ESTABLISHED_MIN_SOURCES;
      checks.push({
        id: 'complaint_as_fact',
        title,
        status: 'observed',
        basis: 'ai_interpretation',
        strength: tentative ? 'tentative' : 'established',
        ...(tentative ? { statusLabel: 'Possible pattern, limited evidence' } : {}),
        observed: `${insight.observed} The complaint is reported by ${sourceWord(sources)} of the ${sourcesRead} read.`,
        evidence: insightList(index, insight.evidenceIds),
        whyItMatters: insight.whyItMatters,
        implication: insight.implication,
      });
    } else {
      const themes = core.perception.complaints.length;
      checks.push({
        id: 'complaint_as_fact',
        title,
        status: 'not_observed',
        basis: 'ai_interpretation',
        evidence: [],
        observed: `An AI model compared what Gemini said about ${meta.brand} with ${themes} complaint theme${themes === 1 ? '' : 's'} from the evidence and matched none of them. That is one model's reading of this sample, not proof that Gemini never repeats a complaint.`,
      });
    }
  }

  // 3. Outdated or incorrect details
  {
    const title = 'Does Gemini describe discontinued, outdated or incorrect details?';
    const claims = data.claims;
    const checked = (claims?.claims ?? []).filter((c) => c.verdict !== 'unverified');
    const contradicted = (claims?.claims ?? []).filter((c) => c.verdict === 'contradicted' && c.evidenceId);
    if (!claims || claims.claims.length === 0) {
      checks.push({ id: 'outdated_details', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason: claims?.note ?? 'Gemini made no checkable statements about the brand.' });
    } else if (contradicted.length > 0) {
      const evidence: InsightEvidence[] = [];
      for (const claim of contradicted.slice(0, 2)) {
        evidence.push(...insightList(index, [claim.origin]));
        if (claim.url) evidence.push({ id: claim.evidenceId ?? '', label: `Source contradicting: "${clip(claim.text, 80)}"`, url: claim.url, quote: claim.quote });
      }
      checks.push({
        id: 'outdated_details',
        title,
        status: 'observed',
        basis: 'ai_interpretation',
        strength: 'established',
        observed: `Gemini stated: ${contradicted.slice(0, 2).map((c) => `"${c.text}"`).join('; ')}. A retrieved source says otherwise.`,
        evidence,
        whyItMatters: 'A shopper relying on this answer would be given a detail that a retrieved source contradicts.',
        implication: "Check which version is current. If the source is right, stating the correct detail plainly on the brand's own pages is a reasonable first step. This audit cannot show whether that would change Gemini's answer.",
      });
    } else if (checked.length === 0) {
      checks.push({ id: 'outdated_details', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason: "None of Gemini's statements could be confirmed or contradicted by the sources retrieved." });
    } else {
      checks.push({ id: 'outdated_details', title, status: 'not_observed', basis: 'ai_interpretation', evidence: [], observed: `${checked.length} of Gemini's statements could be checked against a source and none was contradicted. ${claims.claims.length - checked.length} could not be checked.` });
    }
  }

  // 4. Narrow range. Decided by counting. Two lists are involved and they are never merged:
  //   - GEMINI'S LIST: what the model says the brand sells. It comes from the one place this audit
  //     asks Gemini directly (its description of the brand includes "the product types or lines
  //     you believe it sells"). It is the model's belief and is not checked against the site.
  //   - THE SITE'S RANGE: product lines found on the brand's own pages, each kept only if its
  //     quote was found on the page. It is a sample of the site (pages a search surfaced).
  {
    const title = 'Is the brand known to Gemini for one product while its wider range is ignored?';
    const lines = analysis?.productLines ?? [];
    const siteName = data.site?.domain ?? "the brand's own site";
    const listed: string[] = [];
    for (const product of profile?.products ?? []) {
      const name = product.trim();
      if (name !== '' && !listed.some((existing) => existing.toLowerCase() === name.toLowerCase())) listed.push(name);
    }
    const SITE_LINES_SHOWN = 5;
    const listEvidence: InsightEvidence[] =
      listed.length > 0
        ? [{ id: 'GP', label: `Gemini's list (what the model says ${meta.brand} sells; not checked against the site): ${listed.join(', ')}` }]
        : [];
    const siteEvidence: InsightEvidence[] = lines
      .slice(0, SITE_LINES_SHOWN)
      .map((line) => ({ id: line.ref.pageId, label: `Found on ${siteName}: ${line.name}`, url: line.ref.url, quote: line.ref.quote }));
    if (lines.length > SITE_LINES_SHOWN) {
      siteEvidence.push({ id: 'site-range-more', label: `Found on ${siteName}: ${lines.length - SITE_LINES_SHOWN} more product lines, listed under "Product lines found on the brand's own site"` });
    }
    const twoLists = 'Two separate lists are set side by side here and never merged.';
    const siteRange = `The site's range: ${lines.length} product lines were found on the pages read from ${siteName}, each confirmed by a quote from a page. These are not a verified inventory of the complete range.`;
    const cannot = (reason: string, evidence: InsightEvidence[] = []) =>
      checks.push({ id: 'narrow_range', title, status: 'cannot_assess', basis: 'computed', evidence, reason });

    if (!profile) {
      cannot("Gemini's description of the brand could not be retrieved in this audit, so there is no list from Gemini to set against the site's range.");
    } else if (!profile.recognized) {
      cannot("Gemini did not recognise the brand in this category, so it listed no products to set against the site's range.");
    } else if (listed.length === 0) {
      cannot(`Asked what ${meta.brand} sells, Gemini listed no products, so this audit has no evidence of how much of the range it recognises.`);
    } else if (lines.length < 3) {
      cannot(
        `Fewer than three product lines could be confirmed on the pages read from ${siteName} (${lines.length} found), so there is no verified site range to set Gemini's list against.`,
        listEvidence,
      );
    } else if (listed.length === 1) {
      checks.push({
        id: 'narrow_range',
        title,
        status: 'observed',
        basis: 'computed',
        strength: 'established',
        observed: `${twoLists} Gemini's list: asked what ${meta.brand} sells, Gemini named one product type (${listed[0]}). ${siteRange} This is one answer from one model, asked once, and the pages read are a sample of the site.`,
        evidence: [...listEvidence, ...siteEvidence],
        whyItMatters: 'In this answer Gemini described the brand through a single product, while the pages read from the site show more.',
        implication: "If the other lines were described plainly on the brand's own pages and in independent coverage, a later audit could show whether Gemini lists more of them. This audit did not test that.",
      });
    } else {
      checks.push({
        id: 'narrow_range',
        title,
        status: 'not_observed',
        basis: 'computed',
        observed: `${twoLists} Gemini's list: asked what ${meta.brand} sells, Gemini named ${listed.length} product types. ${siteRange} Gemini named more than one, so this answer does not describe the brand through a single product. The lists are not matched item by item (Gemini names types of product in its own words, while the site list uses the names on the pages), so this does not show that every line is recognised.`,
        evidence: [...listEvidence, ...siteEvidence],
      });
    }
  }

  // 5. Discussion volume vs AI visibility (computed)
  {
    const title = 'Is there a mismatch between how much people discuss the brand and how often Gemini recommends it?';
    const v = core.visibility.metric;
    const detail = core.perception.detail;
    if (v.status !== 'scored' || !data.labels?.available) {
      checks.push({
        id: 'volume_vs_visibility',
        title,
        status: 'cannot_assess',
        basis: 'computed',
        evidence: [],
        reason: v.status !== 'scored' ? 'Gemini API recommendation visibility could not be scored.' : 'Audience evidence could not be analysed.',
      });
    } else {
      const customers = detail.byVoice.customer;
      const evidence: InsightEvidence[] = [
        { id: 'visibility', label: `Gemini API recommendation visibility: ${v.score} (${core.visibility.detail.counted} questions counted)` },
        { id: 'discussion', label: `${customers} customer opinions and ${detail.raw.counted} counted opinions in total, from ${detail.uniqueSources} unique sources` },
      ];
      if (customers >= 15 && v.score < 25) {
        checks.push({
          id: 'volume_vs_visibility',
          title,
          status: 'observed',
          basis: 'computed',
          strength: 'established',
          observed: `This audit found ${customers} customer opinions about ${meta.brand}, yet Gemini rarely recommended it in these answers (visibility ${v.score}).`,
          evidence,
          whyItMatters: 'People discuss the brand, but Gemini seldom names it for these questions. The audit shows the two facts side by side. It cannot show why they differ.',
          implication: 'If the reason is that the model has little independent, readable material to draw on, more of it (reviews on independent sites, clear product pages, third-party coverage) might help. That is a hypothesis this audit did not test.',
        });
      } else if (v.score >= 60 && detail.raw.counted < 8) {
        checks.push({
          id: 'volume_vs_visibility',
          title,
          status: 'observed',
          basis: 'computed',
          strength: 'established',
          observed: `Gemini recommended ${meta.brand} often in these answers (visibility ${v.score}), but this audit found little independent customer discussion (${detail.raw.counted} counted opinions).`,
          evidence,
          whyItMatters: 'The recommendation is not matched by much customer experience that a shopper could read for themselves, at least in what this audit found.',
          implication: 'If more customer reviews were visible, a later audit could show whether sentiment supports the recommendation. This audit cannot say either way.',
        });
      } else {
        checks.push({
          id: 'volume_vs_visibility',
          title,
          status: 'not_observed',
          basis: 'computed',
          observed: `Visibility is ${v.score} with ${customers} customer opinions found: neither mismatch threshold was met (15+ customer opinions with visibility under 25, or visibility 60+ with fewer than 8 counted opinions).`,
          evidence,
        });
      }
    }
  }

  // 6. Source footprint. The audit can count where the brand is discussed. It cannot see which
  // sources Gemini relies on, so this question is never answered either way.
  {
    const title = 'Is the brand missing from sources that AI and search rely on?';
    const searches = meta.searches;
    const discussionSearch = searches.find((s) => s.purpose === 'Customer discussions');
    const reviewSearch = searches.find((s) => s.purpose.startsWith('Independent reviews'));
    const audienceItems = data.audience?.items ?? [];
    const discussions = audienceItems.filter((i) => i.kind === 'discussion').length;
    const reviewDomains = new Set(audienceItems.filter((i) => i.kind === 'review').map((i) => i.domain)).size;
    const youtube = data.youtube;
    const families: { label: string; checked: boolean; present: boolean; text: string }[] = [
      {
        label: 'Reddit-indexed discussions',
        checked: discussionSearch?.ok === true,
        present: discussions > 0,
        text: `Reddit-indexed threads naming the brand: ${discussions}`,
      },
      {
        label: 'independent reviews and publications',
        checked: reviewSearch?.ok === true,
        present: reviewDomains > 0,
        text: `Independent sites with a page naming the brand: ${reviewDomains}`,
      },
      {
        label: 'YouTube videos',
        checked: youtube !== undefined && (youtube.status === 'ok' || youtube.status === 'partial'),
        present: (youtube?.videos.length ?? 0) > 0,
        text: `YouTube videos naming the brand: ${youtube?.videos.length ?? 0}`,
      },
    ];
    const checkedFamilies = families.filter((f) => f.checked);
    const missing = checkedFamilies.filter((f) => !f.present);
    const evidence: InsightEvidence[] = families.map((f, i) => ({ id: `footprint${i + 1}`, label: f.checked ? `Measured: ${f.text}` : `${f.label}: could not be checked in this audit` }));
    if (checkedFamilies.length === 0) {
      checks.push({ id: 'source_footprint', title, status: 'cannot_assess', basis: 'computed', evidence: [], reason: 'None of the source searches completed.' });
    } else {
      const absent =
        missing.length > 0
          ? ` No ${missing.map((f) => f.label).join(' and no ')} naming ${meta.brand} turned up in this audit's one search of each source type, which is a thin footprint there, not proof of absence.`
          : '';
      checks.push({
        id: 'source_footprint',
        title,
        status: 'cannot_assess',
        basis: 'computed',
        evidence,
        reason: `This audit cannot tell which sources Gemini relies on: its answers here carry no citations, and web search was switched off. What it did measure is where ${meta.brand} is publicly discussed, shown below. Being present in those places does not show that Gemini draws on them.${absent}`,
      });
    }
  }

  // 7. Positioning vs experience. An AI model sets every complaint theme against every verified
  // statement from the brand's own site; the code checks both sides exist and grades the result
  // by how many separate sources report the complaint.
  {
    const title = "Does the brand's positioning contradict what customers experience?";
    const statements = siteStatements(core);
    const complaints = core.perception.complaints;
    const insight = firstInsight('positioning_contradiction');
    if (!insightsAvailable || statements.length === 0 || complaints.length === 0) {
      const reason =
        statements.length === 0
          ? "No positioning statement could be verified from the brand's own site."
          : complaints.length === 0
            ? 'No customer complaint appeared in at least two sources, so there was nothing to compare against.'
            : 'The comparison step did not run for this audit.';
      checks.push({ id: 'positioning_contradiction', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason });
    } else if (insight) {
      const audienceIds = insight.evidenceIds.filter((id) => index.family(id) === 'audience');
      const sources = index.audienceSources(audienceIds);
      const tentative = sources < ESTABLISHED_MIN_SOURCES;
      const stated = insight.siteStatement;
      const statementEvidence: InsightEvidence[] = stated
        ? [{ id: stated.ref.pageId, label: `Brand site states: "${stated.statement}"`, url: stated.ref.url, quote: stated.ref.quote }]
        : insightList(index, insight.evidenceIds.filter((id) => index.family(id) === 'site'));
      checks.push({
        id: 'positioning_contradiction',
        title,
        status: 'observed',
        basis: 'ai_interpretation',
        strength: tentative ? 'tentative' : 'established',
        ...(tentative ? { statusLabel: 'Potential tension, limited evidence' } : {}),
        observed: tentative
          ? `${insight.observed} This rests on ${sourceWord(sources)} of the ${sourcesRead} read, so it is a potential tension, not a verified contradiction.`
          : `${insight.observed} ${sourceWord(sources)} of the ${sourcesRead} read report it.`,
        evidence: [...statementEvidence, ...insightList(index, audienceIds)],
        whyItMatters: "The brand's own site makes a promise that some customers in this sample say their experience did not match.",
        implication: 'Read the cited reports before acting on this, and check whether they concern one product or a recent change. This audit cannot show how common the experience is among all customers.',
      });
    } else {
      checks.push({
        id: 'positioning_contradiction',
        title,
        status: 'not_observed',
        basis: 'ai_interpretation',
        evidence: [],
        observed: `An AI model set ${complaints.length} complaint theme${complaints.length === 1 ? '' : 's'} against ${statements.length} statement${statements.length === 1 ? '' : 's'} from the brand's own site and connected none of them. That is one model's reading of this sample, not proof that no tension exists.`,
      });
    }
  }

  return checks;
}

const LIMITATIONS = [
  'Scores are estimates built from a sample of public information gathered at the time shown. They are not a census and will change as the sources change.',
  'Gemini API recommendation visibility measures one Gemini model through the developer API, without live web search. It does not reproduce the consumer Gemini app and says nothing about other AI assistants.',
  'Each question was put to Gemini once. AI answers vary from run to run.',
  'Reddit content comes only from threads surfaced by a web search service. Reddit, Instagram and TikTok were not accessed directly.',
  'YouTube comments are a small sample of top comments on a few videos, retrieved through the official YouTube Data API.',
  "The content gap is judged from pages a search surfaced, not a full crawl of the brand's site: a page that was not retrieved cannot be credited.",
  'Sponsorship is flagged only where it is disclosed in the text or flagged by YouTube. Undisclosed sponsorship cannot be detected.',
  'Labels, themes and interpretations are written by an AI model and then checked against the retrieved text. The scores are calculated in code from those labels.',
  'A complaint theme shows that some customers reported something. It does not show how common it is among all customers, and it is not evidence of a safety or quality problem.',
  'No sales, conversion, loyalty or trust data was measured. Implications and expected results in this report are hypotheses to test, not outcomes.',
  'Sentences the AI model writes about complaints, implications and recommendations pass through a wording screen that replaces known overclaiming phrasings (a stated cause, a generalisation, a promised business result). The screen is a list of phrasings. It reduces overclaiming and does not detect every unsupported causal claim, so read each interpretation and recommendation against the evidence cited beside it.',
];

/** The model name the API itself reported most often in this audit's answers. */
function reportedModel(meta: JobMeta, data: JobData): string {
  const counts = new Map<string, number>();
  const all = [...(data.answers ?? []), ...(data.signature ? [data.signature] : [])];
  for (const answer of all) {
    if (answer.status === 'answered' && answer.model) counts.set(answer.model, (counts.get(answer.model) ?? 0) + 1);
  }
  let best = meta.model;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

/** Why this model: stated from the limits this site is configured with, nothing assumed. */
function modelNote(configured: string): string {
  const perDay = config.geminiRpd();
  if (perDay === null) return `This site uses the Gemini API free tier and is configured to request ${configured}.`;
  return `This site uses the Gemini API free tier and is configured to request ${configured}, because that model's free daily allowance on this site's Google project (${perDay} requests) covers the roughly ${GEMINI_REQUESTS_PER_AUDIT} requests one audit makes. A model with a smaller free allowance could not complete an audit.`;
}

/**
 * The brand name as it should be shown. A name the visitor typed with deliberate capitals is
 * kept. Otherwise the spelling used most often by Gemini, the brand's own page titles and the
 * source titles wins, so "cerave" becomes "CeraVe" and "e.l.f." stays lower case.
 */
function displayBrandName(meta: JobMeta, data: JobData): string {
  if (meta.brandCasing !== 'derived') return meta.brand;
  const texts: string[] = [];
  if (data.profile?.description) texts.push(data.profile.description);
  for (const answer of data.answers ?? []) if (answer.answer) texts.push(answer.answer);
  if (data.signature?.answer) texts.push(data.signature.answer);
  for (const page of data.site?.pages ?? []) texts.push(page.title);
  for (const item of data.audience?.items ?? []) texts.push(item.title);
  for (const video of data.youtube?.videos ?? []) texts.push(video.title);
  return mostCommonCasing(meta.brand, texts) ?? meta.brand;
}

export function buildReport(job: JobMeta, data: JobData): Report {
  // Everything below uses the display spelling of the brand. Matching ignores capitalisation.
  const meta: JobMeta = { ...job, brand: displayBrandName(job, data) };
  const core = computeCore(meta, data);
  const index = buildEvidenceIndex(data, core);
  const checks = betweenTheLines(meta, data, core, index);
  const synthesis = data.synthesis;

  // A checklist item the site analysis returned no verdict for, or whose evidence could not be tied
  // to the question, is LEFT OUT of the content gap score, and the score's confidence is lowered.
  // A missing or incomplete model answer is not evidence that the site fails to address the question.
  const checklistItems = core.contentGap.detail.checklist;
  const unanswered = checklistItems.filter((item) => item.unanswered).length;
  const warnings = [...meta.warnings];
  if (unanswered > 0) {
    warnings.push(
      `The analysis of the brand's site returned no verdict for ${unanswered} of the ${checklistItems.length} checklist items. They are left out of the content gap score, and its confidence is lowered, because a missing answer does not show that the site fails to address them.`,
    );
  }
  const uncertain = checklistItems.filter((item) => item.relevance === 'uncertain').length;
  if (uncertain > 0) {
    warnings.push(
      `For ${uncertain} of the ${checklistItems.length} checklist items, the evidence found on the site could not be tied to the question (for example, it may be about a different product, or the analysis did not say how it relates). They are left out of the content gap score, and its confidence is lowered.`,
    );
  }

  const fixes = [...(synthesis?.fixes ?? [])].sort((a, b) => a.priority - b.priority).slice(0, 5);
  let fixesNote: string | undefined;
  if (brandNotRecognised(data.identity) && (!synthesis || !synthesis.fixesAvailable)) {
    fixesNote = 'No recommendations were made: the brand was not recognised in this category and there was not enough verified evidence about it to rest any on.';
  } else if (!synthesis || !synthesis.fixesAvailable) fixesNote = 'Recommendations could not be generated for this audit.';
  else if (fixes.length < 5) {
    fixesNote = `Only ${fixes.length} recommendation${fixes.length === 1 ? '' : 's'} passed this audit's rules, so only ${fixes.length === 1 ? 'that one is' : 'those are'} shown. A recommendation must cite evidence found in this audit and must not assert a cause or a business result.`;
  }

  // Evidence shown in the report: everything labeled relevant or cited, the site pages, and claim sources.
  const labelById = new Map((data.labels?.labels ?? []).map((l) => [l.id, l]));
  const cited = new Set<string>();
  for (const theme of [...core.perception.praise, ...core.perception.complaints]) theme.evidenceIds.forEach((id) => cited.add(id));
  for (const note of core.perception.advocacy) cited.add(note.evidenceId);
  for (const d of synthesis?.disagreements ?? []) [...d.audienceEvidenceIds, ...d.geminiEvidenceIds].forEach((id) => cited.add(id));
  for (const check of checks) check.evidence.forEach((e) => cited.add(e.id));
  for (const fix of fixes) fix.evidenceIds.forEach((id) => cited.add(id));

  const evidence: EvidenceItem[] = [];
  for (const item of core.items) {
    if (labelById.get(item.id)?.relevant === true || cited.has(item.id) || (item.sponsored?.length ?? 0) > 0) {
      evidence.push({ ...item, text: clip(item.text, 420) });
    }
  }
  for (const page of readablePages(data.site?.pages ?? [])) {
    evidence.push({
      id: page.id,
      kind: 'site_page',
      url: page.url,
      domain: data.site?.domain ?? '',
      title: page.title,
      text: clip(page.text, 260),
      sourceUrl: page.url,
    });
  }
  for (const source of data.claims?.sources ?? []) evidence.push({ ...source, text: clip(source.text, 320) });

  if (fixes.length > 0 && brandNotRecognised(data.identity)) {
    fixesNote = `${fixesNote ? `${fixesNote} ` : ''}Because Gemini did not recognise the brand in this category, these recommendations rest only on audience and website evidence checked as being about the brand. None draws on the brands Gemini recommended.`;
  }

  // What was found but not used, so the reader can see it and judge: results that used a similar name, and
  // items that were read and judged to be about a different business.
  const setAside: SetAsideEvidence[] = [];
  for (const entry of [...(data.audience?.setAside ?? []), ...(data.youtube?.setAside ?? [])]) addSetAside(setAside, entry);
  const mixedIds = new Set((data.labels?.labels ?? []).filter((label) => label.mixedBrand === true).map((label) => label.id));
  for (const item of differentBusinessItems(data)) {
    const reason = mixedIds.has(item.id) ? mixedByReaderReason(meta.brand) : 'Read and judged to be about a different business that has a similar name.';
    addSetAside(setAside, { title: clip(item.title, 120), url: item.sourceUrl || item.url, domain: item.domain, reason });
  }

  const youtube = data.youtube;
  const visibilityDetail = core.visibility.detail;
  const model = reportedModel(meta, data);

  return {
    version: 7,
    id: meta.id,
    brand: meta.brand,
    brandKey: meta.brandKey,
    category: { id: meta.categoryId, label: meta.categoryLabel },
    createdAt: new Date().toISOString(),
    model,
    tier: meta.tier,
    overallConfidence: overallConfidence([
      { name: 'Gemini API recommendation visibility', metric: core.visibility.metric },
      { name: 'audience perception', metric: core.perception.metric },
      { name: 'content gap severity', metric: core.contentGap.metric },
    ]),
    visibility: core.visibility,
    ...(data.identity ? { identity: identitySection(data.identity, meta.brand, meta.categoryLabel, setAside) } : {}),
    brandProfile: data.profile ?? null,
    signatureAnswer: data.signature ?? null,
    answers: data.answers ?? [],
    perception: core.perception,
    contentGap: core.contentGap,
    claims: data.claims?.claims ?? [],
    claimsNote: data.claims?.note,
    competitors: competitorSection(meta, data, core),
    disconnect: disconnectSection(data, core),
    betweenTheLines: checks,
    fixes,
    fixesNote,
    evidence,
    methodology: {
      auditedAt: new Date().toISOString(),
      model,
      modelConfigured: meta.model,
      modelNote: modelNote(meta.model),
      questionBankVersion: QUESTION_BANK_VERSION,
      tier: meta.tier,
      questions: {
        planned: visibilityDetail.planned,
        answered: visibilityDetail.answered,
        failed: visibilityDetail.failed,
        excluded: visibilityDetail.excluded,
        counted: visibilityDetail.counted,
      },
      searches: meta.searches,
      tavilyCreditsUsed: meta.creditsSpent,
      geminiRequests: meta.geminiRequests,
      youtube: {
        status: youtube?.status ?? 'skipped',
        videos: youtube?.videos.length ?? 0,
        comments: youtube?.comments.length ?? 0,
        note: youtube?.note,
      },
      sitePages: core.contentGap.detail.pagesRead,
      unavailable: warnings,
      limitations: LIMITATIONS,
    },
    warnings,
  };
}
