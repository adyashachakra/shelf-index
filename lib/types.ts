// Shared data shapes. Safe to import from both server and browser code (types only).

export type CategoryId =
  | 'skincare'
  | 'fashion'
  | 'homeware'
  | 'cookware'
  | 'beverages'
  | 'agencies'
  | 'other';

export type Tier = 'full' | 'reduced' | 'minimal';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

// ---------- Metrics ----------

export interface ScoredMetric {
  status: 'scored';
  score: number;
  confidence: ConfidenceLevel;
  confidenceReason: string;
}
export interface InsufficientMetric {
  status: 'insufficient';
  reason: string;
}
export interface NotMeasuredMetric {
  status: 'not_measured';
  reason: string;
}
export type Metric = ScoredMetric | InsufficientMetric;
export type MetricOrSkipped = Metric | NotMeasuredMetric;

// ---------- Gemini answers ----------

export interface CategoryQuestion {
  id: string;
  intent: string;
  text: string;
}

export interface AnswerRecommendation {
  brand: string;
  why: string;
}
export interface AnswerMention {
  brand: string;
  stance: 'neutral' | 'cautioned';
}
export interface GeminiAnswer {
  /** Evidence id: G1..G8 for category questions, GS for the signature-claim question. */
  id: string;
  questionId: string;
  question: string;
  intent: string;
  status: 'answered' | 'failed';
  failureReason?: string;
  answer?: string;
  recommendations?: AnswerRecommendation[];
  alsoMentioned?: AnswerMention[];
  model?: string;
  askedAt?: string;
}

export type Placement =
  | { kind: 'recommended'; position: number }
  | { kind: 'mentioned' }
  | { kind: 'cautioned' }
  | { kind: 'absent' };

export interface VisibilityRow {
  answerId: string;
  questionId: string;
  question: string;
  intent: string;
  state: 'counted' | 'excluded' | 'no_answer';
  placement?: Placement;
  credit?: number;
  topBrands: string[];
  why?: string;
  exclusionReason?: string;
  failureReason?: string;
}

export interface VisibilityDetail {
  planned: number;
  answered: number;
  failed: number;
  excluded: number;
  counted: number;
  creditSum: number;
  appearances: number;
  averagePosition: number | null;
  rows: VisibilityRow[];
}

export interface BrandProfile {
  recognized: boolean;
  description: string;
  knownFor: string[];
  products: string[];
  pricePositioning: string;
  officialDomain: string;
  strengths: string[];
  criticisms: string[];
  claims: { text: string; type: string; polarity: 'positive' | 'negative' | 'neutral' }[];
  model?: string;
}

// ---------- Evidence ----------

export type EvidenceKind =
  | 'discussion'
  | 'review'
  | 'youtube_video'
  | 'youtube_comment'
  | 'site_page'
  | 'claim_source'
  | 'competitor_source';

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  url: string;
  domain: string;
  title: string;
  text: string;
  /** The thread, page or video this item belongs to (for a comment: its video). */
  sourceUrl: string;
  /** Sponsorship or affiliate disclosure signals found in the source, if any. */
  sponsored?: string[];
  channel?: string;
  likeCount?: number;
  competitor?: string;
}

export type Voice = 'customer' | 'creator' | 'publication' | 'brand' | 'unclear';
export type Sentiment = 'positive' | 'mixed' | 'negative' | 'neutral';

export interface EvidenceLabel {
  id: string;
  relevant: boolean;
  voice: Voice;
  sentiment: Sentiment;
}

/** What a theme is about: one named product, the brand in general, or not clear from the evidence. */
export type ThemeScope = 'product' | 'brand' | 'unclear';

export interface Theme {
  label: string;
  summary: string;
  evidenceIds: string[];
  quote?: { evidenceId: string; text: string };
  /** Individual excerpts or comments that show the theme. */
  itemCount: number;
  /** Distinct threads, pages or videos those items come from. */
  sourceCount: number;
  scope: ThemeScope;
  /** The product concerned, kept only when its name appears in the cited evidence. */
  product?: string;
}
export interface Concern {
  id: string;
  label: string;
  evidenceIds: string[];
}
export interface AdvocacyNote {
  evidenceId: string;
  note: string;
}

