import 'server-only';
import type { RequestOutcome } from '../clients/gemini';
import type { ReservationKeys } from '../quota/reservations';
import type {
  AdvocacyNote,
  BrandProfile,
  CategoryId,
  CategoryQuestion,
  ClaimCheck,
  Concern,
  CoverageLevel,
  EvidenceRelevance,
  ExpertEvidence,
  Disagreement,
  EvidenceItem,
  EvidenceLabel,
  FixItem,
  GeminiAnswer,
  IdentityData,
  JobSnapshot,
  JobStatus,
  PositioningStatement,
  PricePosition,
  ProductLine,
  QuoteRef,
  SearchLogEntry,
  SetAsideEvidence,
  SitePage,
  Theme,
  Tier,
} from '../types';

// An audit runs as a list of stages. The browser asks the server to run one stage at a time,
// and every stage saves its results before the next begins, so a refresh resumes where it
// stopped and nothing already paid for (a search, a Gemini answer) is ever fetched twice.

export type StageId =
  | 'questions'
  | 'profile'
  | 'audience'
  | 'ask'
  | 'youtube'
  | 'perception'
  | 'website'
  | 'claims'
  | 'competitors'
  | 'synthesis'
  | 'finalize';

export const STAGE_ORDER: { id: StageId; label: (brand: string) => string }[] = [
  { id: 'questions', label: () => 'Preparing the audit' },
  // The brand is identified BEFORE the eight shopper questions and the research stages, so an audit about a
  // brand that cannot be identified in the selected category stops while it has spent almost nothing.
  { id: 'profile', label: (brand) => `Asking Gemini what it knows about ${brand}` },
  { id: 'audience', label: () => 'Checking the brand, then finding customer discussions and independent reviews' },
  { id: 'ask', label: () => 'Asking Gemini 8 shopper questions, one at a time' },
  { id: 'youtube', label: () => 'Sampling YouTube videos and comments' },
  { id: 'perception', label: () => 'Reading the evidence for sentiment and themes' },
  { id: 'website', label: () => "Reading the brand's own website" },
  { id: 'claims', label: () => "Checking Gemini's claims against sources" },
  { id: 'competitors', label: () => 'Comparing with the top three competitors' },
  { id: 'synthesis', label: () => 'Finding the disconnect and writing recommendations' },
  { id: 'finalize', label: () => 'Calculating scores and assembling the report' },
];

/**
 * What this audit's Gemini requests did. Best effort: it is saved at the end of each stage, so after an
 * interruption the outcomes of the interrupted request are missing. The Redis audit counter is the
 * durable count; `started` mirrors it.
 */
export interface GeminiLedger {
  /** Requests the gate allowed so far (the Redis audit counter as last seen). */
  started: number;
  /** Requests allowed per step key (for example "ask:q3" or "profile"). */
  steps: Record<string, number>;
  /** How each request ended. `started` minus the sum of these is shown as "interrupted". */
  outcomes: Partial<Record<RequestOutcome, number>>;
}

export interface JobMeta {
  id: string;
  /** The brand name as shown. Capitalised for display when the visitor typed it in lower case. */
  brand: string;
  /** "typed": keep the visitor's capitalisation. "derived": it was tidied, and may be refined from the sources. */
  brandCasing?: 'typed' | 'derived';
  brandKey: string;
  categoryId: CategoryId;
  categoryLabel: string;
  categoryNoun: string;
  categoryPlural: string;
  cacheKey: string;
  tier: Tier;
  status: JobStatus;
  stageIndex: number;
  notes: Partial<Record<StageId, string>>;
  warnings: string[];
  attempts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  model: string;
  keys: ReservationKeys;
  geminiRequests: number;
  /** Format 8 and later audits only; audits started before this field existed have none. */
  geminiLedger?: GeminiLedger;
  /**
   * Set once, when this audit wanted to send a Gemini request and was refused because it had already sent the
   * most it may (GEMINI_AUDIT_REQUEST_CEILING). From then on every Gemini call returns "no result" at once.
   * The report says so, and a report from such an audit is not saved as the cached result for its brand.
   */
  geminiCeilingReached?: boolean;
  creditsSpent: number;
  searches: SearchLogEntry[];
  error?: string;
  pausedReason?: string;
}

export interface AudienceData {
  discussionsDone: boolean;
  reviewsDone: boolean;
  /** False when the reviews search could not run (so "no website found" would overstate what was checked). */
  reviewsSearched?: boolean;
  items: EvidenceItem[];
  /** Domains whose registered name is the brand's name (strict), seen in search results. */
  brandDomains: string[];
  /** Results that used a similar name or address but were not counted as the brand. Format 7 and later. */
  setAside?: SetAsideEvidence[];
}

