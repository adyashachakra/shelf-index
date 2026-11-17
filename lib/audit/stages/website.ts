import 'server-only';
import { domainBelongsToBrand, mentionsBrand } from '../../evidence/brand-match';
import { cleanDomain, isSocialDomain } from '../../evidence/normalize';
import { verifiedPriceTier } from '../../evidence/price';
import { quoteAppearsIn } from '../../evidence/quotes';
import { applyAllRules, assessRelevance } from '../../evidence/relevance';
import { logEvent } from '../../log';
import type { CoverageLevel, GeminiAnswer, QuoteRef, SitePage } from '../../types';
import type { StageContext } from '../context';
import { readablePages, resultsToSitePages } from '../evidence-builders';
import type { SiteAnalysisData, SiteData } from '../job';
import { askQuestionPrompt, siteAnalysisPrompt } from '../prompts';
import { MIN_READABLE_PAGES } from '../../scoring/content-gap';

const NO_ANALYSIS: SiteAnalysisData = {
  available: false,
  productLines: [],
  positioning: [],
  signatureClaim: null,
  relevance: [],
  coverage: [],
  pricePosition: null,
};

function lower(level: CoverageLevel): CoverageLevel {
  return level === 'clear' ? 'partial' : 'none';
}

/**
 * Stage 7: read the brand's own site (through site-restricted Tavily searches), then have
 * Gemini describe what the site sells and says, and whether it answers each checklist question.
 * Every product line, positioning statement and coverage label must quote a page we retrieved;
 * anything that cannot be verified is dropped or downgraded by the code below.
 */