export interface SentimentCounts {
  positive: number;
  mixed: number;
  negative: number;
}

export type CountedVoice = 'customer' | 'creator' | 'publication' | 'unclear';

/** Counts per kind of audience material: thread excerpts, review pages, videos, individual comments. */
export interface SampleCounts {
  discussions: number;
  reviews: number;
  videos: number;
  comments: number;
}

export interface PerceptionDetail {
  itemsRetrieved: number;
  itemsLabeled: number;
  /** Unweighted item counts. */
  raw: SentimentCounts & {
    counted: number;
    neutral: number;
    irrelevant: number;
    brandCreated: number;
  };
  /** Weighted counts used in the score (customer 1.0; creator, publication, unclear 0.5). */
  weighted: SentimentCounts & { total: number };
  /** Distinct threads, pages and videos among counted items. */
  uniqueSources: number;
  /** Distinct threads, pages and videos among every item that is about the brand, counted or not. */
  sourcesAboutBrand: number;
  uniqueDomains: string[];
  /** Voices present among counted items. */
  sourceTypes: CountedVoice[];
  byVoice: Record<CountedVoice, number>;
  /** Same formula on one voice only; null when that voice has fewer than 5 counted items. */
  voiceScores: { customer: number | null; creator: number | null; publication: number | null };
  sponsoredItems: { evidenceId: string; signals: string[] }[];
  /** The path from material read to opinions counted, by kind of material. */
  sample: { read: SampleCounts; aboutBrand: SampleCounts; counted: SampleCounts };
}

export interface PerceptionSection {
  metric: Metric;
  detail: PerceptionDetail;
  praise: Theme[];
  complaints: Theme[];
  concerns: Concern[];
  advocacy: AdvocacyNote[];
  /** AI-written note on creator vs customer differences; empty when it cannot be told. */
  creatorVsCustomer: string;
  themesNote?: string;
}

// ---------- Brand site and content gap ----------

export type CoverageLevel = 'clear' | 'partial' | 'none';

export interface SitePage {
  id: string;
  url: string;
  title: string;
  text: string;
  section: string;
}

export interface QuoteRef {
  pageId: string;
  url: string;
  quote: string;
}
export interface ProductLine {
  name: string;
  ref: QuoteRef;
}
export interface PositioningStatement {
  statement: string;
  ref: QuoteRef;
}

export interface ChecklistItem {
  id: string;
  source: 'category_question' | 'customer_concern';
  text: string;
  level: CoverageLevel;
  url?: string;
  quote?: string;
  /** True when the model's label could not be verified against the page and was lowered one level. */
  downgraded?: boolean;
  /** True when the analysis returned no verdict for this item. It is still counted as "not addressed". */
  unanswered?: boolean;
  /** For category questions: did Gemini name the audited brand when answering it? */
  geminiNamedBrand?: boolean | null;
  /**
   * How the evidence on the page relates to the question. Absent in reports saved before the
   * relevance check; those are read by `level` alone. Only direct, brand-wide and indirect
   * evidence keeps a level above "none".
   */
  relevance?: EvidenceRelevance;
  /** For a different product: the kind of product the page evidence was about. */
  evidenceAbout?: string;
  /** Why the evidence was not accepted, in plain words. */
  relevanceNote?: string;
  /** For a question about what experts recommend: what the quoted evidence shows about the experts. */
  expertEvidence?: ExpertEvidence;
}

/** direct: the same product. brand_wide: a fact about the whole brand. indirect: related but incomplete. */
export type EvidenceRelevance = 'direct' | 'brand_wide' | 'indirect' | 'different_product' | 'uncertain';
/** What a reader is shown for a checklist item. */
/**
 * What a quote shows about experts: a named expert or organisation recommends or endorses the brand,
 * experts only worked with it, or the brand's own page claims experts recommend it without naming
 * anyone (brand_claim, shown as the brand's claim and never as an independently verified endorsement).
 */
export type ExpertEvidence = 'recommendation' | 'endorsement' | 'collaboration' | 'brand_claim';
export type EvidenceClass = 'clear' | 'touched_on' | 'not_addressed' | 'uncertain';

export type PriceTier = 'budget' | 'premium';

