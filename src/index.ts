import "dotenv/config";
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadGeminiEnv, loadMailEnv } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { getIsoDateInTimeZone, getWeekNumberInTimeZone } from "./lib/date.js";
import { loadResearchConfig } from "./research/config.js";
import {
  buildCompanyHomepagesPrompt,
  buildCompanyHqPrompt,
  buildOverseasSourcesPrompt,
  buildReportFromSourcesPrompt,
  buildSourcesPrompt,
  buildWeeklyPrompt,
} from "./research/prompt.js";
import {
  generateCompanyHomepages,
  generateCompanyHq,
  generateSourceList,
  translateOverseasSectionToKorean,
  generateWeeklyReport,
  generateWeeklyReportFromSources,
} from "./research/gemini.js";
import { WeeklyReportSchema } from "./research/schema.js";
import { postprocessReport } from "./research/postprocess.js";
import {
  ensureOverseasCompetitorSection,
  splitOverseasFromCategoryUpdatesByHq,
} from "./research/augment.js";
import { fillOverseasFromSourcesFallback, fillReportFromSourcesFallback } from "./research/fallbackFill.js";
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

async function main(): Promise<void> {
  const configPath = path.resolve(process.cwd(), opts.config);
  const researchConfig = await loadResearchConfig(configPath);

  const now = new Date();
  let report = null as unknown;
  let subjectPrefix = researchConfig.email?.subject_prefix ?? process.env.MAIL_SUBJECT_PREFIX ?? "[Market Radar]";
  let modelUsed = process.env.GEMINI_MODEL ?? "unknown";
  let geminiEnv: ReturnType<typeof loadGeminiEnv> | null = null;

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
    const baseSourcesPrompt = buildSourcesPrompt({ reportDate, weekNumber, config: researchConfig });
    const categoryIds = researchConfig.categories.map((c) => c.id);

    let sourcesResult = await generateSourceList({ env: geminiEnv, prompt: baseSourcesPrompt });
    let missingCats = computeMissingSourceCategories({ sources: sourcesResult.sources.sources, categoryIds });

    const minKorea = researchConfig.min_companies_per_category ?? 0;
    const targetSourcesHint = Math.max(minKorea * categoryIds.length, 20);
    const minSourcesToUseTwoStep = Math.max(3, researchConfig.min_source_urls ?? 0);
    const maxSourceAttempts = 3;
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

    const allowedUrls = sourcesResult.sources.sources.map((s) => s.url);

    if (allowedUrls.length >= 1 && lastShortKoreaCats.length === 0) {
      const companies = Array.from(new Set(sourcesResult.sources.sources.map((s) => s.company))).slice(0, 50);
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
        sourcesJson: JSON.stringify(sourcesResult.sources),
        allowedUrls,
      });
      const categoriesPresent = Array.from(new Set(sourcesResult.sources.sources.map((s) => s.category)));
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
        sources: sourcesResult.sources.sources,
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

    // Optional postprocess (URL status check) can be enabled in config; default can be false.
    report = await postprocessReport({
      env: geminiEnv,
      modelUsed,
      report: WeeklyReportSchema.parse(report),
      config: researchConfig,
    });

    // Final backfill: ensure at least min_companies_per_category Korea companies per category when possible.
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

  let parsedReport = WeeklyReportSchema.parse(report);
  parsedReport = ensureOverseasCompetitorSection({ report: parsedReport });
  if (geminiEnv) {
    const localized = await translateOverseasSectionToKorean({ env: geminiEnv, report: parsedReport });
    parsedReport = localized.report;
  }

  const markdown = renderMarkdown(parsedReport, researchConfig);
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
  logger.info({ subject }, "Email sent");
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exitCode = 1;
});