export async function runWebsite(ctx: StageContext): Promise<'done' | 'continue'> {
  const { meta, data } = ctx;

  // --- 7a. find the official site and read a sample of its pages ---
  if (!data.site) {
    const candidates: string[] = [];
    const add = (value: string | undefined) => {
      const domain = cleanDomain(value ?? '');
      if (domain !== '' && !isSocialDomain(domain) && !candidates.includes(domain)) candidates.push(domain);
    };
    add(data.profile?.officialDomain);
    for (const domain of data.audience?.brandDomains ?? []) add(domain);

    const site: SiteData = { domain: null, pages: [], secondSearchDone: false };
    if (candidates.length === 0) {
      site.note = "The brand's website could not be identified: Gemini did not name one and none appeared in search results.";
    }
    // Checked once, before any search: a retry after a paid search must never repeat it.
    if (candidates.length > 0 && ctx.timeLeft() < 25_000) return 'continue';
    for (const candidate of candidates.slice(0, 2)) {
      const outcome = await ctx.search("The brand's own site: products", candidate, {
        query: `${meta.brand} products shop collections`,
        maxResults: 8,
        includeDomains: [candidate],
        rawContent: true,
      });
      if (!outcome) {
        site.note = "The brand's website could not be searched.";
        break;
      }
      const pages = resultsToSitePages(outcome.results, candidate, []);
      // A site is used when its address strictly belongs to the brand, or when Gemini recognised the brand and
      // the pages read name it. A name that merely contains the brand's name never establishes ownership, and
      // for a brand Gemini does not know, only a strictly matching address is accepted.
      const looksRight =
        pages.length > 0 &&
        (domainBelongsToBrand(candidate, meta.brand) ||
          (data.profile?.recognized === true && pages.some((p) => mentionsBrand(`${p.title} ${p.text}`, meta.brand))));
      outcome.entry.kept = looksRight ? pages.length : 0;
      if (looksRight) {
        site.domain = candidate;
        site.pages = pages;
        site.note = undefined;
        break;
      }
      site.note = `Pages from ${candidate} did not clearly belong to ${meta.brand}, so the site was not used.`;
    }
    await ctx.save('site', site);
  }

  const site = data.site as SiteData;
  if (site.domain && !site.secondSearchDone) {
    if (meta.tier !== 'minimal') {
      if (ctx.timeLeft() < 12_000) return 'continue';
      const topics = (data.questions ?? [])
        .map((q) => q.intent)
        .slice(0, 5)
        .join(', ');
      const outcome = await ctx.search("The brand's own site: guides, FAQ and blog", site.domain, {
        query: `${meta.brand} guide FAQ how to choose ${topics}`,
        maxResults: 8,
        includeDomains: [site.domain],
        rawContent: true,
      });
      if (outcome) {
        const before = site.pages.length;
        site.pages = resultsToSitePages(outcome.results, site.domain, site.pages);
        outcome.entry.kept = site.pages.length - before;
      }
    }
    site.secondSearchDone = true;
    await ctx.save('site', site);
  }

  // --- 7b. analyse the pages ---
  if (!data.siteAnalysis) {
    const pages = readablePages(site.pages);
    if (!site.domain || pages.length < MIN_READABLE_PAGES) {
      await ctx.save('siteAnalysis', NO_ANALYSIS);
    } else {
      if (ctx.timeLeft() < 20_000) return 'continue';
      const questions = data.questions ?? [];
      const concerns = data.labels?.concerns ?? [];
      const result = await ctx.gemini(
        siteAnalysisPrompt({
          brand: meta.brand,
          categoryLabel: meta.categoryLabel,
          pages: pages.slice(0, 12).map((p) => ({ id: p.id, url: p.url, title: p.title, text: p.text })),
          questions: questions.map((q) => ({ id: q.id, text: q.text })),
          concerns: concerns.map((c) => ({ id: c.id, text: c.label })),
          geminiProducts: data.profile?.products ?? [],
        }),
        'site_analysis',
      );
      if (result === null) {
        await ctx.save('siteAnalysis', NO_ANALYSIS);
        ctx.warn("The brand's site pages were retrieved but could not be analysed, so content gap has no score.");
      } else {
        const pageById = new Map<string, SitePage>(pages.map((p) => [p.id, p]));
        const verify = (pageId: string, quote: string): QuoteRef | null => {
          const page = pageById.get(pageId);
          if (!page || quote === '' || !quoteAppearsIn(quote, page.text)) return null;
          return { pageId, url: page.url, quote };
        };
        const out = result.data;
        const analysis: SiteAnalysisData = {
          available: true,
          productLines: [],
          positioning: [],
          signatureClaim: null,
          relevance: [],
          coverage: [],
          pricePosition: null,
        };
        const pricePage = pageById.get(out.price_position.page_id);
        if (pricePage) {
          const tier = verifiedPriceTier({ tier: out.price_position.tier, quote: out.price_position.quote, title: pricePage.title, text: pricePage.text, brand: meta.brand, ownSite: true });
          if (tier) {
            analysis.pricePosition = { tier, origin: 'brand_site', evidenceId: pricePage.id, url: pricePage.url, domain: site.domain ?? '', quote: out.price_position.quote };
          }
        }
        let unverifiedLines = 0;
        for (const line of out.product_lines) {
          const ref = verify(line.page_id, line.quote);
          if (ref && !analysis.productLines.some((l) => l.name.toLowerCase() === line.name.toLowerCase())) {
            analysis.productLines.push({ name: line.name, ref });
          } else if (!ref) {
            unverifiedLines += 1;
          }
        }
        analysis.productLinesUnverified = unverifiedLines;
        for (const statement of out.positioning) {
          const ref = verify(statement.page_id, statement.quote);
          if (ref) analysis.positioning.push({ statement: statement.statement, ref });
        }
        const sig = out.signature_claim;
        if (sig.claim !== '' && !mentionsBrand(sig.claim, meta.brand)) {
          const ref = verify(sig.page_id, sig.quote);
          if (ref) analysis.signatureClaim = { claim: sig.claim, ref };
        }
        for (const question of questions) {
          const found = out.question_relevance.find((r) => r.question_id.toLowerCase() === question.id.toLowerCase());
          analysis.relevance.push({ questionId: question.id, fit: found?.fit ?? 'unclear', reason: found?.reason ?? '' });
        }
        const checklistIds = [...questions.map((q) => q.id), ...concerns.map((c) => c.id)];
        const itemText = new Map<string, string>([...questions.map((q) => [q.id, q.text] as [string, string]), ...concerns.map((c) => [c.id, c.label] as [string, string])]);
        for (const itemId of checklistIds) {
          const found = out.coverage.find((c) => c.item_id.toLowerCase() === itemId.toLowerCase());
          if (!found) {
            // No verdict came back for this item. The score still treats it as "not addressed"
            // (the formula is unchanged), but the report says so, because a missing verdict is
            // not the same as a page that fails to answer.
            analysis.coverage.push({ itemId, level: 'none', unanswered: true });
            continue;
          }
          if (found.level === 'none') {
            analysis.coverage.push({ itemId, level: 'none' });
            continue;
          }
          const ref = verify(found.page_id, found.quote);
          const page = pageById.get(found.page_id);
          if (!ref && found.relation !== 'different') {
            // No quote to check the product against: the label is lowered one level, as before.
            analysis.coverage.push({ itemId, level: lower(found.level), downgraded: true });
            continue;
          }
          // Is the evidence about what the item asks about? A verdict that fails this check takes
          // the level "none"; a related-but-indirect one is capped at "partial".
          const assessed = assessRelevance({
            itemText: itemText.get(itemId) ?? '',
            level: found.level,
            relation: found.relation,
            asksAbout: found.asks_about,
            quoteAbout: found.quote_about,
            quote: ref?.quote ?? '',
            pageTitle: page?.title ?? '',
          });
          // The quote rules, in order (see lib/evidence/relevance.ts): a page that only says a product suits a
          // range of types does not name the best one for a need; a notice about the visitor's location does not
          // say where products are available; experts who helped make a product do not recommend it; and for a
          // question about effectiveness, suitability, clinical performance or expert recommendation the brand's
          // own statement is a claim, at most "touched on".
          const check = applyAllRules({ itemText: itemText.get(itemId) ?? '', quote: ref?.quote ?? '', outcome: assessed });
          const relevanceFields = {
            relevance: check.relevance,
            ...('expertEvidence' in check && check.expertEvidence ? { expertEvidence: check.expertEvidence } : {}),
            ...(check.brandClaim ? { brandClaim: true } : {}),
            ...(check.evidenceAbout ? { evidenceAbout: check.evidenceAbout } : {}),
            ...(check.note ? { relevanceNote: check.note } : {}),
          };
          if (check.relevance === 'different_product' || check.relevance === 'uncertain') {
            analysis.coverage.push({ itemId, level: 'none', ...relevanceFields });
          } else if (ref) {
            analysis.coverage.push({ itemId, level: check.level, url: ref.url, quote: ref.quote, ...relevanceFields });
          }
        }
        // Counts and item ids only (never page text or answers): how many verdicts were asked
        // for, how many came back, and which items had none.
        logEvent('site_coverage', {
          asked: checklistIds.length,
          returned: out.coverage.length,
          missing: analysis.coverage.filter((c) => c.unanswered === true).map((c) => c.itemId).join(','),
          // Verdicts not accepted because the evidence was about a different product, and
          // verdicts whose link to the question could not be confirmed (item ids only).
          different: analysis.coverage.filter((c) => c.relevance === 'different_product').map((c) => c.itemId).join(','),
          uncertain: analysis.coverage.filter((c) => c.relevance === 'uncertain').map((c) => c.itemId).join(','),
        });
        await ctx.save('siteAnalysis', analysis);
      }
    }
  }

  // --- 7c. test the brand's signature claim on Gemini, without naming the brand ---
  if (data.signature === undefined) {
    const claim = data.siteAnalysis?.signatureClaim;
    if (!claim) {
      await ctx.save('signature', null);
    } else {
      if (ctx.timeLeft() < 15_000) return 'continue';
      const question = `Which ${meta.categoryPlural} are best known for ${claim.claim.replace(/[.?!]+$/, '').toLowerCase()}?`;
      const result = await ctx.gemini(askQuestionPrompt(question), 'signature');
      const base = { id: 'GS', questionId: 'signature', question, intent: 'signature claim' };
      const answer: GeminiAnswer =
        result === null
          ? { ...base, status: 'failed', failureReason: 'Gemini did not return a usable answer' }
          : {
              ...base,
              status: 'answered',
              answer: result.data.answer,
              recommendations: result.data.recommendations,
              alsoMentioned: result.data.also_mentioned,
              model: result.model,
              askedAt: new Date().toISOString(),
            };
      await ctx.save('signature', answer);
    }
  }

  const readable = readablePages(site.pages).length;
  ctx.note(
    'website',
    site.domain ? `${readable} readable page${readable === 1 ? '' : 's'} from ${site.domain}` : 'Official site not identified',
  );
  if (!site.domain) ctx.warn(site.note ?? "The brand's website could not be identified, so content gap has no score.");
  return 'done';
}