/** The brand's price position, kept only when a retrieved source says it in words. */
export interface PricePosition {
  tier: PriceTier;
  origin: 'brand_site' | 'independent_source';
  evidenceId: string;
  url: string;
  domain: string;
  quote: string;
}

export interface ExcludedQuestion {
  questionId: string;
  question: string;
  /** product_range: the site shows the brand sells nothing of that kind. price_tier: the question is about a price tier the brand is not in. */
  kind: 'product_range' | 'price_tier';
  reason: string;
  sourceUrl?: string;
  /** For a price tier: each independent source behind it (at least two). */
  sources?: { domain: string; url: string; quote: string }[];
}

/**
 * How well the brand's price tier is supported. A question is left out on price only when
 * two independent domains state the same tier ("established").
 */
export interface PriceSupport {
  /**
   * established: two sources agree and at least one is genuinely independent of the brand.
   * insufficient: fewer than two usable sources.
   * not_independent: sources were found but none is independent of the brand (press releases and
   * company material are set aside), so the position cannot be established.
   * conflicting: usable sources name different tiers. none: nothing found.
   */
  status: 'established' | 'insufficient' | 'not_independent' | 'conflicting' | 'none';
  tier: PriceTier | null;
  /** The sources that counted: at most one per site, the brand's own site at most once. */
  sources: PricePosition[];
  /** Sources found but not counted as independent evidence (press releases, company material), with the reason. */
  setAside?: { domain: string; url: string; quote: string; tier: PriceTier; reason: string }[];
}

/** What was found about the brand's product range on the pages read. Never an inventory of the full range. */
export interface ProductRangeAssessment {
  status: 'identified' | 'partial' | 'not_assessed';
  pagesRead: number;
  /** Product lines found on the pages, each confirmed by a quote from a page. */
  linesIdentified: number;
  /** Product lines the analysis proposed that could not be confirmed on a page (not shown). */
  unverified: number;
  /** Always states that this is not a verified inventory of the complete range. */
  note: string;
}

export interface ContentGapDetail {
  domain: string | null;
  pagesRead: number;
  sections: string[];
  checklist: ChecklistItem[];
  excluded: ExcludedQuestion[];
  productLines: ProductLine[];
  positioning: PositioningStatement[];
  signatureClaim: { claim: string; ref: QuoteRef } | null;
  /** Null unless two independent sources state the brand's price position in words. */
  pricePosition: PricePosition | null;
  /** How well the price position is supported. Absent in reports saved before version 4. */
  priceSupport?: PriceSupport;
  /** Absent in reports saved before version 4. */
  productRange?: ProductRangeAssessment;
  points: number;
}

export interface ContentGapSection {
  metric: Metric;
  detail: ContentGapDetail;
}

// ---------- Claims ----------

export type ClaimVerdict = 'supported' | 'contradicted' | 'unverified';

export interface ClaimCheck {
  id: string;
  text: string;
  type: string;
  polarity: 'positive' | 'negative' | 'neutral';
  /** Where Gemini said it: an answer id (G1..) or GP for its brand description. */
  origin: string;
  verdict: ClaimVerdict;
  evidenceId?: string;
  url?: string;
  quote?: string;
  note?: string;
}

// ---------- Competitors ----------

export interface CompetitorRow {
  name: string;
  isAuditedBrand: boolean;
  visibility: Metric;
  appearances: number;
  sentiment: MetricOrSkipped;
  sentimentSample: number;
  contentCoverage: NotMeasuredMetric;
}

export interface CompetitorSection {
  rows: CompetitorRow[];
  note: string;
}

// ---------- Synthesis ----------

export interface Disagreement {
  title: string;
  kind: 'disagreement' | 'opportunity' | 'risk';
  audienceSays: string;
  geminiSays: string;
  implication: string;
  audienceEvidenceIds: string[];
  geminiEvidenceIds: string[];
  /** Distinct audience sources behind the "people say" side. */
  audienceSourceCount: number;
}

export interface DisconnectSection {
  status: 'assessed' | 'cannot_assess';
  reason?: string;
  direction?: 'ai_under' | 'ai_over' | 'aligned';
  gap?: number;
  headline?: string;
  disagreements: Disagreement[];
  note?: string;
}

export type CheckStatus = 'observed' | 'not_observed' | 'cannot_assess';

