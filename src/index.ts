import "dotenv/config";
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadGeminiEnv, loadMailEnv, loadSearchApiEnv } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { getIsoDateInTimeZone, getWeekNumberInTimeZone, getWeekYearInTimeZone } from "./lib/date.js";
import { loadResearchConfig } from "./research/config.js";
import {
  buildCompanyHomepagesPrompt,
  buildCompanyHqPrompt,
  buildCompanyDiscoveryPrompt,
  buildOverseasSourcesPrompt,
  buildReportFromSourcesPrompt,
  buildSourcesPrompt,
  buildWeeklyPrompt,
} from "./research/prompt.js";
import {
  generateCompanyHomepages,
  generateCompanyHq,
  generateCompanyDiscovery,
  generateSourceList,
  translateOverseasSectionToKorean,
  generateWeeklyReport,
  generateWeeklyReportFromSources,
} from "./research/gemini.js";
import {
  generateKoreaSourcesViaSearchApiGoogleNews,
  generateGlobalSourcesViaSearchApiGoogleNews,
  generateSourceListViaSearchApiGoogleNewsForWatchlist,
} from "./research/searchapiNews.js";
import { WeeklyReportSchema, type WeeklyReport } from "./research/schema.js";
import { postprocessReport } from "./research/postprocess.js";
import {
  ensureOverseasCompetitorSection,
  splitOverseasFromCategoryUpdatesByHq,
} from "./research/augment.js";
import { fillOverseasFromSourcesFallback, fillReportFromSourcesFallback } from "./research/fallbackFill.js";
import {
  addReportUrlsToHistory,
  filterReportBySeenUrls,
  filterUrlsBySeen,
  getSeenUrlSetForWeek,
  loadSeenHistory,
  normalizeUrlForDedupe,
  saveSeenHistory,
} from "./research/seenHistory.js";
import { renderHtmlFromMarkdown, renderMarkdown } from "./email/render.js";
import { sendEmail } from "./email/mailer.js";

const program = new Command();

program
  .name("market-rader")
  .description("Weekly competitor radar via Gemini grounded search + email")
  .option("-c, --config <path>", "research config json path", "config/research.json")
  .option("--input-report <path>", "use an existing report JSON instead of calling Gemini")
  .option("--as-of <date>", "report date (YYYY-MM-DD) in configured timezone")
  .option("--dry-run", "do not send email; write outputs to out/", false);

program.parse(process.argv);
const opts = program.opts<{ config: string; inputReport?: string; dryRun: boolean; asOf?: string }>();

function computeMissingSourceCategories(args: {
  sources: Array<{ company: string; category: string }>;
  categoryIds: string[];
}): string[] {
  const { sources, categoryIds } = args;
  const byCat = new Map<string, Set<string>>();
  for (const id of categoryIds) byCat.set(id, new Set());
  for (const s of sources) {
    if (!byCat.has(s.category)) continue;
    byCat.get(s.category)!.add(s.company);
  }
  return categoryIds.filter((id) => (byCat.get(id)?.size ?? 0) === 0);
}

function countCategoryUpdates(report: { category_updates: Record<string, Array<unknown>> }): number {
  return Object.values(report.category_updates ?? {}).reduce((sum, items) => sum + (items?.length ?? 0), 0);
}

function hasHangul(s: string): boolean {
  return /[\uAC00-\uD7AF]/.test(s);
}

function computeLikelyKoreanCompanyCountsByCategory(args: {
  sources: Array<{ company: string; category: string }>;
  categoryIds: string[];
}): Map<string, number> {
  const { sources, categoryIds } = args;
  const byCat = new Map<string, Set<string>>();
  for (const id of categoryIds) byCat.set(id, new Set());

  for (const s of sources) {
    if (!byCat.has(s.category)) continue;
    if (!hasHangul(s.company)) continue;
    byCat.get(s.category)!.add(s.company.trim());
  }

  const out = new Map<string, number>();
  for (const id of categoryIds) out.set(id, byCat.get(id)?.size ?? 0);
  return out;
}

function computeDistinctCompaniesPerCategory(args: {
  categoryUpdates: Record<string, Array<{ company: string }>>;
  categoryIds: string[];
}): Map<string, number> {
  const { categoryUpdates, categoryIds } = args;
  const out = new Map<string, number>();
  for (const id of categoryIds) {
    const items = categoryUpdates[id] ?? [];
    const set = new Set(items.map((u) => u.company.trim()).filter(Boolean));
    out.set(id, set.size);
  }
  return out;
}

function scoreTag(tag: string): number {
  const t = tag.trim().toLowerCase();
  if (!t) return 2;
  if (t.includes("m&a") || t.includes("인수") || t.includes("합병")) return 5;
  if (t.includes("투자") || t.includes("fund") || t.includes("financ")) return 5;
  if (t.includes("출시") || t.includes("론칭") || t.includes("런칭") || t.includes("release") || t.includes("launch"))
    return 4;
  if (t.includes("제휴") || t.includes("파트너") || t.includes("협력") || t.includes("partnership")) return 4;
  if (t.includes("업데이트") || t.includes("update")) return 3;
  if (t.includes("채용") || t.includes("hiring")) return 2;
  return 3;
}

