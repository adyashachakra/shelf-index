import 'server-only';
import { readablePages } from '../audit/evidence-builders';
import type { JobData, JobMeta } from '../audit/job';
import { QUESTION_BANK_VERSION } from '../audit/questions';
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
} from '../types';
import { computeCore, type Core } from './core';
import { buildEvidenceIndex, describePlacement, type EvidenceIndex } from './digest';

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

  for (const name of names) {
    const v = visibilityOverQuestions(name, answers, core.countedQuestionIds);
    let visibility: Metric;
    if (brandVisibility.status !== 'scored' || v.score === null || v.counted < MIN_COUNTED_QUESTIONS) {
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
    if (meta.tier !== 'full') {
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

  const note =
    names.length === 0
      ? 'Gemini did not recommend other brands often enough to name competitors.'
      : 'Competitors are the brands Gemini recommended most across the same questions. Their sentiment comes from one search each, a lighter sample than the audited brand received. Content coverage is not measured for competitors in V1, and nothing is estimated in its place.';
  return { rows, note };
}

function disconnectSection(data: JobData, core: Core): DisconnectSection {
  const disagreements = data.synthesis?.disagreements ?? [];
  const note = data.synthesis?.insightsAvailable === false ? 'The comparison of specific points could not be generated for this audit.' : undefined;
  const v = core.visibility.metric;
  const p = core.perception.metric;
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

function betweenTheLines(meta: JobMeta, data: JobData, core: Core, index: EvidenceIndex): BetweenLinesCheck[] {
  const checks: BetweenLinesCheck[] = [];
  const synthesis = data.synthesis;
  const insightsAvailable = synthesis?.insightsAvailable === true;
  const profile = data.profile;
  const analysis = data.siteAnalysis;
  const answers = data.answers ?? [];
  const brandNamedSomewhere =
    (profile?.recognized ?? false) || answers.some((a) => a.status === 'answered' && placementOf(a, meta.brand).kind !== 'absent');
  const firstInsight = (pattern: 'complaint_as_fact' | 'narrow_range' | 'positioning_contradiction') =>
    (synthesis?.insights ?? []).find((i) => i.pattern === pattern);

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
          observed: `The brand's site leads with "${claim.claim}". Asked "${signature.question}", Gemini's first recommendation was ${first ?? 'not a specific brand'}; ${meta.brand} was ${describePlacement(placement)}.`,
          evidence,
          whyItMatters: 'A shopper who asks an AI assistant about the very thing this brand claims to be best at is pointed to someone else first.',
          implication: `Make "${claim.claim}" easy to attribute to ${meta.brand} outside its own site: comparison content, independent reviews and plain-language pages that state it directly.`,
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
          ? 'No recurring customer complaint was found to compare against.'
          : 'The comparison step did not run for this audit.';
      checks.push({ id: 'complaint_as_fact', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason });
    } else if (insight) {
      checks.push({
        id: 'complaint_as_fact',
        title,
        status: 'observed',
        basis: 'ai_interpretation',
        observed: insight.observed,
        evidence: insightList(index, insight.evidenceIds),
        whyItMatters: insight.whyItMatters,
        implication: insight.implication,
      });
    } else {
      checks.push({ id: 'complaint_as_fact', title, status: 'not_observed', basis: 'ai_interpretation', evidence: [], observed: "Nothing in Gemini's answers could be tied to a recurring complaint in the evidence." });
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
        observed: `Gemini stated: ${contradicted.slice(0, 2).map((c) => `"${c.text}"`).join('; ')}. A retrieved source says otherwise.`,
        evidence,
        whyItMatters: 'Shoppers act on what the model tells them. A wrong detail about products, prices or availability costs sales or creates disappointed customers.',
        implication: 'Correct the record where models learn from: update the brand site and product pages so the current facts are stated plainly, and fix stale listings elsewhere.',
      });
    } else if (checked.length === 0) {
      checks.push({ id: 'outdated_details', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason: "None of Gemini's statements could be confirmed or contradicted by the sources retrieved." });
    } else {
      checks.push({ id: 'outdated_details', title, status: 'not_observed', basis: 'ai_interpretation', evidence: [], observed: `${checked.length} of Gemini's statements were checked against sources and none was contradicted.` });
    }
  }

  // 4. Narrow range
  {
    const title = 'Is the brand known to Gemini for one product while its wider range is ignored?';
    const lines = analysis?.productLines ?? [];
    const insight = firstInsight('narrow_range');
    if (!insightsAvailable || lines.length < 3 || !brandNamedSomewhere) {
      const reason = !brandNamedSomewhere
        ? 'Gemini said nothing about the brand to compare against.'
        : lines.length < 3
          ? "Fewer than three product lines could be verified from the brand's site, so the range cannot be compared."
          : 'The comparison step did not run for this audit.';
      checks.push({ id: 'narrow_range', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason });
    } else if (insight) {
      checks.push({
        id: 'narrow_range',
        title,
        status: 'observed',
        basis: 'ai_interpretation',
        observed: insight.observed,
        evidence: insightList(index, insight.evidenceIds),
        whyItMatters: insight.whyItMatters,
        implication: insight.implication,
      });
    } else {
      checks.push({ id: 'narrow_range', title, status: 'not_observed', basis: 'ai_interpretation', evidence: [], observed: `The site shows ${lines.length} product lines and nothing indicated Gemini confines the brand to one of them.` });
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
        { id: 'discussion', label: `${customers} customer opinions and ${detail.raw.counted} counted opinions in total, from ${detail.uniqueSources} sources` },
      ];
      if (customers >= 15 && v.score < 25) {
        checks.push({
          id: 'volume_vs_visibility',
          title,
          status: 'observed',
          basis: 'computed',
          observed: `Customers talk about ${meta.brand} (${customers} customer opinions found), yet Gemini rarely recommends it (visibility ${v.score}).`,
          evidence,
          whyItMatters: 'Real demand exists but the model is not reflecting it, so AI-assisted shoppers are steered elsewhere.',
          implication: 'Turn existing customer conversation into sources a model can learn from: reviews on independent sites, clear product pages and third-party coverage.',
        });
      } else if (v.score >= 60 && detail.raw.counted < 8) {
        checks.push({
          id: 'volume_vs_visibility',
          title,
          status: 'observed',
          basis: 'computed',
          observed: `Gemini recommends ${meta.brand} often (visibility ${v.score}) but little independent customer discussion was found (${detail.raw.counted} counted opinions).`,
          evidence,
          whyItMatters: 'AI visibility that is not backed by visible customer experience is fragile and hard for shoppers to verify.',
          implication: 'Encourage and surface real customer reviews so the recommendation is supported by evidence people can read.',
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

  // 6. Source footprint (computed)
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
    const evidence: InsightEvidence[] = families.map((f, i) => ({ id: `footprint${i + 1}`, label: f.checked ? f.text : `${f.label}: could not be checked in this audit` }));
    if (checkedFamilies.length === 0) {
      checks.push({ id: 'source_footprint', title, status: 'cannot_assess', basis: 'computed', evidence: [], reason: 'None of the source searches completed.' });
    } else if (missing.length > 0) {
      checks.push({
        id: 'source_footprint',
        title,
        status: 'observed',
        basis: 'computed',
        observed: `Our searches found no ${missing.map((f) => f.label).join(' and no ')} naming ${meta.brand}. This reflects one search per source type, so it shows a thin footprint, not proof of absence.`,
        evidence,
        whyItMatters: 'Models and search engines lean on independent, public sources. A brand that is absent there has little for them to draw on.',
        implication: `Prioritise presence in the missing source types: ${missing.map((f) => f.label).join(', ')}.`,
      });
    } else {
      checks.push({ id: 'source_footprint', title, status: 'not_observed', basis: 'computed', observed: 'The brand appeared in every source type that could be checked.', evidence });
    }
  }

  // 7. Positioning vs experience
  {
    const title = "Does the brand's positioning contradict what customers experience?";
    const positioning = analysis?.positioning ?? [];
    const insight = firstInsight('positioning_contradiction');
    if (!insightsAvailable || positioning.length === 0 || core.perception.complaints.length === 0) {
      const reason =
        positioning.length === 0
          ? "No positioning statement could be verified from the brand's own site."
          : core.perception.complaints.length === 0
            ? 'No recurring customer complaint was found to compare against.'
            : 'The comparison step did not run for this audit.';
      checks.push({ id: 'positioning_contradiction', title, status: 'cannot_assess', basis: 'ai_interpretation', evidence: [], reason });
    } else if (insight) {
      checks.push({
        id: 'positioning_contradiction',
        title,
        status: 'observed',
        basis: 'ai_interpretation',
        observed: insight.observed,
        evidence: insightList(index, insight.evidenceIds),
        whyItMatters: insight.whyItMatters,
        implication: insight.implication,
      });
    } else {
      checks.push({ id: 'positioning_contradiction', title, status: 'not_observed', basis: 'ai_interpretation', evidence: [], observed: "No recurring complaint could be tied to a statement on the brand's site." });
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
];

export function buildReport(meta: JobMeta, data: JobData): Report {
  const core = computeCore(meta, data);
  const index = buildEvidenceIndex(data, core);
  const checks = betweenTheLines(meta, data, core, index);
  const synthesis = data.synthesis;

  const fixes = [...(synthesis?.fixes ?? [])].sort((a, b) => a.priority - b.priority).slice(0, 5);
  let fixesNote: string | undefined;
  if (!synthesis || !synthesis.fixesAvailable) fixesNote = 'Recommendations could not be generated for this audit.';
  else if (fixes.length < 5) {
    fixesNote = `Only ${fixes.length} recommendation${fixes.length === 1 ? '' : 's'} could be tied to evidence from this audit, so only ${fixes.length === 1 ? 'that one is' : 'those are'} shown.`;
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

  const youtube = data.youtube;
  const visibilityDetail = core.visibility.detail;
  const model = meta.model;

  return {
    version: 1,
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
      unavailable: meta.warnings,
      limitations: LIMITATIONS,
    },
    warnings: meta.warnings,
  };
}