export interface InsightEvidence {
  id: string;
  label: string;
  url?: string;
  quote?: string;
}

export interface BetweenLinesCheck {
  id: string;
  title: string;
  status: CheckStatus;
  /** "computed" = decided by code from counts and positions; "ai_interpretation" = Gemini's reading of verified evidence. */
  basis: 'computed' | 'ai_interpretation';
  /** For an observed pattern: "tentative" when it rests on thin evidence and must not be read as established. */
  strength?: 'established' | 'tentative';
  /** The wording shown for the status, set where "Observed" would overstate the evidence. */
  statusLabel?: string;
  observed?: string;
  evidence: InsightEvidence[];
  whyItMatters?: string;
  implication?: string;
  reason?: string;
}

export interface FixItem {
  action: string;
  why: string;
  priority: number;
  effort: 'Low' | 'Medium' | 'High';
  /** A hypothesis about what might change. Never a measured or promised outcome. */
  expectedImpact: string;
  evidenceIds: string[];
  /** How much evidence the recommendation rests on, counted in code. */
  evidenceBase: string;
}

// ---------- Methodology ----------

export interface SearchLogEntry {
  purpose: string;
  query: string;
  scope: string;
  results: number;
  kept: number;
  credits: number;
  ok: boolean;
  note?: string;
}

export interface Methodology {
  auditedAt: string;
  /** The model name the Gemini API reported in its responses. */
  model: string;
  /** The model name this site is configured to request. */
  modelConfigured: string;
  /** Why this model is used, built from the site's own configured limits. */
  modelNote: string;
  questionBankVersion: string;
  tier: Tier;
  questions: { planned: number; answered: number; failed: number; excluded: number; counted: number };
  searches: SearchLogEntry[];
  tavilyCreditsUsed: number;
  geminiRequests: number;
  youtube: { status: 'ok' | 'partial' | 'unavailable' | 'skipped'; videos: number; comments: number; note?: string };
  sitePages: number;
  unavailable: string[];
  limitations: string[];
}

export type OverallConfidence =
  | { status: 'stated'; level: ConfidenceLevel; limitedBy: string }
  | { status: 'not_stated'; reason: string };

// ---------- The report ----------

export interface Report {
  /** 4 for new reports. Reports saved as 3 are still read: the fields added in 4 are optional. */
  version: 2 | 3 | 4 | 5;
  id: string;
  /** True only for the bundled example with a fictional brand. */
  illustrative?: boolean;
  brand: string;
  brandKey: string;
  category: { id: CategoryId; label: string };
  createdAt: string;
  model: string;
  tier: Tier;
  overallConfidence: OverallConfidence;
  visibility: { metric: Metric; detail: VisibilityDetail };
  brandProfile: BrandProfile | null;
  signatureAnswer: GeminiAnswer | null;
  answers: GeminiAnswer[];
  perception: PerceptionSection;
  contentGap: ContentGapSection;
  claims: ClaimCheck[];
  claimsNote?: string;
  competitors: CompetitorSection;
  disconnect: DisconnectSection;
  betweenTheLines: BetweenLinesCheck[];
  fixes: FixItem[];
  fixesNote?: string;
  /** Every piece of evidence the report cites, keyed by id in the UI. */
  evidence: EvidenceItem[];
  methodology: Methodology;
  warnings: string[];
}

// ---------- Progress (what the browser sees while an audit runs) ----------

export type JobStatus = 'running' | 'paused' | 'complete' | 'failed';

export interface StageSnapshot {
  id: string;
  label: string;
  state: 'done' | 'active' | 'pending';
  note?: string;
}

export interface JobSnapshot {
  id: string;
  brand: string;
  categoryLabel: string;
  status: JobStatus;
  stages: StageSnapshot[];
  warnings: string[];
  waitSeconds?: number;
  waitReason?: string;
  busy?: boolean;
  error?: string;
}

export type StartErrorCode =
  | 'invalid'
  | 'setup'
  | 'daily_limit'
  | 'visitor_limit'
  | 'monthly_limit'
  | 'gemini_quota'
  | 'storage'
  | 'too_many_requests';

export type StartResponse =
  | { status: 'started' | 'in_progress' | 'cached'; id: string }
  | { status: 'error'; code: StartErrorCode; message: string };