export interface YouTubeData {
  status: 'ok' | 'partial' | 'unavailable' | 'skipped';
  note?: string;
  videos: EvidenceItem[];
  comments: EvidenceItem[];
  /** Videos whose title used a similar name but not the brand's own. */
  setAside?: SetAsideEvidence[];
}

export interface LabelsData {
  available: boolean;
  labels: EvidenceLabel[];
  praise: Theme[];
  complaints: Theme[];
  concerns: Concern[];
  advocacy: AdvocacyNote[];
  creatorVsCustomer: string;
  droppedThemes: number;
  /** Price position stated in words by an independent source; null when none says it. */
  pricePosition: PricePosition | null;
}

export interface SiteData {
  domain: string | null;
  pages: SitePage[];
  secondSearchDone: boolean;
  note?: string;
}

export interface SiteAnalysisData {
  available: boolean;
  productLines: ProductLine[];
  positioning: PositioningStatement[];
  signatureClaim: { claim: string; ref: QuoteRef } | null;
  relevance: { questionId: string; fit: 'in_range' | 'out_of_range' | 'unclear'; reason: string }[];
  /** unanswered: the model returned no verdict for this item at all (it is still counted as "none"). */
  coverage: {
    itemId: string;
    level: CoverageLevel;
    url?: string;
    quote?: string;
    downgraded?: boolean;
    unanswered?: boolean;
    relevance?: EvidenceRelevance;
    evidenceAbout?: string;
    relevanceNote?: string;
    expertEvidence?: ExpertEvidence;
    brandClaim?: boolean;
  }[];
  /** Product lines the analysis proposed that could not be confirmed against a page (not shown). */
  productLinesUnverified?: number;
  /** Price position stated in words on the brand's own pages; null when the pages do not say. */
  pricePosition: PricePosition | null;
}

export interface ClaimsData {
  phase: 'searched' | 'done';
  claims: ClaimCheck[];
  sources: EvidenceItem[];
  note?: string;
}

export interface CompetitorsData {
  names: string[];
  searchedNames: string[];
  items: EvidenceItem[];
  labels: EvidenceLabel[];
  labeled: boolean;
  note?: string;
}

export interface InsightCandidate {
  pattern: 'complaint_as_fact' | 'narrow_range' | 'positioning_contradiction';
  observed: string;
  whyItMatters: string;
  implication: string;
  evidenceIds: string[];
  /** For a positioning tension: the exact statement from the brand's site that the complaint is set against. */
  siteStatement?: PositioningStatement;
}

export interface SynthesisData {
  phase: 'insights' | 'done';
  insightsAvailable: boolean;
  disagreements: Disagreement[];
  insights: InsightCandidate[];
  fixesAvailable: boolean;
  fixes: FixItem[];
}

/** Everything an audit has gathered so far. A missing key means that step has not run yet. */
export interface JobData {
  questions?: CategoryQuestion[];
  answers?: GeminiAnswer[];
  /** null = Gemini's description could not be retrieved. */
  profile?: BrandProfile | null;
  /** Who the brand was established to be in this category. Absent only on audits started before format 7. */
  identity?: IdentityData;
  audience?: AudienceData;
  youtube?: YouTubeData;
  labels?: LabelsData;
  site?: SiteData;
  siteAnalysis?: SiteAnalysisData;
  /** null = no signature claim to test. */
  signature?: GeminiAnswer | null;
  claims?: ClaimsData;
  competitors?: CompetitorsData;
  synthesis?: SynthesisData;
}

export type SectionName = keyof JobData;

export function snapshotOf(meta: JobMeta): JobSnapshot {
  const finished = meta.status === 'complete';
  return {
    id: meta.id,
    brand: meta.brand,
    categoryLabel: meta.categoryLabel,
    status: meta.status,
    stages: STAGE_ORDER.map((stage, index) => ({
      id: stage.id,
      label: stage.label(meta.brand),
      state: finished || index < meta.stageIndex ? 'done' : index === meta.stageIndex ? 'active' : 'pending',
      note: meta.notes[stage.id],
    })),
    warnings: meta.warnings,
    error: meta.status === 'failed' || meta.status === 'identity_failed' ? meta.error : meta.status === 'paused' ? meta.pausedReason : undefined,
  };
}