function rebuildActionItemsFromCategoryUpdates(report: WeeklyReport, maxItems: number): string[] {
  const candidates: Array<{ catId: string; company: string; tag: string; score: number }> = [];
  for (const [catId, items] of Object.entries(report.category_updates ?? {})) {
    for (const u of items ?? []) {
      candidates.push({ catId, company: u.company, tag: u.tag, score: scoreTag(u.tag) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const actions: string[] = [];
  const seenCompanies = new Set<string>();
  const seenActions = new Set<string>();

  const categoryOrder = Array.from(new Set(candidates.map((c) => c.catId))).sort();

  // First pass: try to cover more categories with distinct companies.
  for (const catId of categoryOrder) {
    const pick = candidates.find((c) => c.catId === catId && !seenCompanies.has(c.company.trim()));
    if (!pick) continue;
    const action = `기획팀: ${pick.catId} - ${pick.company} (${pick.tag}) 업데이트 상세 검토 및 벤치마킹 포인트 정리`;
    seenCompanies.add(pick.company.trim());
    seenActions.add(action);
    actions.push(action);
    if (actions.length >= maxItems) return actions;
  }

  // Second pass: fill remaining slots by importance, still preferring distinct companies.
  for (const c of candidates) {
    const companyKey = c.company.trim();
    if (seenCompanies.has(companyKey)) continue;
    const action = `기획팀: ${c.catId} - ${c.company} (${c.tag}) 업데이트 상세 검토 및 벤치마킹 포인트 정리`;
    if (seenActions.has(action)) continue;
    seenCompanies.add(companyKey);
    seenActions.add(action);
    actions.push(action);
    if (actions.length >= maxItems) break;
  }

  return actions;
}

function rebuildTopHighlightsFromCategoryUpdates(args: {
  report: WeeklyReport;
  max: number;
}): WeeklyReport["top_highlights"] {
  const candidates: Array<{
    company: string;
    category: WeeklyReport["top_highlights"][number]["category"];
    title: string;
    insight: string;
    link: string;
    score: number;
  }> = [];

  for (const [cat, updates] of Object.entries(args.report.category_updates ?? {}) as Array<
    [WeeklyReport["top_highlights"][number]["category"], WeeklyReport["category_updates"][WeeklyReport["top_highlights"][number]["category"]]]
  >) {
    for (const u of updates ?? []) {
      if (!u.url) continue;
      candidates.push({
        company: u.company,
        category: cat,
        title: u.title,
        insight: u.insight ?? "요약은 출처 링크를 확인하세요.",
        link: u.url,
        score: scoreTag(u.tag),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked: WeeklyReport["top_highlights"] = [];
  const seen = new Set<string>();
  const seenCompanies = new Set<string>();
  for (const c of candidates) {
    if (seenCompanies.has(c.company.trim())) continue;
    const key = `${c.company}|${c.title}|${c.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seenCompanies.add(c.company.trim());
    picked.push({
      company: c.company,
      category: c.category,
      title: c.title,
      insight: c.insight,
      importance_score: c.score,
      link: c.link,
    });
    if (picked.length >= args.max) break;
  }

  // If we couldn't get enough distinct companies, fill remaining slots with next-best items.
  if (picked.length < args.max) {
    for (const c of candidates) {
      const key = `${c.company}|${c.title}|${c.link}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({
        company: c.company,
        category: c.category,
        title: c.title,
        insight: c.insight,
        importance_score: c.score,
        link: c.link,
      });
      if (picked.length >= args.max) break;
    }
  }
  return picked;
}

async function main(): Promise<void> {
  const configPath = path.resolve(process.cwd(), opts.config);
  const researchConfig = await loadResearchConfig(configPath);

  const now = new Date();
  let report = null as unknown;
  let subjectPrefix = researchConfig.email?.subject_prefix ?? process.env.MAIL_SUBJECT_PREFIX ?? "[Market Radar]";
  let modelUsed = process.env.GEMINI_MODEL ?? "unknown";
  let geminiEnv: ReturnType<typeof loadGeminiEnv> | null = null;
  let searchEnv: ReturnType<typeof loadSearchApiEnv> | null = null;
  let renderMeta:
    | { sourcesCollected?: number; sourcesQueries?: number; droppedUrls?: number; dedupedItems?: number }
    | undefined = undefined;
  let dedupeCtx: { historyPath: string; weekKey: string; seenThisWeek: Set<string>; history: Awaited<ReturnType<typeof loadSeenHistory>> } | null =
    null;

  logger.info({ sourceProvider: researchConfig.source_provider ?? "gemini_grounded" }, "Source provider selected");

  if (opts.inputReport) {
    const raw = await readFile(opts.inputReport, "utf8");
    report = WeeklyReportSchema.parse(JSON.parse(raw));
  } else {
    geminiEnv = loadGeminiEnv();
    subjectPrefix = researchConfig.email?.subject_prefix ?? geminiEnv.MAIL_SUBJECT_PREFIX;
    const timeZone = researchConfig.timezone ?? geminiEnv.TZ;
    if (opts.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) {
      throw new Error("--as-of must be YYYY-MM-DD");
    }
    const baseDate = opts.asOf ? new Date(`${opts.asOf}T00:00:00.000Z`) : now;
    const reportDate = getIsoDateInTimeZone(baseDate, timeZone);
	    const weekNumber = getWeekNumberInTimeZone(baseDate, timeZone);
	    const weekYear = getWeekYearInTimeZone(baseDate, timeZone);
	    const weekKey = `${weekYear}-W${String(weekNumber).padStart(2, "0")}`;

	    const historyPathRaw = process.env.HISTORY_PATH ?? researchConfig.history_path ?? "out/seen.json";
	    const historyPath = historyPathRaw.startsWith("gs://") ? historyPathRaw : path.resolve(process.cwd(), historyPathRaw);
	    // Only dedupe on real sends; for dry-runs we prefer showing the full month of items.
	    const history = opts.dryRun ? null : await loadSeenHistory(historyPath);
	    const seenThisWeek = opts.dryRun ? new Set<string>() : getSeenUrlSetForWeek(history!, weekKey);
	    dedupeCtx = opts.dryRun ? null : { historyPath, weekKey, seenThisWeek, history: history! };

	    const baseSourcesPrompt = buildSourcesPrompt({ reportDate, weekNumber, config: researchConfig });
	    const categoryIds = researchConfig.categories.map((c) => c.id);

    let sourcesResult:
      | Awaited<ReturnType<typeof generateSourceList>>
      | Awaited<ReturnType<typeof generateSourceListViaSearchApiGoogleNewsForWatchlist>>;

    if (researchConfig.source_provider === "searchapi_google_news") {
      searchEnv = loadSearchApiEnv();
      const includeKr = researchConfig.searchapi?.include_kr ?? true;
      const includeGlobal = researchConfig.searchapi?.include_global ?? true;

      // Run KR and GLOBAL collection separately to improve relevance/accuracy.
      const global = includeGlobal
        ? await generateGlobalSourcesViaSearchApiGoogleNews({ env: searchEnv, config: researchConfig, reportDate })
        : { sources: { sources: [] }, meta: { provider: "searchapi_google_news" as const, queries: 0, results: 0 } };
      const kr = includeKr
        ? await generateKoreaSourcesViaSearchApiGoogleNews({ env: searchEnv, config: researchConfig, reportDate })
        : { sources: { sources: [] }, meta: { provider: "searchapi_google_news" as const, queries: 0, results: 0 } };

      const seen = new Set<string>();
      const mergedSources = [...global.sources.sources, ...kr.sources.sources].filter((s) => {
        const key = normalizeUrlForDedupe(s.url);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      sourcesResult = {
        sources: { sources: mergedSources },
        meta: { provider: "searchapi_google_news", queries: kr.meta.queries + global.meta.queries, results: mergedSources.length },
      };
    } else {
      sourcesResult = await generateSourceList({ env: geminiEnv, prompt: baseSourcesPrompt });
    }

    let missingCats = computeMissingSourceCategories({ sources: sourcesResult.sources.sources, categoryIds });

    const minKorea = researchConfig.min_companies_per_category ?? 0;
    const targetSourcesHint = Math.max(minKorea * categoryIds.length, 20);
    const minSourcesToUseTwoStep = Math.max(3, researchConfig.min_source_urls ?? 0);
    const maxSourceAttempts = researchConfig.source_provider === "searchapi_google_news" ? 1 : 3;
    let lastShortKoreaCats: string[] = categoryIds;
    for (let attempt = 1; attempt <= maxSourceAttempts; attempt++) {
      const okCount = sourcesResult.sources.sources.length >= minSourcesToUseTwoStep;
      const okCoverage = missingCats.length === 0;
      const koreaCounts = computeLikelyKoreanCompanyCountsByCategory({
        sources: sourcesResult.sources.sources,
        categoryIds,
      });
      const shortKoreaCats = categoryIds.filter((id) => (koreaCounts.get(id) ?? 0) < minKorea);
      lastShortKoreaCats = shortKoreaCats;

      if (okCount && okCoverage && shortKoreaCats.length === 0) break;
      if (attempt >= maxSourceAttempts) {
        logger.warn(
          {
            attempt,
            sources: sourcesResult.sources.sources.length,
            missingCategories: missingCats,
            shortKoreaCategories: shortKoreaCats,
          },
          "Source coverage still insufficient after max attempts; proceeding with best available",
        );
        break;
      }

      if (researchConfig.source_provider === "searchapi_google_news") break;

      const retryPrompt = [
        baseSourcesPrompt,
        "",
        "IMPORTANT RETRY:",
        "- The previous source list was too sparse.",
        "- Search in BOTH Korean and English queries.",
        `- Target at least ${targetSourcesHint} total sources, and prioritize Korea-headquartered companies for category coverage.`,
        "- You MUST try to find at least 1 credible source per category if any exist in the lookback window.",
        missingCats.length ? `- Focus especially on these missing categories: ${missingCats.join(", ")}` : "",
        shortKoreaCats.length
          ? `- Korea-headquartered coverage is still short for these categories: ${shortKoreaCats.join(", ")}. Add more Korea-headquartered companies for those categories.`
          : "",
        "- If you cannot reach the target counts, still return ALL sources you found (do not return an empty list).",
      ]
        .filter(Boolean)
        .join("\n");

      logger.warn(
        {
          attempt,
          sources: sourcesResult.sources.sources.length,
          missingCategories: missingCats,
          shortKoreaCategories: shortKoreaCats,
        },
        "Source coverage insufficient; retrying source collection",
      );

      sourcesResult = await generateSourceList({ env: geminiEnv, prompt: retryPrompt });
      missingCats = computeMissingSourceCategories({ sources: sourcesResult.sources.sources, categoryIds });
    }

    let allowedUrls = sourcesResult.sources.sources.map((s) => s.url);
    allowedUrls = filterUrlsBySeen({ urls: allowedUrls, seen: seenThisWeek });
    const allowedSet = new Set(allowedUrls.map((u) => normalizeUrlForDedupe(u)));
    const sourcesForReport = sourcesResult.sources.sources.filter((s) => allowedSet.has(normalizeUrlForDedupe(s.url)));

    if (researchConfig.source_provider === "searchapi_google_news") {
      const metaFromSearch = sourcesResult as Awaited<ReturnType<typeof generateSourceListViaSearchApiGoogleNewsForWatchlist>>;
      let sourcesForReportFinal = sourcesForReport;
      let queriesUsed = metaFromSearch.meta.queries;

      const countLocales = (sources: typeof sourcesForReportFinal): { kr: number; global: number } => {
        let kr = 0;
        let global = 0;
        for (const s of sources) {
          const note = typeof s.note === "string" ? s.note : "";
          if (note.includes("[KR]")) kr++;
          else if (note.includes("[GLOBAL]")) global++;
        }
        return { kr, global };
      };

      const mergeSourcesByUrl = (a: typeof sourcesForReportFinal, b: typeof sourcesForReportFinal): typeof sourcesForReportFinal => {
        const merged: typeof sourcesForReportFinal = [];
        const seenUrls = new Set<string>();
        for (const s of [...a, ...b]) {
          const key = normalizeUrlForDedupe(s.url);
          if (!key || seenUrls.has(key)) continue;
          seenUrls.add(key);
          merged.push(s);
        }
        return merged;
      };

      const discoveryEnabled = (researchConfig.searchapi?.enable_company_discovery ?? true) && !researchConfig.watchlist_only;
      if (discoveryEnabled && searchEnv) {
        const byCatKorea = new Map<string, Set<string>>();
        for (const id of categoryIds) byCatKorea.set(id, new Set());
        for (const s of sourcesForReportFinal) {
          if (!byCatKorea.has(s.category)) continue;
          const looksKrLocale = typeof s.note === "string" && s.note.includes("[KR]");
          const looksKrCompany = hasHangul(s.company);
          if (!looksKrLocale && !looksKrCompany) continue;
          byCatKorea.get(s.category)!.add(s.company.trim());
        }
        const minKrCompanies = researchConfig.min_companies_per_category ?? 0;
        const shortCats =
          minKrCompanies > 0 ? categoryIds.filter((id) => (byCatKorea.get(id)?.size ?? 0) < minKrCompanies) : [];

        if (shortCats.length) {
          const alreadyKnown = Array.from(
            new Set([
              ...sourcesForReportFinal.map((s) => s.company.trim()).filter(Boolean),
              ...(researchConfig.watchlist ?? []).map((w) => w.company.trim()).filter(Boolean),
              ...(researchConfig.global_watchlist ?? []).map((w) => w.company.trim()).filter(Boolean),
            ]),
          );

          const perCategoryMax = researchConfig.searchapi?.discovery_candidates_per_category ?? 12;
          const prompt = buildCompanyDiscoveryPrompt({
            reportDate,
            lookbackDays: researchConfig.lookback_days,
            categories: researchConfig.categories,
            focusCategoryIds: shortCats,
            excludedCompanies: researchConfig.excluded_companies ?? [],
            alreadyKnownCompanies: alreadyKnown,
            perCategoryMax,
          });

          const discovered = await generateCompanyDiscovery({ env: geminiEnv, prompt });

          const excluded = new Set((researchConfig.excluded_companies ?? []).map((c) => c.trim()).filter(Boolean));
          const known = new Set(alreadyKnown.map((c) => c.trim()).filter(Boolean));
          const seenCompanyCat = new Set<string>();
          const candidates = discovered.discovery.companies.filter((c) => {
            const company = c.company.trim();
            if (!company) return false;
            const categoryId = c.category_id.trim();
            if (!shortCats.includes(categoryId)) return false;
            if (excluded.has(company)) return false;
            if (known.has(company)) return false;
            const key = `${categoryId}|${company}`;
            if (seenCompanyCat.has(key)) return false;
            seenCompanyCat.add(key);
            return true;
          });

          const maxTotal = researchConfig.searchapi?.discovery_max_companies_total ?? 30;
          const targetPerCategory = researchConfig.searchapi?.discovery_target_companies_per_category ?? 3;
          const picked: Array<{ company: string; category_id: string; aliases: string[] }> = [];
          const perCatPicked = new Map<string, number>();

          for (const c of candidates) {
            if (picked.length >= maxTotal) break;
            const cat = c.category_id.trim();
            const current = perCatPicked.get(cat) ?? 0;
            const currentCount = byCatKorea.get(cat)?.size ?? 0;
            const desired = Math.max(targetPerCategory, minKrCompanies);
            const need = Math.max(0, desired - currentCount);
            if (need === 0) continue;
            // Try a few more than "need" because some will have zero results.
            const cap = need + 2;
            if (current >= cap) continue;
            perCatPicked.set(cat, current + 1);
            picked.push({ company: c.company.trim(), category_id: cat, aliases: c.aliases ?? [] });
          }

          if (picked.length) {
            const maxResults = researchConfig.searchapi?.discovery_max_results_per_query ?? 20;
            const maxPages = researchConfig.searchapi?.discovery_max_pages_per_query ?? 3;

            const extraWatchlist = picked.map((p) => ({
              company: p.company,
              category_id: p.category_id as any,
              aliases: p.aliases ?? [],
              keywords: [],
            }));

            const extra = await generateSourceListViaSearchApiGoogleNewsForWatchlist({
              env: searchEnv,
              config: researchConfig,
              reportDate,
              watchlist: extraWatchlist,
              overrides: { maxResults, maxPages, includeKr: true, includeGlobal: false, requireCompanyMention: false },
            });

            queriesUsed += extra.meta.queries;
            let extraAllowed = extra.sources.sources.map((s) => s.url);
            extraAllowed = filterUrlsBySeen({ urls: extraAllowed, seen: seenThisWeek });
            const extraAllowedSet = new Set(extraAllowed.map((u) => normalizeUrlForDedupe(u)));
            const extraSourcesForReport = extra.sources.sources.filter((s) => extraAllowedSet.has(normalizeUrlForDedupe(s.url)));

            sourcesForReportFinal = mergeSourcesByUrl(sourcesForReportFinal, extraSourcesForReport);
          }
        }
      }

      // If Korea sources are still too sparse, run additional KR-only discovery to top up.
      const minKrSources = researchConfig.searchapi?.kr_min_sources ?? 0;
      if (discoveryEnabled && searchEnv && minKrSources > 0) {
        const before = countLocales(sourcesForReportFinal);
        if (before.kr < minKrSources) {
          logger.info({ kr: before.kr, target: minKrSources }, "KR sources below target; running KR-only top-up");
          const alreadyKnown = Array.from(
            new Set([
              ...sourcesForReportFinal.map((s) => s.company.trim()).filter(Boolean),
              ...(researchConfig.watchlist ?? []).map((w) => w.company.trim()).filter(Boolean),
              ...(researchConfig.global_watchlist ?? []).map((w) => w.company.trim()).filter(Boolean),
            ]),
          );

          const perCategoryMax = researchConfig.searchapi?.discovery_candidates_per_category ?? 12;
          const prompt = buildCompanyDiscoveryPrompt({
            reportDate,
            lookbackDays: researchConfig.lookback_days,
            categories: researchConfig.categories,
            focusCategoryIds: categoryIds,
            excludedCompanies: researchConfig.excluded_companies ?? [],
            alreadyKnownCompanies: alreadyKnown,
            perCategoryMax,
          });

          const discovered = await generateCompanyDiscovery({ env: geminiEnv, prompt });
          const excluded = new Set((researchConfig.excluded_companies ?? []).map((c) => c.trim()).filter(Boolean));
          const known = new Set(alreadyKnown.map((c) => c.trim()).filter(Boolean));
          const seenCompanyCat = new Set<string>();
          const candidates = discovered.discovery.companies
            .map((c) => ({
              company: c.company.trim(),
              category_id: c.category_id.trim(),
              aliases: c.aliases ?? [],
            }))
            .filter((c) => {
              if (!c.company) return false;
              if (!categoryIds.includes(c.category_id)) return false;
              if (excluded.has(c.company)) return false;
              if (known.has(c.company)) return false;
              const key = `${c.category_id}|${c.company}`;
              if (seenCompanyCat.has(key)) return false;
              seenCompanyCat.add(key);
              return true;
            });

          const maxTotal = researchConfig.searchapi?.discovery_max_companies_total ?? 30;
          const maxResults = researchConfig.searchapi?.discovery_max_results_per_query ?? 20;
          const maxPages = researchConfig.searchapi?.discovery_max_pages_per_query ?? 3;

          const byCat = new Map<string, Array<(typeof candidates)[number]>>();
          for (const c of candidates) {
            const list = byCat.get(c.category_id) ?? [];
            list.push(c);
            byCat.set(c.category_id, list);
          }

          const pickedAll: typeof candidates = [];
          const perCatPicked = new Map<string, number>();
          const perCatCap = 12;
          let rr = 0;
          let misses = 0;
          while (pickedAll.length < maxTotal && misses < categoryIds.length) {
            const cat = categoryIds[rr % categoryIds.length]!;
            rr++;
            const list = byCat.get(cat) ?? [];
            const next = list.shift();
            if (!next) {
              misses++;
              continue;
            }
            misses = 0;
            const cur = perCatPicked.get(cat) ?? 0;
            if (cur >= perCatCap) continue;
            perCatPicked.set(cat, cur + 1);
            pickedAll.push(next);
          }

          const estimatePerCompany = 3;
          const maxBatches = 3;
          let batches = 0;
          let current = before;
          const queue = pickedAll.slice();

          while (queue.length && current.kr < minKrSources && batches < maxBatches) {
            const need = Math.max(0, minKrSources - current.kr);
            const batchSize = Math.min(queue.length, Math.max(5, Math.ceil(need / estimatePerCompany)));
            const batch = queue.splice(0, batchSize);
            if (batch.length === 0) break;

            const extraWatchlist = batch.map((p) => ({
              company: p.company,
              category_id: p.category_id as any,
              aliases: p.aliases ?? [],
              keywords: [],
            }));

            const extra = await generateSourceListViaSearchApiGoogleNewsForWatchlist({
              env: searchEnv,
              config: researchConfig,
              reportDate,
              watchlist: extraWatchlist,
              overrides: { maxResults, maxPages, includeKr: true, includeGlobal: false, requireCompanyMention: false },
            });

            queriesUsed += extra.meta.queries;
            let extraAllowed = extra.sources.sources.map((s) => s.url);
            extraAllowed = filterUrlsBySeen({ urls: extraAllowed, seen: seenThisWeek });
            const extraAllowedSet = new Set(extraAllowed.map((u) => normalizeUrlForDedupe(u)));
            const extraSourcesForReport = extra.sources.sources.filter((s) => extraAllowedSet.has(normalizeUrlForDedupe(s.url)));
            sourcesForReportFinal = mergeSourcesByUrl(sourcesForReportFinal, extraSourcesForReport);
            current = countLocales(sourcesForReportFinal);
            batches++;
          }

          if (current.kr < minKrSources) {
            logger.warn({ kr: current.kr, target: minKrSources, batches }, "KR sources still below target after top-up");
          } else {
            logger.info({ kr: current.kr, target: minKrSources, batches }, "KR sources target met after top-up");
          }
        }
      }

      const after = countLocales(sourcesForReportFinal);
      renderMeta = { sourcesCollected: sourcesForReportFinal.length, sourcesQueries: queriesUsed, sourcesKr: after.kr, sourcesGlobal: after.global };

      const companies = Array.from(new Set(sourcesForReportFinal.map((s) => s.company))).slice(0, 60);

      const homepagesPrompt = buildCompanyHomepagesPrompt({
        lookbackDays: researchConfig.lookback_days,
        companies,
      });
      const homepagesResult = await generateCompanyHomepages({ env: geminiEnv, prompt: homepagesPrompt });

      const hqPrompt = buildCompanyHqPrompt({ companies });
      const hqResult = await generateCompanyHq({ env: geminiEnv, prompt: hqPrompt });
      const companyHq = hqResult.hq.company_hq;

      const base = WeeklyReportSchema.parse({
        report_date: reportDate,
        week_number: weekNumber,
        company_homepages: homepagesResult.homepages.company_homepages ?? {},
      });

      report = fillReportFromSourcesFallback({
        report: base,
        sources: sourcesForReportFinal,
        config: researchConfig,
        companyHq,
      });
      report = splitOverseasFromCategoryUpdatesByHq({
        report: WeeklyReportSchema.parse(report),
        companyHq,
      });

      const parsed = WeeklyReportSchema.parse(report);
      report = { ...parsed, top_highlights: rebuildTopHighlightsFromCategoryUpdates({ report: parsed, max: 3 }) };
      modelUsed = geminiEnv.GEMINI_MODEL;
    } else if (allowedUrls.length >= 1) {
      const companies = Array.from(new Set(sourcesForReport.map((s) => s.company))).slice(0, 50);
      const homepagesPrompt = buildCompanyHomepagesPrompt({
        lookbackDays: researchConfig.lookback_days,
        companies,
      });
      const homepagesResult = await generateCompanyHomepages({ env: geminiEnv, prompt: homepagesPrompt });
      const hqPrompt = buildCompanyHqPrompt({ companies });
      const hqResult = await generateCompanyHq({ env: geminiEnv, prompt: hqPrompt });
      const companyHq = hqResult.hq.company_hq;

      const reportPrompt = buildReportFromSourcesPrompt({
        reportDate,
        weekNumber,
        config: researchConfig,
        sourcesJson: JSON.stringify({ sources: sourcesForReport }),
        allowedUrls,
      });
      const categoriesPresent = Array.from(new Set(sourcesForReport.map((s) => s.category)));
      let generated = await generateWeeklyReportFromSources({ env: geminiEnv, prompt: reportPrompt, allowedUrls });
      let candidateReport = {
        ...generated.report,
        company_homepages: {
          ...(generated.report.company_homepages ?? {}),
          ...(homepagesResult.homepages.company_homepages ?? {}),
        },
      };
      const updatesCount = countCategoryUpdates(candidateReport);
      const missingCatsInReport = categoriesPresent.filter(
        (cat) => (candidateReport.category_updates?.[cat]?.length ?? 0) === 0,
      );
      const needsMoreActionItems = (candidateReport.action_items?.length ?? 0) < 3;

      if ((updatesCount === 0 || missingCatsInReport.length > 0 || needsMoreActionItems) && categoriesPresent.length > 0) {
        const strictPrompt = [
          reportPrompt,
          "",
          "STRICT COVERAGE REQUIREMENTS:",
          `- The provided source list includes these categories: ${categoriesPresent.join(", ")}.`,
          `- For EACH listed category, include at least 1 item in category_updates[category] IF the source list includes any Korea-headquartered company in that category.`,
          `- category_updates MUST contain ONLY Korea-headquartered companies. Put overseas companies into overseas_competitor_updates instead.`,
          "- action_items MUST be 3-6 concrete strings.",
          "- Do not return empty arrays for those sections unless the source list truly has no evidence.",
        ].join("\n");

        logger.warn(
          {
            updatesCount,
            missingCatsInReport,
            needsMoreActionItems,
            categoriesPresent,
            sources: sourcesResult.sources.sources.length,
          },
          "Report too sparse for available sources; retrying report generation from sources",
        );

        generated = await generateWeeklyReportFromSources({ env: geminiEnv, prompt: strictPrompt, allowedUrls });
        candidateReport = {
          ...generated.report,
          company_homepages: {
            ...(generated.report.company_homepages ?? {}),
            ...(homepagesResult.homepages.company_homepages ?? {}),
          },
        };
      }

      report = fillReportFromSourcesFallback({
        report: WeeklyReportSchema.parse(candidateReport),
        sources: sourcesForReport,
        config: researchConfig,
        companyHq: companyHq,
      });
      report = splitOverseasFromCategoryUpdatesByHq({
        report: WeeklyReportSchema.parse(report),
        companyHq: companyHq,
      });
      modelUsed = generated.meta.model;
    } else {
      // Fallback to one-shot if grounding metadata is missing or too few sources were captured.
      logger.warn(
        { sources: allowedUrls.length, shortKoreaCategories: lastShortKoreaCats },
        "Too few sources for 2-step pipeline; falling back to one-shot report generation",
      );
      const prompt = buildWeeklyPrompt({ reportDate, weekNumber, config: researchConfig });
      const generated = await generateWeeklyReport({ env: geminiEnv, prompt });
      const companies = Array.from(
        new Set([
          ...generated.report.top_highlights.map((h) => h.company),
          ...Object.values(generated.report.category_updates).flat().map((u) => u.company),
          ...(generated.report.overseas_competitor_updates ?? []).map((u) => u.company),
          ...generated.report.hiring_signals.map((h) => h.company),
        ]),
      ).slice(0, 50);
      const homepagesPrompt = buildCompanyHomepagesPrompt({
        lookbackDays: researchConfig.lookback_days,
        companies,
      });
      const homepagesResult = await generateCompanyHomepages({ env: geminiEnv, prompt: homepagesPrompt });
      const hqPrompt = buildCompanyHqPrompt({ companies });
      const hqResult = await generateCompanyHq({ env: geminiEnv, prompt: hqPrompt });
      report = {
        ...generated.report,
        company_homepages: {
          ...(generated.report.company_homepages ?? {}),
          ...(homepagesResult.homepages.company_homepages ?? {}),
        },
      };
      report = splitOverseasFromCategoryUpdatesByHq({
        report: WeeklyReportSchema.parse(report),
        companyHq: hqResult.hq.company_hq,
      });
      modelUsed = generated.meta.model;
    }

    // Final backfill: ensure at least min_companies_per_category Korea companies per category when possible.
    // (SearchAPI mode intentionally skips LLM-powered backfills to avoid repeating/expanding beyond the news search corpus.)
    if (researchConfig.source_provider === "searchapi_google_news") {
      report = filterReportBySeenUrls({ report: WeeklyReportSchema.parse(report), seen: seenThisWeek });
      // Save history after successful email send only (see below).
    } else {
    const categoryIdsFinal = researchConfig.categories.map((c) => c.id);
    const minKoreaFinal = researchConfig.min_companies_per_category ?? 0;
    const counts = computeDistinctCompaniesPerCategory({
      categoryUpdates: WeeklyReportSchema.parse(report).category_updates,
      categoryIds: categoryIdsFinal,
    });
    const shortCats = categoryIdsFinal.filter((id) => (counts.get(id) ?? 0) < minKoreaFinal);
    if (shortCats.length) {
      logger.warn({ shortCats, counts: Object.fromEntries(counts) }, "Domestic category coverage short; backfilling");
      const backfillPrompt = [
        baseSourcesPrompt,
        "",
        "BACKFILL MODE:",
        `- Focus on these categories: ${shortCats.join(", ")}.`,
        `- For EACH of those categories, find additional Korea-headquartered companies so that category_updates can reach at least ${minKoreaFinal} distinct companies per category.`,
        "- Prefer official announcements, product changelogs, blogs, hiring pages, and reputable Korean tech news.",
      ].join("\n");

      const extraSources = await generateSourceList({ env: geminiEnv, prompt: backfillPrompt });
      const extraCompanies = Array.from(new Set(extraSources.sources.sources.map((s) => s.company))).slice(0, 60);
      const extraHqPrompt = buildCompanyHqPrompt({ companies: extraCompanies });
      const extraHq = await generateCompanyHq({ env: geminiEnv, prompt: extraHqPrompt });

      report = fillReportFromSourcesFallback({
        report: WeeklyReportSchema.parse(report),
        sources: extraSources.sources.sources,
        config: researchConfig,
        companyHq: extraHq.hq.company_hq,
      });
      report = splitOverseasFromCategoryUpdatesByHq({
        report: WeeklyReportSchema.parse(report),
        companyHq: extraHq.hq.company_hq,
      });
    }

    // Overseas backfill: ensure at least 10 overseas items when possible.
    const minOverseasItems = 10;
    const parsedAfterBackfill = WeeklyReportSchema.parse(report);
    if ((parsedAfterBackfill.overseas_competitor_updates?.length ?? 0) < minOverseasItems) {
      const overseasPrompt = buildOverseasSourcesPrompt({
        reportDate,
        weekNumber,
        config: researchConfig,
        minItems: minOverseasItems,
      });

      const overseasSources = await generateSourceList({ env: geminiEnv, prompt: overseasPrompt });
      const overseasCompanies = Array.from(new Set(overseasSources.sources.sources.map((s) => s.company))).slice(0, 80);
      const overseasHqPrompt = buildCompanyHqPrompt({ companies: overseasCompanies });
      const overseasHq = await generateCompanyHq({ env: geminiEnv, prompt: overseasHqPrompt });

      report = fillOverseasFromSourcesFallback({
        report: WeeklyReportSchema.parse(report),
        sources: overseasSources.sources.sources,
        companyHq: overseasHq.hq.company_hq,
        minItems: minOverseasItems,
        maxItems: 15,
      });
      report = splitOverseasFromCategoryUpdatesByHq({
        report: WeeklyReportSchema.parse(report),
        companyHq: overseasHq.hq.company_hq,
      });
    }
    }
  }

  let parsedReport = WeeklyReportSchema.parse(report);
  const countItems = (r: WeeklyReport): number => {
    const parsed = WeeklyReportSchema.parse(r);
    return (
      (parsed.top_highlights?.length ?? 0) +
      Object.values(parsed.category_updates ?? {}).reduce((sum, items) => sum + (items?.length ?? 0), 0) +
      (parsed.overseas_competitor_updates?.length ?? 0) +
      (parsed.hiring_signals?.length ?? 0)
    );
  };
  const beforePostprocessCount = countItems(parsedReport);
  if (!opts.inputReport) {
    parsedReport = await postprocessReport({
      env: geminiEnv ?? undefined,
      modelUsed,
      report: parsedReport,
      config: researchConfig,
    });
  } else {
    // Even for input reports, drop obviously invalid/fallback URLs (no LLM repair unless verify_source_urls=true + env present).
    parsedReport = await postprocessReport({
      env: geminiEnv ?? undefined,
      modelUsed,
      report: parsedReport,
      config: researchConfig,
    });
  }
  const afterPostprocessCount = countItems(parsedReport);
  if (renderMeta) {
    renderMeta.droppedUrls = Math.max(0, beforePostprocessCount - afterPostprocessCount);
  }
  if (dedupeCtx) {
    const before = WeeklyReportSchema.parse(parsedReport);
    const beforeCount =
      (before.top_highlights?.length ?? 0) +
      Object.values(before.category_updates ?? {}).reduce((sum, items) => sum + (items?.length ?? 0), 0) +
      (before.overseas_competitor_updates?.length ?? 0) +
      (before.hiring_signals?.length ?? 0);
    parsedReport = filterReportBySeenUrls({ report: parsedReport, seen: dedupeCtx.seenThisWeek });
    const after = WeeklyReportSchema.parse(parsedReport);
    const afterCount =
      (after.top_highlights?.length ?? 0) +
      Object.values(after.category_updates ?? {}).reduce((sum, items) => sum + (items?.length ?? 0), 0) +
      (after.overseas_competitor_updates?.length ?? 0) +
      (after.hiring_signals?.length ?? 0);
    const dropped = Math.max(0, beforeCount - afterCount);
    if (dropped) {
      logger.info({ weekKey: dedupeCtx.weekKey, dropped }, "Weekly dedupe removed already-sent items");
      if (renderMeta) renderMeta.dedupedItems = dropped;
    }
  }
  parsedReport = ensureOverseasCompetitorSection({ report: parsedReport });

  if (researchConfig.source_provider === "searchapi_google_news") {
    parsedReport = WeeklyReportSchema.parse({
      ...parsedReport,
      top_highlights: rebuildTopHighlightsFromCategoryUpdates({ report: parsedReport, max: 3 }),
      action_items: rebuildActionItemsFromCategoryUpdates(parsedReport, 6),
    });
	  }
	  if (geminiEnv) {
	    try {
	      const localized = await translateOverseasSectionToKorean({ env: geminiEnv, report: parsedReport });
	      parsedReport = localized.report;
	    } catch (err) {
	      logger.warn({ err }, "Overseas translation failed; continuing without translation");
	    }
	  }

  const markdown = renderMarkdown(parsedReport, researchConfig, renderMeta);
  const html = await renderHtmlFromMarkdown(markdown);

  const subject = `${subjectPrefix} ${parsedReport.report_date} (W${parsedReport.week_number}) 경쟁사 동향`;

  await mkdir("out", { recursive: true });
  await writeFile("out/report.json", JSON.stringify(parsedReport, null, 2), "utf8");
  await writeFile("out/email.md", markdown, "utf8");
  await writeFile("out/email.html", html, "utf8");

  if (opts.dryRun) {
    logger.info({ subject, modelUsed }, "Dry-run complete (no email sent)");
    return;
  }

  const mailEnv = loadMailEnv();
  await sendEmail({ env: mailEnv, subject, html, text: markdown });

  if (dedupeCtx) {
    const next = addReportUrlsToHistory({
      history: dedupeCtx.history,
      weekKey: dedupeCtx.weekKey,
      report: parsedReport,
      keepWeeks: 12,
    });
    await saveSeenHistory(dedupeCtx.historyPath, next);
  }

  logger.info({ subject }, "Email sent");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Fatal error");
    process.exit(1);
  });
